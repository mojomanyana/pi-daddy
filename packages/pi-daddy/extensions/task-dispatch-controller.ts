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
import {
  readRuntimeExecutionSettlement,
  pinPrelaunchOwner,
  type RuntimeSettlement,
} from "../src/governance/runtime-settlement.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface TaskScope {
  projectId: string;
  budgetRootTaskId?: string;
  taskId: string;
  revision: number;
  assertCurrent(): Promise<void>;
}
type Host = { cwd: string; sessionId: string };
export type AdmittedAttempt = {
  beforeRuntimeBegin?: (runtime: RuntimeSettlement | undefined) => void;
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
  nativeOwner?: () => RuntimeSettlement | undefined,
) {
  let lastBoundHost: Host | undefined;
  let previous: TaskDispatch | undefined;
  let lastDisplay:
    | { host: Host; project: string; task: string; root: string; revision: number; checked: number; view: DispatchView }
    | undefined;
  const storeFor = (scope: TaskScope) => {
    const rootId = scope.budgetRootTaskId ?? scope.taskId;
    if (!previous || previous.projectId !== scope.projectId || previous.taskId !== rootId)
      previous = new TaskDispatch(directory(), scope.projectId, rootId);
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
          if (!accepting) return;
          if (response.scope) {
            response.unavailable = true;
            return;
          }
          if (
            candidate &&
            typeof candidate.projectId === "string" &&
            typeof candidate.taskId === "string" &&
            (candidate.budgetRootTaskId === undefined || typeof candidate.budgetRootTaskId === "string") &&
            Number.isSafeInteger(candidate.revision) &&
            typeof candidate.assertCurrent === "function"
          )
            response.scope = candidate;
          else response.unavailable = true;
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

  // Recover an interrupted predecessor without replacing its occurrence ID. Missing or ambiguous receipts stay pending.
  async function reconcilePredecessor(binding: NonNullable<ReturnType<typeof select>>) {
    const runtime = nativeOwner?.();
    if (!runtime) return;
    for (const attempt of binding.store.outstanding()) {
      if (attempt.owner !== "pi-daddy" || !attempt.beforeLaunch || attempt.beforeLaunch.ownerId === runtime.ownerId)
        continue;
      const state = await readRuntimeExecutionSettlement(
        directory(),
        attempt.sessionId,
        attempt.cwd,
        attempt.executionId,
        attempt.beforeLaunch,
      ).catch(() => "unknown" as const);
      if (state !== "unknown") {
        await binding.assertCurrent();
        binding.store.settle(attempt.owner, attempt.executionId, state, attempt.taskId ?? binding.store.taskId);
      }
    }
  }

  const controller = {
    /** Capture the current inline scope without enrolling a new execution or spending an attempt. */
    captureDelivery(): { taskId?: string; assertMayContinue(): Promise<void> } {
      const host = current();
      try {
        const binding = select();
        return {
          taskId: binding?.scope.taskId,
          async assertMayContinue() {
            if (!host || current() !== host) throw Error("The delivery session changed.");
            const selected = select();
            if (
              selected?.scope.projectId !== binding?.scope.projectId ||
              selected?.scope.taskId !== binding?.scope.taskId ||
              selected?.store.taskId !== binding?.store.taskId ||
              selected?.scope.revision !== binding?.scope.revision
            )
              throw Error("The selected delivery task changed.");
            if (binding) {
              await binding.assertCurrent();
              binding.store.assertOpen();
            }
          },
        };
      } catch (error) {
        return {
          async assertMayContinue() {
            throw error;
          },
        };
      }
    },
    /** An inline effect's owner can consult the shared pause state without spending a delegated attempt. */
    captureInline(): (() => Promise<void>) | undefined {
      let binding: ReturnType<typeof select>;
      try {
        binding = select();
      } catch (error) {
        return async () => {
          throw error;
        };
      }
      if (!binding) return;
      return async () => {
        await binding.assertCurrent();
        binding.store.assertOpen();
      };
    },
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
        const native = owner === "pi-daddy" ? nativeOwner?.() : undefined;
        if (owner === "pi-daddy" && nativeOwner && !native)
          throw Error("Native owner is unavailable before task admission");
        const beforeLaunch = native ? pinPrelaunchOwner(native, host.sessionId, host.cwd) : undefined;
        const writer =
          owner === "pi-daddy" && writerFolder
            ? await claimTaskWriter(directory(), writerFolder, host, executionId, beforeLaunch)
            : undefined;
        let reserved = false;
        try {
          await binding.assertCurrent();
          store.admit({
            owner,
            executionId,
            taskId: scope.taskId,
            cwd: host.cwd,
            sessionId: host.sessionId,
            ...(beforeLaunch ? { beforeLaunch } : {}),
          });
          reserved = true;
          await binding.assertCurrent();
        } catch (error) {
          try {
            if (reserved) store.settle(owner, executionId, "not-started", scope.taskId);
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
          ...(native
            ? {
                beforeRuntimeBegin(runtime: RuntimeSettlement | undefined) {
                  if (runtime !== native || runtime !== nativeOwner?.() || current() !== host)
                    throw Error("Task reservation's native owner changed before executor entry");
                },
              }
            : {}),
          finish(cleanup) {
            clearInterval(timer);
            if (cleanup === "settled" || cleanup === "not-started") {
              try {
                store.settle(owner, executionId, cleanup, scope.taskId);
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
          await reconcilePredecessor(binding);
          binding.store.assertAvailable(owner);
        },
        reconcile: async (executionId: string, cleanup: "settled" | "not-started") => {
          if (cleanup !== "settled" && cleanup !== "not-started") throw Error("A native terminal receipt is required");
          await binding.assertCurrent();
          const pending = binding.store.outstanding().find((a) => a.owner === owner && a.executionId === executionId);
          if (!pending) return;
          if (pending.cwd !== binding.host.cwd) throw Error("Original execution folder changed");
          binding.store.settle(owner, executionId, cleanup, binding.scope.taskId);
        },
      });
    },
    async snapshot(reuseDisplayed = false): Promise<DispatchView | undefined> {
      const binding = select();
      if (!binding) return;
      const { scope, host, store } = binding;
      if (
        reuseDisplayed &&
        lastDisplay &&
        lastDisplay.host === host &&
        lastDisplay.root === store.taskId &&
        lastDisplay.project === scope.projectId &&
        lastDisplay.task === scope.taskId &&
        lastDisplay.revision === scope.revision &&
        Date.now() >= lastDisplay.checked &&
        Date.now() - lastDisplay.checked < 1000
      )
        return lastDisplay.view;
      await binding.assertCurrent();
      const checked = Date.now(),
        view = store.snapshot(scope.revision, scope.taskId);
      view.observedAt = new Date(checked).toISOString();
      lastDisplay = {
        host,
        project: scope.projectId,
        task: scope.taskId,
        root: store.taskId,
        revision: scope.revision,
        checked,
        view,
      };
      return view;
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
      if (b.store.taskId !== b.scope.taskId) throw Error("Select the parent task to change shared dispatch controls.");
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
            attempt.beforeLaunch,
          ).catch(() => "unknown" as const);
          if (state !== "unknown")
            b.store.settle("pi-daddy", attempt.executionId, state, attempt.taskId ?? b.store.taskId);
        }
      }
      await b.assertCurrent();
      checkClient();
      lastDisplay = undefined;
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
      const page = binding.store.page(after, limit, binding.scope.taskId);
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
