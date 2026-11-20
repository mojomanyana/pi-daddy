import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDispatch } from "../src/governance/task-dispatch.ts";
import { readRuntimeExecutionSettlement } from "../src/governance/runtime-settlement.ts";
import { claimTaskWriter } from "../extensions/task-worktree-writer.ts";
import { createTaskDispatchController } from "../extensions/task-dispatch-controller.ts";

const modules = [
  "../src/governance/runtime-settlement.ts",
  "../extensions/task-worktree-writer.ts",
  "../extensions/task-dispatch-controller.ts",
].map((path) => new URL(path, import.meta.url).href);
const fixture = `
const [rt,writer,controls,dir,boundary]=process.argv.slice(1);
const {openRuntimeSettlement,pinPrelaunchOwner}=await import(rt);
const {claimTaskWriter}=await import(writer);
const {createTaskDispatchController}=await import(controls);
const host={sessionId:"original",cwd:dir};
const native=await openRuntimeSettlement(dir,host.sessionId,dir);
const bus={on(){return ()=>{}},emit(name,req){if(name==="pi.task-history.v1.scope")
req.accept({projectId:"project",taskId:"task",revision:1,assertCurrent:async()=>{}})}};
if(boundary==="writer"){
  await claimTaskWriter(dir, dir, host,"execution",pinPrelaunchOwner(native,host.sessionId,dir));
} else {
  const govern=createTaskDispatchController(bus,()=>host,()=>dir,()=>native);
  const receipt=await govern.capture()("execution",dir);
  let rejected=false;
  try {receipt.beforeRuntimeBegin(undefined);} catch {rejected=true;}
  if(!rejected)throw Error("reservation accepted a different native owner");
  if(boundary==="intent") {receipt.beforeRuntimeBegin(native); native.begin("execution");}
}
process.on("message",()=>{});
process.send({ready:true});
`;

for (const boundary of ["writer", "reservation", "intent"] as const)
  test(
    "owner crash at " + boundary + " preserves exactly the qualified writer and task reservations",
    { timeout: 20000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "daddy-crash-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const child = spawn(process.execPath, ["--input-type=module", "--eval", fixture, ...modules, dir, boundary], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const stopped = once(child, "exit", { signal: AbortSignal.timeout(14000) });
      try {
        const [message] = await Promise.race([
          once(child, "message", { signal: AbortSignal.timeout(9000) }),
          stopped.then(() => {
            throw Error("fixture exited before its boundary");
          }),
        ]);
        assert.deepEqual(message, { ready: true });
        const next = { sessionId: "other", cwd: dir };
        // The original owner still holds the grant, even when it has written no native intent.
        await assert.rejects(claimTaskWriter(dir, dir, next, "contender"), /already owns/);
        assert.ok(child.kill("SIGKILL"));
        const [, signal] = await stopped;
        assert.equal(signal, "SIGKILL");
        const store = new TaskDispatch(dir, "project", "task");
        if (boundary === "intent") {
          await assert.rejects(claimTaskWriter(dir, dir, next, "contender"), /already owns/);
          const [old] = store.outstanding();
          assert.equal(
            await readRuntimeExecutionSettlement(dir, old.sessionId, dir, old.executionId, old.beforeLaunch),
            "unknown",
          );
          return;
        }
        const finish = await claimTaskWriter(dir, dir, next, "contender");
        finish("not-started");
        if (boundary === "writer") {
          assert.equal(store.snapshot(1).outstanding, 0);
          return;
        }
        const [old] = store.outstanding();
        assert.ok(old.beforeLaunch);
        assert.equal(await readRuntimeExecutionSettlement(dir, old.sessionId, dir, old.executionId), "unknown");
        assert.equal(
          await readRuntimeExecutionSettlement(dir, old.sessionId, dir, old.executionId, {
            ...old.beforeLaunch,
            pidNamespace: old.beforeLaunch.pidNamespace + "-other",
          }),
          "unknown",
        );
        const bus = {
          on() {
            return () => {};
          },
          emit(name: string, req: any) {
            if (name === "pi.task-history.v1.scope")
              req.accept({ projectId: "project", taskId: "task", revision: 1, assertCurrent: async () => {} });
          },
        };
        const controller = createTaskDispatchController(
          bus as never,
          () => next,
          () => dir,
        );
        store.change("cancel", null, 0);
        const s = store.snapshot(1);
        await controller.change(
          {
            action: "resume",
            expected: { projectId: "project", taskId: "task", selectionRevision: 1, revision: s.revision },
          },
          () => {},
        );
        assert.equal(store.snapshot(1).outstanding, 0);
        assert.equal(store.snapshot(1).admitted, 1);
        assert.throws(() => store.admit({ ...next, owner: "pi-daddy", executionId: "execution" }), /already reserved/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await stopped.catch(() => {});
      }
    },
  );
