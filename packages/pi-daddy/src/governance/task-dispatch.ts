/** Owner journal for parent Pi dispatch. A history replay never launches or cancels a child. */
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { readBoundedTextSync } from "../kernel/bounded-read-sync.ts";
import { artifactHash, privateArtifactDirectory, publishArtifact } from "./operation-artifact-io.ts";

export const dispatchOwners = ["pi-daddy", "scout", "harness", "jev"] as const;
export type DispatchOwner = (typeof dispatchOwners)[number];
export interface DispatchCounts {
  admitted: number;
  outstanding: number;
  limit: number | null;
}
const isOwner = (value: unknown): value is DispatchOwner => dispatchOwners.includes(value as DispatchOwner);
const attemptKey = (owner: DispatchOwner, executionId: string) => JSON.stringify([owner, executionId]);
export type DispatchCommand = "pause" | "cancel" | "resume" | "budget";
export interface DispatchView {
  projectId: string;
  taskId: string;
  selectionRevision: number;
  revision: number;
  state: "open" | "pausing" | "paused" | "cancelling" | "cancelled";
  counts: Record<DispatchOwner, DispatchCounts>;
  admitted: number;
  outstanding: number;
  limit: number | null;
}
export interface DispatchEdit {
  action: DispatchCommand;
  limit?: number | null;
  owner?: DispatchOwner | "task";
  expected: Pick<DispatchView, "projectId" | "taskId" | "selectionRevision" | "revision">;
}

export function isDispatchEdit(value: unknown): value is DispatchEdit {
  if (!value || typeof value !== "object") return false;
  const edit = value as Partial<DispatchEdit>;
  const expected = edit.expected;
  return (
    !!expected &&
    typeof expected === "object" &&
    Object.keys(expected).every((k) => ["projectId", "taskId", "selectionRevision", "revision"].includes(k)) &&
    validText(expected.projectId, 512) &&
    validText(expected.taskId, 160) &&
    Number.isSafeInteger(expected.selectionRevision) &&
    expected.selectionRevision >= 0 &&
    Number.isSafeInteger(expected.revision) &&
    expected.revision >= 0 &&
    Object.keys(edit).every((k) =>
      ["action", "expected", ...(edit.action === "budget" ? ["limit", "owner"] : [])].includes(k),
    ) &&
    (edit.action === "budget"
      ? validTaskLimit(edit.limit) && (edit.owner === undefined || edit.owner === "task" || isOwner(edit.owner))
      : ["pause", "cancel", "resume"].includes(edit.action ?? ""))
  );
}

type Attempt = { owner: DispatchOwner; executionId: string; sessionId: string; cwd: string };
type Control =
  | { action: "admit"; attempt: Attempt }
  | { action: "settle"; owner: DispatchOwner; executionId: string; cleanup: "settled" | "not-started" }
  | { action: "pause" | "cancel" | "resume" }
  | { action: "budget"; owner: DispatchOwner | "task"; limit: number | null };
const errno = (e: unknown, code: string) => (e as NodeJS.ErrnoException)?.code === code;
const validText = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export const validTaskLimit = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);

export class TaskDispatch {
  readonly projectId: string;
  readonly taskId: string;
  private readonly root: string;
  private readonly exclusive: boolean;
  private revision = 0;
  private policyRevision = 0;
  private previousPolicy?: { revision: number; event: Control };
  private taskLimit: number | null = null;
  private mode: "open" | "pause" | "cancel" = "open";
  private readonly counts = Object.fromEntries(
    dispatchOwners.map((owner) => [owner, { admitted: 0, outstanding: 0, limit: null }]),
  ) as Record<DispatchOwner, DispatchCounts>;
  private readonly admitted = new Set<string>();
  private readonly pending = new Map<string, Attempt>();

  constructor(directory: string, projectId: string, taskId: string, exclusiveWriter = false) {
    this.exclusive = exclusiveWriter;
    if (!validText(projectId, 512) || !validText(taskId, 160)) throw Error("Invalid task identity");
    this.projectId = projectId;
    this.taskId = taskId;
    this.root = join(
      realpathSync(directory),
      "pi-daddy",
      exclusiveWriter ? "task-writers" : "task-dispatch",
      artifactHash(JSON.stringify([projectId, taskId])),
    );
  }

  snapshot(selectionRevision: number): DispatchView {
    this.catchUp();
    const outstanding = this.pending.size;
    const state =
      this.mode === "cancel"
        ? outstanding
          ? "cancelling"
          : "cancelled"
        : this.mode === "pause"
          ? outstanding
            ? "pausing"
            : "paused"
          : "open";
    return {
      projectId: this.projectId,
      taskId: this.taskId,
      selectionRevision,
      revision: this.policyRevision,
      state,
      outstanding,
      admitted: this.admitted.size,
      counts: structuredClone(this.counts),
      limit: this.taskLimit,
    };
  }

  change(
    action: DispatchCommand,
    limit: number | null,
    expectedRevision: number,
    owner: DispatchOwner | "task" = "task",
  ) {
    const event: Control = action === "budget" ? { action, owner, limit } : { action };
    this.append(event, () => {
      if (this.policyRevision !== expectedRevision) {
        if (
          this.previousPolicy?.revision === expectedRevision &&
          JSON.stringify(event) === JSON.stringify(this.previousPolicy.event)
        )
          return false;
        throw Error("Task policy changed. Refresh before applying a command.");
      }
      if (action === "pause" && this.mode === "cancel" && this.pending.size)
        throw Error("Cancellation is still settling.");
      if (action === "resume" && this.mode === "cancel" && this.pending.size)
        throw Error("Cancellation is still settling. Outstanding executions must be reconciled first.");
      if (
        action === "budget" &&
        (!validTaskLimit(limit) ||
          (limit !== null && limit < (owner === "task" ? this.admitted.size : this.counts[owner].admitted)))
      )
        throw Error("The allowance must cover all previously admitted attempts.");
    });
  }

  assertAvailable(owner: DispatchOwner) {
    this.catchUp();
    if (this.mode !== "open") throw Error("Task dispatch is stopped. Inspect task controls before resuming.");
    if (this.taskLimit !== null && this.admitted.size >= this.taskLimit)
      throw Error("This task's shared attempt allowance is exhausted.");
    const bucket = this.counts[owner];
    if (bucket.limit !== null && bucket.admitted >= bucket.limit)
      throw Error(owner + " task attempt allowance is exhausted.");
  }

  admit(attempt: Attempt) {
    if (!validText(attempt.executionId, 256) || !validText(attempt.sessionId, 256) || !validText(attempt.cwd, 4096))
      throw Error("Invalid task dispatch identity");
    this.append({ action: "admit", attempt }, () => {
      this.assertAvailable(attempt.owner);
      if (this.exclusive && this.pending.size)
        throw Error(
          "A writer already owns this working copy. Reuse its result or select a separate registered worktree.",
        );
      if (this.admitted.has(attemptKey(attempt.owner, attempt.executionId)))
        throw Error("Task attempt already reserved. Reconcile the existing execution.");
    });
  }

  settle(owner: DispatchOwner, executionId: string, cleanup: "settled" | "not-started") {
    this.append({ action: "settle", owner, executionId, cleanup }, () =>
      this.pending.has(attemptKey(owner, executionId)),
    );
  }

  outstanding(): Attempt[] {
    this.catchUp();
    return [...this.pending.values()];
  }

  private recordAt(seq: number): Control | undefined {
    let text: string;
    try {
      text = readBoundedTextSync(join(this.root, seq + ".json"), { maxBytes: 16_384, confinedRoot: this.root }).text;
    } catch (error) {
      if (errno(error, "ENOENT")) return;
      throw error;
    }
    const record = JSON.parse(text);
    if (
      record?.version !== 1 ||
      record.seq !== seq ||
      record.taskId !== this.taskId ||
      record.projectId !== this.projectId ||
      !record.event
    )
      throw Error("Task dispatch history is unavailable or incompatible");
    return record.event as Control;
  }

  private readable(): boolean {
    try {
      privateArtifactDirectory(this.root);
      return true;
    } catch (error) {
      if (errno(error, "ENOENT") && this.revision === 0) return false;
      throw error;
    }
  }

  private catchUp() {
    if (!this.readable()) return;
    for (;;) {
      const event = this.recordAt(this.revision + 1);
      if (!event) return;
      this.apply(event);
      this.revision++;
    }
  }

  /** Return bounded, metadata-only observations of the journal. There is no dispatch path in replay. */
  page(after: number, limit: number) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      after > Number.MAX_SAFE_INTEGER - 51 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw Error("Invalid task history cursor or page size");
    const events: Array<{
      version: 1;
      owner: "pi-daddy";
      operationId: string;
      kind: string;
      state: string;
      label: string;
    }> = [];
    const present = this.readable();
    if (after && (!present || !this.recordAt(after))) throw Error("Task history cursor is unavailable");
    let next = after;
    while (present && events.length < limit) {
      const seq = next + 1,
        event = this.recordAt(seq);
      if (!event) break;
      let state: string, label: string, identity: string;
      switch (event.action) {
        case "admit":
        case "settle": {
          const owner = event.action === "admit" ? event.attempt?.owner : event.owner;
          const id = event.action === "admit" ? event.attempt?.executionId : event.executionId;
          if (
            !isOwner(owner) ||
            !validText(id, 256) ||
            (event.action === "settle" && !["settled", "not-started"].includes(event.cleanup))
          )
            throw Error("Invalid task dispatch receipt");
          identity = JSON.stringify([owner, id]);
          state = event.action === "admit" ? "admitted" : event.cleanup;
          label =
            event.action === "admit"
              ? owner + " attempt admitted"
              : event.cleanup === "settled"
                ? owner + " cleanup confirmed"
                : owner + " attempt confirmed unstarted";
          break;
        }
        case "budget":
        case "pause":
        case "cancel":
        case "resume":
          if (
            event.action === "budget" &&
            ((!isOwner(event.owner) && event.owner !== "task") || !validTaskLimit(event.limit))
          )
            throw Error("Invalid task budget");
          identity = "policy-" + seq;
          state = event.action;
          label =
            event.action === "budget"
              ? event.owner + " attempt cap " + (event.limit === null ? "removed" : "set to " + event.limit)
              : event.action === "pause"
                ? "Pause requested"
                : event.action === "cancel"
                  ? "Cancellation requested"
                  : "Dispatch resumed";
          break;
        default:
          throw Error("Unsupported task receipt");
      }
      events.push({
        version: 1,
        owner: "pi-daddy",
        operationId: "dispatch-" + artifactHash(JSON.stringify([this.projectId, this.taskId, identity])),
        kind: "dispatch",
        state,
        label,
      });
      next = seq;
    }
    return { after, next, more: present && Boolean(this.recordAt(next + 1)), events };
  }

  private apply(event: Control) {
    switch (event?.action) {
      case "admit": {
        const a = event.attempt;
        if (
          !a ||
          !validText(a.executionId, 256) ||
          !validText(a.sessionId, 256) ||
          !validText(a.cwd, 4096) ||
          !isOwner(a.owner) ||
          this.admitted.has(attemptKey(a.owner, a.executionId))
        )
          throw Error("Invalid task dispatch reservation");
        this.admitted.add(attemptKey(a.owner, a.executionId));
        this.pending.set(attemptKey(a.owner, a.executionId), a);
        this.counts[a.owner].admitted++;
        this.counts[a.owner].outstanding++;
        break;
      }
      case "settle":
        if (
          !["settled", "not-started"].includes(event.cleanup) ||
          !isOwner(event.owner) ||
          !this.pending.delete(attemptKey(event.owner, event.executionId))
        )
          throw Error("Invalid task dispatch settlement");
        this.counts[event.owner].outstanding--;
        break;
      case "budget":
        if ((event.owner !== "task" && !isOwner(event.owner)) || !validTaskLimit(event.limit))
          throw Error("Invalid task dispatch allowance");
        if (event.owner === "task") this.taskLimit = event.limit;
        else this.counts[event.owner].limit = event.limit;
        break;
      case "pause":
      case "cancel":
        this.mode = event.action;
        break;
      case "resume":
        this.mode = "open";
        break;
      default:
        throw Error("Unknown task dispatch record");
    }
    if (["budget", "pause", "cancel", "resume"].includes(event?.action)) {
      this.previousPolicy = { revision: this.policyRevision, event };
      this.policyRevision = this.revision + 1;
    }
  }

  private append(event: Control, admit: () => void | boolean) {
    privateArtifactDirectory(this.root, true);
    for (;;) {
      this.catchUp();
      if (admit() === false) return;
      const seq = this.revision + 1;
      const entry = {
        version: 1,
        seq,
        projectId: this.projectId,
        taskId: this.taskId,
        at: new Date().toISOString(),
        event,
      };
      const data = JSON.stringify(entry) + "\n";
      if (Buffer.byteLength(data) > 16_384) throw Error("Task dispatch record exceeds its size bound");
      try {
        publishArtifact(this.root, seq + ".json", data, false);
      } catch (error) {
        if (errno(error, "EEXIST")) continue;
        throw error;
      }
      this.apply(event);
      this.revision = seq;
      return;
    }
  }
}
