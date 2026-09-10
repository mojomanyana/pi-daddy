import { randomUUID } from "node:crypto";
import { archivePolicyBinding, ingestPolicySource } from "./archive-policy.js";
import { retainArchiveSource } from "./evidence-archive.js";
export interface ArchiveObserverOptions {
  policyPath: string; sourceId: string; intervalMs: number; maxPolls: number;
  previousCheckpointId?: string; signal?: AbortSignal;
  /** Optional synchronous metadata consumer, never a worker hook. Its failure does not stop capture. */
  onObservation?: (value: ReturnType<typeof ingestPolicySource>) => void;
}
function cadence(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms); signal?.addEventListener("abort", finish, { once: true });
  });
}
/** Bounded external file observation. No worker process, socket, session API, prompt or control channel is used. */
export async function observeArchiveSource(options: ArchiveObserverOptions) {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1 || options.intervalMs > 60000
    || !Number.isSafeInteger(options.maxPolls) || options.maxPolls < 1 || options.maxPolls > 128) throw new Error("bounded observer interval/poll count required");
  const binding = archivePolicyBinding(options.policyPath, options.sourceId), observerId = randomUUID(), startedAt = new Date().toISOString();
  let lastCheckpointId = options.previousCheckpointId ?? null, polls = 0, receiptId = "", consumer = options.onObservation;
  let stopped: "poll-limit" | "aborted" | "policy-change" = "poll-limit", terminal = false;
  const gaps = new Set<string>();
  const records: Array<{ poll: number; at: string; checkpointId: string | null; state: "captured" | "gap" }> = [];
  const persist = () => retainArchiveSource(binding.archiveRoot, {
    sourceId: `observer-${observerId}`, parser: { id: "archive-observer", version: "1" }, retention: "exact",
    bytes: Buffer.from(JSON.stringify({ version: "archive-observer-v1", observerId, policySha256: binding.policySha256, sourceId: binding.sourceId,
      startedAt, polls, lastCheckpointId, state: terminal ? "terminal" : "running", stopped: terminal ? stopped : null, gaps: [...gaps].sort(), records, workerInteractions: 0, continuity: "bounded-observations-not-complete-live-coverage" })),
  }).manifestId;
  for (let i = 0; i < options.maxPolls; i++) {
    if (options.signal?.aborted) { stopped = "aborted"; break; }
    try { if (archivePolicyBinding(options.policyPath, options.sourceId).policySha256 !== binding.policySha256) throw new Error("changed"); }
    catch { gaps.add("policy-changed-or-unavailable"); stopped = "policy-change"; break; }
    polls++;
    try {
      const observation = ingestPolicySource(options.policyPath, options.sourceId, lastCheckpointId ?? undefined, binding.policySha256);
      lastCheckpointId = observation.checkpointId;
      records.push({ poll: polls, at: new Date().toISOString(), checkpointId: lastCheckpointId, state: "captured" });
      if (consumer) {
        try {
          const returned = consumer(observation) as unknown;
          if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
            gaps.add("async-consumer-outcome-unobserved"); consumer = undefined;
            // The unsupported asynchronous outcome is already an explicit durable gap; never await it on capture.
            void Promise.resolve(returned).catch(() => undefined);
          }
        } catch { gaps.add("observation-consumer-failed"); consumer = undefined; }
      }
    } catch { gaps.add("source-observation-failed"); records.push({ poll: polls, at: new Date().toISOString(), checkpointId: lastCheckpointId, state: "gap" }); }
    receiptId = persist();
    if (i + 1 < options.maxPolls) await cadence(options.intervalMs, options.signal);
  }
  if (options.signal?.aborted) stopped = "aborted";
  terminal = true; receiptId = persist();
  return { observerId, polls, lastCheckpointId, receiptId, stopped, gaps: [...gaps].sort(), workerInteractions: 0 as const };
}
