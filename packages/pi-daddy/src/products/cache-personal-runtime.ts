/**
 * Personal-best-effort-v1 runtime: trusted profiles + real observations + live graph/shared scheduler.
 * Profiles declare understood deterministic, effect-free, service-free work; they are not discovered
 * from command names and NOT supplied by an RPC requester. The injected start must own a qualified
 * process tree. No shell command runs on unsupported/uncertain lookup: return bypass to the existing
 * governed adapter. Authorization is current before IO and at scheduler access/validation/queue delay.
 * File fingerprints are best effort, not atomic freshness; undetected races/contexts remain possible.
 * No persistent hydration. Input events block results and irreversibly reject in-flight publication.
 */
import { createHash, randomUUID } from "node:crypto";
import { frozenPersonalInvocation, type PersonalCacheInvocation } from "../kernel/cache-personal-invocation.ts";
export type { PersonalCacheInvocation } from "../kernel/cache-personal-invocation.ts";
import {
  snapshotPersonalInputs,
  type PersonalCacheInput,
  type PersonalInputOptions,
  type PersonalInputSnapshot,
} from "../executors/cache-personal-inputs.ts";
import { CacheGraph, type CacheGraphLimits, type CacheObservation, type CacheDirtyToken } from "./cache-graph.ts";
import {
  CacheScheduler,
  CacheCleanupFailure,
  type CacheSchedulerLimits,
  type CacheWork,
  type CacheRequester,
  type CacheRequestOptions,
  type CacheResolution,
  type OwnedCacheRun,
} from "./cache-scheduler.ts";

export interface PersonalCacheProfile {
  id: string;
  revision: string;
  contract: "personal-best-effort-v1";
  cwd: string;
  shell: string;
  command: string;
  env: Readonly<Record<string, string>>;
  inputs: readonly PersonalCacheInput[];
  effects: "none";
  external: "none";
  deterministic: true;
}
export interface PersonalRuntimeOptions {
  workspace: string;
  profiles: readonly PersonalCacheProfile[];
  graph: CacheGraphLimits;
  scheduler: CacheSchedulerLimits;
  inputs: PersonalInputOptions["limits"];
  captures: number;
  barrier: PersonalInputOptions["barrier"];
  start(
    invocation: Readonly<PersonalCacheInvocation>,
    options: { executionId: string; signal: AbortSignal; onData(bytes: Buffer): void | Promise<void> },
  ): Promise<OwnedCacheRun>;
  closeInputs(): Promise<void>;
}
export interface PersonalRequestOptions extends CacheRequestOptions {
  /** Bridge must join own cleanup before returning to committed native transport. */
  joinCleanup?: true;
}
interface SourceRow {
  profile: PersonalCacheProfile;
  input: CacheObservation;
  fingerprint: string;
  dirty?: CacheDirtyToken;
}
interface PlanRow {
  work: CacheWork;
  invocation: Readonly<PersonalCacheInvocation>;
  source?: SourceRow;
}
interface ActorRow {
  token: CacheRequester;
  authorize(invocation: Readonly<PersonalCacheInvocation>): boolean;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const refusal = (kind: "bypass" | "reject", reason: string): CacheResolution => ({
  requestId: randomUUID(),
  kind,
  reason,
});

export class PersonalCacheRuntime {
  private readonly options: PersonalRuntimeOptions;
  private readonly graph: CacheGraph;
  private readonly scheduler: CacheScheduler;
  private readonly workspace;
  private readonly actors = new Map<CacheRequester, ActorRow>();
  private readonly plans = new Map<string, PlanRow>();
  private readonly byWork = new Map<CacheWork, PlanRow>();
  private readonly sources = new Map<string, SourceRow>();
  private readonly noStarts = new WeakMap<CacheResolution, { actor: CacheRequester; invocation: string }>();
  private readonly cleanup = new Set<Promise<void>>();
  private readonly cleanupErrors: unknown[] = [];
  private readonly accesses = new Set<{
    actor: ActorRow;
    invocation: Readonly<PersonalCacheInvocation>;
    signal?: AbortSignal;
  }>();
  private readonly lifetime = new AbortController();
  private pending = 0;
  private captures = 0;
  private generation = 0;
  private closed = false;
  private inputQueue: Promise<void> = Promise.resolve();
  private shutdownTask?: Promise<void>;
  constructor(options: PersonalRuntimeOptions) {
    if (
      !options.workspace.startsWith("/") ||
      !Number.isSafeInteger(options.captures) ||
      options.captures < 1 ||
      options.captures > 16 ||
      !options.profiles.length ||
      options.profiles.length > options.graph.observations
    )
      throw Error("personal cache runtime configuration malformed");
    const profiles = options.profiles.map((profile) => {
      if (
        !profile.id ||
        !profile.revision ||
        profile.contract !== "personal-best-effort-v1" ||
        profile.effects !== "none" ||
        profile.external !== "none" ||
        profile.deterministic !== true ||
        !profile.cwd.startsWith("/") ||
        !profile.shell.startsWith("/") ||
        typeof profile.command !== "string" ||
        !profile.inputs.length
      )
        throw Error("personal cache profile is not an explicit eligible contract");
      const invocation = frozenPersonalInvocation({ ...profile, timeoutMs: 1 });
      return Object.freeze({
        ...profile,
        env: invocation.env,
        inputs: Object.freeze(profile.inputs.map((input) => Object.freeze({ ...input }))),
      });
    });
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
      throw Error("personal cache duplicate profile id");
    this.options = { ...options, profiles, inputs: { ...options.inputs } };
    this.graph = new CacheGraph(options.graph);
    this.scheduler = new CacheScheduler(this.graph, options.scheduler);
    this.workspace = this.graph.workspace(options.workspace);
  }
  attach(authorize: ActorRow["authorize"]): CacheRequester {
    if (this.closed) throw Error("personal cache runtime closed");
    let row: ActorRow;
    const token = this.scheduler.attach((work) => {
      const plan = this.byWork.get(work);
      return !!plan && this.allowed(row, plan.invocation);
    });
    row = { token, authorize };
    this.actors.set(token, row);
    return token;
  }
  private allowed(actor: ActorRow, invocation: Readonly<PersonalCacheInvocation>): boolean {
    try {
      return this.actors.has(actor.token) && actor.authorize(invocation) === true;
    } catch {
      return false;
    }
  }
  private async capture(
    profile: PersonalCacheProfile,
    permit: () => boolean,
    signal?: AbortSignal,
  ): Promise<{ observation: PersonalInputSnapshot; generation: number }> {
    let release!: () => void;
    const prior = this.inputQueue;
    this.inputQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      if (!permit() || this.closed || this.captures >= this.options.captures || this.cleanupErrors.length)
        return {
          observation: { kind: "bypass", reason: "personal input ownership unavailable", cleanup: Promise.resolve() },
          generation: this.generation,
        };
      this.captures++;
      let generation = this.generation,
        initial = true;
      const value = await snapshotPersonalInputs({
        inputs: profile.inputs,
        limits: this.options.inputs,
        signal: AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
        barrier: async () => {
          if (!permit()) throw Error("personal cache authority changed before observation");
          const value = await this.options.barrier();
          if (!permit()) throw Error("personal cache authority changed during barrier");
          if (initial) {
            initial = false;
            generation = this.generation;
          }
          return value;
        },
      });
      if (value.kind === "observed") this.captures--;
      else {
        if (!signal?.aborted && !this.lifetime.signal.aborted && permit()) this.uncertain(value.reason);
        const work = value.cleanup.then(
          () => {
            this.captures--;
            this.cleanup.delete(work);
          },
          (error) => {
            this.cleanupErrors.push(error);
            this.uncertain("input cleanup unresolved");
          },
        );
        this.cleanup.add(work);
      }
      return { observation: value, generation };
    } finally {
      release();
    }
  }
  private async refresh(
    profile: PersonalCacheProfile,
    permit: () => boolean,
    signal?: AbortSignal,
  ): Promise<SourceRow | string> {
    const { generation, observation: observed } = await this.capture(profile, permit, signal);
    if (observed.kind === "bypass") return observed.reason;
    if (this.closed || generation !== this.generation) return "observed event arrived during input acquisition";
    const key = digest(profile),
      row = this.sources.get(key);
    if (row) {
      if (row.dirty) {
        this.graph.reconcile(row.dirty, observed.fingerprint);
        row.dirty = undefined;
      } else this.graph.observe(this.workspace, key, observed.fingerprint);
      row.fingerprint = observed.fingerprint;
      return row;
    }
    const source = {
      profile,
      fingerprint: observed.fingerprint,
      input: this.graph.observe(this.workspace, key, observed.fingerprint),
    };
    this.sources.set(key, source);
    return source;
  }
  changed(paths: readonly string[]): void {
    if (this.closed || !paths.length) return;
    this.generation++;
    for (const row of this.sources.values())
      if (
        row.profile.inputs.some((input) =>
          paths.some(
            (path) =>
              path === input.path ||
              input.path.startsWith(path + "/") ||
              (input.kind === "directory" && path.startsWith(input.path + "/")),
          ),
        )
      ) {
        this.graph.invalidateRuns(row.input);
        row.dirty = this.graph.dirty(row.input);
      }
  }
  uncertain(_reason: string): void {
    this.generation++;
    this.graph.clear();
    this.sources.clear();
  }
  clear(): void {
    this.uncertain("operator cleared cache");
  }
  disconnect(actor: CacheRequester): void {
    this.scheduler.disconnect(actor);
    this.actors.delete(actor);
  }
  private prune(): void {
    for (const [key, row] of this.plans)
      if (this.scheduler.forget(row.work)) {
        this.plans.delete(key);
        this.byWork.delete(row.work);
      }
  }
  async request(
    actorToken: CacheRequester,
    input: PersonalCacheInvocation,
    options: PersonalRequestOptions = {},
  ): Promise<CacheResolution> {
    let invocation: Readonly<PersonalCacheInvocation>;
    try {
      invocation = frozenPersonalInvocation(input);
    } catch (error) {
      return refusal("bypass", String(error));
    }
    const actor = this.actors.get(actorToken);
    if (!actor || !this.allowed(actor, invocation))
      return refusal("reject", "personal cache request is not currently authorized");
    if (this.closed || this.pending >= this.options.scheduler.requests)
      return this.noStart(actorToken, invocation, "personal cache runtime closed or busy");
    const profile = this.options.profiles.find(
      (value) =>
        value.cwd === invocation.cwd &&
        value.shell === invocation.shell &&
        value.command === invocation.command &&
        digest(value.env) === digest(invocation.env),
    );
    if (!profile) return this.noStart(actorToken, invocation, "unsupported invocation; no explicit personal profile");
    this.pending++;
    const access = { actor, invocation, signal: options.signal };
    this.accesses.add(access);
    let submitted = false;
    try {
      const source = await this.refresh(profile, () => this.allowed(actor, invocation), options.signal);
      if (!this.allowed(actor, invocation))
        return refusal("reject", "personal cache authority changed during acquisition");
      if (typeof source === "string") return this.noStart(actorToken, invocation, source);
      const key = digest([this.options.workspace, profile, invocation, source.fingerprint]);
      let plan = this.plans.get(key);
      if (!plan || plan.source !== source) {
        if (this.scheduler.stats().prepared >= this.options.scheduler.work) this.prune();
        const fingerprint = source.fingerprint;
        const work = this.scheduler.prepare({
          workspace: this.workspace,
          key,
          inputs: [source.input],
          parents: [],
          shareable: true,
          validate: async (signal) => {
            const permit = () =>
              [...this.accesses].some(
                (access) =>
                  !access.signal?.aborted &&
                  digest(access.invocation) === digest(invocation) &&
                  this.allowed(access.actor, access.invocation),
              );
            const current = await this.refresh(profile, permit, signal);
            return typeof current !== "string" && current === source && current.fingerprint === fingerprint;
          },
          start: (options) => this.options.start(invocation, options),
        });
        plan = { work, invocation, source };
        this.plans.set(key, plan);
        this.byWork.set(work, plan);
      }
      const inputFingerprint = source.fingerprint;
      const request = this.scheduler.createRequest(actorToken, plan.work, {
        ...options,
        onData: (bytes) => {
          if (this.allowed(actor, invocation)) return options.onData?.(bytes);
        },
      });
      submitted = true;
      try {
        const settled = await this.scheduler.submit(request);
        const result = { ...settled, inputFingerprint, profileId: profile.id };
        if (result.kind === "bypass" && !result.executionId && !result.outcome)
          this.noStarts.set(result, { actor: actorToken, invocation: digest(invocation) });
        return this.allowed(actor, invocation)
          ? result
          : {
              requestId: result.requestId,
              executionId: result.executionId,
              kind: "reject",
              reason: "personal cache authority changed before delivery",
            };
      } finally {
        try {
          if (options.joinCleanup) await this.scheduler.settle(request);
        } finally {
          this.scheduler.acknowledge(request);
        }
      }
    } catch (error) {
      if (error instanceof CacheCleanupFailure) throw error;
      return refusal(submitted ? "reject" : "bypass", `personal runtime unavailable: ${String(error)}`);
    } finally {
      this.pending--;
      this.accesses.delete(access);
    }
  }
  private noStart(actor: CacheRequester, invocation: PersonalCacheInvocation, reason: string): CacheResolution {
    const result = refusal("bypass", reason);
    this.noStarts.set(result, { actor, invocation: digest(invocation) });
    return result;
  }
  /** Trusted, one-use NO-START receipt only. No JSON/client claim may enable post-G ordinary execution.
   * This uses the SAME actor/runner/scheduler and bounds, but never reads/joins/publishes cache state. */
  async uncached(
    actorToken: CacheRequester,
    input: PersonalCacheInvocation,
    receipt: CacheResolution,
    options: PersonalRequestOptions = {},
  ): Promise<CacheResolution> {
    let invocation: Readonly<PersonalCacheInvocation>;
    try {
      invocation = frozenPersonalInvocation(input);
    } catch {
      return refusal("reject", "normal invocation malformed");
    }
    const proof = this.noStarts.get(receipt),
      actor = this.actors.get(actorToken);
    if (
      !proof ||
      proof.actor !== actorToken ||
      proof.invocation !== digest(invocation) ||
      !actor ||
      !this.allowed(actor, invocation)
    )
      return refusal("reject", "normal execution lacks current same-invocation no-start receipt");
    this.noStarts.delete(receipt);
    if (this.closed || this.pending >= this.options.scheduler.requests || options.signal?.aborted)
      return refusal("reject", "normal execution admission closed, cancelled or busy");
    this.pending++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.inputQueue.then(() => Promise.all([...this.cleanup])),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(Error("normal input cleanup unresolved; retain")), 1500);
        }),
      ]);
      clearTimeout(timer);
      if (
        this.cleanupErrors.length ||
        this.scheduler.failure ||
        this.closed ||
        options.signal?.aborted ||
        !this.allowed(actor, invocation)
      )
        return refusal("reject", "normal execution ownership or authority unavailable");
      const key = digest(["uncached", invocation]);
      let plan = this.plans.get(key);
      if (!plan) {
        if (this.scheduler.stats().prepared >= this.options.scheduler.work) this.prune();
        const work = this.scheduler.prepare({
          workspace: this.workspace,
          key,
          inputs: [],
          parents: [],
          shareable: false,
          cacheable: false,
          validate: async () => !this.closed && !this.cleanupErrors.length,
          start: (options) => this.options.start(invocation, options),
        });
        plan = { work, invocation };
        this.plans.set(key, plan);
        this.byWork.set(work, plan);
      }
      const request = this.scheduler.createRequest(actorToken, plan.work, options);
      try {
        const result = await this.scheduler.submit(request);
        return this.allowed(actor, invocation) ? result : refusal("reject", "normal authority changed before delivery");
      } finally {
        try {
          if (options.joinCleanup) await this.scheduler.settle(request);
        } finally {
          this.scheduler.acknowledge(request);
        }
      }
    } catch (error) {
      if (error instanceof CacheCleanupFailure) throw error;
      return refusal("reject", `normal execution unavailable: ${String(error)}`);
    } finally {
      clearTimeout(timer);
      this.pending--;
    }
  }
  shutdown(): Promise<void> {
    return (this.shutdownTask ??= (async () => {
      this.closed = true;
      this.lifetime.abort();
      const owned = await Promise.allSettled([
        Promise.resolve().then(() => this.options.closeInputs()),
        this.scheduler.shutdown(),
        this.inputQueue,
      ]);
      const errors: unknown[] = owned.flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...this.cleanup]),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("personal input cleanup unresolved after1500ms")), 1500);
          }),
        ]);
      } catch (error) {
        errors.push(error);
      } finally {
        clearTimeout(timer);
      }
      errors.push(...this.cleanupErrors);
      if (errors.length) throw new AggregateError(errors, "personal runtime shutdown unresolved; retain");
      this.graph.clear();
      this.sources.clear();
      this.plans.clear();
      this.byWork.clear();
      this.actors.clear();
    })());
  }
  stats() {
    return {
      ...this.scheduler.stats(),
      graph: this.graph.stats(),
      captures: this.captures,
      pending: this.pending,
      cleanupFaults: this.cleanupErrors.length,
      contract: "personal-best-effort-v1" as const,
    };
  }
}
