/**
 * Child model usage reaches the delegating Pi session once (owner decision 2026-11-17).
 *
 * `delegate`, `delegate_all` and `delegate_chain` report their children's observed usage in Pi's tool-result
 * `usage` field, which Pi adds to that session's totals. The reader keeps a child's own calls (the ledger's figure)
 * apart from what its own delegation results reported, so a two-level tree reaches the root once. Children run as
 * inert `pi` scripts writing a real session file (`pi-fixture.ts`); no model and no network.
 *
 * Breaks if: a result stops reporting `usage` or reports it for a reused operation; the reader counts a child's
 * delegation results as its own calls (the ledger and the root would count a grandchild twice) or drops them (the
 * root would miss it); an unmeasured child is counted as measured or given invented usage; a fan-out child that
 * threw after running loses its usage; or the dashboard and report stop saying the usage is already included.
 */
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import grantsExtension from "../extensions/grants.ts";
import { childFailureOutcome } from "../extensions/fanout-outcome.ts";
import { executePlannedChild } from "../extensions/execute-child.ts";
import { ensureDashboardSessionServer } from "../extensions/dashboard-session-server.ts";
import { closeSessionAutoMode, initializeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import type { GrantsSession } from "../extensions/session.ts";
import { newEpisodeId } from "../src/kernel/episode-id.ts";
import { dashboardSessionRequest } from "../src/products/dashboard-session-client.ts";
import { activitySessionFor } from "../src/executors/activity-session.ts";
import {
  childUsageInSession,
  delegationUsage,
  observedChildUsage,
  observedUsageOf,
  withObservedUsage,
} from "../src/executors/child-usage.ts";
import { ENV_HERDR } from "../src/executors/executor.ts";
import { appendRecord } from "../src/governance/record.ts";
import { buildChildLifecycleEvent, type ChildUsageTotals } from "../src/governance/ledger-events.ts";
import { ENV_CHILD_IDLE_TIMEOUT, ENV_CHILD_TIMEOUT } from "../src/kernel/run-child.ts";
import { ENV_DEPTH, ENV_FANOUT, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH } from "../src/kernel/propagation.ts";
import { renderDashboard } from "../src/products/dashboard-render.ts";
import { renderEpisodeReport, reportEpisodes } from "../src/products/episode-report.ts";
import { piFixtureScript } from "./pi-fixture.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { toolSources } from "./tool-sources-fixture.ts";

after(cleanupTempDirs);

/** Fixed, binary-exact usage: distinct powers of two, so a call counted twice or not at all changes every sum. */
const u = (input: number, output: number, cost: number): ChildUsageTotals => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});
const plus = (...all: ChildUsageTotals[]): ChildUsageTotals => ({
  input: all.reduce((sum, x) => sum + x.input, 0),
  output: all.reduce((sum, x) => sum + x.output, 0),
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: all.reduce((sum, x) => sum + x.totalTokens, 0),
  cost: {
    input: all.reduce((sum, x) => sum + x.cost.input, 0),
    output: all.reduce((sum, x) => sum + x.cost.output, 0),
    cacheRead: 0,
    cacheWrite: 0,
    total: all.reduce((sum, x) => sum + x.cost.total, 0),
  },
});
const C1 = u(1, 2, 0.5),
  C2 = u(4, 8, 0.25),
  G = u(16, 32, 0.125),
  R1 = u(64, 128, 1),
  R2 = u(256, 512, 2);

const user = () => ({ role: "user", content: "TASK", timestamp: 1 }) as const;
const assistant = (usage: ChildUsageTotals, call?: string) =>
  ({
    role: "assistant",
    api: "test",
    provider: "local",
    model: "model",
    content: call ? [{ type: "toolCall", id: call, name: "delegate", arguments: {} }] : [{ type: "text", text: "ok" }],
    usage,
    stopReason: call ? "toolUse" : "stop",
    timestamp: 2,
  }) as never;
const toolResult = (toolName: string, id: string, usage?: unknown, details?: unknown) =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text: "result" }],
    ...(usage === undefined ? {} : { usage }),
    ...(details === undefined ? {} : { details }),
    isError: false,
    timestamp: 3,
  }) as never;
async function observe(manager: SessionManager) {
  const path = join(await tempDir("child-usage-"), "session.jsonl");
  const rows = [manager.getHeader(), ...manager.getEntries()];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return (await activitySessionFor(["--print", "--session", path, "task"], "exec:child-usage")).usage();
}

test("a child's own calls are read apart from what its delegation results reported", async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user());
  manager.appendMessage(assistant(C1, "call-1"));
  const record = { reported: true, measured: 2, unmeasured: 1, coverage: "partial" };
  manager.appendMessage(toolResult("delegate_all", "call-1", G, { childUsage: record }));
  manager.appendMessage(toolResult("read", "call-2"));
  manager.appendMessage(assistant(C2));
  const observed = await observe(manager);
  assert.deepEqual(observed.usage, plus(C1, C2), "the ledger's figure: this child's own calls only");
  assert.deepEqual(observed.delegated, { usage: G, measured: 2, unmeasured: 1 });
  assert.deepEqual(observedChildUsage(observed), { usage: plus(C1, C2, G), measured: 3, unmeasured: 1 });
});

test("a delegation result without a record, or whose usage the host dropped, counts its children as unmeasured", async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user());
  manager.appendMessage(assistant(C1, "call-1"));
  // A call that threw: Pi's error result has no details record and no usage. Nothing says whether a child ran.
  manager.appendMessage(toolResult("delegate", "call-1"));
  // Reported, but the host kept no usage on the message: its two measured children are not in this session's total.
  manager.appendMessage(
    toolResult("delegate_all", "call-2", undefined, { childUsage: { reported: true, measured: 2, unmeasured: 0 } }),
  );
  // A reused operation: nothing ran, nothing to count.
  manager.appendMessage(
    toolResult("delegate_chain", "call-3", undefined, { childUsage: { reported: false, measured: 0, unmeasured: 0 } }),
  );
  manager.appendMessage(assistant(C2));
  const observed = await observe(manager);
  assert.deepEqual(observed.usage, plus(C1, C2));
  assert.deepEqual(observed.delegated, { measured: 0, unmeasured: 3 });
  assert.deepEqual(observedChildUsage(observed), { usage: plus(C1, C2), measured: 1, unmeasured: 3 });
});

test("malformed reported usage invalidates the observation instead of counting part of it", async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user());
  manager.appendMessage(assistant(C1, "call-1"));
  manager.appendMessage(toolResult("delegate", "call-1", { ...G, input: -1 }));
  manager.appendMessage(assistant(C2));
  assert.deepEqual(await observe(manager), { unavailable: "session-invalid" });
  assert.deepEqual(observedChildUsage({}), { measured: 0, unmeasured: 1 }, "an unobserved child adds nothing");
});

test("two-level tree: every model call reaches the root session once and the ledger once", async () => {
  // The grandchild's delegation result, as its parent (the child) returns it.
  const grandchild = observedChildUsage({ usage: G });
  const childResult = delegationUsage([{ observedUsage: grandchild }]);
  assert.deepEqual(childResult, {
    usage: G,
    childUsage: { reported: true, measured: 1, unmeasured: 0, coverage: "complete" },
  });
  // The child's session as Pi persists it: its own calls around that result.
  const child = SessionManager.inMemory();
  child.appendMessage(user());
  child.appendMessage(assistant(C1, "g"));
  child.appendMessage(toolResult("delegate", "g", childResult.usage, { childUsage: childResult.childUsage }));
  child.appendMessage(assistant(C2));
  const observed = await observe(child);
  assert.deepEqual(observed.usage, plus(C1, C2), "the child's ledger record holds its own calls, not G");
  const rootResult = delegationUsage([{ observedUsage: observedChildUsage(observed) }]);
  assert.deepEqual(rootResult, {
    usage: plus(C1, C2, G),
    childUsage: { reported: true, measured: 2, unmeasured: 0, coverage: "complete" },
  });
  // The root session as Pi persists it. Pi 1.0.4 and 1.5.2 `getSessionStats` and the footer sum assistant usage
  // and tool-result usage of every message entry; the real-Pi tier asks Pi itself (child-usage-total.it.ts).
  const root = SessionManager.inMemory();
  root.appendMessage(user());
  root.appendMessage(assistant(R1, "c"));
  root.appendMessage(toolResult("delegate", "c", rootResult.usage, { childUsage: rootResult.childUsage }));
  root.appendMessage(assistant(R2));
  const counted = root.getEntries().flatMap((entry) => {
    const message = entry.type === "message" ? (entry.message as { usage?: ChildUsageTotals }) : undefined;
    return message?.usage ? [message.usage] : [];
  });
  assert.deepEqual(plus(...counted), plus(R1, R2, C1, C2, G));
  assert.deepEqual(childUsageInSession(root.getEntries()), { results: 1, recorded: 1, cost: 0.875 });

  // The ledger holds each execution's own calls, so the episode report sums every call once too.
  const ledger = join(await tempDir("child-usage-ledger-"), "grants.jsonl");
  const episodeId = "episode:00000000-0000-4000-8000-0000000000c1";
  // As `execute-child.ts` writes it: the token detail is derived from the same own totals.
  const lifecycle = (executionId: string, parentExecutionId: string | null, usage: ChildUsageTotals) =>
    appendRecord(
      ledger,
      "lifecycle",
      buildChildLifecycleEvent({
        episodeId,
        executionId,
        parentExecutionId,
        childId: parentExecutionId ? "d1.1" : "d0.1",
        state: "completed",
        executor: "process",
        usage,
        tokenDetail: {
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
        },
        now: new Date("2026-11-17T10:00:00.000Z"),
      }),
    );
  await lifecycle("exec:00000000-0000-4000-8000-0000000000c1", null, observed.usage!);
  await lifecycle("exec:00000000-0000-4000-8000-0000000000c2", "exec:00000000-0000-4000-8000-0000000000c1", G);
  const report = reportEpisodes({
    ledgerText: await readFile(ledger, "utf8"),
    activityText: "",
    commitByEpisode: new Map(),
    options: {},
  });
  assert.equal(report.rows[0].cost, 0.875, "C1 + C2 + G, each once");
  assert.equal(report.rows[0].inputTokens, 21);
  assert.equal(report.rows[0].outputTokens, 42);
  assert.equal(report.parentSessionTotals, "include-reported-child-usage");
  assert.match(
    renderEpisodeReport(report, false),
    /Where its delegation result reported that usage and the host recorded it, the delegating Pi session's usage and cost already include it: compare with them, do not add\.\n$/,
  );
});

test("a reused operation, an unexecuted refusal and an unmeasured child add no usage", () => {
  const measured = { observedUsage: observedChildUsage({ usage: C1 }) };
  assert.deepEqual(
    delegationUsage([
      measured,
      { observedUsage: observedChildUsage({ usage: C2 }), operation: { reused: true } },
      {},
      { observedUsage: observedChildUsage({}) },
    ]),
    { usage: C1, childUsage: { reported: true, measured: 1, unmeasured: 1, coverage: "partial" } },
  );
  assert.deepEqual(delegationUsage([{ observedUsage: observedChildUsage({}) }]), {
    childUsage: { reported: false, measured: 0, unmeasured: 1, coverage: "unavailable" },
  });
  assert.deepEqual(delegationUsage([{}, { operation: { reused: true } }]), {
    childUsage: { reported: false, measured: 0, unmeasured: 0, coverage: "complete" },
  });
});

test("a fan-out child that ran and then threw keeps its observed usage, also inside an aggregate error", () => {
  const observed = observedChildUsage({ usage: C1 });
  const direct = childFailureOutcome(withObservedUsage(new Error("executor lost"), observed), 1);
  assert.deepEqual(direct.observedUsage, observed);
  const wrapped = new AggregateError([withObservedUsage(new Error("executor lost"), observed), new Error("record")]);
  assert.deepEqual(childFailureOutcome(wrapped, 1).observedUsage, observed);
  assert.equal(childFailureOutcome(new Error("refused before launch"), 1).observedUsage, undefined);
});

test("a child whose execution throws after it ran keeps its observed usage on the error", async () => {
  const dir = await tempDir("child-usage-throw-");
  await writeFile(join(dir, "pi"), piFixtureScript(`__piFixture.usage = ${JSON.stringify(C1)}; console.log("ran");`));
  await chmod(join(dir, "pi"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const executionId = "exec:00000000-0000-4000-8000-0000000000d1";
    let caught: unknown;
    await executePlannedChild({
      session: { executor: { kind: "process" } } as GrantsSession,
      plan: {
        ok: true,
        args: [" task"],
        env: {},
        effective: [],
        result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
        childDepth: 1,
        requested: [],
        taskDigest: "a".repeat(64),
      } as never,
      childId: "d0.1",
      executionId,
      parentExecutionId: null,
      cwd: dir,
      // Fails after the child settled, inside the executor's own error path.
      capacityReservation: {
        executionId,
        childAllowance: 0,
        bindOwnership: () => {},
        finalize: () => {
          throw new Error("reservation record lost");
        },
      } as never,
    }).catch((error) => (caught = error));
    assert.match(String(caught), /reservation record lost/);
    assert.deepEqual(observedUsageOf(caught), { usage: C1, measured: 1, unmeasured: 0 });
  } finally {
    process.env.PATH = oldPath;
  }
});

test("the dashboard says reported child usage is already in the Pi session, and when the host did not record it", () => {
  const line = (childUsage: { results: number; recorded: number; cost: number }) =>
    renderDashboard({ nodes: [], workflows: [], corrupt: [] } as never, {
      color: false,
      width: 120,
      modelRows: [],
      childUsage,
    })
      .split("\n")
      .filter((text) => text.startsWith("child usage"));
  assert.deepEqual(line({ results: 2, recorded: 2, cost: 0.875 }), [
    "child usage already in this Pi session's totals: $0.875 from 2 delegation results",
  ]);
  assert.deepEqual(line({ results: 3, recorded: 1, cost: 0.5 }), [
    "child usage already in this Pi session's totals: $0.5 from 1 of 3 delegation results; 2 not recorded by this Pi",
  ]);
  assert.deepEqual(line({ results: 1, recorded: 0, cost: 0 }), [
    "child usage not in this Pi session's totals: this Pi did not record it (1 delegation result)",
  ]);
  assert.deepEqual(line({ results: 1, recorded: 2, cost: 0 }), [], "an impossible snapshot shows nothing");
  // What the session server reads: only delegation results carrying a record that says they reported usage.
  const entries = [
    {
      type: "message",
      message: toolResult("delegate", "a", C1, { childUsage: { reported: true, measured: 1, unmeasured: 0 } }),
    },
    {
      type: "message",
      message: toolResult("delegate", "b", undefined, { childUsage: { reported: true, measured: 1, unmeasured: 0 } }),
    },
    {
      type: "message",
      message: toolResult("delegate", "c", undefined, { childUsage: { reported: false, measured: 0, unmeasured: 0 } }),
    },
    {
      type: "message",
      message: toolResult("scout_research", "d", G, { childUsage: { reported: true, measured: 1, unmeasured: 0 } }),
    },
  ];
  assert.deepEqual(childUsageInSession(entries), { results: 2, recorded: 1, cost: 0.5 });
  assert.equal(childUsageInSession(entries.slice(2)), undefined);
});

test("the owning session's dashboard snapshot reads its own record; an unreadable record shows nothing", async () => {
  const record = { childUsage: { reported: true, measured: 1, unmeasured: 0, coverage: "complete" } };
  let entries: () => unknown[] = () => [
    { type: "message", message: assistant(R1, "c") },
    { type: "message", message: toolResult("delegate", "c", C1, record) },
    { type: "message", message: toolResult("delegate_chain", "d", undefined, record) },
  ];
  const session = {
    episodeId: newEpisodeId(),
    ownerBound: true,
    reloadLifecycle: { root: {} },
    definitions: new Map(),
    definitionRuntimeSettings: { definitions: new Map(), defaults: {} },
    definitionRuntimeOverrides: new Map(),
    parentSession: { getSessionFile: () => undefined, getEntries: () => entries() },
  } as unknown as GrantsSession;
  await initializeSessionAutoMode(session, {}, "child-usage-fixture");
  const endpoint = await ensureDashboardSessionServer(session);
  try {
    const get = () => dashboardSessionRequest(endpoint.socketPath, endpoint.token, { action: "get" });
    assert.deepEqual((await get()).childUsage, { results: 2, recorded: 1, cost: 0.5 });
    entries = () => {
      throw new Error("record unavailable");
    };
    const unreadable = await get();
    assert.equal("childUsage" in unreadable, false);
    assert.equal(unreadable.cost, null);
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
  }
});

// ---- The real extension with inert children ----

const KEYS = [ENV_GRANT, ENV_DEPTH, ENV_MAX_DEPTH, ENV_GATED, ENV_LEDGER, ENV_FANOUT, ENV_HERDR, ENV_CHILD_TIMEOUT];
const saved = new Map<string, string | undefined>();
afterEach(() => {
  for (const [key, value] of saved) value === undefined ? delete process.env[key] : (process.env[key] = value);
  saved.clear();
});
type Tool = {
  execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<any>;
};

/** The extension as Pi loads it, with `pi` on PATH replaced by an inert script. */
async function harness(script: string, env: Record<string, string> = {}) {
  const dir = await tempDir("child-usage-wiring-");
  await writeFile(join(dir, "pi"), piFixtureScript(script));
  await chmod(join(dir, "pi"), 0o755);
  for (const key of [...KEYS, "PATH", "PI_CODING_AGENT_DIR", ENV_CHILD_IDLE_TIMEOUT])
    if (!saved.has(key)) saved.set(key, process.env[key]);
  for (const key of KEYS) delete process.env[key];
  const ledger = join(dir, "grants.jsonl");
  Object.assign(process.env, {
    [ENV_HERDR]: "0",
    [ENV_GRANT]: "tool:read,tool:delegate",
    [ENV_FANOUT]: "4",
    [ENV_LEDGER]: ledger,
    PI_CODING_AGENT_DIR: dir,
    PATH: `${dir}:${process.env.PATH}`,
    ...env,
  });
  const tools = new Map<string, Tool>(),
    hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>(),
    active = new Set(["read"]);
  const ctx = {
    cwd: dir,
    sessionManager: { getSessionId: () => `fixture:${dir}` },
    ui: { notify: () => {}, select: async () => undefined },
    modelRegistry: { find: () => undefined },
  };
  grantsExtension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => void hooks.set(name, handler),
    registerTool: (spec: Tool & { name: string }) => void tools.set(spec.name, spec),
    registerCommand: () => {},
    getAllTools: () => toolSources(),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active.clear();
      names.forEach((name) => active.add(name));
    },
  } as never);
  await hooks.get("session_start")!({}, ctx);
  const run = (tool: string, id: string, params: unknown) =>
    tools.get(tool)!.execute(id, params, undefined, undefined, ctx);
  const lifecycle = async () =>
    (await readFile(ledger, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).body)
      .filter((body) => body.event === "child_lifecycle" && body.state !== "starting" && body.state !== "running");
  return { run, lifecycle };
}
/** Each inert child reads its usage from its task text: `usage=<input>,<output>,<cost>`. */
const BY_TASK = `#!/usr/bin/env node
const task = process.argv.at(-1);
const match = /usage=(\\d+),(\\d+),([\\d.]+)/.exec(task);
const n = match ? match.slice(1).map(Number) : [0, 0, 0];
__piFixture.usage = { input: n[0], output: n[1], cacheRead: 0, cacheWrite: 0, totalTokens: n[0] + n[1],
  cost: { input: n[2] / 2, output: n[2] / 2, cacheRead: 0, cacheWrite: 0, total: n[2] } };
if (task.includes("unmeasured")) __piFixture.usage = undefined;
if (task.includes("exit=3")) { console.log("partial work"); process.exit(3); }
if (task.includes("hang")) { __piFixture.persist(0); setInterval(() => {}, 1000); }
else console.log("done " + task.trim());
`;
const task = (usage: ChildUsageTotals, extra = "") =>
  `work usage=${usage.input},${usage.output},${usage.cost.total} ${extra}`.trim();

test("delegate reports its child's usage to the session, and the ledger keeps the same own calls", async () => {
  const { run, lifecycle } = await harness(BY_TASK);
  const result = await run("delegate", "one", { task: task(C1), tools: ["read"] });
  assert.equal(result.isError, false);
  assert.deepEqual(result.usage, C1);
  assert.deepEqual(result.details.childUsage, { reported: true, measured: 1, unmeasured: 0, coverage: "complete" });
  assert.deepEqual(result.details.observedUsage, { usage: C1, measured: 1, unmeasured: 0 });
  assert.deepEqual(
    (await lifecycle()).map((event) => event.usage),
    [C1],
  );
});

test("delegate_all reports measured children's usage and says how many were not measured", async () => {
  const { run } = await harness(BY_TASK);
  const result = await run("delegate_all", "all", {
    children: [
      { task: task(C1), tools: ["read"] },
      { task: task(C2, "unmeasured"), tools: ["read"] },
      { task: task(G), tools: ["read"] },
    ],
  });
  assert.deepEqual(result.usage, plus(C1, G), "the unmeasured child's usage is not invented");
  assert.deepEqual(result.details.childUsage, { reported: true, measured: 2, unmeasured: 1, coverage: "partial" });
  assert.deepEqual(
    result.details.outcomes.map((outcome: any) => outcome.observedUsage),
    [
      { usage: C1, measured: 1, unmeasured: 0 },
      { measured: 0, unmeasured: 1 },
      { usage: G, measured: 1, unmeasured: 0 },
    ],
  );
});

test("delegate_chain reports every step that ran", async () => {
  const { run } = await harness(BY_TASK);
  const result = await run("delegate_chain", "chain", {
    steps: [
      { task: task(C1), tools: ["read"] },
      { task: task(C2), tools: ["read"] },
    ],
  });
  assert.equal(result.details.completed, 2);
  assert.deepEqual(result.usage, plus(C1, C2));
  assert.deepEqual(result.details.childUsage, { reported: true, measured: 2, unmeasured: 0, coverage: "complete" });
});

test("a child that delegated reports its own calls plus its delegation's once; the ledger keeps its own only", async () => {
  const delegated = JSON.stringify({ reported: true, measured: 1, unmeasured: 0, coverage: "complete" });
  const { run, lifecycle } = await harness(`#!/usr/bin/env node
__piFixture.entries = [
  { type: "message", message: { role: "assistant", api: "fixture", provider: "fixture", model: "fixture",
    content: [{ type: "toolCall", id: "g", name: "delegate", arguments: {} }], usage: ${JSON.stringify(C1)},
    stopReason: "toolUse", timestamp: 1 } },
  { type: "message", message: { role: "toolResult", toolCallId: "g", toolName: "delegate",
    content: [{ type: "text", text: "grandchild done" }], usage: ${JSON.stringify(G)},
    details: { childUsage: ${delegated} }, isError: false, timestamp: 1 } },
];
__piFixture.usage = ${JSON.stringify(C2)};
console.log("child done");
`);
  const result = await run("delegate", "tree", { task: "delegate further", tools: ["read"] });
  assert.deepEqual(result.usage, plus(C1, C2, G));
  assert.deepEqual(result.details.childUsage, { reported: true, measured: 2, unmeasured: 0, coverage: "complete" });
  assert.deepEqual(
    (await lifecycle()).map((event) => event.usage),
    [plus(C1, C2)],
  );
});

test("a reused operation reports no usage again", async () => {
  const { run } = await harness(BY_TASK);
  const spec = { operation_id: "build:usage-once", task: task(C1), tools: ["read"] };
  const first = await run("delegate", "first", spec);
  assert.deepEqual(first.usage, C1);
  const again = await run("delegate", "again", spec);
  assert.equal(again.details.operation.reused, true);
  assert.equal("usage" in again, false);
  assert.deepEqual(again.details.childUsage, { reported: false, measured: 0, unmeasured: 0, coverage: "complete" });
  const all = await run("delegate_all", "all-again", { children: [spec, spec] });
  assert.equal("usage" in all, false);
  assert.deepEqual(all.details.childUsage, { reported: false, measured: 0, unmeasured: 0, coverage: "complete" });
});

test("a failed child and a timed-out child report what was observed before they stopped", async () => {
  const { run } = await harness(BY_TASK, { [ENV_CHILD_TIMEOUT]: "60", [ENV_CHILD_IDLE_TIMEOUT]: "3" });
  const failed = await run("delegate", "failed", { task: task(C1, "exit=3"), tools: ["read"] });
  assert.equal(failed.isError, true);
  assert.equal(failed.details.exitCode, 3);
  assert.deepEqual(failed.usage, C1);
  const timedOut = await run("delegate", "hang", { task: task(C2, "hang"), tools: ["read"] });
  assert.equal(timedOut.isError, true);
  assert.equal(timedOut.details.timedOut, true);
  assert.deepEqual(timedOut.usage, C2);
  assert.deepEqual(timedOut.details.childUsage, { reported: true, measured: 1, unmeasured: 0, coverage: "complete" });
});
