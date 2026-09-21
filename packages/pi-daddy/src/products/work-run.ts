import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createControlJournal, controlJournal, type ControlBinding } from "./control-journal.ts";
import { composeStepTask, HANDOFF_MAX_BYTES } from "../kernel/chain.ts";
import { splitBudget } from "../kernel/fanout.ts";
import { workSetup, type WorkSetup, type WorkTaskSetup } from "./work-setup.ts";

export interface WorkRunOutcome {
  ok: boolean;
  text: string;
  reason?: string;
  control?: "failed";
  exitCode: number | null;
  truncated?: boolean;
  aborted?: boolean;
  timedOut?: boolean;
}
export interface WorkRunTask {
  id: string;
  state: "waiting" | "running" | "finished" | "failed" | "blocked";
  executionId: string | null;
  resultPath: string | null;
  resultDigest: string | null;
  reason: string | null;
}
export interface WorkPolicyPin {
  orderId: string;
  candidateDigest: string;
  adoptionId: string | null;
  revision: number;
  scopeDigest: string;
}
export interface WorkRunInitial {
  version: "work-run-v1";
  runId: string;
  selectionDigest: string;
  setup: WorkSetup;
  policyPin: WorkPolicyPin | null;
}
export interface WorkRunResult {
  binding: ControlBinding<WorkRunInitial>;
  tasks: WorkRunTask[];
  acceptance: "not-assessed";
}
/** Finite DAG scheduler only. Execution, grants, cancellation, deadlines and observation remain original-owner operations. */
export async function runWorkSetup(input: {
  directory: string;
  selectionDigest: string;
  setup: WorkSetup;
  budget: number;
  signal?: AbortSignal;
  orderId?: string;
  policyPin?: WorkPolicyPin | null;
  execute(
    task: WorkTaskSetup,
    prompt: string,
    perChildBudget: number,
    started: (executionId: string) => Promise<void>,
  ): Promise<WorkRunOutcome>;
  onUpdate?: (tasks: readonly WorkRunTask[]) => void;
  priorities?: string[];
  /** Read the existing owner hold; waiting here never grants or performs a control action. */
  admissionOpen?: () => boolean;
}): Promise<WorkRunResult> {
  const setup = workSetup(input.setup),
    split = splitBudget(input.budget, setup.tasks.length);
  if (!split.ok) throw Error(split.reason);
  if (!/^[a-f0-9]{64}$/.test(input.selectionDigest)) throw Error("exact selected work digest required");
  const order = input.priorities ?? setup.tasks.map((t) => t.id);
  if (
    order.length !== setup.tasks.length ||
    new Set(order).size !== order.length ||
    order.some((id) => !setup.tasks.some((t) => t.id === id))
  )
    throw Error("priority must name each task exactly once");
  const binding = await createControlJournal(input.directory, {
    version: "work-run-v1" as const,
    runId: input.orderId ?? randomUUID(),
    selectionDigest: input.selectionDigest,
    setup,
    policyPin: input.policyPin ?? null,
  });
  const journal = controlJournal(binding),
    outcomes = new Map<string, WorkRunOutcome>();
  const tasks: WorkRunTask[] = order.map((id) => ({
    id,
    state: "waiting",
    executionId: null,
    resultPath: null,
    resultDigest: null,
    reason: null,
  }));
  const running = new Map<string, Promise<void>>();
  let persistenceFailure: unknown;
  const publish = () => {
    try {
      input.onUpdate?.(tasks.map((t) => ({ ...t })));
    } catch {
      /* display is not execution */
    }
  };
  const record = (task: WorkRunTask) =>
    journal.transaction(async (_events, append) => append({ type: "task", ...task }));
  while (tasks.some((t) => t.state === "waiting") || running.size) {
    for (const row of tasks.filter((t) => t.state === "waiting")) {
      const spec = setup.tasks.find((t) => t.id === row.id)!;
      if (
        input.signal?.aborted ||
        persistenceFailure ||
        spec.dependencies.some((d) => ["failed", "blocked"].includes(tasks.find((t) => t.id === d)!.state))
      ) {
        row.state = "blocked";
        row.reason = input.signal?.aborted
          ? "Cancelled before admission"
          : persistenceFailure
            ? "Result/control persistence failed; no further admission"
            : "A dependency did not finish successfully";
        try {
          await record(row);
        } catch (error) {
          persistenceFailure ??= error;
        }
        continue;
      }
      if (
        input.admissionOpen?.() === false ||
        running.size >= setup.maxParallel ||
        !spec.dependencies.every((d) => tasks.find((t) => t.id === d)!.state === "finished")
      )
        continue;
      row.state = "running";
      const pending = (async () => {
        try {
          const previous = spec.dependencies.map((d) => `${d}\n${outcomes.get(d)!.text}`).join("\n\n");
          if (Buffer.byteLength(previous) > HANDOFF_MAX_BYTES)
            throw Error(
              "Complete predecessor output exceeds the 32 KiB handoff bound; dependent work was not launched",
            );
          await record(row);
          const outcome = await input.execute(
            spec,
            composeStepTask(spec.outcome, spec.dependencies.length ? previous : undefined),
            split.perChild,
            async (executionId) => {
              row.executionId = executionId;
              await record(row);
              publish();
            },
          );
          outcomes.set(spec.id, outcome);
          if (Buffer.byteLength(outcome.text) > 1024 * 1024)
            throw Error("original child result exceeds retention bound");
          const bytes = Buffer.from(outcome.text),
            file = `${spec.id}.txt`;
          await writeFile(join(binding.directory, file), bytes, { mode: 0o600, flag: "wx" });
          row.resultPath = join(binding.directory, file);
          row.resultDigest = createHash("sha256").update(bytes).digest("hex");
          row.state = outcome.ok && !outcome.control && !outcome.truncated ? "finished" : "failed";
          row.reason =
            row.state === "finished"
              ? null
              : (outcome.reason ??
                (outcome.control
                  ? "Observation/control failed"
                  : outcome.truncated
                    ? "Output truncated"
                    : "Attempt failed"));
        } catch (error) {
          row.state = "failed";
          row.reason = String(error);
        }
        try {
          await record(row);
        } catch (error) {
          persistenceFailure ??= error;
          row.state = "failed";
          row.reason = `Control acknowledgement unknown: ${String(error)}`;
        }
        publish();
      })().finally(() => running.delete(row.id));
      running.set(row.id, pending);
      publish();
    }
    publish();
    if (running.size) await Promise.race(running.values());
    else if (tasks.some((t) => t.state === "waiting"))
      await wait(100, undefined, { signal: input.signal }).catch((error) => {
        if (!input.signal?.aborted) throw error;
      });
  }
  // No detached promises, restart relaunch, refund or retry. Original children have all settled here.
  if (persistenceFailure)
    throw Error(`Work results may exist but control persistence failed: ${String(persistenceFailure)}`);
  return { binding, tasks, acceptance: "not-assessed" };
}
export async function inspectWorkRun(binding: ControlBinding<WorkRunInitial>): Promise<WorkRunResult> {
  workSetup(binding.initial.setup);
  if (binding.initial.version !== "work-run-v1") throw Error("unsupported work run");
  const rows = new Map<string, WorkRunTask>();
  for (const event of (await controlJournal(binding).read()).events)
    if (event.type === "task") rows.set(String(event.id), event as unknown as WorkRunTask);
  return {
    binding,
    tasks: binding.initial.setup.tasks.map(
      (t) =>
        rows.get(t.id) ?? {
          id: t.id,
          state: "waiting",
          executionId: null,
          resultPath: null,
          resultDigest: null,
          reason: "No launch acknowledgement; do not infer or retry",
        },
    ),
    acceptance: "not-assessed",
  };
}
