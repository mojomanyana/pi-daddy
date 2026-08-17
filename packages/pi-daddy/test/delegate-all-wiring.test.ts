/**
 * Wiring tests for `delegate_all` — the fan-out tool as the extension actually registers it.
 *
 * `src/` is pure and `test/fanout.test.ts` covers the budget arithmetic, but R-28 was a defect **in an
 * argument list** that 226 pure tests could not see. So this loads the real extension against a fake `pi`
 * and invokes the registered tool, which is the only way to test that the pieces are connected.
 *
 * **Nothing is spawned.** Every child here requests a capability the session does not hold, so each one is
 * refused before any process starts — which is also what makes the test fast and deterministic. The
 * governance, identity and reporting paths are exactly the ones under test.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { MAX_CHILDREN_PER_CALL } from "../src/fanout.ts";
import { ENV_APPROVED, ENV_DEPTH, ENV_FANOUT, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH, ENV_PARENT_ID } from "../src/propagation.ts";
import { ENV_HERDR } from "../src/executor.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const KEYS = [ENV_GRANT, ENV_DEPTH, ENV_MAX_DEPTH, ENV_GATED, ENV_APPROVED, ENV_LEDGER, ENV_FANOUT, ENV_PARENT_ID, ENV_HERDR];
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
  saved.clear();
});

interface ToolSpec {
  name: string;
  /** Captured so a test can read what the MODEL is told, which is where R-39 lived. */
  parameters?: unknown;
  execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>;
}

async function harness(env: Record<string, string>, existingDir?: string) {
  // `existingDir` lets a test stage `SKILL.md` definitions before the extension loads them.
  const dir = existingDir ?? (await tempDir("grants-fanout-"));
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const k of KEYS) delete process.env[k];
  // `PI_GRANTS_HERDR=0` by DEFAULT, and this line is load-bearing rather than tidy-up.
  //
  // ADR-0031 made an unset variable mean *probe*, and `resolveExecutor` runs inside `session_start` — which
  // this harness calls. Leaving it unset would run a real `herdr tab list` against whatever is on the
  // developer's machine, so this suite would select panes here and subprocesses in CI, from the same source.
  // A test whose outcome depends on which daemons happen to be running is not a test. `0` skips the probe
  // entirely; a test that wants the other paths overrides it and says why.
  Object.assign(process.env, { [ENV_HERDR]: "0", ...env });

  const tools = new Map<string, ToolSpec>();
  const hooks = new Map<string, (e: unknown, c: unknown) => unknown>();
  const ctx = { cwd: dir, ui: { notify: () => {}, select: async () => undefined }, signal: undefined };

  grantsExtension({
    on: (name: string, handler: (e: unknown, c: unknown) => unknown) => void hooks.set(name, handler),
    registerTool: (spec: ToolSpec) => void tools.set(spec.name, spec),
    registerCommand: () => {},
    getAllTools: () => ["read", "grep", "write", "delegate"].map((name) => ({ name })),
  } as never);

  await hooks.get("session_start")!({}, ctx);
  return { dir, tools, ctx };
}

/**
 * The `agent` parameter description as the MODEL receives it.
 *
 * Two shapes, deliberately handled in one place: `delegate` has `agent` at the top level, while
 * `delegate_all` nests it inside each `children` item. Getting this wrong is how a test passes for the
 * wrong tool — it happened while writing these, and the assertion caught it.
 */
function agentDescriptionOf(spec: ToolSpec): string {
  const schema = spec.parameters as {
    properties?: {
      agent?: { description?: string };
      children?: { items?: { properties?: { agent?: { description?: string } } } };
    };
  };
  return (
    schema?.properties?.agent?.description ??
    schema?.properties?.children?.items?.properties?.agent?.description ??
    ""
  );
}

/** Children that request a capability a read-only session cannot grant, so none of them spawns. */
const refusedChildren = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ task: `audit module ${i + 1}`, tools: ["write"] }));

test("delegate_all is registered when the session may delegate", async () => {
  const { tools } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
  assert.ok(tools.has("delegate_all"), "fan-out must be reachable");
  assert.ok(tools.has("delegate"), "and the single form stays");
});

test("delegate_all is NOT registered when tool:delegate is withheld", async () => {
  // The S-5 property, extended to the new tool: "withhold tool:delegate and the child is a leaf" must stay
  // true, or fan-out becomes a way around it.
  const { tools } = await harness({ [ENV_GRANT]: "tool:read" });
  assert.ok(!tools.has("delegate_all"));
  assert.ok(!tools.has("delegate"));
});

test("more children than the per-call limit is refused before anything runs", async () => {
  const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_FANOUT]: "1000" });
  await assert.rejects(
    () => tools.get("delegate_all")!.execute("t", { children: refusedChildren(MAX_CHILDREN_PER_CALL + 1) }, undefined, undefined, ctx),
    /per-call limit/,
  );
});

test("a fan-out wider than the remaining budget is refused, naming the remedy", async () => {
  const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_FANOUT]: "2" });
  await assert.rejects(
    () => tools.get("delegate_all")!.execute("t", { children: refusedChildren(4) }, undefined, undefined, ctx),
    /budget exhausted[\s\S]*PI_GRANTS_FANOUT/,
  );
});

test("every child is reported, and an all-failed fan-out throws rather than returning text", async () => {
  // R-03: a missing result must never be indistinguishable from an empty one. A fan-out that returned a
  // cheerful report when nothing ran is how an orchestrator summarises four reviews that never happened.
  const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
  await assert.rejects(
    () => tools.get("delegate_all")!.execute("t", { children: refusedChildren(3) }, undefined, undefined, ctx),
    (error: Error) => {
      assert.match(error.message, /every child was refused/);
      for (const n of [1, 2, 3]) assert.match(error.message, new RegExp(`child ${n} — FAILED`), `child ${n} must appear`);
      assert.match(error.message, /tool:write/, "and the reason must name the capability");
      return true;
    },
  );
});

test("F8: concurrent siblings get distinct, hierarchical ledger ids", async () => {
  // The defect this fixes: every child was recorded as `delegate@d1`, so four concurrent siblings produced
  // four lines identical except `ts` — and two in the same millisecond were indistinguishable. Refusals are
  // recorded too (G6), which is why this works without spawning anything.
  const dir = await tempDir("grants-ledger-");
  const ledger = join(dir, "ledger.jsonl");
  const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_LEDGER]: ledger });

  await tools.get("delegate_all")!.execute("t", { children: refusedChildren(3) }, undefined, undefined, ctx).catch(() => undefined);

  const lines = (await readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 3, "each child is audited, including refusals");
  const ids = lines.map((l) => l.childId);
  assert.equal(new Set(ids).size, 3, `siblings must be distinguishable, got ${JSON.stringify(ids)}`);
  assert.deepEqual([...ids].sort(), ["d0.1", "d0.2", "d0.3"]);
  for (const line of lines) assert.equal(line.parentId, "d0", "and every one names its real parent");
});

test("ADR-0018: the digest reaches the LEDGER FILE, not just the plan", async () => {
  // The class of defect this catches is the one that keeps recurring here: a correct value on the plan that
  // the call site never passes to `buildRecord` (R-28, B-I3). Only a real ledger line can show it.
  //
  // Nothing spawns: the definition declares a sub-tool pattern, which `--tools` cannot express, so the plan
  // is refused — but refused AFTER the file is read, which is exactly the case that must still be
  // identified. Deterministic, and no child process.
  const dir = await tempDir("grants-digest-");
  const TASK_SENTINEL = "ZZ-task-text-that-must-never-be-recorded-ZZ";
  const body = "# Patterned\n\nDo the patterned thing.";
  await mkdir(join(dir, ".pi", "skills", "patterned"), { recursive: true });
  await writeFile(
    join(dir, ".pi", "skills", "patterned", "SKILL.md"),
    `---\nname: patterned\ndescription: Declares a sub-tool pattern.\nallowed-tools: Read, Bash(git:*)\n---\n${body}`,
  );

  const ledger = join(dir, "ledger.jsonl");
  const { tools, ctx } = await harness(
    { [ENV_GRANT]: "agent:patterned,tool:read,tool:bash,tool:delegate", [ENV_LEDGER]: ledger },
    dir,
  );

  await tools
    .get("delegate")!
    .execute("t", { task: TASK_SENTINEL, agent: "patterned" }, undefined, undefined, ctx)
    .catch(() => undefined);

  const [line] = (await readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(line.blocked, true);
  assert.equal(line.definitionDigest?.name, "patterned");
  assert.equal(
    line.definitionDigest?.sha256,
    createHash("sha256").update(body, "utf8").digest("hex"),
    "the recorded digest must be of the body the child would have received",
  );
  assert.ok(!JSON.stringify(line).includes(TASK_SENTINEL), "the TASK is never written to the ledger (ADR-0018)");
});

test("a child's ledger id descends from an inherited parent id, not from depth", async () => {
  // Without this every level restarts at `d0` and the ledger cannot be joined into a tree across process
  // boundaries — the half of F8 that only shows up below the root.
  const dir = await tempDir("grants-ledger-");
  const ledger = join(dir, "ledger.jsonl");
  const { tools, ctx } = await harness({
    [ENV_GRANT]: "tool:read,tool:delegate",
    [ENV_LEDGER]: ledger,
    [ENV_DEPTH]: "1",
    [ENV_PARENT_ID]: "d0.2",
  });

  await tools.get("delegate_all")!.execute("t", { children: refusedChildren(2) }, undefined, undefined, ctx).catch(() => undefined);

  const lines = (await readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.childId).sort(), ["d0.2.1", "d0.2.2"]);
});

test("R-39: the model is told which definitions it may spawn", async () => {
  // The defect: `spawnable` was computed when `registerDelegationTools` ran, which is synchronous in the
  // extension factory — before the `session_start` hook that loads `session.definitions`. So the map was
  // always empty and every model in every governed session read `Available: none.`, then reasonably used
  // `delegate({tools})` instead: the path with no operator-authored instructions, no `agent:` prerequisite,
  // no body digest on the record and no `always` approval available. ADR-0017 and ADR-0019 were both dead
  // machinery for the reason ADR-0019 was written to fix.
  //
  // Reintroduce it by moving the `refreshSpawnable()` call out of `session_start` and this fails.
  const dir = await tempDir("grants-fanout-");
  await mkdir(join(dir, ".pi", "skills", "reviewer"), { recursive: true });
  await writeFile(
    join(dir, ".pi", "skills", "reviewer", "SKILL.md"),
    "---\nname: reviewer\ndescription: Reviews a diff.\nallowed-tools: Read\n---\nReview the diff.",
    "utf8",
  );

  const { tools } = await harness({ [ENV_GRANT]: "agent:reviewer,tool:read,tool:delegate" }, dir);

  for (const name of ["delegate", "delegate_all"]) {
    const described = agentDescriptionOf(tools.get(name)!);
    assert.match(described, /reviewer/, `${name} must name the definition this session may spawn`);
    assert.doesNotMatch(described, /Available: none/, `${name} must not claim there are none`);
  }
});

test("R-39: a definition the session may NOT spawn is not advertised", async () => {
  // The other half, and the reason the list is filtered rather than just "every definition on disk":
  // telling the model it can spawn something every attempt at which is refused is R-28's shape in a
  // description. `reviewer` exists on disk; the grant does not carry `agent:reviewer`.
  const dir = await tempDir("grants-fanout-");
  await mkdir(join(dir, ".pi", "skills", "reviewer"), { recursive: true });
  await writeFile(
    join(dir, ".pi", "skills", "reviewer", "SKILL.md"),
    "---\nname: reviewer\ndescription: Reviews a diff.\nallowed-tools: Read\n---\nReview the diff.",
    "utf8",
  );

  const { tools } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" }, dir);

  const described = agentDescriptionOf(tools.get("delegate")!);
  assert.match(described, /Available: none/, "an unauthorised definition must not be advertised (ADR-0017)");
});

test("ADR-0031: a session that DEMANDED herdr and cannot reach it refuses every delegation", async () => {
  // **The refusal must land in the PLANNER's path, not at the executor.** A child that reaches `tab create`
  // has already had its ledger line written, so a refusal any later would record a spawn that never happened
  // — and one any earlier could not know the probe's answer. The production change that breaks this: moving
  // the `session.executor.refusal` check into `runHerdrPane`, or making `1` fall back to a subprocess.
  //
  // The probe is made to fail for real rather than mocked: `PATH` is emptied for the duration, so
  // `execFile("herdr", …)` cannot resolve the binary and `defaultExec` is exercised end to end. That is why
  // this test is worth having on top of `test/executor.test.ts`, which covers the table in isolation.
  const realPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const { tools } = await harness({
      [ENV_GRANT]: "tool:read,tool:delegate",
      [ENV_HERDR]: "1",
    });

    await assert.rejects(
      () => tools.get("delegate")!.execute("c1", { task: "read the file", tools: ["read"] }, undefined, undefined, {
        cwd: process.cwd(),
        ui: { notify: () => {}, select: async () => undefined },
        hasUI: false,
      }),
      (error: Error) => {
        assert.match(error.message, /PI_GRANTS_HERDR/, "the refusal must name the variable that caused it");
        assert.match(error.message, /refused/);
        return true;
      },
    );
  } finally {
    process.env.PATH = realPath;
  }
});

test("ADR-0031: PI_GRANTS_HERDR=0 spawns nothing through herdr and does not refuse", async () => {
  // The other side of the same switch: an operator who ruled herdr out must be unaffected by whether herdr is
  // running. This is also the configuration every other test in this file runs under, asserted once so the
  // harness default above is not merely assumed.
  const { tools } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_HERDR]: "0" });
  // A capability the session does not hold, so it is refused for THAT reason and never spawned — the same
  // trick the rest of this suite uses to stay fast. What matters is which reason comes back.
  await assert.rejects(
    () => tools.get("delegate")!.execute("c1", { task: "write a file", tools: ["write"] }, undefined, undefined, {
      cwd: process.cwd(),
      ui: { notify: () => {}, select: async () => undefined },
      hasUI: false,
    }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /PI_GRANTS_HERDR/, "a PI_GRANTS_HERDR=0 session must never blame herdr");
      return true;
    },
  );
});

test("ADR-0032: delegate_all renders ONE status block covering every child", async () => {
  // `onUpdate` replaces the tool's rendered result, so one painter per child would have each overwriting the
  // others and the operator would watch a single child flicker. The production change that breaks this:
  // building a reporter per child instead of per call.
  const frames: string[] = [];
  const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
  const onUpdate = (partial: { content: Array<{ text: string }> }) => void frames.push(partial.content[0].text);

  await tools
    .get("delegate_all")!
    .execute("t", { children: refusedChildren(3) }, undefined, onUpdate as never, ctx)
    .catch(() => undefined);

  assert.ok(frames.length > 0, "a fan-out must paint at least the settled frame");
  const last = frames[frames.length - 1];
  assert.match(last, /3 children/, "one block, and it counts all of them");
  assert.equal(last.match(/failed/g)?.length, 3, "every child's end state must show, not just the first");
});

test("ADR-0032: delegate paints too — it is the one-child case of the same block", async () => {
  // `_onUpdate` was discarded here, so a single delegation showed the bare word `delegate` for up to ten
  // minutes. The production change that breaks this: renaming it back to `_onUpdate`.
  const frames: string[] = [];
  const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
  const onUpdate = (partial: { content: Array<{ text: string }> }) => void frames.push(partial.content[0].text);

  await tools
    .get("delegate")!
    .execute("t", { task: "audit", tools: ["write"] }, undefined, onUpdate as never, ctx)
    .catch(() => undefined);

  assert.ok(frames.length > 0);
  assert.match(frames[frames.length - 1], /1 child/);
});

test("ADR-0032: the block names the executor it is running under", async () => {
  // So a transcript read later says where those children ran, matching the ledger and the banner.
  const frames: string[] = [];
  const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_HERDR]: "0" });
  const onUpdate = (partial: { content: Array<{ text: string }> }) => void frames.push(partial.content[0].text);

  await tools
    .get("delegate")!
    .execute("t", { task: "audit", tools: ["write"] }, undefined, onUpdate as never, ctx)
    .catch(() => undefined);

  assert.match(frames[frames.length - 1], /captured subprocesses/);
});
