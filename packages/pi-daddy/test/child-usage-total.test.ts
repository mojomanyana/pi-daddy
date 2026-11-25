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
 * threw after running loses its usage; a retried child reports only one of its attempts; or the dashboard and report
 * stop saying the usage is already included.
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
  addDelegationResult,
  childUsageInSession,
  delegationUsage,
  observedChildUsage,
  observedUsageOf,
  USAGE_CEILINGS,
  withObservedUsage,
} from "../src/executors/child-usage.ts";
import { childUsageReport, registerChildUsageReport } from "../extensions/child-usage-report.ts";
import { appendRecord } from "../src/governance/record.ts";
import { buildChildLifecycleEvent, type ChildUsageTotals } from "../src/governance/ledger-events.ts";
import { ENV_CHILD_IDLE_TIMEOUT, ENV_CHILD_TIMEOUT } from "../src/kernel/run-child.ts";
import { ENV_DEPTH, ENV_FANOUT, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH } from "../src/kernel/propagation.ts";
import { ENV_REPLAY_RETRY } from "../src/kernel/env-names.ts";
import { renderDashboard } from "../src/products/dashboard-render.ts";
import { renderEpisodeReport, reportEpisodes } from "../src/products/episode-report.ts";
import { evidenceFromProvider, providerToolOutput } from "./execution-evidence-fixture.ts";
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
/** An assistant message calling several tools at once, by name and id. */
const calling = (usage: ChildUsageTotals, ...calls: Array<[name: string, id: string]>) =>
  ({
    role: "assistant",
    api: "test",
    provider: "local",
    model: "model",
    content: calls.map(([name, id]) => ({ type: "toolCall", id, name, arguments: {} })),
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  }) as never;
async function observe(manager: SessionManager, edit = (text: string) => text) {
  const path = join(await tempDir("child-usage-"), "session.jsonl");
  const rows = [manager.getHeader(), ...manager.getEntries()];
  await writeFile(path, edit(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`));
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
    childUsage: { reported: true, cost: G.cost.total, measured: 1, unmeasured: 0, coverage: "complete" },
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
    childUsage: { reported: true, cost: 0.875, measured: 2, unmeasured: 0, coverage: "complete" },
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
  const grouped = reportEpisodes({
    ledgerText: await readFile(ledger, "utf8"),
    activityText: "",
    commitByEpisode: new Map(),
    options: { groupBy: "model" },
  });
  assert.equal(grouped.parentSessionTotals, "include-reported-child-usage", "the --group-by path says it too");
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
    { usage: C1, childUsage: { reported: true, cost: C1.cost.total, measured: 1, unmeasured: 1, coverage: "partial" } },
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
  assert.deepEqual(line({ results: 1, recorded: 1, cost: NaN }), [], "nor does a cost that is not a number");
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

test("a parent-run tool's own usage, which Pi adds to the delegation that ran it, is not child usage", () => {
  // Integration with parent-run tools (2026-11-17). The root runs `scout_research` for its child as a nested call of
  // the waiting `delegate`, and Pi adds a nested call's usage to that call's persisted result (`_handleAgentEvent`,
  // Pi 1.0.4 and 1.5.2; run in parent-run-tools.it.ts). The session's totals hold both once; the line names only
  // the children's share.
  const scout = u(1024, 2048, 4);
  const reported = delegationUsage([{ observedUsage: observedChildUsage({ usage: C1 }) }]);
  assert.deepEqual(reported, {
    usage: C1,
    childUsage: { reported: true, cost: C1.cost.total, measured: 1, unmeasured: 0, coverage: "complete" },
  });
  const persisted = (childUsage: unknown) => ({
    type: "message",
    message: {
      ...(toolResult("delegate", "a", plus(C1, scout), { childUsage }) as object),
      nestedCalls: { calls: [{ id: "a/1", name: "scout_research", status: "ok" }], complete: true },
    },
  });
  assert.deepEqual(childUsageInSession([persisted(reported.childUsage)]), { results: 1, recorded: 1, cost: 0.5 });
  assert.deepEqual(
    renderDashboard({ nodes: [], workflows: [], corrupt: [] } as never, {
      color: false,
      width: 120,
      modelRows: [],
      childUsage: childUsageInSession([persisted(reported.childUsage)]),
    })
      .split("\n")
      .filter((text) => text.startsWith("child usage")),
    ["child usage already in this Pi session's totals: $0.5 from 1 delegation result"],
  );
  // A record without the children's own cost, or with one the kept usage cannot hold, is bounded by the kept usage.
  const { cost: _cost, ...uncosted } = reported.childUsage;
  for (const childUsage of [uncosted, { ...uncosted, cost: 5 }, { ...uncosted, cost: -1 }, { ...uncosted, cost: "0" }])
    assert.deepEqual(childUsageInSession([persisted(childUsage)]), { results: 1, recorded: 1, cost: 4.5 });
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

// ---- Review of 2026-11-17: unanswered calls, hostile numbers, thrown calls ----

test("a delegation call with no result is one unmeasured child: the child stopped while it waited", async () => {
  // The reviewer's probe: the child was killed or cancelled while its own `delegate` waited on a grandchild.
  const manager = SessionManager.inMemory();
  manager.appendMessage(user());
  manager.appendMessage(assistant(C1, "g"));
  const observed = await observe(manager);
  assert.deepEqual(observed.usage, C1);
  assert.deepEqual(observed.delegated, { measured: 0, unmeasured: 1 });
  assert.deepEqual(delegationUsage([{ observedUsage: observedChildUsage(observed) }]), {
    usage: C1,
    childUsage: { reported: true, cost: C1.cost.total, measured: 1, unmeasured: 1, coverage: "partial" },
  });
});

test("only this turn's delegation calls left without a result count, each call once", async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user());
  manager.appendMessage(assistant(R1, "earlier-turn")); // A previous turn's call is not this turn's work.
  manager.appendMessage(user());
  manager.appendMessage(
    calling(C1, ["delegate_all", "a"], ["delegate_chain", "b"], ["read", "c"], ["delegate", "d"], ["delegate", "d"]),
  );
  manager.appendMessage(
    toolResult("delegate_all", "a", G, { childUsage: { reported: true, measured: 1, unmeasured: 0 } }),
  );
  const nothing = { childUsage: { reported: false, measured: 0, unmeasured: 0 } };
  manager.appendMessage(toolResult("delegate", "d", undefined, nothing));
  manager.appendMessage(toolResult("delegate", "orphan", undefined, nothing)); // Answers no call; cancels none.
  manager.appendMessage(assistant(C2));
  const observed = await observe(manager);
  assert.deepEqual(observed.usage, plus(C1, C2));
  // "b" and the second "d" have no result; "c" is not a delegation; "a" and the first "d" were answered.
  assert.deepEqual(observed.delegated, { usage: G, measured: 1, unmeasured: 2 });
});

test("children are added one at a time: only the child that passes a ceiling is unmeasured", () => {
  const legit = { observedUsage: observedChildUsage({ usage: u(100, 0, 5) }) };
  // As if a value had passed every check upstream: the sum itself is guarded.
  const huge = { observedUsage: { usage: u(1e308, 0, 1.7e308), measured: 1, unmeasured: 0 } };
  const legitOnly = {
    usage: u(100, 0, 5),
    childUsage: { reported: true, cost: 5, measured: 1, unmeasured: 1, coverage: "partial" },
  };
  assert.deepEqual(delegationUsage([legit, huge]), legitOnly, "$5 is reported, not absorbed");
  assert.deepEqual(delegationUsage([huge, legit, huge]), {
    ...legitOnly,
    childUsage: { ...legitOnly.childUsage, unmeasured: 2 },
  });
  // Exactly at a ceiling is accepted; one token past it, the child that passes it is unmeasured.
  const below = { observedUsage: observedChildUsage({ usage: u(USAGE_CEILINGS.tokens - 100, 0, 1) }) };
  const one = { observedUsage: observedChildUsage({ usage: u(1, 0, 0) }) };
  assert.deepEqual(delegationUsage([below, legit, one]), {
    usage: plus(u(USAGE_CEILINGS.tokens - 100, 0, 1), u(100, 0, 5)),
    childUsage: { reported: true, cost: 6, measured: 2, unmeasured: 1, coverage: "partial" },
  });
  // One settled child: its own calls and its delegations are added the same way.
  const delegated = { usage: G, measured: 2, unmeasured: 1 };
  assert.deepEqual(observedChildUsage({ usage: u(USAGE_CEILINGS.tokens * 2, 0, 1), delegated }), {
    usage: G,
    measured: 2,
    unmeasured: 2,
  });
  assert.deepEqual(
    observedChildUsage({ usage: C1, delegated: { ...delegated, usage: u(USAGE_CEILINGS.tokens, 0, 1) } }),
    {
      usage: C1,
      measured: 1,
      unmeasured: 3,
    },
  );
  assert.deepEqual(observedChildUsage({ usage: u(1, 0, USAGE_CEILINGS.cost * 2) }), { measured: 0, unmeasured: 1 });
});

test("a value read back that is not usage invalidates; a number past a ceiling is unmeasured; bad counts are no record", () => {
  const record = (measured: number, unmeasured = 0, reported = true) => ({
    childUsage: { reported, measured, unmeasured },
  });
  const before = { usage: C1, measured: 1, unmeasured: 0 };
  // Not a non-negative number: the child's observation is invalid, as for its own calls.
  assert.equal(addDelegationResult(before, { usage: { ...G, reasoning: -1 }, details: record(1) }), undefined);
  assert.equal(addDelegationResult(before, { usage: { ...G, cost: { ...G.cost, total: Number.NaN } } }), undefined);
  // Infinity (JSON `1e999`) and values past a ceiling are numbers, but implausible: that result's children are unmeasured.
  for (const usage of [
    { ...G, input: Number.POSITIVE_INFINITY },
    { ...G, reasoning: USAGE_CEILINGS.tokens + 1 },
    { ...G, cacheWrite: USAGE_CEILINGS.tokens + 1 },
    { ...G, cost: { ...G.cost, cacheRead: USAGE_CEILINGS.cost * 1.0000001 } },
  ])
    assert.deepEqual(addDelegationResult(before, { usage, details: record(2, 1) }), { ...before, unmeasured: 3 });
  // At the ceilings exactly, accepted.
  const top = { ...u(USAGE_CEILINGS.tokens, 0, USAGE_CEILINGS.cost), reasoning: USAGE_CEILINGS.tokens };
  assert.deepEqual(addDelegationResult(undefined, { usage: top, details: record(1) }), {
    usage: top,
    measured: 1,
    unmeasured: 0,
  });
  // Counts that are not plausible make no record: one unmeasured child, its plausible usage still counted.
  for (const details of [record(-1), record(2.5), record(USAGE_CEILINGS.executions + 1), record(1, -1)])
    assert.deepEqual(addDelegationResult(undefined, { usage: G, details }), { usage: G, measured: 0, unmeasured: 1 });
  assert.deepEqual(addDelegationResult(undefined, { usage: G, details: record(USAGE_CEILINGS.executions) }), {
    usage: G,
    measured: USAGE_CEILINGS.executions,
    unmeasured: 0,
  });
  // A record that says it reported nothing measured nothing, whatever it counts as measured.
  assert.deepEqual(addDelegationResult(undefined, { details: record(3, 1, false) }), { measured: 0, unmeasured: 4 });
});

test("a child's session with an infinite delegated value keeps its own usage; only that result is unmeasured", async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user());
  manager.appendMessage(assistant(C1, "g"));
  const reported = { childUsage: { reported: true, measured: 2, unmeasured: 0 } };
  manager.appendMessage(toolResult("delegate", "g", { ...G, input: 987654321 }, reported));
  manager.appendMessage(assistant(C2));
  const observed = await observe(manager, (text) => text.replace("987654321", "1e999"));
  assert.deepEqual(observed.usage, plus(C1, C2));
  assert.deepEqual(observed.delegated, { measured: 0, unmeasured: 2 });
});

test("Pi's tool_result hook reports a thrown call's settled children once and leaves every other result alone", async () => {
  const hooks = new Map<string, (event: any) => any>();
  const session = {},
    other = {};
  registerChildUsageReport({ on: (name: string, handler: any) => void hooks.set(name, handler) } as never, session);
  const hook = (event: object) =>
    hooks.get("tool_result")!({ type: "tool_result", toolName: "delegate_all", isError: true, details: {}, ...event });
  const ran = { observedUsage: observedChildUsage({ usage: C1 }) };

  // Children settled, then the call threw. Pi's bare error result gets their usage and a record; nothing else changes.
  const call = childUsageReport(session, "x");
  call.add(ran, { observedUsage: observedChildUsage({}) });
  call.add({ observedUsage: observedChildUsage({ usage: C2 }), operation: { reused: true } });
  assert.equal(await call.settle(Promise.resolve(ran)), ran);
  const lost = withObservedUsage(new Error("executor lost"), observedChildUsage({ usage: G }));
  await assert.rejects(call.settle(Promise.reject(lost)), /executor lost/);
  assert.deepEqual(hook({ toolCallId: "x", details: { kept: true } }), {
    usage: plus(C1, C1, G),
    details: {
      kept: true,
      childUsage: { reported: true, cost: 1.125, measured: 3, unmeasured: 1, coverage: "partial" },
    },
  });
  assert.equal(hook({ toolCallId: "x" }), undefined, "taken once");

  // A result that reported itself is left alone, so nothing is counted twice.
  childUsageReport(session, "returned").add(ran);
  assert.equal(hook({ toolCallId: "returned", isError: false, usage: C1 }), undefined);
  childUsageReport(session, "unmeasured").add({ observedUsage: observedChildUsage({}) });
  const unmeasured = { childUsage: { reported: false, measured: 0, unmeasured: 1, coverage: "unavailable" } };
  assert.equal(hook({ toolCallId: "unmeasured", isError: false, details: unmeasured }), undefined);

  // A refusal that started no child, or an error without an observation, changes nothing.
  const refused = childUsageReport(session, "refused");
  refused.add({});
  await assert.rejects(refused.settle(Promise.reject(new Error("refused"))), /refused/);
  assert.equal(hook({ toolCallId: "refused" }), undefined);
  // Children that ran unmeasured: a record says so, and no usage is invented.
  childUsageReport(session, "none-measured").add({ observedUsage: observedChildUsage({}) });
  assert.deepEqual(hook({ toolCallId: "none-measured" }), {
    details: { childUsage: { reported: false, measured: 0, unmeasured: 1, coverage: "unavailable" } },
  });

  // Per call and per session: a new call under an id starts empty; another session's calls are its own.
  childUsageReport(session, "same").add(ran);
  childUsageReport(session, "same");
  assert.equal(hook({ toolCallId: "same" }), undefined);
  childUsageReport(other, "elsewhere").add(ran);
  assert.equal(hook({ toolCallId: "elsewhere" }), undefined);
  // Never another tool's result under the same id.
  childUsageReport(session, "shared-id").add(ran);
  assert.equal(hook({ toolCallId: "shared-id", toolName: "read" }), undefined);
  assert.equal(hook({ toolCallId: "shared-id" }), undefined, "and the entry is gone");
  // agent_end clears whatever the hook did not take.
  childUsageReport(session, "left").add(ran);
  hooks.get("agent_end")!({});
  assert.equal(hook({ toolCallId: "left" }), undefined);
});

// ---- The real extension with inert children ----

const KEYS = [
  ENV_GRANT,
  ENV_DEPTH,
  ENV_MAX_DEPTH,
  ENV_GATED,
  ENV_LEDGER,
  ENV_FANOUT,
  ENV_CHILD_TIMEOUT,
  ENV_REPLAY_RETRY,
];
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
  const toolResult = (event: object) => hooks.get("tool_result")!({ type: "tool_result", ...event }, ctx) as any;
  /**
   * As Pi 1.0.4 and 1.5.2 run a tool (`agent-loop.js` `executePreparedToolCall` and `finalizeExecutedToolCall`): a
   * throw becomes a bare error result, then the `tool_result` handler runs on every result, and its `usage` and
   * `details` replace the result's. Daddy's is the only handler here.
   */
  const asPi = async (tool: string, id: string, params: unknown) => {
    let result: any, isError: boolean;
    try {
      result = await run(tool, id, params);
      isError = result.isError === true;
    } catch (error) {
      result = {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        details: {},
      };
      isError = true;
    }
    const event = { toolName: tool, toolCallId: id, input: params, content: result.content, details: result.details };
    const after = await toolResult({ ...event, isError, ...(result.usage ? { usage: result.usage } : {}) });
    return {
      ...result,
      isError,
      details: after?.details ?? result.details,
      usage: after?.usage ?? result.usage,
      after,
    };
  };
  const lifecycle = async () =>
    (await readFile(ledger, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).body)
      .filter((body) => body.event === "child_lifecycle" && body.state !== "starting" && body.state !== "running");
  return { run, asPi, toolResult, lifecycle };
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
if (task.includes("veto")) { process.stdout.write("BLOCKED_CRITICAL_ASSURANCE\\nvetoed"); process.exit(3); }
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
  assert.deepEqual(result.details.childUsage, {
    reported: true,
    cost: C1.cost.total,
    measured: 1,
    unmeasured: 0,
    coverage: "complete",
  });
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
  assert.deepEqual(result.details.childUsage, {
    reported: true,
    cost: 0.625,
    measured: 2,
    unmeasured: 1,
    coverage: "partial",
  });
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
  assert.deepEqual(result.details.childUsage, {
    reported: true,
    cost: 0.75,
    measured: 2,
    unmeasured: 0,
    coverage: "complete",
  });
});

test("the model is shown none of the child usage: not in the text, not in the evidence summary", async () => {
  // Integration with the compact evidence summary (2026-11-17). `usage`, `details.childUsage` and each outcome's
  // `observedUsage` are for Pi's totals and the operator; the provider receives the content only, and the summary
  // is computed from the complete projection, which names none of them.
  const { run } = await harness(BY_TASK.replace('console.log("done " + task.trim());', 'console.log("done");'));
  const results = [
    await run("delegate", "one", { task: task(C1), tools: ["read"] }),
    await run("delegate_all", "all", {
      children: [
        { task: task(C1), tools: ["read"] },
        { task: task(G), tools: ["read"] },
      ],
    }),
    await run("delegate_chain", "chain", { steps: [{ task: task(C2), tools: ["read"] }] }),
  ];
  for (const result of results) {
    assert.equal(result.usage.input > 0, true, "usage was reported to Pi");
    const output = providerToolOutput(result);
    assert.doesNotMatch(output, /usage|measured|coverage|totalTokens|cacheRead|"cost"/i);
    for (const outcome of evidenceFromProvider(result).outcomes)
      assert.deepEqual(Object.keys(outcome).sort(), ["cleanup", "final", "ok", "ordinal", "work"]);
  }
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
  assert.deepEqual(result.details.childUsage, {
    reported: true,
    cost: 0.875,
    measured: 2,
    unmeasured: 0,
    coverage: "complete",
  });
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
  // A chain whose first step is the existing operation returns early, with its own record (review nit 5).
  const chain = await run("delegate_chain", "chain-again", { steps: [spec, { task: task(C2), tools: ["read"] }] });
  assert.equal(chain.details.completed, 0);
  assert.equal("usage" in chain, false);
  assert.deepEqual(chain.details.childUsage, { reported: false, measured: 0, unmeasured: 0, coverage: "complete" });
});

test("a failed child and a timed-out child report what was observed before they stopped", async () => {
  // One attempt each: with the automatic retry on, these read-only children run twice (tested below).
  const { run } = await harness(BY_TASK, {
    [ENV_CHILD_TIMEOUT]: "60",
    [ENV_CHILD_IDLE_TIMEOUT]: "3",
    [ENV_REPLAY_RETRY]: "0",
  });
  const failed = await run("delegate", "failed", { task: task(C1, "exit=3"), tools: ["read"] });
  assert.equal(failed.isError, true);
  assert.equal(failed.details.exitCode, 3);
  assert.deepEqual(failed.usage, C1);
  const timedOut = await run("delegate", "hang", { task: task(C2, "hang"), tools: ["read"] });
  assert.equal(timedOut.isError, true);
  assert.equal(timedOut.details.timedOut, true);
  assert.deepEqual(timedOut.usage, C2);
  assert.deepEqual(timedOut.details.childUsage, {
    reported: true,
    cost: C2.cost.total,
    measured: 1,
    unmeasured: 0,
    coverage: "complete",
  });
});

test("a fan-out with a vetoed child reports every child's usage through Pi's hook; the veto passes unchanged", async () => {
  const { asPi, lifecycle } = await harness(BY_TASK);
  const result = await asPi("delegate_all", "veto-all", {
    children: [
      { task: task(C1), tools: ["read"] },
      { task: task(C2, "veto"), tools: ["read"] },
    ],
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: "BLOCKED_CRITICAL_ASSURANCE\nvetoed" }]);
  assert.deepEqual(result.usage, plus(C1, C2), "the vetoed child and its measured sibling");
  assert.deepEqual(result.details, {
    childUsage: { reported: true, cost: 0.75, measured: 2, unmeasured: 0, coverage: "complete" },
  });
  assert.deepEqual((await lifecycle()).map((event) => event.usage.input).sort(), [C1.input, C2.input]);
});

test("a vetoed delegate and a chain stopped by a vetoed step report the children that ran; a refusal is unchanged", async () => {
  const { asPi } = await harness(BY_TASK);
  const record = (measured: number, cost: number) => ({
    childUsage: { reported: true, cost, measured, unmeasured: 0, coverage: "complete" },
  });
  const vetoed = await asPi("delegate", "veto-one", { task: task(C2, "veto"), tools: ["read"] });
  assert.equal(vetoed.isError, true);
  assert.deepEqual(vetoed.content, [{ type: "text", text: "BLOCKED_CRITICAL_ASSURANCE\nvetoed" }]);
  assert.deepEqual(vetoed.usage, C2);
  assert.deepEqual(vetoed.details, record(1, C2.cost.total));
  const chain = await asPi("delegate_chain", "veto-chain", {
    steps: [
      { task: task(C1), tools: ["read"] },
      { task: task(G, "veto"), tools: ["read"] },
    ],
  });
  assert.equal(chain.isError, true);
  assert.deepEqual(chain.content, [{ type: "text", text: "BLOCKED_CRITICAL_ASSURANCE\nvetoed" }]);
  assert.deepEqual(chain.usage, plus(C1, G), "the step before the veto, and the vetoed step");
  assert.deepEqual(chain.details, record(2, 0.625));
  const refused = await asPi("delegate", "refused", { task: task(C1), tools: ["bash"] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /^delegation refused: cannot grant tool:bash/);
  assert.equal(refused.after, undefined, "nothing ran, so the refusal's result is Pi's own");
  assert.deepEqual(refused.details, {});
  assert.equal(refused.usage, undefined);
});

test("a returned result passes Pi's hook unchanged, so its usage is counted once", async () => {
  // One attempt: with the automatic retry on, the failing read-only child runs twice (tested below).
  const { asPi } = await harness(BY_TASK, { [ENV_REPLAY_RETRY]: "0" });
  const result = await asPi("delegate_all", "returned", {
    children: [
      { task: task(C1), tools: ["read"] },
      { task: task(C2, "exit=3"), tools: ["read"] },
    ],
  });
  assert.equal(result.isError, true, "a failed child is returned, not thrown");
  assert.equal(result.after, undefined);
  assert.deepEqual(result.usage, plus(C1, C2));
  assert.deepEqual(result.details.childUsage, {
    reported: true,
    cost: 0.75,
    measured: 2,
    unmeasured: 0,
    coverage: "complete",
  });
});

test("a child stopped while its own delegation waited reports partial coverage to its parent", async () => {
  const { run } = await harness(`#!/usr/bin/env node
__piFixture.entries = [
  { type: "message", message: { role: "assistant", api: "fixture", provider: "fixture", model: "fixture",
    content: [{ type: "toolCall", id: "g", name: "delegate", arguments: {} }], usage: ${JSON.stringify(C1)},
    stopReason: "toolUse", timestamp: 1 } },
];
__piFixture.usage = ${JSON.stringify(C2)};
console.log("child done");
`);
  const result = await run("delegate", "inflight", { task: "wait on a grandchild", tools: ["read"] });
  assert.deepEqual(result.usage, plus(C1, C2));
  assert.deepEqual(result.details.childUsage, {
    reported: true,
    cost: 0.75,
    measured: 1,
    unmeasured: 1,
    coverage: "partial",
  });
});

/** An inert child that fails without a final on its first launch per task (or on every launch with `always`). */
const ATTEMPTS = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const task = process.argv.at(-1);
const counter = path.join(path.dirname(process.argv[1]), "attempt-" + crypto.createHash("sha256").update(task).digest("hex"));
const attempt = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(attempt));
__piFixture.usage = attempt === 1 ? ${JSON.stringify(C1)} : ${JSON.stringify(C2)};
if (attempt === 1 || task.includes("always")) process.exit(3);
console.log("done");
`;

test("a retried read-only child reports both attempts' usage once, as the ledger records them", async () => {
  // Integration with the automatic retry (2026-11-17): both attempts used the model, and each has its own lifecycle
  // record, so the session's totals hold both or the two would disagree. Each attempt is one measured execution.
  const { run, lifecycle } = await harness(ATTEMPTS);
  const both = { reported: true, cost: 0.75, measured: 2, unmeasured: 0, coverage: "complete" };
  const retried = await run("delegate", "retried", { task: "once", tools: ["read"] });
  assert.equal(retried.isError, false);
  assert.equal(retried.details.retry.attempts, 2);
  assert.deepEqual(retried.usage, plus(C1, C2));
  assert.deepEqual(retried.details.childUsage, both);
  assert.deepEqual(retried.details.retry.first.observedUsage, { usage: C1, measured: 1, unmeasured: 0 });
  const failed = await run("delegate", "failed", { task: "always", tools: ["read"] });
  assert.equal(failed.isError, true);
  assert.equal(failed.details.retry.attempts, 2);
  assert.deepEqual(failed.usage, plus(C1, C2));
  assert.deepEqual(failed.details.childUsage, both);
  const all = await run("delegate_all", "all", { children: [{ task: "once in a fan-out", tools: ["read"] }] });
  assert.deepEqual(all.usage, plus(C1, C2));
  assert.deepEqual(all.details.childUsage, both);
  const chain = await run("delegate_chain", "chain", { steps: [{ task: "once in a chain", tools: ["read"] }] });
  assert.deepEqual(chain.usage, plus(C1, C2));
  assert.deepEqual(chain.details.childUsage, both);
  assert.deepEqual(
    (await lifecycle()).map((event) => event.usage.cost.total).sort(),
    [C1, C1, C1, C1, C2, C2, C2, C2].map((usage) => usage.cost.total).sort(),
    "eight executions, each recorded with its own usage",
  );
});
