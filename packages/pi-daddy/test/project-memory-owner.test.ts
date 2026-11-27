import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  registerProjectMemoryOwner,
  PROJECT_MEMORY_OWNER_EVENT,
  PROJECT_MEMORY_OWNER_REQUEST,
  type ProjectMemoryOwner,
} from "../extensions/project-memory-owner.ts";
import { connectedEcosystemPreferences } from "../extensions/ecosystem-preferences.ts";
import { closeSessionAutoMode, initializeSessionAutoMode, setAutoApproval } from "../extensions/session-auto-mode.ts";
import type { GrantsSession } from "../extensions/session.ts";

after(cleanupTempDirs);

function fixture(cwd = process.cwd()) {
  const events = new EventEmitter();
  const pi: Pick<ExtensionAPI, "events"> = {
    events: {
      emit: (key, value) => {
        events.emit(key, value);
      },
      on: (key, listener) => {
        events.on(key, listener);
        return () => {
          events.off(key, listener);
        };
      },
    },
  };
  const session = {
    ownerBound: true,
    depth: 0,
    malformedBounds: [],
    cwd,
    reloadLifecycle: { root: {} },
  } as unknown as GrantsSession;
  const current = { id: "native-session", trusted: true };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd,
    isProjectTrusted: () => current.trusted,
    sessionManager: { getSessionId: () => current.id },
  } as unknown as ExtensionContext;
  const notices: { owner: ProjectMemoryOwner; valid: boolean }[] = [];
  events.on(PROJECT_MEMORY_OWNER_EVENT, (owner: ProjectMemoryOwner) =>
    notices.push({ owner, valid: owner.isCurrent() }),
  );
  const request = (sessionId = current.id, directory = cwd) => {
    let answer: ProjectMemoryOwner | undefined;
    events.emit(PROJECT_MEMORY_OWNER_REQUEST, {
      version: 1,
      sessionId,
      cwd: directory,
      reply: (owner: ProjectMemoryOwner) => {
        answer = owner;
      },
    });
    return answer;
  };
  return { pi, session, ctx, current, notices, request };
}

test("workspace memory follows each Auto change, while manual memory edits leave Auto alone across reload", async (t) => {
  const profile = await tempDir("memory-settings-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const { pi, session, ctx, current, notices, request } = fixture();
  await writeFile(join(profile, "ecosystem.json"), JSON.stringify({ bookie: { workspaceMemory: true } }));
  const bridge = registerProjectMemoryOwner(pi, session);
  const ready = bridge.begin(ctx);
  await initializeSessionAutoMode(session, process.env, current.id, ctx);
  try {
    ready();
    const owner = request();
    assert.ok(owner && owner.isCurrent());
    const autoEnabled = () => session.reloadLifecycle.autoMode!.authority!.snapshot().enabled;
    assert.equal(autoEnabled(), true);
    assert.equal(request("some-other-session"), undefined);
    assert.equal(request(current.id, "/another-dir"), undefined);
    const preferences = (input: Record<string, unknown>) =>
      connectedEcosystemPreferences(
        pi.events,
        { ...ctx, modelRegistry: { getAvailable: () => [] } } as unknown as ExtensionContext,
        input,
        session.reloadLifecycle.projectMemoryOwner,
      );
    const saveMemory = (value: boolean) => preferences({ action: "save", key: "workspaceMemory", value });
    saveMemory(false);
    assert.equal(autoEnabled(), true);
    assert.equal(owner.isCurrent(), false);
    assert.equal(notices.at(-1)?.valid, false);
    await setAutoApproval(session, true, "dashboard");
    assert.equal(request(), undefined);
    await setAutoApproval(session, false, "command");
    await setAutoApproval(session, true, "dashboard");
    assert.ok(request()?.isCurrent());
    bridge.begin(ctx)();
    assert.ok(request()?.isCurrent());
    assert.equal(preferences({ action: "list" }).values?.workspaceMemory, true);
    await setAutoApproval(session, false, "dashboard");
    assert.equal(request(), undefined);
    saveMemory(true);
    assert.equal(autoEnabled(), false);
    const replacement = request();
    assert.ok(replacement && replacement.isCurrent());
    assert.equal(owner.isCurrent(), false);
    current.trusted = false;
    assert.equal(replacement.isCurrent(), false);
    current.trusted = true;
    assert.equal(replacement.isCurrent(), false);
  } finally {
    bridge.close();
    await closeSessionAutoMode(session);
  }
});

test("trusted startup honors saved opt-outs, boolean memory settings and explicit launch overrides", async (t) => {
  const profile = await tempDir("memory-defaults-");
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: profile };
  delete env.PI_DADDY_AUTO_MODE;
  delete env.PI_DADDY_AUTO_MODE_REF;
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  for (const [startup, preference, override, expectedAuto, expectedMemory] of [
    [true, true, undefined, true, true],
    [true, false, undefined, true, false],
    [false, true, undefined, false, false],
    [false, true, "1", true, true],
    [true, true, "0", false, false],
  ] as const) {
    await writeFile(
      join(profile, "ecosystem.json"),
      JSON.stringify({ autoOnStartup: startup, bookie: { workspaceMemory: preference } }),
    );
    const { pi, session, ctx, current, request } = fixture();
    const bridge = registerProjectMemoryOwner(pi, session);
    try {
      await initializeSessionAutoMode(session, { ...env, PI_DADDY_AUTO_MODE: override }, current.id, ctx);
      bridge.begin(ctx)();
      assert.equal(await session.autoMode!.admit(), expectedAuto);
      assert.equal(!!request(), expectedMemory);
    } finally {
      bridge.close();
      await closeSessionAutoMode(session);
    }
  }
});

test("automatic approval needs a live trusted root and readable settings", async () => {
  const profile = await tempDir("auto-trust-");
  await writeFile(join(profile, "ecosystem.json"), "{");
  for (const variant of ["invalid-settings", "untrusted", "headless", "noninteractive", "child", "unknown-id"]) {
    const { session, ctx, current } = fixture();
    if (variant === "child") session.depth = 1;
    if (variant === "untrusted") current.trusted = false;
    if (variant === "headless") ctx.hasUI = false;
    if (variant === "noninteractive") ctx.mode = "json";
    if (variant === "unknown-id") current.id = "";
    const env = { PI_CODING_AGENT_DIR: variant === "invalid-settings" ? profile : join(profile, "clean") };
    try {
      await initializeSessionAutoMode(session, env, "native-session", ctx);
      assert.equal(await session.autoMode!.admit(), false, variant);
    } finally {
      await closeSessionAutoMode(session);
    }
  }
});

test("rebind and reload revoke saved leases and obsolete startup completions before allowing the new owner", async () => {
  const { pi, session, ctx, current, request } = fixture();
  const bridge = registerProjectMemoryOwner(pi, session);
  await initializeSessionAutoMode(session, { PI_DADDY_AUTO_MODE: "1" }, current.id);
  try {
    const obsolete = bridge.begin(ctx);
    const complete = bridge.begin(ctx);
    obsolete();
    assert.equal(request(), undefined);
    complete();
    const first = request();
    assert.ok(first && first.isCurrent());
    const second = registerProjectMemoryOwner(pi, session);
    const ready = second.begin(ctx);
    assert.equal(first.isCurrent(), false);
    assert.equal(request(), undefined);
    ready();
    const fresh = request();
    assert.ok(fresh && fresh.isCurrent());
    bridge.close();
    assert.equal(request(), fresh);
    second.close();
    assert.equal(fresh.isCurrent(), false);
    assert.equal(request(), undefined);
    second.begin(ctx)();
    assert.ok(request()?.isCurrent());
    second.close();
  } finally {
    bridge.close();
    await closeSessionAutoMode(session);
  }
});

test("a child, non-interactive session, untrusted project or missing native identity cannot obtain a memory owner", async () => {
  for (const variant of [
    "child",
    "child-id",
    "inherited-authority",
    "no-ui",
    "headless",
    "malformed",
    "moved",
    "wrong-owner",
    "untrusted",
    "trust-unknown",
    "missing-owner",
  ]) {
    const { pi, session, ctx, current, request } = fixture();
    const bridge = registerProjectMemoryOwner(pi, session);
    await initializeSessionAutoMode(session, { PI_DADDY_AUTO_MODE: "1" }, current.id);
    try {
      const context = { ...ctx };
      if (variant === "child") session.depth = 1;
      if (variant === "child-id") session.ownExecutionId = "child";
      if (variant === "inherited-authority") delete session.reloadLifecycle.autoMode!.authority;
      if (variant === "no-ui") context.hasUI = false;
      if (variant === "headless") context.mode = "json";
      if (variant === "malformed") session.malformedBounds = ["invalid"];
      if (variant === "moved") session.cwd = "/elsewhere";
      if (variant === "wrong-owner") current.id = "other";
      if (variant === "untrusted") current.trusted = false;
      if (variant === "trust-unknown") Reflect.deleteProperty(context, "isProjectTrusted");
      if (variant === "missing-owner") Reflect.deleteProperty(context, "sessionManager");
      bridge.begin(context)();
      assert.equal(request(), undefined, variant);
    } finally {
      bridge.close();
      await closeSessionAutoMode(session);
    }
  }
});

for (const change of ["redirect an alias", "replace its target"] as const) {
  test(`a workspace must not retain an owner after an operator can ${change}`, async () => {
    const root = await tempDir("memory-owner-");
    const first = join(root, "first"),
      second = join(root, "second"),
      alias = join(root, "selected");
    await mkdir(first);
    await mkdir(second);
    await symlink(first, alias, "junction");
    const { pi, session, ctx, current, request } = fixture(alias);
    const bridge = registerProjectMemoryOwner(pi, session);
    try {
      await initializeSessionAutoMode(session, { PI_DADDY_AUTO_MODE: "1" }, current.id);
      bridge.begin(ctx)();
      const owner = request();
      assert.ok(owner && owner.isCurrent());
      if (change === "redirect an alias") {
        await unlink(alias);
        await symlink(second, alias, "junction");
      } else {
        await rename(first, join(root, "previous"));
        await mkdir(first);
      }
      assert.equal(owner.isCurrent(), false);
      assert.equal(request(), undefined);
      if (change === "redirect an alias") {
        await unlink(alias);
        await symlink(first, alias, "junction");
        assert.equal(owner.isCurrent(), false);
      }
    } finally {
      bridge.close();
      await closeSessionAutoMode(session);
    }
  });
}
