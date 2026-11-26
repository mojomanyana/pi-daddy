/**
 * The one automatic retry of a replay-safe child (owner decision 2026-11-17), through the tools as the extension
 * registers them. Inert Node scripts named `pi` stand in for the child and count their own launches, so each test
 * states exactly how many child processes ran. No model, no network.
 *
 * Production changes that break this file: not retrying an eligible read-only child, retrying a second time,
 * retrying a write-capable child, a cancelled child, a stable operation or a child whose approval was spent;
 * ignoring `PI_DADDY_REPLAY_RETRY=0`; giving the retry a fresh full deadline; losing the retained retry link or the first
 * attempt's receipt; not telling the model that a retry happened; feeding a chain the first attempt's identity, or
 * dropping a later step's provenance on its retry; letting a retry on the workspace-routed path ask anyone; not
 * marking a stable operation's eligible failure `replayable`, or marking one any other guard refused;
 * re-planning a retry without the call's bound definitionId, or without checking it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import grantsExtension from "../extensions/grants.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { verifyLedger } from "../src/governance/ledger.ts";
import { openOperationArtifacts } from "../src/governance/operation-artifacts.ts";
import {
  ENV_APPROVED,
  ENV_CHILD_IDLE_TIMEOUT,
  ENV_CHILD_TIMEOUT,
  ENV_DEPTH,
  ENV_FANOUT,
  ENV_GATED,
  ENV_GRANT,
  ENV_LEDGER,
  ENV_MAX_DEPTH,
  ENV_PARENT_ID,
  ENV_PUBLIC_EVIDENCE_DIR,
  ENV_REPLAY_RETRY,
  ENV_WORKSPACE_LEASE_DIR,
  ENV_WORKSPACE_PIN,
  ENV_WORKSPACE_REGISTRY,
} from "../src/kernel/env-names.ts";
import { evidenceFromProvider } from "./execution-evidence-fixture.ts";
import { piFixtureScript } from "./pi-fixture.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { toolSources } from "./tool-sources-fixture.ts";
import { assertReleasedHarnessLedger } from "./released-harness-fixture.ts";

after(cleanupTempDirs);

const KEYS = [
  ENV_GRANT,
  ENV_DEPTH,
  ENV_MAX_DEPTH,
  ENV_GATED,
  ENV_APPROVED,
  ENV_LEDGER,
  ENV_FANOUT,
  ENV_PARENT_ID,
  ENV_REPLAY_RETRY,
  ENV_CHILD_TIMEOUT,
  ENV_CHILD_IDLE_TIMEOUT,
  ENV_PUBLIC_EVIDENCE_DIR,
  ENV_WORKSPACE_REGISTRY,
  ENV_WORKSPACE_LEASE_DIR,
  ENV_WORKSPACE_PIN,
  "PATH",
  "PI_CODING_AGENT_DIR",
  "REPLAY_FIXTURE_DIR",
];
const saved = new Map<string, string | undefined>();
afterEach(() => {
  for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
  saved.clear();
});

/**
 * A child that keys its behaviour on words in its task and counts its launches per task: `fail-once` exits 1
 * without a final on its first launch, `fail-always` on every launch, `hold-once` does so on its first launch once the
 * test writes `release`, `silent-once` goes quiet on its first launch,
 * `provider-once` exits 0 after a failed model request, `busy-always` keeps writing, anything else answers.
 */
const CHILD = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const task = process.argv.at(-1) || "";
const dir = process.env.REPLAY_FIXTURE_DIR;
const counter = path.join(dir, crypto.createHash("sha256").update(task).digest("hex").slice(0, 16));
const attempt = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(attempt));
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : null;
fs.appendFileSync(path.join(dir, "launches"), JSON.stringify({ task: task.trim(), attempt, model, execution: process.env.PI_DADDY_EXECUTION }) + "\\n");
const first = attempt === 1;
if (task.includes("fail-always") || (task.includes("fail-once") && first)) process.exit(1);
else if (task.includes("silent-once") && first) setTimeout(() => {}, 600000);
else if (task.includes("answered-idle")) {
  process.stdout.write("already answered");
  process.removeAllListeners("exit");
  __piFixture.persist(0);
  __fixtureEmit({ type: "message_end", message: __fixtureMessage(0) });
  __fixtureEmit({ type: "agent_end" });
  __fixtureEmit({ type: "agent_settled" });
  setTimeout(() => {}, 600000);
}
else if (task.includes("hold-once") && first)
  setInterval(() => fs.existsSync(path.join(dir, "release")) && process.exit(1), 20);
else if (task.includes("busy-always") || task.includes("slow-always")) setInterval(() => process.stdout.write("."), 100);
else if (task.includes("provider-once") && first) {
  process.removeAllListeners("exit");
  process.on("exit", () => {
    __piFixture.persist(1);
    __fixtureEmit({ type: "message_end", message: __fixtureMessage(1) });
    __fixtureEmit({ type: "agent_end" });
    __fixtureEmit({ type: "agent_settled" });
  });
} else process.stdout.write("answer " + attempt);
`;

interface Tool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    u: undefined,
    ctx: unknown,
  ) => Promise<any>;
}

async function harness(
  env: Record<string, string>,
  options: { durable?: boolean; answer?: "allow-once"; definitions?: Record<string, string> } = {},
) {
  const dir = await tempDir("replay-retry-");
  const fixtures = await tempDir("replay-retry-launches-");
  const bin = join(fixtures, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pi"), piFixtureScript(CHILD));
  await chmod(join(bin, "pi"), 0o755);
  for (const [name, tools] of Object.entries(options.definitions ?? {})) {
    await mkdir(join(dir, ".pi", "skills", name), { recursive: true });
    await writeFile(
      join(dir, ".pi", "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Does ${name} work.\nallowed-tools: ${tools}\n---\nDo the ${name} job.`,
    );
  }
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const k of KEYS) if (k !== "PATH") delete process.env[k];
  Object.assign(process.env, {
    PATH: `${bin}:${saved.get("PATH") ?? ""}`,
    REPLAY_FIXTURE_DIR: fixtures,
    ...(options.durable ? { PI_CODING_AGENT_DIR: dir } : {}),
    ...env,
  });
  const tools = new Map<string, Tool>();
  const hooks = new Map<string, (e: unknown, c: unknown) => unknown>();
  const activeTools = new Set(["read", "grep", "find", "ls", "bash"]);
  const prompts: string[] = [];
  const notes: string[] = [];
  const ctx = {
    ...(options.durable ? { sessionManager: { getSessionId: () => `fixture:${dir}` } } : {}),
    cwd: dir,
    hasUI: true,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "known" && ["model", "other"].includes(id) ? { provider, id } : undefined,
    },
    ui: {
      notify: (message: string) => void notes.push(message),
      select: async (title: string, choices: string[]) => {
        prompts.push(title);
        return options.answer === "allow-once" ? choices.find((choice) => choice.includes("once")) : undefined;
      },
    },
  };
  const session = createGrantsSession(
    fileURLToPath(new URL("../extensions/grants.ts", import.meta.url)),
    undefined,
    fileURLToPath(new URL("../extensions/activity-timeline.ts", import.meta.url)),
  );
  grantsExtension(
    {
      on: (name: string, handler: (e: unknown, c: unknown) => unknown) => void hooks.set(name, handler),
      registerTool: (spec: Tool & { name: string }) => void tools.set(spec.name, spec),
      registerCommand: () => {},
      getAllTools: () => toolSources(),
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => {
        activeTools.clear();
        names.forEach((name) => activeTools.add(name));
      },
      // Pi's selected skills, as the real host reports them; definitions then carry their exact identity.
      getCommands: () =>
        Object.keys(options.definitions ?? {}).map((name) => ({
          source: "skill",
          name: `skill:${name}`,
          sourceInfo: { path: join(dir, ".pi", "skills", name, "SKILL.md") },
        })),
    } as never,
    session,
  );
  await hooks.get("session_start")!({}, ctx);
  const launches = async (): Promise<
    Array<{ task: string; attempt: number; model: string | null; execution: string }>
  > => {
    try {
      return (await readFile(join(fixtures, "launches"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const call = (tool: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    tools.get(tool)!.execute(`call-${tool}`, params, signal, undefined, ctx);
  const release = () => writeFile(join(fixtures, "release"), "");
  return { dir, call, launches, prompts, notes, session, release };
}

async function ledger(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).body);
}

const GRANT = "tool:read,tool:grep,tool:delegate";
/** What Daddy says of a child that exited 1 without a final; its exit code is kept beside it. */
const NO_FINAL =
  "the sub-agent has no attributable complete final: Error: no eligible current terminal assistant message";

test("a read-only child that exits without a final is retried once and the retry's answer is returned", async () => {
  const { call, launches } = await harness({ [ENV_GRANT]: GRANT });
  const result = await call("delegate", { task: "fail-once inspect", tools: ["read", "grep"] });
  assert.equal(result.isError, false);
  assert.equal(result.content[0].text, "answer 2");
  const runs = await launches();
  assert.deepEqual(
    runs.map((run) => run.attempt),
    [1, 2],
  );
  assert.notEqual(runs[0].execution, runs[1].execution, "a fresh execution identity");
  const outcome = result.details;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, undefined);
  assert.equal(outcome.retry.attempts, 2);
  assert.equal(outcome.retry.firstFailure, "process exited without a final");
  assert.equal(outcome.retry.executionId, runs[1].execution);
  assert.equal(outcome.cleanup.identity.executionId, runs[1].execution);
  assert.equal(outcome.retry.first.exitCode, 1);
  assert.equal(outcome.retry.first.cleanup.identity.executionId, runs[0].execution, "first receipt kept whole");
  // The model is told, in one fixed phrase, and is given only the retry's identity.
  const summary = evidenceFromProvider(result).outcomes[0];
  assert.deepEqual(summary.retry, { attempts: 2, firstFailure: "process exited without a final" });
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.cleanup, { state: "settled", identity: { executionId: runs[1].execution } });
  assert.ok(!JSON.stringify(summary).includes(runs[0].execution), "the first identity stays in details");
});

test("a second failure reports both attempts and there is never a third", async () => {
  const { call, launches } = await harness({ [ENV_GRANT]: GRANT });
  const result = await call("delegate", { task: "fail-always inspect", tools: ["read"] });
  assert.equal(result.isError, true);
  assert.deepEqual(
    (await launches()).map((run) => run.attempt),
    [1, 2],
  );
  assert.equal(result.details.reason, `${NO_FINAL}; first attempt: ${NO_FINAL}`);
  assert.equal(result.details.exitCode, 1);
  assert.equal(result.details.refusal.code, "CHILD_EXIT_NONZERO");
  assert.equal(result.details.retry.first.reason, NO_FINAL);
  assert.equal(result.details.retry.first.exitCode, 1);
  assert.match(result.content[0].text, /^delegation failed: .*first attempt: /);
  assert.deepEqual(evidenceFromProvider(result).outcomes[0].retry, {
    attempts: 2,
    firstFailure: "process exited without a final",
  });
});

test("delegate_describe and the startup summary mark replay-safe definitions from their tools", async () => {
  const { call, notes } = await harness(
    { [ENV_GRANT]: `${GRANT},tool:bash,agent:look,agent:fix` },
    { definitions: { look: "read, grep, context:files", fix: "read, bash" } },
  );
  const describe = async (agent: string) => JSON.parse((await call("delegate_describe", { agent })).content[0].text);
  assert.equal((await describe("look")).replaySafe, true);
  assert.equal((await describe("fix")).replaySafe, false);
  assert.ok(
    notes.some((note) =>
      note.endsWith(
        "\n  replay-safe (retried once automatically if it fails without answering; with operation_id, marked " +
          "replayable for the coordinator to retry instead): look",
      ),
    ),
    JSON.stringify(notes),
  );
});

test("PI_DADDY_REPLAY_RETRY=0 stops the retry and the marking stays", async () => {
  const { call, launches, notes } = await harness(
    { [ENV_GRANT]: `${GRANT},agent:look`, [ENV_REPLAY_RETRY]: "0" },
    { definitions: { look: "read, grep" } },
  );
  const result = await call("delegate", { task: "fail-always look", agent: "look" });
  assert.equal(result.isError, true);
  assert.equal((await launches()).length, 1);
  assert.equal(result.details.retry, undefined);
  assert.equal(result.details.reason, NO_FINAL);
  const described = await call("delegate_describe", { agent: "look" });
  assert.equal(JSON.parse(described.content[0].text).replaySafe, true);
  assert.ok(
    notes.some((note) =>
      note.endsWith("\n  replay-safe (not retried or marked replayable: switched off by PI_DADDY_REPLAY_RETRY): look"),
    ),
    JSON.stringify(notes),
  );
});

test("a malformed PI_DADDY_REPLAY_RETRY is off and reported at startup", async () => {
  const { call, launches, notes } = await harness({ [ENV_GRANT]: GRANT, [ENV_REPLAY_RETRY]: "yes" });
  assert.ok(
    notes.includes(
      "grants: PI_DADDY_REPLAY_RETRY must be literal 1 or 0 — no failed child is retried automatically (failing closed)",
    ),
    JSON.stringify(notes),
  );
  await call("delegate", { task: "fail-once inspect", tools: ["read"] });
  assert.equal((await launches()).length, 1);
});

test("a child holding a shell is never retried", async () => {
  const { call, launches } = await harness({ [ENV_GRANT]: `${GRANT},tool:bash`, [ENV_GATED]: "" });
  const result = await call("delegate", { task: "fail-always inspect", tools: ["read", "bash"] });
  assert.equal(result.isError, true);
  assert.equal((await launches()).length, 1);
  assert.equal(result.details.retry, undefined);
});

test("a child the parent cancelled is never retried", async () => {
  const { call, launches } = await harness({ [ENV_GRANT]: GRANT });
  const controller = new AbortController();
  const pending = call("delegate", { task: "slow-always inspect", tools: ["read"] }, controller.signal);
  for (let i = 0; i < 100 && (await launches()).length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  const result = await pending;
  assert.equal(result.details.aborted, true);
  assert.equal(result.details.retry, undefined);
  assert.equal((await launches()).length, 1);
});

test("a child whose first attempt spent an approval is never retried", async () => {
  const { call, launches, prompts } = await harness(
    { [ENV_GRANT]: GRANT, [ENV_GATED]: "tool:grep" },
    { answer: "allow-once" },
  );
  const result = await call("delegate", { task: "fail-once inspect", tools: ["read", "grep"] });
  assert.equal(prompts.length, 1, "one human answer, for one spawn");
  assert.equal(result.isError, true);
  assert.equal((await launches()).length, 1);
  assert.equal(result.details.retry, undefined);
  assert.equal(result.details.reason, NO_FINAL, "no second attempt was even planned");
});

test("a chain step that spent an upfront approval is never retried", async () => {
  const { call, launches, prompts } = await harness(
    { [ENV_GRANT]: GRANT, [ENV_GATED]: "tool:grep", [ENV_FANOUT]: "4" },
    { answer: "allow-once" },
  );
  const result = await call("delegate_chain", { steps: [{ task: "fail-once first", tools: ["read", "grep"] }] });
  assert.equal(prompts.length, 1, "asked once, before any step ran");
  assert.equal((await launches()).length, 1);
  assert.equal(result.details.outcomes[0].retry, undefined);
  assert.equal(result.details.outcomes[0].reason, NO_FINAL, "no second attempt was even planned");
  assert.equal(result.details.aborted, true);
});

test("a retry asks nobody: a gate that appears after the first attempt refuses it instead of prompting", async () => {
  const { call, launches, prompts, session, release } = await harness(
    { [ENV_GRANT]: GRANT, [ENV_GATED]: "" },
    { answer: "allow-once" },
  );
  const pending = call("delegate", { task: "hold-once inspect", tools: ["read", "grep"] });
  for (let i = 0; i < 500 && (await launches()).length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  session.gated = ["tool:grep"];
  await release();
  const result = await pending;
  assert.equal(prompts.length, 0);
  assert.equal((await launches()).length, 1);
  assert.equal(result.details.retry, undefined);
  assert.equal(result.details.reason, `${NO_FINAL}; automatic retry not started: tool:grep requires explicit approval`);
});

test("the retry keeps the first attempt's model even if the session's choice changes in between", async () => {
  const { call, launches, session, release } = await harness(
    { [ENV_GRANT]: `${GRANT},agent:look` },
    { definitions: { look: "read, grep" } },
  );
  session.definitionRuntimeOverrides.set("look", { model: "known/model" });
  const pending = call("delegate", { task: "hold-once look", agent: "look" });
  for (let i = 0; i < 500 && (await launches()).length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  session.definitionRuntimeOverrides.set("look", { model: "known/other" });
  await release();
  const result = await pending;
  assert.equal(result.isError, false);
  const [first, second] = (await launches()).map((run) => run.model);
  assert.match(first ?? "", /model$/);
  assert.equal(second, first);
});

test("both attempts are in the ledger without expanding its contract, and inherit the first deadline", async () => {
  const dir = await tempDir("replay-retry-ledger-");
  const path = join(dir, "ledger.jsonl");
  const { call, launches } = await harness({ [ENV_GRANT]: GRANT, [ENV_LEDGER]: path });
  const result = await call("delegate", { task: "fail-once inspect", tools: ["read"] });
  const [first, second] = (await launches()).map((run) => run.execution);
  const events = await ledger(path);
  const decisions = events.filter((event) => event.event === "capability_decision");
  assert.deepEqual(
    decisions.map((event) => [event.executionId, event.retryOf ?? null, event.blocked]),
    [
      [first, null, false],
      [second, null, false],
    ],
  );
  assert.equal(decisions[0].childId, decisions[1].childId, "same logical position");
  assert.equal(decisions[0].taskDigest, decisions[1].taskDigest, "same task");
  assert.deepEqual(decisions[0].effective, decisions[1].effective);
  const lifecycle = (id: string, state: string) =>
    events.find((event) => event.event === "child_lifecycle" && event.executionId === id && event.state === state);
  assert.equal(lifecycle(first, "failed")?.exitCode, 1);
  assert.equal(lifecycle(second, "completed")?.exitCode, 0);
  assert.ok(
    Date.parse(lifecycle(second, "starting").deadlineAt) <= Date.parse(lifecycle(first, "starting").deadlineAt),
    "the retry may not run past the first attempt's deadline",
  );
  assert.equal(result.details.retry.executionId, second);
  assert.equal(result.details.retry.first.cleanup.identity.executionId, first);
  assert.equal((await verifyLedger(path)).ok, true, "the closed reader accepts both ordinary records");
  await assertReleasedHarnessLedger(await readFile(path, "utf8"));
});

test("a complete final followed by idle timeout is kept without automatic retry or a replayable mark", async () => {
  const { call, launches } = await harness(
    { [ENV_GRANT]: GRANT, [ENV_CHILD_IDLE_TIMEOUT]: "2", [ENV_CHILD_TIMEOUT]: "15" },
    { durable: true },
  );
  for (const spec of [
    { task: "answered-idle direct", tools: ["read"] },
    { task: "answered-idle operation", tools: ["read"], operation_id: "read:answered-timeout" },
  ]) {
    const result = await call("delegate", spec);
    assert.equal(result.details.timedOut, true);
    assert.equal(result.details.final.state, "complete");
    assert.equal(result.details.final.text, "already answered");
    assert.equal(result.details.cleanup.state, "settled");
    assert.equal(result.details.retry, undefined);
    assert.equal(result.details.replayable, undefined);
  }
  assert.equal((await launches()).length, 2, "one execution per request, including the operation-bound request");
});

test("a stable operation is never retried: its eligible failure is marked replayable, and a reuse is not", async () => {
  const { call, launches } = await harness({ [ENV_GRANT]: GRANT }, { durable: true });
  const spec = { operation_id: "investigate:replay", task: "fail-once inspect", tools: ["read"] };
  const result = await call("delegate", spec);
  assert.equal(result.isError, true);
  assert.equal((await launches()).length, 1);
  assert.equal(result.details.retry, undefined);
  assert.equal(result.details.replayable, true, "the operation's owner may retry it once");
  assert.equal(result.details.reason, NO_FINAL, "nothing about a retry is claimed");
  assert.equal(result.details.operation.reused, false);
  assert.equal(result.details.operation.state, "settled");
  assert.equal(result.details.operation.executionId, (await launches())[0].execution);
  const summary = evidenceFromProvider(result).outcomes[0];
  assert.equal(summary.replayable, true);
  assert.equal(summary.retry, undefined);
  const again = await call("delegate", spec);
  assert.equal((await launches()).length, 1, "no new child");
  assert.equal(again.isError, false, "as before this change: a reference, not a result");
  assert.equal(again.details.operation.reused, true);
  assert.equal(again.details.ok, false);
  assert.equal(again.details.operation.runtime.work, "failed");
  assert.equal(again.details.replayable, undefined, "a reference is not an attempt");
  assert.equal("replayable" in evidenceFromProvider(again).outcomes[0], false);
});

test("a stable operation's failure is not marked replayable when any other guard refuses", async () => {
  const operation = (task: string, tools: string[]) => ({
    operation_id: `investigate:${task.replaceAll(" ", "-")}`,
    task,
    tools,
  });
  const unmarked = async (name: string, result: any, launched: number, runs: () => Promise<unknown[]>) => {
    assert.equal(result.details.ok, false, name);
    assert.equal(result.details.replayable, undefined, name);
    assert.equal("replayable" in evidenceFromProvider(result).outcomes[0], false, name);
    assert.equal((await runs()).length, launched, name);
  };
  // Not replay-safe: the plan holds a shell.
  {
    const { call, launches } = await harness({ [ENV_GRANT]: `${GRANT},tool:bash`, [ENV_GATED]: "" }, { durable: true });
    await unmarked("shell", await call("delegate", operation("fail-always shell", ["read", "bash"])), 1, launches);
  }
  // Kill switch off.
  {
    const { call, launches } = await harness({ [ENV_GRANT]: GRANT, [ENV_REPLAY_RETRY]: "0" }, { durable: true });
    await unmarked("switched off", await call("delegate", operation("fail-always off", ["read"])), 1, launches);
  }
  // An approval was spent on the attempt.
  {
    const { call, launches, prompts } = await harness(
      { [ENV_GRANT]: GRANT, [ENV_GATED]: "tool:grep" },
      { durable: true, answer: "allow-once" },
    );
    await unmarked("approval", await call("delegate", operation("fail-always gated", ["read", "grep"])), 1, launches);
    assert.equal(prompts.length, 1);
  }
  // The parent cancelled the attempt.
  {
    const { call, launches } = await harness({ [ENV_GRANT]: GRANT }, { durable: true });
    const controller = new AbortController();
    const pending = call("delegate", operation("slow-always cancelled", ["read"]), controller.signal);
    for (let i = 0; i < 100 && (await launches()).length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const result = await pending;
    assert.equal(result.details.aborted, true);
    await unmarked("parent abort", result, 1, launches);
  }
  // The operation's status could not be recorded: a failed control step, so no mark either.
  {
    const { call, launches, session } = await harness(
      { [ENV_GRANT]: `${GRANT},agent:look` },
      { durable: true, definitions: { look: "read" } },
    );
    await call("delegate_describe", { agent: "look" });
    const operations = session.autoMode!.operations! as { claim: (...args: any[]) => Promise<any> };
    const claim = operations.claim.bind(operations);
    const unfinished: Array<() => Promise<unknown>> = [];
    operations.claim = async (...args) => {
      const owned = await claim(...args);
      if (!owned.reused) {
        const finish = owned.finish.bind(owned);
        unfinished.push(() => finish("uncertain"));
        owned.finish = async () => {
          throw new Error("operation registry unavailable");
        };
      }
      return owned;
    };
    const failedSpec = { ...operation("fail-always unrecorded", ["read"]), agent: "look" };
    const result = await call("delegate", failedSpec);
    // The live registry still holds the operation as running; settle it so the owner can close.
    for (const finish of unfinished) await finish();
    assert.equal(result.details.control, "failed");
    assert.match(result.details.reason, /operation status update failed: Error: operation registry unavailable$/);
    await unmarked("control failed", result, 1, launches);
    assert.equal(
      session.reloadLifecycle.operationFinals!.artifacts!.history(failedSpec.operation_id)?.operation.runtime
        ?.automaticRetryEligibility,
      undefined,
      "failed owner settlement must not publish durable automatic-retry evidence",
    );
  }
});

test("delegate_all retries per child, leaving a sibling that succeeded alone", async () => {
  const { call, launches } = await harness({ [ENV_GRANT]: GRANT });
  const result = await call("delegate_all", {
    children: [
      { task: "fail-once alpha", tools: ["read"] },
      { task: "beta", tools: ["read"] },
    ],
  });
  assert.equal(result.isError, false);
  const runs = await launches();
  assert.deepEqual(runs.map((run) => `${run.task}#${run.attempt}`).sort(), [
    "beta#1",
    "fail-once alpha#1",
    "fail-once alpha#2",
  ]);
  const [alpha, beta] = result.details.outcomes;
  assert.equal(alpha.retry.attempts, 2);
  assert.equal(beta.retry, undefined);
  assert.deepEqual(
    evidenceFromProvider(result).outcomes.map((outcome: any) => outcome.retry ?? null),
    [{ attempts: 2, firstFailure: "process exited without a final" }, null],
  );
});

test("delegate_chain retries a step before deciding to continue, and the next step names the retry", async () => {
  const dir = await tempDir("replay-retry-chain-ledger-");
  const path = join(dir, "ledger.jsonl");
  const { call, launches } = await harness({ [ENV_GRANT]: GRANT, [ENV_LEDGER]: path, [ENV_FANOUT]: "4" });
  const result = await call("delegate_chain", {
    steps: [
      { task: "fail-once first", tools: ["read"] },
      { task: "fail-once second uses {previous}", tools: ["read"] },
    ],
  });
  assert.equal(result.isError, false);
  assert.equal(result.details.aborted, false);
  const runs = await launches();
  assert.equal(runs.length, 4);
  assert.match(runs[2].task, /second uses[\s\S]*answer 2/, "the retry's answer composed the next task");
  assert.equal(runs[3].task, runs[2].task, "a later step's retry has the same composed task");
  const decisions = (await ledger(path)).filter((event) => event.event === "capability_decision");
  assert.deepEqual(
    decisions.map((event) => [event.executionId, event.retryOf ?? null, event.taskFromExecutionId ?? null]),
    [
      [runs[0].execution, null, null],
      [runs[1].execution, null, null],
      // ADR-0033 provenance names the execution that wrote the input, for the step and for its retry alike.
      [runs[2].execution, null, runs[1].execution],
      [runs[3].execution, null, runs[1].execution],
    ],
  );
  assert.equal(result.details.outcomes[0].retry.attempts, 2);
  assert.equal(result.details.outcomes[1].retry.attempts, 2);
});

test("a retry on the workspace-routed path asks nobody either", async () => {
  // Review finding 4 (M1b): the routed path plans through its own approval call, which no other test reached.
  const dir = await tempDir("replay-retry-workspace-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "base"],
    { cwd: dir },
  );
  const config = await tempDir("replay-retry-workspace-config-");
  const registry = join(config, "registry.json");
  await writeFile(registry, JSON.stringify({ version: 1, workspaces: { w1: { path: dir } } }));
  const { call, launches, prompts, session, release } = await harness(
    {
      [ENV_GRANT]: `${GRANT},workspace:w1`,
      [ENV_GATED]: "",
      [ENV_WORKSPACE_REGISTRY]: registry,
      [ENV_WORKSPACE_LEASE_DIR]: join(config, "leases"),
    },
    { answer: "allow-once" },
  );
  const pending = call("delegate", {
    task: "hold-once routed",
    tools: ["read", "grep"],
    workspace: { workspace_id: "w1", access: "read" },
  });
  for (let i = 0; i < 500 && (await launches()).length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  session.gated = ["tool:grep"];
  await release();
  const result = await pending;
  assert.equal(prompts.length, 0, "the retry asked nobody");
  assert.equal((await launches()).length, 1);
  assert.equal(result.details.cwd, dir, "the first attempt ran in the routed workspace");
  assert.equal(result.details.retry, undefined);
  assert.equal(result.details.reason, `${NO_FINAL}; automatic retry not started: tool:grep requires explicit approval`);
});

test("an idle timeout is retried with the time that remains; a wall-clock timeout leaves none", async () => {
  const idle = await harness({ [ENV_GRANT]: GRANT, [ENV_CHILD_IDLE_TIMEOUT]: "1", [ENV_CHILD_TIMEOUT]: "60" });
  const quiet = await idle.call("delegate", { task: "silent-once inspect", tools: ["read"] });
  assert.equal(quiet.isError, false);
  assert.equal(quiet.details.retry.firstFailure, "timed out");
  assert.equal(quiet.details.retry.first.timedOut, true);
  assert.equal((await idle.launches()).length, 2);

  const wall = await harness({ [ENV_GRANT]: GRANT, [ENV_CHILD_IDLE_TIMEOUT]: "1", [ENV_CHILD_TIMEOUT]: "2" });
  const busy = await wall.call("delegate", { task: "busy-always inspect", tools: ["read"] });
  assert.equal(busy.details.timedOut, true);
  assert.equal(busy.details.retry, undefined);
  assert.equal((await wall.launches()).length, 1);
});

test("a failed model request with exit 0 is retried as a provider failure", async () => {
  const { call, launches } = await harness({ [ENV_GRANT]: GRANT });
  const result = await call("delegate", { task: "provider-once inspect", tools: ["read"] });
  assert.equal(result.isError, false);
  assert.equal(result.details.retry.firstFailure, "provider request failed");
  assert.equal(result.details.retry.first.exitCode, 0);
  assert.equal(result.details.retry.first.final.providerError, true);
  assert.equal((await launches()).length, 2);
});

test("public capture names the retry as the execution that answered, and keeps the first attempt complete", async () => {
  const { call, launches } = await harness({
    [ENV_GRANT]: GRANT,
    [ENV_PUBLIC_EVIDENCE_DIR]: await tempDir("replay-retry-capture-"),
  });
  const result = await call("delegate", { task: "fail-once inspect", tools: ["read"] });
  const [first, retry] = (await launches()).map((run) => run.execution);
  const status = JSON.parse(result.content.at(-1).text.slice("Public evidence capture: ".length));
  assert.equal(status.status, "captured");
  const manifest = JSON.parse(await readFile(status.ref.path, "utf8"));
  assert.equal(manifest.requested[0].executionId, retry);
  assert.equal(manifest.finals[0].executionId, retry);
  assert.equal(manifest.finals[0].final.sha256, result.details.final.sha256);
  const complete = manifest.runtimeEvidence.outcomes[0];
  assert.equal(complete.cleanup.identity.executionId, retry);
  assert.equal(complete.retry.first.cleanup.identity.executionId, first);
  assert.equal(complete.retry.first.final.state, "unavailable");
});

test("a retry and a replayable mark keep the definition the call bound; one changed in between refuses the retry", async () => {
  // Integration with the session's definition binding (2026-11-17). The retry re-plans the same spec, so it re-checks
  // the bound definitionId like any call; the mark changes neither the binding, the describe memory nor the request
  // an `operation_id` names.
  const path = join(await tempDir("replay-retry-binding-"), "ledger.jsonl");
  const { dir, call, launches, session, release } = await harness(
    { [ENV_GRANT]: `${GRANT},agent:look`, [ENV_LEDGER]: path },
    { durable: true, definitions: { look: "read, grep" } },
  );
  const { definitionId } = JSON.parse((await call("delegate_describe", { agent: "look" })).content[0].text);
  const remembered = { definitionId, source: "remembered" };
  const memory = () => [...(session.reloadLifecycle.describedDefinitions ?? new Map())];

  const retried = await call("delegate", { task: "fail-once bound", agent: "look" });
  assert.equal(retried.details.retry.attempts, 2);
  assert.deepEqual(retried.details.definitionBinding, remembered);
  const decisions = (await ledger(path)).filter((event) => event.event === "capability_decision");
  assert.equal(decisions.length, 2);
  assert.equal(decisions[1].retryOf, undefined);
  assert.equal(retried.details.retry.first.cleanup.identity.executionId, decisions[0].executionId);
  assert.equal(retried.details.retry.executionId, decisions[1].executionId);
  assert.deepEqual(
    decisions[1].definitionDigest,
    decisions[0].definitionDigest,
    "the retry planned the same definition",
  );
  assert.deepEqual(memory(), [["look", definitionId]]);

  const spec = { task: "fail-always marked", agent: "look", operation_id: "investigate:bound" };
  const marked = await call("delegate", spec);
  assert.equal(marked.details.replayable, true);
  assert.deepEqual(marked.details.definitionBinding, remembered);
  assert.deepEqual(memory(), [["look", definitionId]]);
  const proof = {
    version: 1,
    eligible: true,
    operationId: spec.operation_id,
    executionId: marked.details.operation.executionId,
    definitionId,
  };
  const freshStore = openOperationArtifacts(dir, { sessionId: `fixture:${dir}`, cwd: dir });
  assert.deepEqual(
    freshStore.history(spec.operation_id)?.operation.runtime?.automaticRetryEligibility,
    proof,
    "the original owner retains exact eligibility independently of the in-memory tool result",
  );
  // The same request again is the same operation, with the ID remembered or supplied: a reference, not a conflict.
  for (const again of [spec, { ...spec, definitionId }]) {
    const reused = await call("delegate", again);
    assert.equal(reused.details.operation.reused, true);
    assert.equal(reused.details.replayable, undefined);
  }
  // The coordinator's one retry under a new operation binds the same definition.
  const coordinator = await call("delegate", { ...spec, operation_id: "investigate:bound-retry" });
  assert.equal(coordinator.details.operation.reused, false);
  assert.deepEqual(coordinator.details.definitionBinding, remembered);

  // A definition that changes while the first attempt runs: the retry is refused by the identity check and the first
  // attempt is the answer, still naming the definition it ran.
  const before = (await launches()).length;
  const pending = call("delegate", { task: "hold-once bound", agent: "look" });
  for (let i = 0; i < 500 && (await launches()).length === before; i += 1) await new Promise((r) => setTimeout(r, 10));
  session.definitions.set("look", { ...session.definitions.get("look")!, definitionId: "def:changed-meanwhile" });
  await release();
  const refused = await pending;
  assert.equal((await launches()).length, before + 1, "no second launch");
  assert.equal(refused.details.retry, undefined);
  assert.deepEqual(refused.details.definitionBinding, remembered);
  assert.match(
    refused.details.reason,
    /; automatic retry not started: Definition snapshot changed or is unavailable for agent "look": it changed since this session described it\. Describe it again with delegate_describe\./,
  );
  assert.deepEqual(memory(), [["look", definitionId]]);
});
