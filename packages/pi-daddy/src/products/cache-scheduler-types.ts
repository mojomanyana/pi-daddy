/** Trusted coordinator contracts, not a client protocol or an eligibility/authority oracle.
 * Only a qualified owned-run adapter may certify exited or cleanupVerified. Successful callback
 * responses in synthetic tests do not prove filesystem consistency, determinism or process death.
 */
import type { CacheWorkspace, CacheObservation, CacheResultRef, CacheRunTicket } from "./cache-graph.ts";
import type { CachePayloadToken } from "./cache-payloads.ts";
export interface CacheRequester {
  readonly cacheRequester: unique symbol;
}
export interface CacheWork {
  readonly cacheWork: unique symbol;
}
export interface CacheRequest {
  readonly cacheRequest: unique symbol;
}
export interface CacheRunOutcome {
  output: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  timedOut: boolean;
  complete: boolean;
}
export interface OwnedCacheRun {
  outcome: Promise<CacheRunOutcome>;
  exited: Promise<void>;
  stop(): Promise<void>;
}
export interface CacheWorkPlan {
  workspace: CacheWorkspace;
  key: string;
  inputs: readonly CacheObservation[];
  parents: readonly CacheResultRef[];
  shareable: boolean;
  validate(signal: AbortSignal): Promise<boolean>;
  start(options: { executionId: string; signal: AbortSignal; onData(bytes: Buffer): void }): Promise<OwnedCacheRun>;
}
export interface CacheRequestOptions {
  force?: boolean;
  signal?: AbortSignal;
  waitMs?: number;
  onData?(bytes: Buffer): void;
}
export interface CacheResolution {
  requestId: string;
  kind: "execute" | "join" | "reuse" | "bypass" | "reject" | "cancelled" | "timed-out";
  executionId?: string;
  outcome?: Readonly<CacheRunOutcome>;
  published?: boolean;
  reason?: string;
}
export interface CacheSchedulerLimits {
  running: number;
  pending: number;
  requests: number;
  requesters: number;
  work: number;
  validationMs: number;
  completionMs: number;
  calls: number;
  streamBytes: number;
  streamChunks: number;
  replies: { bytes: number; itemBytes: number; payloads: number; deliveries: number };
}
export class CacheStartFailure extends Error {
  readonly cleanupVerified: boolean;
  constructor(message: string, cleanupVerified: boolean) {
    super(message);
    this.cleanupVerified = cleanupVerified;
  }
}
export interface ActorRow {
  token: CacheRequester;
  authorize(work: CacheWork): boolean;
  requests: Set<RequestRow>;
}
export interface WorkRow {
  token: CacheWork;
  plan: Readonly<CacheWorkPlan>;
}
export interface RequestRow {
  token: CacheRequest;
  id: string;
  actor: ActorRow;
  work: WorkRow;
  force: boolean;
  state: "new" | "checking" | "waiting" | "done";
  controller: AbortController;
  removeSignal?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  onData?: (bytes: Buffer) => void;
  promise?: Promise<CacheResolution>;
  resolve?: (result: CacheResolution) => void;
  summary?: Omit<CacheResolution, "outcome">;
  metadata?: Omit<CacheRunOutcome, "output">;
  payload?: CachePayloadToken;
  execution?: ExecutionRow;
}
export interface ExecutionRow {
  id: string;
  work: WorkRow;
  interests: Set<RequestRow>;
  kinds: Map<RequestRow, "execute" | "join">;
  controller: AbortController;
  ticket?: CacheRunTicket;
  handle?: OwnedCacheRun;
  active: boolean;
  started: boolean;
  exitVerified: boolean;
  stopping: boolean;
  task?: Promise<void>;
  fault?: Error;
  stream: Buffer[];
  streamBytes: number;
  replayable: boolean;
}
