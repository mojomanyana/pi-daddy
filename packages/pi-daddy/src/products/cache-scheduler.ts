/** Bounded epoch-local sharing over TRUSTED prepared work, not a transport, profile checker or launcher.
 * Authorization is checked synchronously before EACH access and again after validation/queue delay.
 * Exact coordinator-generated keys must already include effective args/env/cwd/runtime/input identity;
 * model text or claimed hashes may never prepare work. Opaque handles cannot cross instances.
 * Logical retries use the SAME request handle; acknowledged handles cannot silently execute again.
 * Actual-exit ownership, not output completion or stop dispatch, releases a running slot. Root namespace
 * supervision remains mandatory: a rejected start without verified cleanup permanently faults admission.
 * Waiting deadlines detach interests; tool execution bounds remain the owned runner's responsibility.
 * Streaming gets private exact bytes per current interested reader. Reader failure detaches only it.
 * Count/UTF8 limits aren't RSS guarantees. No client endpoint or existing Pi tool is changed here.
 */
import { randomUUID } from "node:crypto";
import { CachePayloads } from "./cache-payloads.ts";
import { CacheStartFailure } from "./cache-scheduler-types.ts";
import { cacheRunOutcome, encodeCacheReplay, decodeCacheReplay } from "./cache-scheduler-replay.ts";
import { observeCacheReport, waitCacheReport } from "./cache-scheduler-wait.ts";
import type { CacheGraph } from "./cache-graph.ts";
import type {
  CacheRequester,
  CacheWork,
  CacheRequest,
  CacheResolution,
  CacheRequestOptions,
  CacheSchedulerLimits,
  CacheWorkPlan,
  CacheRunOutcome,
  ActorRow,
  WorkRow,
  RequestRow,
  ExecutionRow,
} from "./cache-scheduler-types.ts";
export { CacheStartFailure } from "./cache-scheduler-types.ts";
export type {
  CacheRequester,
  CacheWork,
  CacheRequest,
  CacheResolution,
  CacheRequestOptions,
  CacheSchedulerLimits,
  CacheWorkPlan,
  CacheRunOutcome,
  OwnedCacheRun,
} from "./cache-scheduler-types.ts";

export class CacheScheduler {
  private limits: CacheSchedulerLimits;
  private replies: CachePayloads;
  private actors = new Map<CacheRequester, ActorRow>();
  private work = new Map<CacheWork, WorkRow>();
  private requests = new WeakMap<CacheRequest, RequestRow>();
  private known = new WeakSet<CacheRequest>();
  private live = new Set<RequestRow>();
  private queue: ExecutionRow[] = [];
  private executions = new Set<ExecutionRow>();
  private calls = 0;
  private closed = false;
  private shutdownTask?: Promise<void>;
  private fault?: Error;
  get failure(): Error | undefined {
    return this.fault;
  }
  private graph: CacheGraph;
  constructor(graph: CacheGraph, limits: CacheSchedulerLimits) {
    this.graph = graph;
    const { replies, ...counts } = limits;
    const required = [
      "running",
      "pending",
      "requests",
      "requesters",
      "work",
      "validationMs",
      "completionMs",
      "calls",
      "streamBytes",
      "streamChunks",
    ] as const;
    if (
      Object.keys(counts).length !== required.length ||
      required.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] <= 0) ||
      limits.validationMs > 30000 ||
      limits.completionMs > 30000
    )
      throw new Error("cache scheduler limits must be positive safe integers; validationMs <= 30000");
    this.limits = { ...limits, replies: { ...replies } };
    this.replies = new CachePayloads(replies);
  }
  attach(authorize: ActorRow["authorize"]): CacheRequester {
    if (this.closed || this.actors.size >= this.limits.requesters)
      throw new Error("cache requester admission unavailable");
    const token = Object.freeze({}) as CacheRequester;
    this.actors.set(token, { token, authorize, requests: new Set() });
    return token;
  }
  prepare(plan: CacheWorkPlan): CacheWork {
    if (this.closed || this.work.size >= this.limits.work) throw new Error("cache prepared-work admission unavailable");
    if (
      typeof plan.key !== "string" ||
      !plan.key ||
      !Array.isArray(plan.inputs) ||
      !Array.isArray(plan.parents) ||
      typeof plan.shareable !== "boolean" ||
      typeof plan.validate !== "function" ||
      typeof plan.start !== "function"
    )
      throw new Error("cache prepared work is malformed");
    if (!this.graph.validatePreparation(plan.workspace, plan.key, plan.inputs, plan.parents))
      throw new Error("cache prepared work exceeds graph dependency bounds or has unavailable parents");
    const token = Object.freeze({}) as CacheWork;
    this.work.set(token, {
      token,
      plan: Object.freeze({
        ...plan,
        inputs: Object.freeze([...plan.inputs]),
        parents: Object.freeze([...plan.parents]),
      }),
    });
    return token;
  }
  createRequest(actorToken: CacheRequester, workToken: CacheWork, options: CacheRequestOptions = {}): CacheRequest {
    const actor = this.actors.get(actorToken),
      work = this.work.get(workToken);
    if (!actor || !work) throw new Error("cache requester or work handle is foreign or unavailable");
    if (this.closed || this.live.size >= this.limits.requests)
      throw new Error("cache logical-request admission unavailable");
    if (
      (options.force !== undefined && typeof options.force !== "boolean") ||
      (options.waitMs !== undefined && (!Number.isSafeInteger(options.waitMs) || options.waitMs <= 0))
    )
      throw new Error("cache request force/waitMs is malformed");
    const token = Object.freeze({}) as CacheRequest;
    const row: RequestRow = {
      token,
      id: randomUUID(),
      actor,
      work,
      force: options.force === true,
      state: "new",
      controller: new AbortController(),
      onData: options.onData,
    };
    this.requests.set(token, row);
    this.known.add(token);
    this.live.add(row);
    actor.requests.add(row);
    if (options.signal) {
      const abort = () => this.cancel(token);
      options.signal.addEventListener("abort", abort, { once: true });
      row.removeSignal = () => options.signal!.removeEventListener("abort", abort);
      if (options.signal.aborted) abort();
    }
    if (options.waitMs && row.state !== "done")
      row.timer = setTimeout(() => this.cancel(token, "timed-out"), options.waitMs);
    return token;
  }
  private authorized(row: RequestRow): boolean {
    try {
      return this.actors.has(row.actor.token) && row.actor.authorize(row.work.token) === true;
    } catch {
      return false;
    } // No callback return or throw can confer authority.
  }
  async submit(token: CacheRequest): Promise<CacheResolution> {
    const row = this.requests.get(token);
    if (!row) throw new Error("cache logical request is foreign or acknowledged");
    if (!this.authorized(row)) {
      const refusal: CacheResolution = {
        requestId: row.id,
        kind: "reject",
        reason: "cache request is not currently authorized",
      };
      if (row.state === "new") this.finish(row, refusal);
      return refusal;
    }
    if (row.state === "done") return this.replay(row);
    if (row.promise) return row.promise;
    if (this.closed || this.calls >= this.limits.calls) {
      const refusal: CacheResolution = { requestId: row.id, kind: "reject", reason: "cache admission closed or busy" };
      this.finish(row, refusal);
      return refusal;
    }
    row.promise = new Promise((resolve) => {
      row.resolve = resolve;
    });
    row.state = "checking";
    this.calls++;
    void this.check(row)
      .catch((error) => this.finish(row, { kind: "reject", reason: String(error) }))
      .finally(() => {
        this.calls--;
      });
    return row.promise;
  }
  private async validated(work: WorkRow, signal: AbortSignal): Promise<boolean> {
    const control = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (valid: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        control.abort();
        resolve(valid);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), this.limits.validationMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        finish(false);
        return;
      }
      Promise.resolve()
        .then(() => work.plan.validate(control.signal))
        .then(
          (value) => finish(value === true),
          () => finish(false),
        );
    });
  }
  private async check(row: RequestRow): Promise<void> {
    if (!(await this.validated(row.work, row.controller.signal))) {
      this.finish(row, { kind: "bypass", reason: "source validation unavailable before execution" });
      return;
    }
    if (row.state === "done") return;
    if (!this.authorized(row)) {
      this.finish(row, { kind: "reject", reason: "cache authority changed during validation" });
      return;
    }
    const plan = row.work.plan;
    if (!row.force) {
      const hit = this.graph.acquire(plan.workspace, plan.key);
      if (hit) {
        const replay = decodeCacheReplay(hit.delivery.read(), this.limits.streamBytes, this.limits.streamChunks);
        hit.delivery.release();
        if (!replay) {
          this.graph.remove(hit.ref);
          this.finish(row, { kind: "bypass", reason: "cache replay protocol is incompatible" });
          return;
        }
        for (const chunk of replay.stream) {
          if (row.controller.signal.aborted) break;
          this.deliver(row, chunk, hit.execution.executionId);
        }
        this.finish(row, {
          kind: "reuse",
          executionId: hit.execution.executionId,
          published: true,
          outcome: replay.outcome,
        });
        return;
      }
      if (plan.shareable) {
        const match = [...this.executions, ...this.queue].find(
          (execution) =>
            execution.replayable &&
            !execution.controller.signal.aborted &&
            execution.work.token === row.work.token &&
            (!execution.ticket || this.graph.canJoin(execution.ticket)),
        );
        if (match) {
          this.interest(match, row, "join");
          return;
        }
      }
    }
    if (this.queue.length >= this.limits.pending) {
      this.finish(row, { kind: "reject", reason: "cache pending execution limit reached" });
      return;
    }
    const execution: ExecutionRow = {
      id: randomUUID(),
      work: row.work,
      interests: new Set(),
      kinds: new Map(),
      controller: new AbortController(),
      active: false,
      started: false,
      exitVerified: false,
      stopping: false,
      stream: [],
      streamBytes: 0,
      replayable: true,
    };
    this.interest(execution, row, "execute");
    this.queue.push(execution);
    this.pump();
  }
  private interest(execution: ExecutionRow, row: RequestRow, kind: "execute" | "join"): void {
    row.state = "waiting";
    row.execution = execution;
    execution.interests.add(row);
    execution.kinds.set(row, kind);
    for (const chunk of execution.stream) {
      if (row.controller.signal.aborted) break;
      this.deliver(row, chunk, execution.id);
    }
  }
  private pump(): void {
    while (!this.closed && this.occupancy() < this.limits.running && this.queue.length) {
      const execution = this.queue.shift()!;
      if (!execution.interests.size) continue;
      execution.active = true;
      this.executions.add(execution);
      execution.task = this.run(execution).catch((error) => {
        execution.fault = error instanceof Error ? error : new Error(String(error));
        for (const row of [...execution.interests])
          this.finish(row, { kind: "reject", executionId: execution.id, reason: execution.fault.message });
        if (!execution.started || execution.exitVerified) this.releaseExecution(execution);
        else this.terminalFault(execution.fault);
      });
    }
  }
  private deliver(row: RequestRow, bytes: Buffer, executionId: string): void {
    try {
      row.onData?.(Buffer.from(bytes));
    } catch (error) {
      this.finish(row, { kind: "reject", executionId, reason: `cache reader failed: ${String(error)}` });
    }
  }
  private stream(execution: ExecutionRow, bytes: Buffer): void {
    if (!this.executions.has(execution)) return;
    if (!Buffer.isBuffer(bytes)) {
      execution.replayable = false;
      for (const row of [...execution.interests])
        this.finish(row, { kind: "reject", executionId: execution.id, reason: "cache stream is not byte data" });
      return;
    }
    if (execution.replayable) {
      if (
        bytes.length > this.limits.streamBytes - execution.streamBytes ||
        execution.stream.length >= this.limits.streamChunks
      ) {
        execution.replayable = false;
        execution.stream = [];
        execution.streamBytes = 0;
      } else {
        execution.stream.push(Buffer.from(bytes));
        execution.streamBytes += bytes.length;
      }
    }
    for (const row of [...execution.interests]) this.deliver(row, bytes, execution.id);
  }
  private stop(execution: ExecutionRow): void {
    execution.controller.abort();
    if (execution.exitVerified || !execution.handle || execution.stopping) return;
    execution.stopping = true;
    const handle = execution.handle;
    void Promise.resolve()
      .then(() => handle.stop())
      .catch((error) => {
        execution.fault = error instanceof Error ? error : new Error(String(error));
        this.terminalFault(execution.fault);
      });
  }
  private occupancy(): number {
    return [...this.executions].filter((row) => row.active).length;
  }
  private terminalFault(error: Error): void {
    this.fault ??= error;
    this.closed = true;
    this.graph.clear();
    for (const row of this.live)
      if (row.state !== "done")
        this.finish(row, {
          kind: "reject",
          executionId: row.execution?.id,
          reason: `cache coordinator fault: ${error.message}`,
        });
    this.queue = [];
    for (const execution of this.executions) this.stop(execution);
  }
  private async run(execution: ExecutionRow): Promise<void> {
    const { plan } = execution.work;
    if (!(await this.validated(execution.work, execution.controller.signal))) {
      for (const row of [...execution.interests])
        this.finish(row, { kind: "bypass", reason: "source validation unavailable after queue delay" });
      this.releaseExecution(execution);
      return;
    }
    for (const row of [...execution.interests])
      if (!this.authorized(row)) this.finish(row, { kind: "reject", reason: "cache authority changed while queued" });
    if (!execution.interests.size) {
      this.releaseExecution(execution);
      return;
    }
    execution.ticket = this.graph.begin(plan.workspace, plan.key, plan.inputs, plan.parents);
    if (!execution.ticket) {
      for (const row of [...execution.interests])
        this.finish(row, { kind: "bypass", reason: "cache graph admission unavailable before execution" });
      this.releaseExecution(execution);
      return;
    }
    execution.started = true;
    try {
      execution.handle = await plan.start({
        executionId: execution.id,
        signal: execution.controller.signal,
        onData: (bytes) => this.stream(execution, bytes),
      });
    } catch (error) {
      if (!(error instanceof CacheStartFailure) || !error.cleanupVerified) throw error;
      for (const row of [...execution.interests])
        this.finish(row, { kind: "reject", executionId: execution.id, reason: error.message });
      this.releaseExecution(execution);
      return;
    }
    if (execution.controller.signal.aborted) this.stop(execution);
    // Observe outcome immediately, but cancellation/teardown waits only for actual exit, not lost output.
    const report = observeCacheReport(execution.handle.outcome);
    try {
      await execution.handle.exited;
    } catch (error) {
      throw new Error(`cache owned execution exit unresolved: ${String(error)}`);
    }
    execution.exitVerified = true;
    execution.active = false;
    this.pump();
    if (!execution.interests.size) {
      this.releaseExecution(execution);
      return;
    }
    const result = await waitCacheReport(report, execution.controller.signal, this.limits.completionMs);
    if (!result) {
      this.releaseExecution(execution);
      return;
    }
    if (result.status !== "fulfilled") {
      for (const row of [...execution.interests])
        this.finish(row, {
          kind: "reject",
          executionId: execution.id,
          reason: `cache execution outcome unavailable: ${String(result.reason)}`,
        });
      this.releaseExecution(execution);
      return;
    }
    const outcome = cacheRunOutcome(result.value);
    let published = false;
    if (
      execution.replayable &&
      !execution.controller.signal.aborted &&
      outcome.exitCode === 0 &&
      outcome.signal === null &&
      outcome.complete === true &&
      outcome.cancelled === false &&
      outcome.timedOut === false &&
      (await this.validated(execution.work, execution.controller.signal))
    )
      published = !!this.graph.publish(execution.ticket, {
        ...outcome,
        executionId: execution.id,
        output: encodeCacheReplay(outcome, execution.stream),
      });
    for (const row of [...execution.interests])
      this.finish(row, { kind: execution.kinds.get(row)!, executionId: execution.id, outcome, published });
    this.releaseExecution(execution);
  }
  private releaseExecution(execution: ExecutionRow): void {
    if (execution.ticket) this.graph.abandon(execution.ticket);
    execution.active = false;
    execution.stream = [];
    execution.streamBytes = 0;
    this.executions.delete(execution);
    execution.handle = undefined;
    this.pump();
  }
  private finish(row: RequestRow, partial: Omit<CacheResolution, "requestId">): void {
    if (row.state === "done") return;
    const result: CacheResolution = Object.freeze({ requestId: row.id, ...partial });
    row.state = "done";
    clearTimeout(row.timer);
    row.removeSignal?.();
    row.removeSignal = undefined;
    row.onData = undefined;
    row.controller.abort();
    const { outcome, ...summary } = result;
    row.summary = summary;
    if (outcome) {
      const { output, ...metadata } = outcome;
      row.metadata = metadata;
      row.payload = this.replies.store(output);
    }
    const resolve = row.resolve;
    row.resolve = undefined;
    row.promise = undefined;
    resolve?.(result);
    const execution = row.execution;
    row.execution = undefined;
    if (execution) {
      execution.interests.delete(row);
      execution.kinds.delete(row);
      if (!execution.interests.size) {
        if (this.executions.has(execution)) this.stop(execution);
        else this.queue = this.queue.filter((item) => item !== execution);
      }
    }
  }
  private replay(row: RequestRow): CacheResolution {
    const summary = row.summary!;
    if (!row.metadata) return summary;
    const pin = row.payload && this.replies.pin(row.payload);
    if (!pin)
      return {
        ...summary,
        kind: "reject",
        reason: "original execution output was not retained; retry cannot relaunch",
      };
    const output = pin.read();
    pin.release();
    return { ...summary, outcome: Object.freeze({ ...row.metadata, output }) };
  }
  cancel(token: CacheRequest, kind: "cancelled" | "timed-out" = "cancelled"): void {
    const row = this.requests.get(token);
    if (row) this.finish(row, { kind, executionId: row.execution?.id });
  }
  acknowledge(token: CacheRequest): void {
    const row = this.requests.get(token);
    if (!row) {
      if (!this.known.has(token)) throw new Error("cache request handle is foreign");
      return;
    }
    if (row.state !== "done") throw new Error("cannot acknowledge an unfinished cache request");
    if (row.payload) this.replies.drop(row.payload);
    row.actor.requests.delete(row);
    this.live.delete(row);
    this.requests.delete(token);
  }
  disconnect(token: CacheRequester): void {
    const actor = this.actors.get(token);
    if (!actor) throw new Error("cache requester handle is foreign or disconnected");
    this.actors.delete(token);
    for (const row of [...actor.requests]) {
      this.cancel(row.token);
      this.acknowledge(row.token);
    }
  }
  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.closed = true;
    for (const row of this.live) this.cancel(row.token);
    for (const execution of this.executions) this.stop(execution);
    this.shutdownTask = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(poll);
        reject(new Error("cache scheduler shutdown unresolved after 1500ms"));
      }, 1500);
      const poll = setInterval(() => {
        if (this.executions.size) return;
        clearTimeout(deadline);
        clearInterval(poll);
        for (const row of [...this.live]) this.acknowledge(row.token);
        this.actors.clear();
        this.work.clear();
        resolve();
      }, 5);
    });
    return this.shutdownTask;
  }
  stats() {
    return {
      running: this.occupancy(),
      finalizing: this.executions.size - this.occupancy(),
      queued: this.queue.length,
      requests: this.live.size,
      requesters: this.actors.size,
      prepared: this.work.size,
      calls: this.calls,
      replies: this.replies.stats(),
      streamBytes: [...this.executions].reduce((sum, row) => sum + row.streamBytes, 0),
      faults: [...this.executions].filter((execution) => execution.fault).length,
    };
  }
}
