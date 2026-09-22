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
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTimeout === undefined) delete process.env[ENV_CHILD_TIMEOUT];
    else process.env[ENV_CHILD_TIMEOUT] = oldTimeout;
    if (oldIdle === undefined) delete process.env[ENV_CHILD_IDLE_TIMEOUT];
    else process.env[ENV_CHILD_IDLE_TIMEOUT] = oldIdle;
  }
});

test("PR 3e: the temporary session directory is removed even when the run throws before the child starts", async () => {
  // Review finding 2: it leaked on every throw path. Breaks by: moving dispose() back into the success branch.
  const { readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await tempDir("execute-child-dispose-");
  const unwritable = dir; // a directory as the ledger path: the strict starting append fails (EISDIR) and rethrows
  // **A SET, not a count.** The count compared process-wide entries in the shared tmpdir while other test
  // FILES run in parallel and create and remove directories of the same prefix, so a sibling's cleanup landing
  // between the two reads failed this test with `1 !== 2` — a directory vanishing, which is the opposite of
  // what it is looking for. Observed once on Node 22 in CI and not reproducible locally. Comparing what is NEW
  // makes it immune to anything another file does, and still fails for the leak it exists to catch.
  const listExec = async () => new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-daddy-exec_")));
  const before = await listExec();
  await assert.rejects(
    executePlannedChild({
      session: { ledgerPath: unwritable, executor: { kind: "process" } } as GrantsSession,
      plan: plan(),
      childId: "d0.1",
      executionId,
      parentExecutionId: null,
      cwd: dir,
    }),
  );
  const leaked = [...(await listExec())].filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], "a session directory allocated for this run survived its failure");
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
