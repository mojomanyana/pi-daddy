/** Trusted Bookie selection identifies the task. Daddy retains authority over only its own dispatch. */
import {
  TaskDispatch,
  type DispatchEdit,
  type DispatchView,
  type DispatchOwner,
  isDispatchEdit,
} from "../src/governance/task-dispatch.ts";
import { claimTaskWriter } from "./task-worktree-writer.ts";
import { agentDir } from "../src/kernel/project-paths.ts";
import { readRuntimeExecutionSettlement } from "../src/governance/runtime-settlement.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface TaskScope {
  projectId: string;
  taskId: string;
  revision: number;
  assertCurrent(): Promise<void>;
}
type Host = { cwd: string; sessionId: string };
export type AdmittedAttempt = {
  signal: AbortSignal;
  finish(cleanup: "settled" | "not-started" | "unknown"): void;
};
export type TaskDispatchAdmission = {
  (executionId: string, writerFolder?: string): Promise<AdmittedAttempt>;
  assertAvailable(): Promise<void>;
  reconcile(executionId: string, cleanup: "settled" | "not-started"): Promise<void>;
};
export function createTaskDispatchController(
  bus: ExtensionAPI["events"],
  current: () => Host | undefined,
  directory = agentDir,
) {
  let lastBoundHost: Host | undefined;
  let previous: TaskDispatch | undefined;
  const storeFor = (scope: TaskScope) => {
    if (!previous || previous.projectId !== scope.projectId || previous.taskId !== scope.taskId)
      previous = new TaskDispatch(directory(), scope.projectId, scope.taskId);
    return previous;
  };

  function select() {
    const host = current();
    if (!host) return;
    const response: { scope?: TaskScope; unavailable?: boolean } = {};
    let accepting = true;
    try {
      bus?.emit?.("pi.task-history.v1.scope", {
        version: 1,
        cwd: host.cwd,
        sessionId: host.sessionId,
        unavailable() {
          if (accepting) response.unavailable = true;
        },
        accept(candidate: TaskScope) {
          if (accepting && response.scope) response.unavailable = true;
          if (
            accepting &&
            !response.scope &&
            candidate &&
            typeof candidate.projectId === "string" &&
            typeof candidate.taskId === "string" &&
            Number.isSafeInteger(candidate.revision) &&
            typeof candidate.assertCurrent === "function"
          )
            response.scope = candidate;
        },
      });
    } catch {
      response.unavailable = true;
    } finally {
      accepting = false;
    }
    if (response.unavailable || (!response.scope && lastBoundHost === host))
      throw Error("Task scope is temporarily unavailable. Reopen its history before dispatch.");
    if (!response.scope) return;
    lastBoundHost = host;
    const chosen = response.scope;
    const assertCurrent = async () => {
      if (current() !== host) throw Error("Task session changed");
      await chosen.assertCurrent();
      if (current() !== host) throw Error("Task session changed");
    };
    return { scope: chosen, assertCurrent, host, store: storeFor(chosen) };
  }

  const controller = {
    capture(owner: DispatchOwner = "pi-daddy", expectedHost?: Host): TaskDispatchAdmission | undefined {
      if (expectedHost && (current()?.cwd !== expectedHost.cwd || current()?.sessionId !== expectedHost.sessionId))
        return;
      let binding: ReturnType<typeof select>;
      try {
        binding = select();
      } catch (error) {
        const unavailable = async (): Promise<never> => {
          throw error;
        };
        return Object.assign(unavailable, { assertAvailable: unavailable, reconcile: unavailable });
      }
      if (
        !binding ||
        (expectedHost && (binding.host.cwd !== expectedHost.cwd || binding.host.sessionId !== expectedHost.sessionId))
      )
        return;
      const admit = async (executionId: string, writerFolder?: string): Promise<AdmittedAttempt> => {
        const { host, scope, store } = binding;
        await binding.assertCurrent();
        const writer =
          owner === "pi-daddy" && writerFolder
            ? await claimTaskWriter(directory(), writerFolder, host, executionId)
            : undefined;
        let reserved = false;
        try {
          await binding.assertCurrent();
          store.admit({ owner, executionId, cwd: host.cwd, sessionId: host.sessionId });
          reserved = true;
          await binding.assertCurrent();
        } catch (error) {
          try {
            if (reserved) store.settle(owner, executionId, "not-started");
          } finally {
            writer?.("not-started");
          }
          throw error;
        }
        const controller = new AbortController();
        const checkCancel = () => {
          try {
            if (store.snapshot(scope.revision).state === "cancelling") controller.abort();
          } catch {
            // An unreadable journal does not authorize signalling the running worker.
          }
        };
        checkCancel();
        const timer = setInterval(checkCancel, 2000);
        timer.unref();
        return {
          signal: controller.signal,
          finish(cleanup) {
            clearInterval(timer);
            if (cleanup === "settled" || cleanup === "not-started") {
              try {
                store.settle(owner, executionId, cleanup);
              } finally {
                writer?.(cleanup);
              }
            } else if (cleanup !== "unknown") throw Error("Unsupported task cleanup status");
          },
        };
      };
      return Object.assign(admit, {
        assertAvailable: async () => {
          await binding.assertCurrent();
          binding.store.assertAvailable(owner);
        },
        reconcile: async (executionId: string, cleanup: "settled" | "not-started") => {
          if (cleanup !== "settled" && cleanup !== "not-started") throw Error("A native terminal receipt is required");
          await binding.assertCurrent();
          const pending = binding.store.outstanding().find((a) => a.owner === owner && a.executionId === executionId);
          if (!pending) return;
          if (pending.cwd !== binding.host.cwd) throw Error("Original execution folder changed");
          binding.store.settle(owner, executionId, cleanup);
        },
      });
    },
    async snapshot(): Promise<DispatchView | undefined> {
      const binding = select();
      if (!binding) return;
      await binding.assertCurrent();
      return binding.store.snapshot(binding.scope.revision);
    },
    async change(edit: DispatchEdit, checkClient: () => void): Promise<DispatchView> {
      const b = select();
      const expected = edit.expected;
      if (
        !b ||
        !expected ||
        b.scope.projectId !== expected.projectId ||
        b.scope.taskId !== expected.taskId ||
        b.scope.revision !== expected.selectionRevision ||
        !Number.isSafeInteger(expected.revision)
      )
        throw Error("Selected task changed. Inspect the current task before applying this control.");
      if (!isDispatchEdit(edit)) throw Error("Invalid task control");
      await b.assertCurrent();
      checkClient();
      // The operator acts on the state displayed. Reconciliation itself is safe to repeat.
      if (edit.action === "resume") {
        for (const attempt of b.store.outstanding()) {
          if (attempt.owner !== "pi-daddy") continue;
          const state = await readRuntimeExecutionSettlement(
            directory(),
            attempt.sessionId,
            attempt.cwd,
            attempt.executionId,
          ).catch(() => "unknown" as const);
          if (state !== "unknown") b.store.settle("pi-daddy", attempt.executionId, state);
        }
      }
      await b.assertCurrent();
      checkClient();
      b.store.change(edit.action, edit.limit ?? null, expected.revision, edit.owner);
      return b.store.snapshot(b.scope.revision);
    },
  };
  const unsubscribe = bus?.on?.("pi.task-dispatch.v1.bind", (raw: unknown) => {
    const req = raw as {
      version?: unknown;
      owner?: unknown;
      cwd?: unknown;
      sessionId?: unknown;
      accept?: (admit: unknown) => void;
    };
    if (
      !req ||
      req.version !== 1 ||
      !["scout", "harness", "jev"].includes(String(req.owner)) ||
      typeof req.cwd !== "string" ||
      typeof req.sessionId !== "string" ||
      typeof req.accept !== "function"
    )
      return;
    const admit = controller.capture(req.owner as DispatchOwner, { cwd: req.cwd, sessionId: req.sessionId });
    if (!admit) return;
    req.accept(
      Object.assign(
        async (input: { operationId: string }) => {
          if (!input || typeof input.operationId !== "string") throw Error("Missing native attempt id");
          return admit(input.operationId);
        },
        {
          reconcile: async (input: { operationId: string; cleanup: "settled" | "not-started" }) => {
            if (!input || typeof input.operationId !== "string") throw Error("Missing native attempt id");
            await admit.reconcile(input.operationId, input.cleanup);
          },
        },
      ),
    );
  });
  const stopReplay = bus?.on?.("pi.task-history.v1.replay", (raw: unknown) => {
    const req = raw as {
      version?: unknown;
      owner?: unknown;
      cwd?: unknown;
      sessionId?: unknown;
      projectId?: unknown;
      taskId?: unknown;
      after?: unknown;
      limit?: unknown;
      accept?: (read: () => Promise<ReturnType<TaskDispatch["page"]>>) => void;
    };
    const host = current();
    if (
      !req ||
      !host ||
      req.version !== 1 ||
      req.owner !== "pi-daddy" ||
      req.cwd !== host.cwd ||
      req.sessionId !== host.sessionId ||
      typeof req.accept !== "function" ||
      typeof req.after !== "number" ||
      typeof req.limit !== "number"
    )
      return;
    const binding = select();
    if (!binding || req.projectId !== binding.scope.projectId || req.taskId !== binding.scope.taskId) return;
    const after = req.after,
      limit = req.limit;
    req.accept(async () => {
      await binding.assertCurrent();
      const page = binding.store.page(after, limit);
      await binding.assertCurrent();
      return page;
    });
  });
  return Object.assign(controller, {
    close: () => {
      unsubscribe?.();
      stopReplay?.();
    },
  });
}
