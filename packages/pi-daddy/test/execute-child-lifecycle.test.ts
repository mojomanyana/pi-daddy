import { piFixtureScript } from "./pi-fixture.ts";
import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import {
  appendAfterRuntimeRecord,
  executePlannedChild,
  isHerdrWriterCloseFailure,
} from "../extensions/execute-child.ts";
import type { GrantsSession } from "../extensions/session.ts";
import type { Delegation } from "../src/kernel/delegate.ts";
import { runWithFinalizers } from "../src/governance/finalization.ts";
import { HerdrWriterCloseError } from "../src/executors/run-herdr.ts";
import { ENV_CHILD_IDLE_TIMEOUT, ENV_CHILD_TIMEOUT } from "../src/kernel/run-child.ts";
import {
  CHILD_ATTRIBUTION_ENV_KEYS,
  ENV_CHILD_DEFINITION,
  ENV_CHILD_EPISODE,
  ENV_CHILD_EXECUTION,
} from "../src/kernel/env-names.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const executionId = "exec:00000000-0000-4000-8000-000000000001";

function plan(): Delegation {
  return {
    ok: true,
    args: [],
    env: {},
    effective: [],
    result: { effective: [], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    childDepth: 1,
    requested: [],
    definitionHash: "b".repeat(64),
    definitionPackageVersion: "2.3.1",
    taskDigest: "a".repeat(64),
  };
}

test("an attached Herdr close failure still retains the writer lease", async () => {
  let caught: unknown;
  try {
    await runWithFinalizers(async () => {
      throw new Error("primary executor failure");
    }, [
      {
        label: "finalizer failed",
        run: () => {
          throw new HerdrWriterCloseError("w1:t9");
        },
      },
    ]);
  } catch (error) {
    caught = error;
  }
  assert.equal(isHerdrWriterCloseFailure(caught), true);
});

test("a terminal lifecycle append waits for the running append it follows", async () => {
  const order: string[] = [];
  let release!: () => void;
  const running = new Promise<void>((resolve) => {
    release = resolve;
  }).then(() => {
    order.push("running");
  });
  const terminal = appendAfterRuntimeRecord(running, async () => {
    order.push("terminal");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], "terminal must not overtake a pending running append");
  release();
  await terminal;
  assert.deepEqual(order, ["running", "terminal"]);
});

test("a SIGTERM-ignoring child is hard-killed by the recorded lifecycle deadline", async () => {
  const dir = await tempDir("execute-child-hard-deadline-");
  const bin = join(dir, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  const shim = join(bin, "pi");
  await writeFile(
    shim,
    "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n",
    "utf8",
  );
  await chmod(shim, 0o755);

  const ledgerPath = join(dir, "ledger.jsonl");
  const oldPath = process.env.PATH;
  const oldTimeout = process.env[ENV_CHILD_TIMEOUT];
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  process.env[ENV_CHILD_TIMEOUT] = "1";

  try {
    const outcome = await executePlannedChild({
      session: { ledgerPath, executor: { kind: "process" } } as GrantsSession,
      plan: plan(),
      childId: "d0.1",
      executionId,
      parentExecutionId: null,
      cwd: dir,
    });
    assert.equal(outcome.timedOut, true);

    const events = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).body);
    const starting = events.find((event) => event.state === "starting");
    const terminal = events.find((event) => event.state === "failed");
    assert.ok(starting?.deadlineAt && terminal?.ts);
    assert.ok(
      Date.parse(terminal.ts) <= Date.parse(starting.deadlineAt) + 150,
      `terminal observation lagged the hard deadline by ${Date.parse(terminal.ts) - Date.parse(starting.deadlineAt)}ms`,
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env[ENV_CHILD_TIMEOUT];
    else process.env[ENV_CHILD_TIMEOUT] = oldTimeout;
  }
});

test("reported cost never pauses or stops a live child", async () => {
  const dir = await tempDir("execute-child-cost-gate-");
  const bin = join(dir, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  const shim = join(bin, "pi");
  await writeFile(
    shim,
    piFixtureScript(`#!/usr/bin/env node
const fs = require("node:fs");
const path = process.argv[process.argv.indexOf("--session") + 1];
const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
  cost: { input: 0.8, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 1 } };
__piFixture.usage=usage; __piFixture.provider="p"; __piFixture.model="m"; __piFixture.persist();
setTimeout(() => { console.log("completed despite cost"); }, 1200);
`),
    "utf8",
  );
  await chmod(shim, 0o755);
  const ledgerPath = join(dir, "ledger.jsonl");
  const oldPath = process.env.PATH;
  const oldTimeout = process.env[ENV_CHILD_TIMEOUT];
  const oldIdle = process.env[ENV_CHILD_IDLE_TIMEOUT];
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  process.env[ENV_CHILD_TIMEOUT] = "10";
  process.env[ENV_CHILD_IDLE_TIMEOUT] = "10";
  try {
    const outcome = await executePlannedChild({
      session: {
        ledgerPath,
        executor: { kind: "process" },
        episodeId: "episode:00000000-0000-4000-8000-000000000001",
      } as GrantsSession,
      plan: { ...plan(), args: [" task"] },
      childId: "d0.1",
      executionId,
      parentExecutionId: null,
      cwd: dir,
    });
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /completed despite cost/);
    const events = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).body);
    assert.deepEqual(
      events.filter((event) => event.event === "cost_gate").map((event) => event.outcome),
      [],
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env[ENV_CHILD_TIMEOUT];
    else process.env[ENV_CHILD_TIMEOUT] = oldTimeout;
    if (oldIdle === undefined) delete process.env[ENV_CHILD_IDLE_TIMEOUT];
    else process.env[ENV_CHILD_IDLE_TIMEOUT] = oldIdle;
  }
});

test("PR 3e: a silent child is stopped by the inactivity bound, recorded as idle, and told why", async () => {
  // Breaks by: not passing idleTimeoutMs/activityProbe to runChild, or dropping idleTimeoutMs from the starting event.
  const dir = await tempDir("execute-child-idle-");
  const bin = join(dir, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  const shim = join(bin, "pi");
  await writeFile(shim, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", "utf8");
  await chmod(shim, 0o755);
  const ledgerPath = join(dir, "ledger.jsonl");
  const oldPath = process.env.PATH,
    oldTimeout = process.env[ENV_CHILD_TIMEOUT],
    oldIdle = process.env[ENV_CHILD_IDLE_TIMEOUT];
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  process.env[ENV_CHILD_TIMEOUT] = "60"; // the ceiling is a minute away; idleness must fire first
  process.env[ENV_CHILD_IDLE_TIMEOUT] = "1";
  try {
    const started = Date.now();
    const outcome = await executePlannedChild({
      session: { ledgerPath, executor: { kind: "process" } } as GrantsSession,
      plan: plan(),
      childId: "d0.1",
      executionId,
      parentExecutionId: null,
      cwd: dir,
    });
    assert.equal(outcome.timedOut, true);
    assert.ok(Date.now() - started < 20_000, "the one-minute ceiling did not do this");
    assert.match(
      outcome.ok ? "" : (outcome.reason ?? ""),
      /showed no activity for 1 second\(s\) and was killed \(PI_DADDY_CHILD_IDLE_TIMEOUT/,
    );
    const events = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).body);
    assert.equal(events.find((event) => event.state === "starting")?.idleTimeoutMs, 1000);
    assert.equal(events.find((event) => event.state === "failed")?.reason, "idle-timeout");
    assert.equal(events.find((event) => event.state === "failed")?.usageUnavailable, "session-missing");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env[ENV_CHILD_TIMEOUT];
    else process.env[ENV_CHILD_TIMEOUT] = oldTimeout;
    if (oldIdle === undefined) delete process.env[ENV_CHILD_IDLE_TIMEOUT];
    else process.env[ENV_CHILD_IDLE_TIMEOUT] = oldIdle;
  }
});

test("failed lifecycle observations preserve verified output and dispose temporary session", async () => {
  const { readdir, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await tempDir("execute-child-dispose-");
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pi"), piFixtureScript("console.log('verified output')"));
  await chmod(join(bin, "pi"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  const listExec = async () => new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-daddy-exec_")));
  const before = await listExec();
  try {
    const result = await executePlannedChild({
      session: { ledgerPath: dir, executor: { kind: "process" } } as GrantsSession,
      plan: plan(),
      childId: "d0.1",
      executionId,
      parentExecutionId: null,
      cwd: dir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.work, "succeeded");
    assert.equal(result.final?.state, "complete");
    assert.equal(result.cleanup?.state, "settled");
    assert.equal(result.observation?.state, "incomplete");
    assert.match(result.text, /verified output/);
    assert.deepEqual(
      [...(await listExec())].filter((name) => !before.has(name)),
      [],
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test("a governed child sees exactly the three work-attribution variables", async () => {
  const dir = await tempDir("execute-child-attribution-env-");
  const bin = join(dir, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  const shim = join(bin, "pi");
  await writeFile(
    shim,
    piFixtureScript(`#!/usr/bin/env node
const keys = ${JSON.stringify(["PI_DADDY_EPISODE", "PI_DADDY_DEFINITION", "PI_DADDY_EXECUTION"])};
console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));
`),
    "utf8",
  );
  await chmod(shim, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  try {
    const childPlan = plan();
    childPlan.env = {
      [ENV_CHILD_EPISODE]: "episode:00000000-0000-4000-8000-000000000099",
      [ENV_CHILD_DEFINITION]: "review-security",
      [ENV_CHILD_EXECUTION]: executionId,
    };
    const outcome = await executePlannedChild({
      session: { executor: { kind: "process" } } as GrantsSession,
      plan: childPlan,
      childId: "d0.1",
      executionId,
      parentExecutionId: null,
      cwd: dir,
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(JSON.parse(outcome.text), {
      [ENV_CHILD_EPISODE]: "episode:00000000-0000-4000-8000-000000000099",
      [ENV_CHILD_DEFINITION]: "review-security",
      [ENV_CHILD_EXECUTION]: executionId,
    });
    assert.deepEqual(CHILD_ATTRIBUTION_ENV_KEYS, [ENV_CHILD_EPISODE, ENV_CHILD_DEFINITION, ENV_CHILD_EXECUTION]);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test("terminal lifecycle captures child usage before disposing the private session", async () => {
  const dir = await tempDir("execute-child-usage-");
  const bin = join(dir, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  const shim = join(bin, "pi");
  await writeFile(
    shim,
    piFixtureScript(`#!/usr/bin/env node
const fs = require("node:fs");
const path = process.argv[process.argv.indexOf("--session") + 1];
const usage = {input:7,output:2,cacheRead:3,cacheWrite:1,reasoning:1,totalTokens:14,cost:{input:0.07,output:0.02,cacheRead:0.01,cacheWrite:0.01,total:0.11}};
__piFixture.usage=usage; __piFixture.provider="openai-codex"; __piFixture.model="gpt-5.3-codex";
__piFixture.entries=[{type:"model_change",provider:"openai-codex",modelId:"gpt-5.3-codex"}, {type:"thinking_level_change",thinkingLevel:"high"}, {type:"compaction",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}];
console.log("done");
`),
    "utf8",
  );
  await chmod(shim, 0o755);
  const ledgerPath = join(dir, "ledger.jsonl");
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  try {
    const outcome = await executePlannedChild({
      session: { ledgerPath, executor: { kind: "process" } } as GrantsSession,
      plan: plan(),
      childId: "d0.1",
      executionId,
      parentExecutionId: null,
      cwd: dir,
      resolvedRuntime: { modelSource: "pi", thinking: "high", thinkingSource: "explicit" },
    });
    assert.equal(outcome.ok, true);
    const text = await readFile(ledgerPath, "utf8");
    const events = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).body);
    assert.ok(events.every((event) => event.modelSource === "pi" && event.thinkingSource === "explicit"));
    const completed = events.find((event) => event.state === "completed");
    assert.deepEqual(completed?.usage, {
      input: 7,
      output: 2,
      cacheRead: 3,
      cacheWrite: 1,
      reasoning: 1,
      totalTokens: 14,
      cost: { input: 0.07, output: 0.02, cacheRead: 0.01, cacheWrite: 0.01, total: 0.11 },
    });
    assert.deepEqual(completed?.resolvedModel, { provider: "openai-codex", modelId: "gpt-5.3-codex" });
    assert.deepEqual(completed?.thinkingLevel, { level: "high", source: "explicit" });
    assert.deepEqual(completed?.tokenDetail, {
      inputTokens: 7,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      reasoningTokens: 1,
    });
    assert.equal(completed?.compactionCount, 1);
    assert.equal(completed?.definitionHash, "b".repeat(64));
    assert.equal(completed?.definitionPackageVersion, "2.3.1");
    assert.deepEqual(completed?.exportedEnvironment, [...CHILD_ATTRIBUTION_ENV_KEYS]);
    assert.doesNotMatch(text, /PRIVATE CHILD/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test("the executor receives only the time remaining on the recorded lifecycle deadline", async () => {
  const dir = await tempDir("execute-child-deadline-");
  const bin = join(dir, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  const shim = join(bin, "pi");
  await writeFile(
    shim,
    "#!/usr/bin/env node\nconsole.log(Date.now());\nsetTimeout(() => process.exit(0), 600);\n",
    "utf8",
  );
  await chmod(shim, 0o755);

  const ledgerPath = join(dir, "ledger.jsonl");
  await writeFile(`${ledgerPath}.lock`, "held by the test\n", "utf8");
  const oldPath = process.env.PATH;
  const oldTimeout = process.env[ENV_CHILD_TIMEOUT];
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  process.env[ENV_CHILD_TIMEOUT] = "1";
  const release = setTimeout(() => void rm(`${ledgerPath}.lock`, { force: true }), 650);

  try {
    const outcome = await executePlannedChild({
      session: { ledgerPath, executor: { kind: "process" } } as GrantsSession,
      plan: plan(),
      childId: "d0.1",
      executionId,
      parentExecutionId: null,
      cwd: dir,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, true, "ledger waiting consumes the same deadline the dashboard records");

    const events = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).body);
    const starting = events.find((event) => event.state === "starting");
    const terminal = events.find((event) => event.state === "failed");
    assert.ok(starting?.deadlineAt && terminal?.ts);
    assert.ok(
      Date.parse(terminal.ts) <= Date.parse(starting.deadlineAt) + 100,
      "termination tracks the recorded deadline",
    );
  } finally {
    clearTimeout(release);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env[ENV_CHILD_TIMEOUT];
    else process.env[ENV_CHILD_TIMEOUT] = oldTimeout;
    await rm(`${ledgerPath}.lock`, { force: true });
  }
});
