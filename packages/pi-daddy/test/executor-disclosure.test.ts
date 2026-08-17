/**
 * "Where do this session's children run?" — answered out loud, at session start and in `/grants`.
 *
 * ADR-0031 lets an unset `PI_GRANTS_HERDR` choose the executor by probing. That is only defensible because the
 * choice is **announced**: the ADR's own rejected objection is that a run must not "silently relocate". These
 * tests are that guarantee, so **the production change that breaks them is deleting either disclosure**.
 *
 * The `mayDelegate` case is here because it was a real defect, caught in review before it shipped: the first
 * version gated the banner on `session.governed`. An ungoverned session still registers `delegate` and still
 * spawns, so that version would have moved an ungoverned session's children into herdr panes in silence —
 * ADR-0031's objection reappearing inside the fix for it.
 *
 * Every case pins `PI_GRANTS_HERDR` explicitly. Leaving it unset would shell out to whatever herdr is running
 * on the machine under test, which is how a suite comes to pass here and fail in CI.
 */

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { ENV_HERDR } from "../src/executor.ts";
import { ENV_APPROVED, ENV_DEPTH, ENV_FANOUT, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH, ENV_PARENT_ID } from "../src/propagation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const KEYS = [ENV_GRANT, ENV_DEPTH, ENV_MAX_DEPTH, ENV_GATED, ENV_APPROVED, ENV_LEDGER, ENV_FANOUT, ENV_PARENT_ID, ENV_HERDR];
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
  saved.clear();
});

interface CommandSpec {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

async function harness(env: Record<string, string>) {
  const dir = await tempDir("grants-disclosure-");
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);

  const notices: string[] = [];
  const commands = new Map<string, CommandSpec>();
  const hooks = new Map<string, (e: unknown, c: unknown) => unknown>();
  const ctx = {
    cwd: dir,
    ui: { notify: (message: string) => void notices.push(message), select: async () => undefined },
    signal: undefined,
    hasUI: false,
  };

  grantsExtension({
    on: (name: string, handler: (e: unknown, c: unknown) => unknown) => void hooks.set(name, handler),
    registerTool: () => {},
    registerCommand: (name: string, spec: CommandSpec) => void commands.set(name, spec),
    getAllTools: () => ["read", "grep", "delegate"].map((name) => ({ name })),
  } as never);

  await hooks.get("session_start")!({}, ctx);
  return { notices, commands, ctx, dir };
}

const executorLine = (notices: string[]) => notices.find((n) => n.includes("executor")) ?? "";

test("a governed session that can delegate names its executor at session start", async () => {
  const { notices } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_HERDR]: "0" });
  assert.match(executorLine(notices), /captured subprocess/);
  assert.match(executorLine(notices), /PI_GRANTS_HERDR=0/);
});

test("an UNGOVERNED session that can still spawn names its executor too", async () => {
  // The defect this prevents. With no PI_GRANTS_GRANT the session holds the wildcard and `mayDelegate` is
  // true, so `delegate` is registered and children are spawned — under whichever executor was chosen. Gating
  // the line on `governed` would have relocated those children into panes without a word.
  const { notices } = await harness({ [ENV_HERDR]: "0" });
  assert.match(executorLine(notices), /captured subprocess/, "an ungoverned session still runs children somewhere");
  assert.ok(
    !notices.some((n) => n.includes("holding [")),
    "sanity: this really is the ungoverned path, so the grant banner is absent",
  );
});

test("a LEAF session names no executor, because it has nothing to run anywhere", async () => {
  // Withholding tool:delegate means no delegate tool at all (S-5), so there is no executor worth naming. This
  // is why the guard is `mayDelegate` rather than being dropped entirely.
  const { notices } = await harness({ [ENV_GRANT]: "tool:read", [ENV_HERDR]: "0" });
  assert.equal(executorLine(notices), "", "a leaf must not be told where its non-existent children would run");
});

test("a demanded-but-unreachable herdr is disclosed as a refusal, not as a working executor", async () => {
  // PATH is emptied so the real probe genuinely fails, exercising defaultExec rather than a mock.
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const { notices } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_HERDR]: "1" });
    assert.match(executorLine(notices), /DEMANDED but unreachable/);
    assert.match(executorLine(notices), /every delegation will refuse/);
  } finally {
    process.env.PATH = realPath;
  }
});

test("/grants prints the executor beside the grant", async () => {
  // The gap that produced ADR-0031: this screen named holding, depth, ledger, approvals and catalog, and
  // never said where children run — so "my children are invisible subprocesses" was undiscoverable.
  const { commands, ctx, notices } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_HERDR]: "0" });
  notices.length = 0;

  await commands.get("grants")!.handler("", ctx);

  const screen = notices.join("\n");
  assert.match(screen, /executor {3}captured subprocess/, "the status screen must carry an executor row");
  assert.match(screen, /holding {4}/, "and it must still carry the grant");
});

test("/grants and the session banner never disagree about the executor", async () => {
  // Both read the same `ExecutorChoice.disclosure` rather than composing their own sentence. Two spellings of
  // one fact is R-28, which is the defect that made a diagnostic contradict the enforcer.
  const { commands, ctx, notices } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_HERDR]: "0" });
  const banner = executorLine(notices);
  notices.length = 0;

  await commands.get("grants")!.handler("", ctx);
  const row = notices.join("\n").split("\n").find((l) => l.includes("executor")) ?? "";

  const shared = banner.replace(/^grants: executor — /, "").trim();
  assert.ok(shared.length > 0);
  assert.ok(row.includes(shared), `\`/grants\` row ${JSON.stringify(row)} must carry the banner's own wording`);
});
