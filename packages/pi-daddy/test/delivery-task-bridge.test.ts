import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import { after, test } from "node:test";
import { registerDeliveryTaskBridge } from "../extensions/delivery-task-bridge.ts";
import { createTaskDispatchController } from "../extensions/task-dispatch-controller.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

interface Context {
  version: 1;
  sessionId: string;
  cwd: string;
  taskId?: string;
  assertMayContinue(): Promise<void>;
}

async function fixture(depth = 0) {
  const directory = await tempDir("delivery-scope-");
  let host = { cwd: directory, sessionId: "one" };
  let selected: { projectId: string; taskId: string; revision: number } | undefined;
  let assertCurrent: () => Promise<void> = async () => {};
  const events = new EventEmitter();
  const bus = {
    emit: events.emit.bind(events),
    on(name: string, listener: (...args: unknown[]) => void) {
      events.on(name, listener);
      return () => events.off(name, listener);
    },
  } as never;
  events.on("pi.task-history.v1.scope", (request) => {
    if (!selected) return;
    const pinned = selected;
    request.accept({
      ...pinned,
      async assertCurrent() {
        await assertCurrent();
        if (pinned !== selected) throw Error("Bookie selection changed");
      },
    });
  });
  const controller = createTaskDispatchController(
    bus,
    () => host,
    () => directory,
  );
  const close = registerDeliveryTaskBridge(bus, () => host, depth, controller);
  return {
    close,
    directory,
    controller,
    get(sessionId = host.sessionId, cwd = host.cwd) {
      let context: Context | undefined;
      events.emit("pi-daddy:delivery-task:v1", {
        version: 1,
        sessionId,
        cwd,
        reply: (reply: Context) => (context = reply),
      });
      return context;
    },
    select(taskId: string, revision: number, projectId = "project") {
      selected = { projectId, taskId, revision };
    },
    replaceSession() {
      host = { ...host, sessionId: "two" };
    },
    duringSelectionCheck(fn: () => Promise<void>) {
      assertCurrent = fn;
    },
    async change(action: "pause" | "resume" | "cancel") {
      const { projectId, taskId, selectionRevision, revision } = (await controller.snapshot())!;
      await controller.change({ action, expected: { projectId, taskId, selectionRevision, revision } }, () => {});
    },
  };
}

test("inline continuation uses the current selected Pause and Cancel controls and spends zero attempts", async () => {
  const f = await fixture();
  const unselected = f.get()!;
  assert.equal(unselected.taskId, undefined);
  await unselected.assertMayContinue();
  f.select("ticket", 1);
  await assert.rejects(unselected.assertMayContinue(), /selected delivery task changed/);
  const selected = f.get()!;
  assert.equal(selected.taskId, "ticket");
  await selected.assertMayContinue();
  assert.deepEqual(await readdir(f.directory), []);
  await f.change("pause");
  await assert.rejects(selected.assertMayContinue(), /dispatch is stopped/);
  await f.change("resume");
  await selected.assertMayContinue();
  await f.change("cancel");
  await assert.rejects(f.get()!.assertMayContinue(), /dispatch is stopped/);
  assert.equal((await f.controller.snapshot())?.admitted, 0);
  f.select("other", 2);
  await assert.rejects(selected.assertMayContinue(), /selected delivery task changed/);
  await f.get()!.assertMayContinue();
});

test("continuation rejects a wrong owner, a same-ID selection revision change, and stale async checks", async () => {
  const f = await fixture();
  await assert.rejects(f.get("foreign")!.assertMayContinue(), /session changed or is unavailable/);
  await assert.rejects(f.get(undefined, "/foreign")!.assertMayContinue(), /session changed or is unavailable/);
  f.select("ticket", 1);
  const first = f.get()!;
  f.select("ticket", 2);
  await assert.rejects(first.assertMayContinue(), /selected delivery task changed/);
  const second = f.get()!;
  f.duringSelectionCheck(async () => f.replaceSession());
  await assert.rejects(second.assertMayContinue(), /Task session changed/);
  f.close?.();
  assert.equal(f.get(), undefined);
  assert.equal((await fixture(1)).get(), undefined, "a governed child has no parent continuation bridge");
});
