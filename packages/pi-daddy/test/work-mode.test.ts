import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "../extensions/session.ts";
import { initializeSessionAutoMode, closeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import {
  beginWorkModeRequest,
  capturedWorkMode,
  finishWorkModeRequest,
  initializeWorkMode,
  registerWorkMode,
  setWorkMode,
  workModeSnapshot,
  WORK_MODE_ENTRY,
} from "../extensions/work-mode.ts";
import { ENV_WORK_MODE, parseWorkMode, workModeGuidance, standardWorkMode } from "../src/kernel/work-mode.ts";

const ambitious = { mode: "ambitious" as const, emphases: ["depth" as const] };
type Entry = { type: string; customType: string; data: unknown };
async function fixture() {
  const session = {
    episodeId: "work-mode-fixture",
    ownerBound: true,
    depth: 0,
    reloadLifecycle: { root: {} },
  } as unknown as GrantsSession;
  let id = "work-mode-native";
  let records: Entry[] = [];
  let branch: Entry[] | undefined;
  let writeFails = false;
  const hooks = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      if (writeFails) throw Error("private storage failure");
      records.push({ type: "custom", customType, data: structuredClone(data) });
    },
    on: (name: string, handler: (...args: any[]) => any) => {
      hooks.set(name, handler);
    },
    registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
  } as unknown as ExtensionAPI;
  const notices: string[] = [];
  const ctx = {
    sessionManager: { getSessionId: () => id, getEntries: () => records, getBranch: () => branch ?? records },
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  await initializeSessionAutoMode(session, {}, id);
  registerWorkMode(pi, session);
  initializeWorkMode(pi, session, ctx, "startup", {});
  return {
    session,
    pi,
    ctx,
    hooks,
    commands,
    notices,
    get records() {
      return records;
    },
    setBranch(value: Entry[] | undefined) {
      branch = value;
    },
    failWrite(value: boolean) {
      writeFails = value;
    },
    async newSession() {
      id = "new-native";
      records = [];
      await initializeSessionAutoMode(session, {}, id);
      initializeWorkMode(pi, session, ctx, "new", {});
    },
    close: () => closeSessionAutoMode(session),
  };
}

test("Standard and absent selections add no guidance, entries or changes to existing authority", async () => {
  const f = await fixture();
  try {
    const owner = f.session.autoMode;
    assert.equal(workModeGuidance(undefined, "parent"), undefined);
    assert.equal(workModeGuidance(standardWorkMode(), "child"), undefined);
    assert.equal(f.hooks.get("before_agent_start")!({ systemPrompt: "exact existing prompt" }), undefined);
    assert.equal(capturedWorkMode(f.session), undefined);
    assert.equal(f.records.length, 0);
    assert.equal(f.session.autoMode, owner);
    assert.equal((await owner!.read()).enabled, false);
    assert.deepEqual(workModeSnapshot(f.session).active, standardWorkMode());
    f.hooks.get("agent_settled")!();
    assert.equal(workModeSnapshot(f.session).active, undefined);
  } finally {
    await f.close();
  }
});

test("selections accept bounded combinations and never accept arbitrary instruction text", () => {
  assert.deepEqual(parseWorkMode({ mode: "ambitious", emphases: ["range", "speed"] }), {
    mode: "ambitious",
    emphases: ["speed", "range"],
  });
  for (const value of [
    null,
    {},
    { mode: "expert", emphases: [] },
    { ...ambitious, prompt: "private instructions" },
    { mode: "standard", emphases: ["speed"] },
    { mode: "ambitious", emphases: ["depth", "depth"] },
    { mode: "ambitious", emphases: ["unknown"] },
    { mode: "ambitious", emphases: "depth" },
  ])
    assert.equal(parseWorkMode(value), undefined);
  const child = workModeGuidance(ambitious, "child")!;
  assert.match(child, /^Working style: Ambitious/);
  assert.match(child, /Stay strictly within your assigned role and tool ceiling/);
  assert.match(child, /Deeper proof:/);
  assert.doesNotMatch(child, /JEV/i);
  assert.doesNotMatch(child, /Faster delivery:|Broader approaches:/);
});

test("active request is captured once; a mid-run next selection survives settlement and is consumed once", async () => {
  const f = await fixture();
  try {
    setWorkMode(f.session, ambitious, "next-request");
    assert.deepEqual(beginWorkModeRequest(f.session), ambitious);
    assert.equal(workModeSnapshot(f.session).nextRequest, undefined);
    setWorkMode(f.session, { mode: "ambitious", emphases: ["range"] }, "next-request");
    assert.deepEqual(beginWorkModeRequest(f.session), ambitious, "same run retry keeps initial capture");
    const captured = capturedWorkMode(f.session)!;
    captured.emphases.push("speed");
    assert.deepEqual(capturedWorkMode(f.session), ambitious, "callers cannot mutate active selection");
    initializeWorkMode(f.pi, f.session, f.ctx, "reload", {});
    assert.deepEqual(capturedWorkMode(f.session), ambitious);
    finishWorkModeRequest(f.session);
    assert.deepEqual(beginWorkModeRequest(f.session), { mode: "ambitious", emphases: ["range"] });
    finishWorkModeRequest(f.session);
    assert.deepEqual(beginWorkModeRequest(f.session), standardWorkMode());
    assert.equal(f.records.filter((entry) => (entry.data as any).consumed).length, 2);
  } finally {
    await f.close();
  }
});

test("resume and tree use branch settings without resurrecting consumed overrides; /new resets Standard", async () => {
  const f = await fixture();
  try {
    setWorkMode(f.session, ambitious, "session");
    setWorkMode(f.session, standardWorkMode(), "next-request");
    const branchBeforeConsumption = [...f.records];
    beginWorkModeRequest(f.session);
    finishWorkModeRequest(f.session);
    f.setBranch(branchBeforeConsumption);
    initializeWorkMode(f.pi, f.session, f.ctx, "tree", {});
    assert.equal(workModeSnapshot(f.session).nextRequest, undefined);
    assert.deepEqual(workModeSnapshot(f.session).selection, ambitious);
    initializeWorkMode(f.pi, f.session, f.ctx, "resume", {});
    assert.deepEqual(beginWorkModeRequest(f.session), ambitious);
    f.setBranch(undefined);
    await f.newSession();
    assert.deepEqual(workModeSnapshot(f.session).selection, standardWorkMode());
    assert.equal(workModeSnapshot(f.session).active, undefined);
    assert.equal(f.records.length, 0);
  } finally {
    await f.close();
  }
});

test("selection is not applied when its save fails and unrecordable override does not become execution", async () => {
  const f = await fixture();
  try {
    f.failWrite(true);
    assert.throws(() => setWorkMode(f.session, ambitious, "session"), /not saved/);
    assert.deepEqual(workModeSnapshot(f.session).selection, standardWorkMode());
    f.failWrite(false);
    setWorkMode(f.session, ambitious, "next-request");
    f.failWrite(true);
    assert.deepEqual(beginWorkModeRequest(f.session), standardWorkMode());
    assert.match(workModeSnapshot(f.session).note!, /not used/);
    assert.doesNotMatch(workModeSnapshot(f.session).note!, /private storage failure/);
    assert.equal(capturedWorkMode(f.session), undefined);
  } finally {
    await f.close();
  }
});

test("children keep inherited guidance but cannot select settings; root ignores ambient mode", async () => {
  const f = await fixture();
  try {
    const env = { [ENV_WORK_MODE]: JSON.stringify(ambitious) };
    initializeWorkMode(f.pi, f.session, f.ctx, "startup", env);
    assert.deepEqual(workModeSnapshot(f.session).selection, standardWorkMode());
    f.session.depth = 1;
    initializeWorkMode(f.pi, f.session, f.ctx, "startup", env);
    assert.deepEqual(capturedWorkMode(f.session), ambitious);
    assert.throws(() => setWorkMode(f.session, standardWorkMode(), "session"), /owning parent/);
    assert.equal(
      f.hooks.get("before_agent_start")!({ systemPrompt: "child launch already supplied guidance" }),
      undefined,
    );
    initializeWorkMode(f.pi, f.session, f.ctx, "startup", { [ENV_WORK_MODE]: "invalid private value" });
    assert.deepEqual(workModeSnapshot(f.session).selection, standardWorkMode());
    assert.match(workModeSnapshot(f.session).note!, /unavailable/);
    assert.doesNotMatch(workModeSnapshot(f.session).note!, /private value/);
  } finally {
    await f.close();
  }
});

test("parent guidance is per run and explicit Standard restores the original unmodified hook result", async () => {
  const f = await fixture();
  try {
    setWorkMode(f.session, ambitious, "session");
    const event = {
      systemPrompt: "base",
      systemPromptOptions: { promptGuidelines: [] as string[], sections: {} as Record<string, string> },
    };
    assert.equal(f.hooks.get("before_agent_start")!(event), undefined);
    assert.match(event.systemPromptOptions.sections["pi-daddy-work-mode"], /^Working style: Ambitious/);
    setWorkMode(f.session, standardWorkMode(), "session");
    assert.deepEqual(capturedWorkMode(f.session), ambitious, "active children keep their assigned mode");
    f.hooks.get("agent_settled")!();
    assert.equal(f.hooks.get("before_agent_start")!({ systemPrompt: "base" }), undefined);
    assert.equal(capturedWorkMode(f.session), undefined);
    assert.equal(
      f.records.every((record) => record.customType === WORK_MODE_ENTRY),
      true,
    );
  } finally {
    await f.close();
  }
});

test("Standard cold review dispatches only to an available model distinct from the active model", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "standard-review-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd });
  await writeFile(join(cwd, "one.txt"), "first");
  await writeFile(join(cwd, "two.txt"), "second");
  const f = await fixture();
  t.after(f.close);
  const previous = { ...process.env };
  const keys = ["PI_DADDY_AUTO_REVIEW", "PI_ECO_MODEL_STRONG", "PI_CODING_AGENT_DIR"];
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  process.env.PI_DADDY_AUTO_REVIEW = "1";
  process.env.PI_CODING_AGENT_DIR = cwd;
  const calls: string[] = [];
  const ctx = {
    ...f.ctx,
    cwd,
    model: { provider: "fixture", id: "active" },
    modelRegistry: {
      find: (provider: string, id: string) => (id === "missing" ? undefined : { provider, id }),
      streamSimple: (model: { id: string }) => {
        calls.push(model.id);
        return { result: async () => ({ content: [{ type: "text", text: "VERDICT: PASS" }] }) };
      },
    },
  };
  for (const spec of ["fixture/missing", "session,fixture/strong", "fixture/active", "fixture/strong"]) {
    process.env.PI_ECO_MODEL_STRONG = spec;
    f.hooks.get("before_agent_start")!({ prompt: "Review this change", systemPromptOptions: {} }, ctx);
    await f.hooks.get("agent_before_settle")!({}, ctx);
  }
  assert.deepEqual(calls, ["strong"]);
});
