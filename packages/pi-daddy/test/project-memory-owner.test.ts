import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, symlink, unlink } from "node:fs/promises";
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

test("root Auto offers project memory to early and late observers, with immediate withdrawal even on audit failure", async () => {
  const { pi, session, ctx, current, notices, request } = fixture();
  const bridge = registerProjectMemoryOwner(pi, session);
  const ready = bridge.begin(ctx);
  await initializeSessionAutoMode(session, {}, current.id);
  try {
    ready();
    assert.equal(request(), undefined);
    await setAutoApproval(session, true, "dashboard");
    const owner = request();
    assert.ok(owner && owner.isCurrent());
    assert.equal(notices.at(-1)?.owner, owner);
    assert.equal(request("some-other-session"), undefined);
    assert.equal(request(current.id, "/another-dir"), undefined);
    session.ledgerPath = "/dev/null/unwritable";
    await assert.rejects(setAutoApproval(session, false, "command"));
    assert.equal(owner.isCurrent(), false);
    assert.equal(request(), undefined);
    assert.equal(notices.at(-1)?.valid, false);
    await assert.rejects(setAutoApproval(session, true, "command"));
    assert.equal(request(), undefined);
    session.ledgerPath = undefined;
    await setAutoApproval(session, true, "command");
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

test("a workspace alias may not redirect an existing owner to a different directory", async () => {
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
    await unlink(alias);
    await symlink(second, alias, "junction");
    assert.equal(owner.isCurrent(), false);
    assert.equal(request(), undefined);
    await unlink(alias);
    await symlink(first, alias, "junction");
    assert.equal(owner.isCurrent(), false);
  } finally {
    bridge.close();
    await closeSessionAutoMode(session);
  }
});
