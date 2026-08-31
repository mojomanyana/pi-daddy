import assert from "node:assert/strict";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { appendAfterRuntimeRecord, executePlannedChild } from "../extensions/execute-child.ts";
import type { GrantsSession } from "../extensions/session.ts";
import type { Delegation } from "../src/delegate.ts";
import { ENV_CHILD_TIMEOUT } from "../src/run-child.ts";
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
    taskDigest: "a".repeat(64),
  };
}

test("a terminal lifecycle append waits for the running append it follows", async () => {
  const order: string[] = [];
  let release!: () => void;
  const running = new Promise<void>((resolve) => { release = resolve; }).then(() => { order.push("running"); });
  const terminal = appendAfterRuntimeRecord(running, async () => { order.push("terminal"); });

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
  await writeFile(shim, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n", "utf8");
  await chmod(shim, 0o755);

  const ledgerPath = join(dir, "ledger.jsonl");
  const oldPath = process.env.PATH;
  const oldTimeout = process.env[ENV_CHILD_TIMEOUT];
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  process.env[ENV_CHILD_TIMEOUT] = "1";

  try {
    const outcome = await executePlannedChild({
      session: { ledgerPath, executor: { kind: "process" } } as GrantsSession,
      plan: plan(), childId: "d0.1", executionId, parentExecutionId: null, cwd: dir,
    });
    assert.equal(outcome.timedOut, true);

    const events = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
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

test("the executor receives only the time remaining on the recorded lifecycle deadline", async () => {
  const dir = await tempDir("execute-child-deadline-");
  const bin = join(dir, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  const shim = join(bin, "pi");
  await writeFile(shim, "#!/usr/bin/env node\nconsole.log(Date.now());\nsetTimeout(() => process.exit(0), 600);\n", "utf8");
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
      plan: plan(), childId: "d0.1", executionId, parentExecutionId: null, cwd: dir,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, true, "ledger waiting consumes the same deadline the dashboard records");

    const events = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const starting = events.find((event) => event.state === "starting");
    const terminal = events.find((event) => event.state === "failed");
    assert.ok(starting?.deadlineAt && terminal?.ts);
    assert.ok(Date.parse(terminal.ts) <= Date.parse(starting.deadlineAt) + 100, "termination tracks the recorded deadline");
  } finally {
    clearTimeout(release);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env[ENV_CHILD_TIMEOUT];
    else process.env[ENV_CHILD_TIMEOUT] = oldTimeout;
    await rm(`${ledgerPath}.lock`, { force: true });
  }
});
