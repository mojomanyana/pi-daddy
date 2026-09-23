import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { runChild } from "../src/kernel/run-child.ts";
import { activitySessionFor } from "../src/executors/activity-session.ts";
import { waitForSettled } from "../src/executors/herdr-poll.ts";
import { processTreeActivity } from "../src/executors/process-activity.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/**
 * PR 3e (ADR-0038 note): the working bound is inactivity, not a wall clock. These drive REAL child processes.
 * Production change that breaks each test is named beside it.
 */
const node = (script: string, over = {}) => ({
  command: process.execPath,
  args: ["-e", script],
  env: process.env,
  cwd: process.cwd(),
  ...over,
});

test("a silent child is stopped at the inactivity bound and the result says it was idleness", async () => {
  // Breaks by: dropping `armIdle`/the idle timer from runChild.
  const started = Date.now();
  const r = await runChild(node("setInterval(() => {}, 1000)", { idleTimeoutMs: 300, timeoutMs: 10_000 }));
  assert.equal(r.timedOut, true);
  assert.equal(r.idle, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 5_000, "the wall clock was ten seconds; idleness must have fired first");
});

test("a child that keeps writing outlives an inactivity bound shorter than its run", async () => {
  // Breaks by: not re-arming the idle timer on output bytes.
  const script = "let n=0;const t=setInterval(()=>{process.stdout.write('.');if(++n>=12){clearInterval(t);}},50)";
  const r = await runChild(node(script, { idleTimeoutMs: 300, timeoutMs: 10_000 }));
  assert.equal(r.code, 0, `idle killed a working child: ${JSON.stringify(r)}`);
  assert.equal(r.idle, undefined);
  assert.equal(r.text, ".".repeat(12));
});

test("a child that is quiet on stdout but grows its session file is working, not hung", async () => {
  // Breaks by: dropping the activity probe, or comparing markers by identity only.
  const dir = await tempDir("child-inactivity-");
  const file = join(dir, "session.jsonl");
  const script = `const fs=require("node:fs");let n=0;const t=setInterval(()=>{fs.appendFileSync(${JSON.stringify(file)},"x\\n");if(++n>=12){clearInterval(t);}},50)`;
  const r = await runChild(
    node(script, {
      idleTimeoutMs: 300,
      timeoutMs: 10_000,
      activityProbeIntervalMs: 25,
      activityProbe: async () => {
        try {
          const s = await stat(file);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return undefined;
        }
      },
    }),
  );
  assert.equal(r.code, 0, `idle killed a child whose session file was growing: ${JSON.stringify(r)}`);
  assert.equal(r.idle, undefined);
  assert.equal((await readFile(file, "utf8")).length, 24);
});

test("the wall-clock ceiling still stops a child that never goes quiet", async () => {
  // Breaks by: letting activity extend the ceiling.
  const r = await runChild(
    node("setInterval(()=>process.stdout.write('.'),20)", { idleTimeoutMs: 5_000, timeoutMs: 300 }),
  );
  assert.equal(r.timedOut, true);
  assert.equal(r.idle, undefined, "a runaway is a wall-clock stop, not an idleness stop");
});

test("an activity session gives a child without retention a private session file and removes it afterwards", async () => {
  // Breaks by: leaving `--no-session` in place, or disposing a retention target.
  const plan = ["--print", "--no-session", "--tools", "read", " do the thing"];
  const session = await activitySessionFor(plan, "exec:00000000-0000-4000-8000-000000000001");
  assert.equal(session.args.includes("--no-session"), false);
  assert.equal(session.args[session.args.indexOf("--session") + 1], session.path);
  assert.equal(session.args.at(-1), " do the thing", "the task stays the last argv element");
  assert.equal(await session.probe(), undefined, "no marker before pi writes the file");
  await writeFile(session.path, '{"type":"session"}\n');
  const first = await session.probe();
  await new Promise((r) => setTimeout(r, 5));
  await appendFile(session.path, '{"type":"message"}\n');
  assert.notEqual(await session.probe(), first, "an append changes the marker");
  await session.dispose();
  await assert.rejects(stat(session.path));

  const retained = await tempDir("child-inactivity-retained-");
  await mkdir(join(retained, "execution-1"));
  const target = join(retained, "execution-1", "session.jsonl");
  const kept = await activitySessionFor(["--print", "--session", target, " task"], "exec:2");
  assert.deepEqual(kept.args, ["--print", "--session", target, " task"]);
  await writeFile(target, "kept\n");
  await kept.dispose();
  assert.equal(await readFile(target, "utf8"), "kept\n", "a retention target is never removed here");
});

test("child usage totals are read from the current turn before the temporary session is removed", async () => {
  const plan = ["--print", "--no-session", " task"];
  const session = await activitySessionFor(plan, "exec:00000000-0000-4000-8000-000000000002");
  const lines = [
    { type: "message", message: { role: "assistant", usage: usage(100, 10, 1) } },
    { type: "message", message: { role: "user", content: "PRIVATE CURRENT TASK" } },
    { type: "message", message: { role: "assistant", content: "PRIVATE ANSWER", usage: usage(20, 3, 0.25) } },
    { type: "message", message: { role: "toolResult", content: "PRIVATE TOOL RESULT" } },
    { type: "message", message: { role: "assistant", usage: usage(5, 2, 0.1) } },
  ];
  await writeFile(session.path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  assert.deepEqual(await session.usage(), {
    usage: {
      input: 25,
      output: 5,
      cacheRead: 4,
      cacheWrite: 2,
      reasoning: 2,
      totalTokens: 39,
      cost: { input: 0.21000000000000002, output: 0.07, cacheRead: 0.03, cacheWrite: 0.02, total: 0.35 },
    },
  });
  await session.dispose();
  await assert.rejects(stat(session.path));
  assert.deepEqual(await session.usage(), { unavailable: "session-missing" });
});

test("child usage failure is atomic and privacy-safe", async () => {
  const first = await activitySessionFor(["--print", "--no-session", " task"], "exec:bad-usage-1");
  await writeFile(first.path, '{"type":"message","message":{"role":"user"}}\nnot-json\n');
  assert.deepEqual(await first.usage(), { unavailable: "session-invalid" });
  await first.dispose();

  const second = await activitySessionFor(["--print", "--no-session", " task"], "exec:bad-usage-2");
  await writeFile(
    second.path,
    [
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant", usage: usage(20, 3, 0.25) } },
      { type: "message", message: { role: "assistant", usage: { input: "PRIVATE TRANSCRIPT" } } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  assert.deepEqual(await second.usage(), { unavailable: "session-invalid" });
  await second.dispose();
});

function usage(input: number, output: number, totalCost: number) {
  return {
    input,
    output,
    cacheRead: input === 100 ? 50 : input === 20 ? 3 : 1,
    cacheWrite: input === 100 ? 20 : input === 20 ? 2 : 0,
    ...(input === 5 ? {} : { reasoning: input === 100 ? 10 : 2 }),
    totalTokens: input === 100 ? 190 : input === 20 ? 30 : 9,
    cost:
      input === 20
        ? { input: 0.2, output: 0.05, cacheRead: 0.02, cacheWrite: 0.02, total: totalCost }
        : input === 5
          ? { input: 0.01, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: totalCost }
          : { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: totalCost },
  };
}

test("the Herdr settle loop stops a pane whose text and session file stop changing", async () => {
  // Breaks by: dropping the idle check from waitForSettled, or resetting activity on an unchanged pane.
  let marker = 0;
  const reply = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ id: "x", result }), stderr: "" });
  const exec = async (argv: string[]) => {
    if (argv[0] === "agent" && argv[1] === "get")
      return reply({ agent: { agent_status: "working", state_change_seq: 11 } });
    if (argv[0] === "agent" && argv[1] === "read") return reply({ text: "same text" });
    return reply({});
  };
  const started = Date.now();
  const settled = await waitForSettled(
    exec as never,
    {
      name: "child-1",
      pollIntervalMs: 10,
      idleTimeoutMs: 150,
      activityProbe: () => (marker < 5 ? String(++marker) : String(marker)),
      onSnapshot: () => {},
    },
    10,
    Date.now() + 10_000,
    65536,
  );
  assert.deepEqual(settled, { timedOut: true, idle: true });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150 && elapsed < 5_000, `idleness fired after ${elapsed}ms`);
});

test("a child that is silent everywhere but whose grandchild burns CPU is working (Linux /proc signal)", async (t) => {
  // Review finding 1 on PR 3e: pi writes its session file only when a message or tool result ENDS, so one long tool
  // call is silent on both stdout and the file. Breaks by: dropping the process-tree probe from execute-child, or
  // `processTreeActivity` no longer walking descendants.
  if (process.platform !== "linux") return t.skip("reads /proc");
  const own = await processTreeActivity(process.pid);
  assert.ok(own && own.includes(String(process.pid)), `own marker ${own}`);
  // A parent that spawns a busy grandchild and otherwise sleeps: no stdout, no file, only CPU in the tree.
  const script =
    "const {spawn}=require('node:child_process');" +
    "const g=spawn(process.execPath,['-e','const e=Date.now()+700;while(Date.now()<e){}'],{stdio:'ignore'});" +
    "g.on('exit',()=>process.exit(0));";
  let pid: number | undefined;
  const r = await runChild(
    node(script, {
      idleTimeoutMs: 300,
      timeoutMs: 10_000,
      activityProbeIntervalMs: 25,
      onSpawn: (spawned: number) => {
        pid = spawned;
      },
      activityProbe: () => (pid === undefined ? undefined : processTreeActivity(pid)),
    }),
  );
  assert.equal(r.code, 0, `idle killed a child whose grandchild was working: ${JSON.stringify(r)}`);
  assert.equal(r.idle, undefined);
  assert.equal(await processTreeActivity(2 ** 22 - 1), undefined, "a pid that does not exist has no marker");
});
