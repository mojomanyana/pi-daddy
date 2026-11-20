import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDispatch } from "../src/governance/task-dispatch.ts";
import { claimTaskWriter } from "../extensions/task-worktree-writer.ts";
import { createTaskDispatchController } from "../extensions/task-dispatch-controller.ts";
import { taskControlRequest } from "../src/products/dashboard-task-controls.ts";
import type { DashboardSessionSnapshot } from "../src/products/dashboard-session-client.ts";

test("different native owners race across processes for one shared slot; reopening preserves reservations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "daddy-task-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new TaskDispatch(root, "p", "t");
  store.change("budget", 1, 0);
  const url = new URL("../src/governance/task-dispatch.ts", import.meta.url).href;
  const run = promisify(execFile);
  const script = `const [url,dir,owner]=process.argv.slice(1);const {TaskDispatch}=await import(url);
  try{new TaskDispatch(dir,"p","t").admit({owner,executionId:"native",sessionId:"s",cwd:dir}); console.log("accepted")}
  catch(e){if(!e.message.includes("allowance is exhausted"))throw e;console.log("capped")}`;
  const results = await Promise.all(
    ["scout", "harness"].map((owner) =>
      run(process.execPath, ["--input-type=module", "--eval", script, url, root, owner]),
    ),
  );
  assert.deepEqual(results.map((r) => r.stdout.trim()).sort(), ["accepted", "capped"]);
  let snapshot = store.snapshot(1);
  assert.equal(snapshot.admitted, 1);
  const winner = snapshot.counts.scout.admitted ? "scout" : "harness";
  const newSession = new TaskDispatch(root, "p", "t");
  newSession.settle(winner, "native", "settled");
  newSession.change("budget", null, snapshot.revision);
  snapshot = store.snapshot(1);
  store.change("budget", 0, snapshot.revision, "jev");
  assert.throws(() => store.admit({ owner: "jev", executionId: "native", cwd: root, sessionId: "next" }), /allowance/);
  assert.throws(
    () => newSession.admit({ owner: winner, executionId: "native", cwd: root, sessionId: "next" }),
    /already reserved/,
  );
  assert.equal(store.snapshot(2).admitted, 1);
});

test("a paused or cancelled task retains pending work until its owner settles it, and stale edits cannot reopen it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "daddy-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new TaskDispatch(root, "p", "t"),
    second = new TaskDispatch(root, "p", "t");
  first.admit({ owner: "pi-daddy", executionId: "one", sessionId: "s", cwd: root });
  first.change("pause", null, 0);
  assert.equal(second.snapshot(3).state, "pausing");
  assert.throws(() => second.admit({ owner: "scout", executionId: "next", sessionId: "s", cwd: root }), /stopped/);
  assert.throws(() => second.change("resume", null, 0), /changed/);
  first.change("cancel", null, first.snapshot(3).revision);
  assert.equal(second.snapshot(3).state, "cancelling");
  assert.throws(() => second.change("resume", null, second.snapshot(3).revision), /settling/);
  first.settle("pi-daddy", "one", "settled");
  assert.equal(second.snapshot(4).state, "cancelled");
  second.change("resume", null, second.snapshot(4).revision);
  assert.equal(first.snapshot(4).state, "open");
});

test("working copies permit simultaneous writers on separate roots; subfolders of a single copy share one slot", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "daddy-writers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, "a"),
    b = join(root, "b");
  const git = promisify(execFile);
  await git("git", ["init", "-q", a]);
  await git("git", [
    "-C",
    a,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  await git("git", ["-C", a, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "--detach", b, "HEAD"]);
  mkdirSync(join(a, "sub"));
  const host = { sessionId: "owner", cwd: a };
  const release = await claimTaskWriter(root, a, host, "one");
  await assert.rejects(claimTaskWriter(root, join(a, "sub"), { ...host, sessionId: "other" }, "two"), /already owns/);
  const other = await claimTaskWriter(root, b, host, "elsewhere");
  other("settled");
  release("settled");
  const next = await claimTaskWriter(root, join(a, "sub"), host, "three");
  next("not-started");
});

test("optional task broker distinguishes absent, revoked, stale and admitted scope, and late receipt cannot rerun work", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "daddy-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = { cwd: dir, sessionId: "s" };
  let task: string | undefined,
    revoked = false;
  const bus = new Map<string, (data: any) => void>();
  const events = {
    on: (k: string, fn: (data: any) => void) => {
      bus.set(k, fn);
      return () => bus.delete(k);
    },
    emit: (k: string, msg: any) => bus.get(k)?.(msg),
  };
  bus.set("pi.task-history.v1.scope", (r) => {
    if (revoked) {
      r.unavailable();
      return;
    }
    if (task) {
      const selected = task;
      r.accept({
        projectId: "p",
        taskId: task,
        revision: 1,
        assertCurrent: async () => {
          if (revoked || selected !== task) throw Error("revoked");
        },
      });
    }
  });
  const controller = createTaskDispatchController(
    events as never,
    () => host,
    () => dir,
  );
  t.after(() => controller.close());
  function bind() {
    let bound: any;
    events.emit("pi.task-dispatch.v1.bind", {
      version: 1,
      owner: "scout",
      ...host,
      accept: (fn: any) => {
        bound = fn;
      },
    });
    return bound;
  }
  assert.equal(bind(), undefined);
  task = "first";
  const prior = bind();
  task = "second";
  await assert.rejects(prior({ operationId: "same" }), /revoked/);
  const attached = bind();
  const run = await attached({ operationId: "same" });
  run.finish("unknown");
  await assert.rejects(attached({ operationId: "same" }), /already reserved/);
  assert.equal((await controller.snapshot())?.outstanding, 1);
  await attached.reconcile({ operationId: "same", cleanup: "settled" });
  assert.equal((await controller.snapshot())?.outstanding, 0);
  let readPage: (() => Promise<ReturnType<TaskDispatch["page"]>>) | undefined;
  events.emit("pi.task-history.v1.replay", {
    version: 1,
    owner: "pi-daddy",
    ...host,
    projectId: "p",
    taskId: task,
    after: 0,
    limit: 1,
    accept: (fn: () => Promise<ReturnType<TaskDispatch["page"]>>) => {
      readPage = fn;
    },
  });
  assert.ok(readPage);
  const page = await readPage();
  assert.equal(page.after, 0);
  assert.equal(page.next, 1);
  assert.equal(page.more, true);
  assert.equal(page.events[0].state, "admitted");
  assert.ok(!JSON.stringify(page).includes(dir));
  assert.ok(!JSON.stringify(page).includes('"same"'));
  assert.deepEqual(await readPage(), page);
  const last = new TaskDispatch(dir, "p", "second").page(page.next, 1);
  assert.equal(last.more, false);
  assert.equal(last.events[0].state, "settled");
  assert.equal(last.events[0].operationId, page.events[0].operationId);
  const shown = await controller.snapshot();
  const action = taskControlRequest(
    { taskDispatch: shown, observation: { ...host, generation: "g" } } as DashboardSessionSnapshot,
    "task budget 2",
  );
  assert.ok(typeof action !== "string");
  assert.equal(action.edit.owner, "task");
  await controller.change({ ...action.edit, limit: 1 }, () => {});
  await controller.captureInline()!();
  const policy = (await controller.snapshot())!;
  await controller.change(
    {
      action: "pause",
      expected: { projectId: "p", taskId: "second", selectionRevision: 1, revision: policy.revision },
    },
    () => {},
  );
  await assert.rejects(controller.captureInline()!(), /stopped/);

  revoked = true;
  await assert.rejects(readPage(), /revoked/);
  await assert.rejects(bind()({ operationId: "next" }), /unavailable/);
  await assert.rejects(
    controller.change(action.edit, () => {}),
    /unavailable/,
  );
});

test("declared tasks consume their root's shared allowance and expose only their original facts in replay", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "daddy-root-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = new TaskDispatch(dir, "project", "root");
  root.change("budget", 1, 0);
  root.admit({ owner: "harness", taskId: "first-child", executionId: "fixture", sessionId: "session", cwd: dir });
  root.settle("harness", "fixture", "settled", "first-child");
  assert.equal(root.snapshot(2, "sibling").inherited, true);
  assert.throws(
    () => root.admit({ owner: "pi-daddy", taskId: "sibling", executionId: "other", sessionId: "s", cwd: dir }),
    /shared.*exhausted/,
  );
  const own = root.page(0, 3, "first-child");
  assert.deepEqual(
    own.events.map((e) => e.state),
    ["admitted", "settled"],
  );
  assert.equal(own.next, 3);
  assert.equal(own.more, false);
  assert.deepEqual(root.page(0, 3, "sibling").events, []);
  assert.deepEqual(
    root.page(0, 3).events.map((e) => e.state),
    ["budget"],
  );
  const separate = new TaskDispatch(dir, "project", "independent");
  separate.admit({ owner: "pi-daddy", executionId: "other", sessionId: "s", cwd: dir });
  assert.equal(separate.snapshot(1).admitted, 1);
});
