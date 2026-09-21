import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { workSetup } from "../src/products/work-setup.ts";
import { runWorkSetup, inspectWorkRun } from "../src/products/work-run.ts";
after(cleanupTempDirs);
const result = (text: string, ok = true) => ({ ok, text, exitCode: ok ? 0 : 1 });
async function fixture() {
  const cwd = await tempDir("bounded-work-");
  return {
    directory: join(cwd, "order"),
    selectionDigest: "a".repeat(64),
    budget: 8,
    setup: workSetup({
      version: "work-setup-v1",
      id: "dag",
      outcome: "Complete independent branches",
      maxParallel: 2,
      tasks: [
        { id: "a", agent: "reader", outcome: "Read A", model: "p/a", thinking: "low", dependencies: [] },
        { id: "b", agent: "reader", outcome: "Read B", model: "p/b", thinking: "high", dependencies: [] },
        { id: "c", agent: "reviewer", outcome: "Use A", model: "p/c", thinking: "medium", dependencies: ["a"] },
        { id: "d", agent: "reader", outcome: "Read D", model: "p/a", thinking: "low", dependencies: [] },
      ],
    }),
  };
}

test("ordinary DAG overlaps independent children, bounds admission and supplies complete predecessor bytes", async () => {
  const input = await fixture();
  let running = 0,
    peak = 0,
    admissionPeak = 0;
  const started: string[] = [],
    release = new Map<string, () => void>();
  let ready!: () => void;
  const wave = new Promise<void>((r) => (ready = r));
  const pending = runWorkSetup({
    ...input,
    onUpdate: (rows) => {
      admissionPeak = Math.max(admissionPeak, rows.filter((r) => r.state === "running").length);
    },
    execute: async (task, prompt, budget, notify) => {
      await notify(`execution-${task.id}`);
      assert.equal(budget, 1);
      running++;
      peak = Math.max(peak, running);
      started.push(task.id);
      if (task.id === "a" || task.id === "b")
        await new Promise<void>((resolve) => {
          release.set(task.id, resolve);
          if (release.size === 2) ready();
        });
      if (task.id === "c") {
        assert.ok(prompt.includes("complete A"));
        assert.ok(!prompt.includes("complete B"));
      }
      running--;
      return result(`complete ${task.id.toUpperCase()}`);
    },
  });
  await wave;
  assert.deepEqual([...started].sort(), ["a", "b"]);
  release.get("a")!();
  release.get("b")!();
  const complete = await pending;
  assert.ok(complete.tasks.every((t) => t.state === "finished"));
  assert.equal(peak, 2);
  assert.equal(admissionPeak, 2);
  assert.equal(await readFile(complete.tasks[0].resultPath!, "utf8"), "complete A");
  assert.ok((await inspectWorkRun(complete.binding)).tasks.every((t) => t.state === "finished"));
  await assert.rejects(
    runWorkSetup({
      ...input,
      execute: async () => {
        throw Error("must not retry");
      },
    }),
    /EEXIST|exist/,
  );
});

test("failed predecessors block only dependents; oversized handoff refuses without truncating", async () => {
  const first = await fixture(),
    started: string[] = [];
  const failed = await runWorkSetup({
    ...first,
    execute: async (t) => {
      started.push(t.id);
      return result("failed-a", t.id !== "a");
    },
  });
  assert.equal(failed.tasks.find((t) => t.id === "c")?.state, "blocked");
  assert.ok(!started.includes("c"));
  assert.ok(started.includes("d"));
  const second = await fixture();
  started.length = 0;
  const bounded = await runWorkSetup({
    ...second,
    execute: async (t) => {
      started.push(t.id);
      return result(t.id === "a" ? "x".repeat(32769) : "Other");
    },
  });
  assert.ok(!started.includes("c"));
  assert.match(bounded.tasks.find((t) => t.id === "c")?.reason ?? "", /exceeds.*handoff bound/);
});

test("an original owner pause keeps pending tasks waiting until explicit resume", async () => {
  const input = await fixture();
  let open = false,
    started = 0,
    ready!: () => void;
  const waiting = new Promise<void>((resolve) => (ready = resolve));
  const run = runWorkSetup({
    ...input,
    admissionOpen: () => open,
    onUpdate: (rows) => {
      if (rows.every((r) => r.state === "waiting")) ready();
    },
    execute: async () => {
      started++;
      return result("done");
    },
  });
  await waiting;
  assert.equal(started, 0);
  open = true;
  assert.ok((await run).tasks.every((t) => t.state === "finished"));
  assert.equal(started, 4);
});

test("cancellation waits for original settlement and never dispatches remaining work", async () => {
  const input = await fixture(),
    abort = new AbortController();
  let ready!: () => void,
    settled = 0,
    started = 0;
  const active = new Promise<void>((r) => (ready = r));
  const pending = runWorkSetup({
    ...input,
    signal: abort.signal,
    execute: async () => {
      started++;
      if (started === 2) ready();
      await new Promise<void>((resolve) =>
        abort.signal.addEventListener(
          "abort",
          () =>
            setImmediate(() => {
              settled++;
              resolve();
            }),
          { once: true },
        ),
      );
      return result("stopped", false);
    },
  });
  await active;
  abort.abort();
  const view = await pending;
  assert.equal(settled, 2);
  assert.equal(started, 2);
  assert.equal(view.tasks.find((t) => t.id === "c")?.state, "blocked");
  assert.equal(view.tasks.find((t) => t.id === "d")?.state, "blocked");
});
