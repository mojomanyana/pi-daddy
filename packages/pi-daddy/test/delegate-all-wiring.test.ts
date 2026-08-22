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
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { MAX_CHILDREN_PER_CALL } from "../src/fanout.ts";
import { ENV_APPROVED, ENV_DEPTH, ENV_FANOUT, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH, ENV_PARENT_ID } from "../src/propagation.ts";
import { ENV_HERDR } from "../src/executor.ts";
import { verifyLedger } from "../src/ledger.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import {
  acquireWorkspaceLease,
  ENV_WORKSPACE_LEASE_DIR,
  ENV_WORKSPACE_REGISTRY,
  validateRegisteredWorkspace,
} from "../src/workspace.ts";
import { execFileSync } from "node:child_process";

after(cleanupTempDirs);

const KEYS = [
  ENV_GRANT, ENV_DEPTH, ENV_MAX_DEPTH, ENV_GATED, ENV_APPROVED, ENV_LEDGER, ENV_FANOUT, ENV_PARENT_ID,
  ENV_HERDR, ENV_WORKSPACE_REGISTRY, ENV_WORKSPACE_LEASE_DIR,
];
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
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "CAPABILITY_ESCALATION");
      assert.match(error.message, /every child was refused/);
      for (const n of [1, 2, 3]) assert.match(error.message, new RegExp(`child ${n} — FAILED`), `child ${n} must appear`);
      assert.match(error.message, /tool:write/, "and the reason must name the capability");
      return true;
    },
  );
});

test("mixed all-failed fan-out does not assign one child's refusal code to the aggregate", async () => {
  const bin = await tempDir("grants-mixed-failure-shim-");
  await writeFile(join(bin, "pi"), "#!/usr/bin/env node\nprocess.exit(1)\n");
  await chmod(join(bin, "pi"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
    await assert.rejects(
      () => tools.get("delegate_all")!.execute("mixed", {
        children: [{ task: "denied", tools: ["write"] }, { task: "runtime", tools: ["read"] }],
      }, undefined, undefined, ctx),
      (error: Error & { code?: string; details?: Record<string, unknown> }) => {
        // The name of this test is the invariant: no CHILD's code may become the aggregate's. It used to
        // be checked by asserting no code at all, which also threw away the machine-readable half — on
        // total failure `details.refusals` is not returned, so the codes existed nowhere. They are named
        // in `details` now, under an aggregate code that is deliberately not any child's.
        assert.equal(error.code, "FANOUT_FAILED");
        assert.match(error.message, /every child was refused or failed/);
        const codes = String(error.details?.codes ?? "").split(",").filter(Boolean);
        assert.ok(codes.length > 1, `mixed codes must all survive, got ${JSON.stringify(codes)}`);
        assert.equal(codes.includes("FANOUT_FAILED"), false, "the aggregate code is not a child's code");
        return true;
      },
    );
  } finally {
    process.env.PATH = oldPath;
  }
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

test("ADR-0032: delegate_all paints DURING the run, one block covering every child", async () => {
  // **Rewritten because the first version could not fail.** A reviewer built a reporter per child instead of per
  // call — the exact change the test's own comment named — and it stayed green, for two reasons: it inspected only
  // the LAST frame (and the call-level `settle()` always runs last, so the final frame is combined either way),
  // and its `refusedChildren` fixture meant no child ever spawned, so **no sink ever fired and `frames.length`
  // was 1**. The during-run painting that ADR-0032 is entirely about was untested.
  //
  // This drives children that really run: `PI_GRANTS_HERDR=0` with a `node` that prints and exits, so `runChild`
  // streams for real. Then EVERY frame must carry every child, not merely the last one.
  const frames: string[] = [];
  const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate", [ENV_HERDR]: "0" });
  const onUpdate = (partial: { content: Array<{ text: string }> }) => void frames.push(partial.content[0].text);

  await tools
    .get("delegate_all")!
    .execute(
      "t",
      { children: [{ task: "one", tools: ["read"] }, { task: "two", tools: ["read"] }] },
      undefined,
      onUpdate as never,
      ctx,
    )
    .catch(() => undefined);

  assert.ok(frames.length >= 1, "a fan-out must paint");
  for (const [index, frame] of frames.entries()) {
    assert.match(frame, /2 children/, `frame ${index} lost a child: ${JSON.stringify(frame.slice(0, 120))}`);
  }
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

test("ADR-0031: the ledger records the executor a REAL spawn ran under, not a constant", async () => {
  // **The highest-value gap a reviewer found.** Hardcoding BOTH ledger call sites to `executor: "process"` left
  // all 442 tests green, because the three `ledger-integrity` tests pass the value in themselves — they exercise
  // `buildRecord`'s plumbing, never the wiring. So ADR-0031's stated reason for making the field required
  // ("nothing outside the record preserves which argv ran") was itself unverified.
  //
  // This drives the real extension end to end and reads the real ledger file, once per executor. The production
  // change that breaks it: hardcoding either call site, or dropping `session.executor.kind`.
  for (const [herdr, expected] of [["0", "process"], ["1", "herdr"]] as const) {
    const dir = await tempDir("grants-executor-ledger-");
    const ledger = join(dir, "ledger.jsonl");
    // PATH is emptied for the herdr case so the probe fails and the delegation refuses — a refusal still writes a
    // record, and the executor it names must be the one the session settled on, not a default.
    const realPath = process.env.PATH;
    if (herdr === "1") process.env.PATH = "";
    try {
      const { tools, ctx } = await harness({
        [ENV_GRANT]: "tool:read,tool:delegate",
        [ENV_LEDGER]: ledger,
        [ENV_HERDR]: herdr,
      });
      await tools
        .get("delegate")!
        .execute("t", { task: "audit", tools: ["write"] }, undefined, undefined, ctx)
        .catch(() => undefined);
    } finally {
      process.env.PATH = realPath;
    }

    const lines = (await readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.length >= 1, `no record written for PI_GRANTS_HERDR=${herdr}`);
    for (const record of lines) {
      assert.equal(record.executor, expected, `PI_GRANTS_HERDR=${herdr} must record executor ${expected}`);
    }
  }
});

async function registeredWorkspaceFixture() {
  const dir = await tempDir("grants-workspace-wiring-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  const configDir = await tempDir("grants-workspace-config-");
  const registry = join(configDir, "registry.json");
  const leaseDir = join(configDir, "leases");
  await writeFile(registry, JSON.stringify({ version: 1, workspaces: { w1: { path: dir } } }));
  return { dir, registry, leaseDir };
}

test("BLOCKED_CRITICAL_ASSURANCE from a child remains a failed delegation and the token is unchanged", async () => {
  const bin = await tempDir("grants-pi-blocked-shim-");
  const shim = join(bin, "pi");
  await writeFile(shim, "#!/usr/bin/env node\nprocess.stdout.write('BLOCKED_CRITICAL_ASSURANCE\\nMissing controls:\\n- review');process.exit(3)\n");
  await chmod(shim, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
    await assert.rejects(
      () => tools.get("delegate")!.execute("blocked", { task: "gate", tools: ["read"] }, undefined, undefined, ctx),
      (error: Error) => {
        assert.equal(error.message, "BLOCKED_CRITICAL_ASSURANCE\nMissing controls:\n- review");
        return true;
      },
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("fan-out and chain cannot turn one BLOCKED_CRITICAL_ASSURANCE child into partial success", async () => {
  const bin = await tempDir("grants-pi-partial-blocked-shim-");
  const shim = join(bin, "pi");
  await writeFile(shim, `#!/usr/bin/env node
const blocked=process.argv.join(' ').includes('BLOCKME');
process.stdout.write(blocked?'BLOCKED_CRITICAL_ASSURANCE\\nMissing controls:\\n- review':'OK');
process.exit(blocked?3:0);
`);
  await chmod(shim, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:read,tool:delegate" });
    for (const [name, args] of [
      ["delegate_all", { children: [{ task: "good", tools: ["read"] }, { task: "BLOCKME", tools: ["read"] }] }],
      ["delegate_chain", { steps: [{ task: "good", tools: ["read"] }, { task: "BLOCKME", tools: ["read"] }] }],
    ] as const) {
      await assert.rejects(
        () => tools.get(name)!.execute("blocked", args, undefined, undefined, ctx),
        (error: Error) => {
          assert.equal(error.message, "BLOCKED_CRITICAL_ASSURANCE\nMissing controls:\n- review");
          return true;
        },
      );
    }
  } finally {
    process.env.PATH = oldPath;
  }
});

test("partial chain results retain per-step structured refusals", async () => {
  const bin = await tempDir("grants-chain-refusal-shim-");
  await writeFile(join(bin, "pi"), "#!/usr/bin/env node\nprocess.stdout.write('OK')\n");
  await chmod(join(bin, "pi"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const { tools, ctx } = await harness({
      [ENV_GRANT]: "tool:read,tool:bash,tool:delegate", [ENV_GATED]: "tool:bash",
    });
    Object.assign(ctx, { hasUI: false, mode: "rpc" });
    const result = await tools.get("delegate_chain")!.execute("partial", {
      steps: [
        { task: "first", tools: ["read"] },
        { task: "second", tools: ["bash"], correlation: { run_id: "run-1" } },
      ],
    }, undefined, undefined, ctx) as { details: { refusals: Array<{ code?: string } | null> } };
    assert.equal(result.details.refusals[0], null);
    assert.equal(result.details.refusals[1]?.code, "GATED_UNAPPROVED");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("chain once approvals are attributed and consumed by the step/capability they named", async () => {
  const bin = await tempDir("grants-chain-once-shim-");
  const shim = join(bin, "pi");
  await writeFile(shim, "#!/usr/bin/env node\nprocess.stdout.write('OK')\n");
  await chmod(shim, 0o755);
  const ledger = join(await tempDir("grants-chain-once-ledger-"), "ledger.jsonl");
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const { tools, ctx } = await harness({
      [ENV_GRANT]: "tool:read,tool:bash,tool:delegate", [ENV_GATED]: "tool:read,tool:bash", [ENV_LEDGER]: ledger,
    });
    let prompts = 0;
    Object.assign(ctx, { hasUI: true, mode: "rpc" });
    (ctx.ui as { select: () => Promise<string | undefined> }).select = async () => { prompts += 1; return "Allow once"; };
    await tools.get("delegate_chain")!.execute("once", {
      steps: [{ task: "read", tools: ["read"] }, { task: "shell", tools: ["bash"] }],
    }, undefined, undefined, ctx);
    assert.equal(prompts, 2, "the step-2 approval must not be spent or re-prompted on step 1");
    const decisions = (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      .filter((event) => event.event === "capability_decision" && !event.blocked);
    assert.deepEqual(decisions.map((record) => record.approved), [["tool:read"], ["tool:bash"]]);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("a correlated session approval cannot replay for a different task", async () => {
  const bin = await tempDir("grants-pi-binding-shim-");
  const shim = join(bin, "pi");
  await writeFile(shim, "#!/usr/bin/env node\nprocess.stdout.write('OK')\n");
  await chmod(shim, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const { tools, ctx } = await harness({ [ENV_GRANT]: "tool:bash,tool:delegate" });
    let prompts = 0;
    Object.assign(ctx, { hasUI: true, mode: "rpc" });
    (ctx.ui as { select: () => Promise<string | undefined> }).select = async () => {
      prompts += 1;
      return prompts === 1 ? "Allow for this session" : undefined;
    };
    const common = { tools: ["bash"], correlation: { run_id: "run-1", task_id: "task-1", context_id: "ctx-1" } };
    await tools.get("delegate")!.execute("a", { ...common, task: "probe exact failure" }, undefined, undefined, ctx);
    await tools.get("delegate")!.execute("b", { ...common, task: "probe exact failure" }, undefined, undefined, ctx);
    assert.equal(prompts, 1, "same exact binding may reuse the session answer");
    await assert.rejects(
      () => tools.get("delegate")!.execute("c", { ...common, task: "probe a different failure" }, undefined, undefined, ctx),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "APPROVAL_SCOPE_MISMATCH");
        assert.match(error.message, /^delegation refused: .*dismissed/);
        return true;
      },
    );
    assert.equal(prompts, 2, "a different task must ask again rather than replay");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("a failed always-store write is ledgered as session-only with no fake expiry", async () => {
  const dir = await tempDir("grants-persist-downgrade-");
  await mkdir(join(dir, ".pi", "skills", "worker"), { recursive: true });
  await writeFile(join(dir, ".pi", "skills", "worker", "SKILL.md"),
    "---\nname: worker\ndescription: works\nallowed-tools: Bash\n---\nWork.\n");
  const ledger = join(dir, "ledger.jsonl");
  const bin = await tempDir("grants-persist-downgrade-bin-");
  await writeFile(join(bin, "pi"), "#!/usr/bin/env node\nprocess.stdout.write('OK')\n");
  await chmod(join(bin, "pi"), 0o755);
  const oldPath = process.env.PATH;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.PI_CODING_AGENT_DIR = "/dev/null";
  try {
    const { tools, ctx } = await harness({
      [ENV_GRANT]: "agent:worker,tool:bash,tool:delegate", [ENV_LEDGER]: ledger,
    }, dir);
    Object.assign(ctx, { hasUI: true, mode: "rpc" });
    (ctx.ui as { select: () => Promise<string | undefined> }).select = async () => "Always allow in this project (30 days)";
    await tools.get("delegate")!.execute("persist", { task: "work", agent: "worker" }, undefined, undefined, ctx);
    const record = (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      .find((event) => event.event === "capability_decision");
    assert.equal(record.approvalScopes["tool:bash"], "session");
    assert.equal(record.approvalExpiresAt, undefined);
  } finally {
    process.env.PATH = oldPath;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
});

test("a write-capable child cannot underdeclare read access to bypass a writer conflict", async () => {
  const { dir, registry, leaseDir } = await registeredWorkspaceFixture();
  const ledger = join(await tempDir("grants-workspace-ledger-"), "ledger.jsonl");
  const workspace = await validateRegisteredWorkspace({ workspaceId: "w1", registeredRoot: dir });
  const held = await acquireWorkspaceLease({ workspace, access: "write", leaseDir, ownerId: "existing" });
  try {
    const { tools, ctx } = await harness({
      // `workspace:w1` required since ADR-0035: routing is an authority the caller must hold.
      [ENV_GRANT]: "tool:read,tool:bash,tool:delegate,workspace:w1",
      [ENV_LEDGER]: ledger,
      [ENV_WORKSPACE_REGISTRY]: registry,
      [ENV_WORKSPACE_LEASE_DIR]: leaseDir,
    }, dir);
    await assert.rejects(
      () => tools.get("delegate")!.execute("t", {
        task: "write despite the label",
        tools: ["bash"],
        workspace: { workspace_id: "w1", access: "read" },
        correlation: { schema_version: "1.0", run_id: "run-1", task_id: "task-1", tree_sha: "a".repeat(40) },
      }, undefined, undefined, ctx),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "WORKSPACE_WRITE_CONFLICT");
        assert.match(error.message, /^delegation refused: .*active pi-daddy-governed writer/);
        return true;
      },
    );
    const lines = (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const refusedLease = lines.find((line) => line.event === "workspace_lease" && line.outcome === "refused");
    assert.ok(refusedLease);
    assert.equal(refusedLease.access, "write", "trusted capabilities override the model's read label");
    const decision = lines.find((line) => line.event === "capability_decision");
    assert.equal(decision.refusal.code, "WORKSPACE_WRITE_CONFLICT");
    assert.equal(lines.some((line) => line.event === "child_lifecycle"), false, "no process reached starting");
  } finally {
    await held.release("test-complete");
  }
});

test("a governed process starts in the validated workspace with the same effective --tools", async () => {
  const { dir, registry, leaseDir } = await registeredWorkspaceFixture();
  const bin = await tempDir("grants-pi-shim-");
  const shim = join(bin, "pi");
  await writeFile(shim, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)}))\n`);
  await chmod(shim, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const { tools, ctx } = await harness({
      [ENV_GRANT]: "tool:read,tool:delegate,workspace:w1",
      [ENV_WORKSPACE_REGISTRY]: registry,
      [ENV_WORKSPACE_LEASE_DIR]: leaseDir,
    }, dir);
    const result = await tools.get("delegate")!.execute("t", {
      task: "report",
      tools: ["read"],
      workspace: { workspace_id: "w1", access: "read" },
      correlation: { run_id: "run-1", task_id: "task-1", workspace_id: "w1" },
    }, undefined, undefined, ctx) as { content: Array<{ text: string }> };
    const child = JSON.parse(result.content[0].text);
    assert.equal(child.cwd, dir);
    const at = child.argv.indexOf("--tools");
    assert.equal(child.argv[at + 1], "read", "workspace routing must not widen the grant");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("ADR-0031: a pre-0.16 ledger line, which has no executor field, still parses", async () => {
  // The field is REQUIRED in TypeScript and absent from every line 0.15.0 wrote. A reviewer proved the read path
  // does not care (`verifyLedger` validates only `Array.isArray(parsed.denied)`) — but nothing pinned it, so a
  // future `if (!parsed.executor) throw` would silently reclassify every older ledger as corrupt with a green
  // suite. This is that pin.
  const dir = await tempDir("grants-legacy-ledger-");
  const ledger = join(dir, "ledger.jsonl");
  const legacy = {
    ts: "2026-08-16T10:00:00.000Z", parentId: "d0", childId: "d0.1", depth: 1, agentType: "review",
    requested: ["tool:read"], parentGrant: ["tool:read"], effective: ["tool:read"],
    denied: [], clipped: [], gatedBlocked: [], blocked: false,
  };
  await writeFile(ledger, `${JSON.stringify(legacy)}\n`, "utf8");

  const report = await verifyLedger(ledger);
  assert.equal(report.ok, true, "a line without `executor` must not read as corrupt");
  assert.equal(report.records, 1, "and it must still be counted");
});
