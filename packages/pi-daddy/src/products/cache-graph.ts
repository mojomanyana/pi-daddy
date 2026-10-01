/**
 * Epoch-local live graph, not a history store. Coordinator-only methods implement bounded, atomic
 * state transitions with no IO or user callbacks. These methods DON'T establish input consistency,
 * determinism, filesystem coverage, or current caller authorization. Trusted coordinator discovery
 * must first qualify and reconcile its real sources; client hashes/declarations cannot call observe
 * or reconcile. A watcher barrier or equal fingerprint alone does NOT supply that source proof.
 *
 * Dirty blocks transitive access. Confirmed change/loss immediately removes results, BOTH directions
 * of runtime edges and reusable payload ownership; runs lose publication eligibility irreversibly.
 * Existing delivery pins alone can finish after deletion. Completion never restores a dead ticket.
 * Limits bound object counts and string lengths, NOT measured heap/RSS. Transactions run in the
 * separate Node coordinator, not Pi's UI loop; maximum-edge latency must be measured before enabling.
 */
import { CachePayloads } from "./cache-payloads.ts";
import type {
  CacheWorkspace,
  CacheObservation,
  CacheDirtyToken,
  CacheRunTicket,
  CacheResultRef,
  CacheGraphLimits,
  CacheOutcome,
  WorkspaceState,
  InputState,
  Consumer,
  RunState,
  ResultState,
} from "./cache-graph-types.ts";
export type {
  CacheWorkspace,
  CacheObservation,
  CacheDirtyToken,
  CacheRunTicket,
  CacheResultRef,
  CacheGraphLimits,
  CacheOutcome,
} from "./cache-graph-types.ts";

export class CacheGraph {
  private limits: CacheGraphLimits;
  private output: CachePayloads;
  private scopes = new Map<string, WorkspaceState>();
  private workspaceHandles = new WeakMap<CacheWorkspace, WorkspaceState>();
  private inputHandles = new WeakMap<CacheObservation, InputState>();
  private dirtyHandles = new WeakMap<CacheDirtyToken, InputState>();
  private runHandles = new WeakMap<CacheRunTicket, RunState>();
  private resultHandles = new WeakMap<CacheResultRef, ResultState>();
  private knownRuns = new WeakSet<CacheRunTicket>();
  private knownResults = new WeakSet<CacheResultRef>();
  private runs = new Set<RunState>();
  private observations = 0;
  private entries = 0;
  private edges = 0;
  private order = 0;

  constructor(limits: CacheGraphLimits) {
    if (
      [limits.workspaces, limits.observations, limits.entries, limits.runs, limits.edges, limits.keyBytes].some(
        (n) => !Number.isSafeInteger(n) || n <= 0,
      )
    )
      throw new Error("cache graph limits must be positive safe integers");
    this.limits = { ...limits, output: { ...limits.output } };
    this.output = new CachePayloads(limits.output);
  }
  private key(text: string): void {
    if (typeof text !== "string" || !text || Buffer.byteLength(text, "utf8") > this.limits.keyBytes)
      throw new Error("cache graph key exceeds limit or is empty");
  }
  private scope(handle: CacheWorkspace): WorkspaceState {
    const value = this.workspaceHandles.get(handle);
    if (!value) throw new Error("cache workspace handle is foreign or fabricated");
    return value;
  }
  private input(handle: CacheObservation): InputState {
    const value = this.inputHandles.get(handle);
    if (!value) throw new Error("cache observation handle is foreign or unavailable");
    return value;
  }
  private run(handle: CacheRunTicket): RunState | undefined {
    if (!this.knownRuns.has(handle)) throw new Error("cache run handle is foreign or fabricated");
    return this.runHandles.get(handle);
  }
  private result(handle: CacheResultRef): ResultState | undefined {
    if (!this.knownResults.has(handle)) throw new Error("cache result handle is foreign or fabricated");
    return this.resultHandles.get(handle);
  }
  workspace(canonicalIdentity: string): CacheWorkspace {
    this.key(canonicalIdentity);
    const existing = this.scopes.get(canonicalIdentity);
    if (existing) return existing.token;
    if (this.scopes.size >= this.limits.workspaces) throw new Error("cache workspace limit reached");
    const token = Object.freeze({}) as CacheWorkspace;
    const row = { name: canonicalIdentity, token, inputs: new Map(), entries: new Map() };
    this.scopes.set(canonicalIdentity, row);
    this.workspaceHandles.set(token, row);
    return token;
  }
  observe(workspace: CacheWorkspace, key: string, fingerprint: string): CacheObservation {
    const scope = this.scope(workspace);
    this.key(key);
    this.key(fingerprint);
    const row = scope.inputs.get(key);
    if (row) {
      // Existing dirty evidence can ONLY be reconciled with its current event token.
      if (row.pending) throw new Error("cache observation needs current dirty reconciliation");
      if (row.fingerprint !== fingerprint) this.reconcile(this.dirty(row.token), fingerprint);
      return row.token;
    }
    if (this.observations >= this.limits.observations) throw new Error("cache observation limit reached");
    const token = Object.freeze({}) as CacheObservation;
    const input = { scope, key, fingerprint, token, live: true, users: new Set<Consumer>() };
    scope.inputs.set(key, input);
    this.inputHandles.set(token, input);
    this.observations++;
    return token;
  }
  dirty(handle: CacheObservation): CacheDirtyToken {
    const input = this.input(handle),
      token = Object.freeze({}) as CacheDirtyToken;
    // Old event handles must not keep a historical observation record reachable.
    if (input.pending) this.dirtyHandles.delete(input.pending);
    input.pending = token;
    this.dirtyHandles.set(token, input);
    return token;
  }
  reconcile(token: CacheDirtyToken, fingerprint: string | undefined): boolean {
    if (fingerprint !== undefined) this.key(fingerprint);
    const input = this.dirtyHandles.get(token);
    if (!input || !input.live || input.pending !== token) return false;
    this.dirtyHandles.delete(token);
    input.pending = undefined;
    if (fingerprint === input.fingerprint) return true;
    for (const consumer of [...input.users]) this.erase(consumer);
    if (fingerprint === undefined) {
      input.live = false;
      input.scope.inputs.delete(input.key);
      this.inputHandles.delete(input.token);
      this.observations--;
    } else input.fingerprint = fingerprint;
    return true;
  }
  private connect(node: Consumer): void {
    for (const input of node.inputs) input.users.add(node);
    for (const parent of node.parents) parent.users.add(node);
    this.edges += node.inputs.size + node.parents.size;
  }
  private detach(node: Consumer): void {
    for (const input of node.inputs) input.users.delete(node);
    for (const parent of node.parents) parent.users.delete(node);
    this.edges -= node.inputs.size + node.parents.size;
    node.inputs.clear();
    node.parents.clear();
  }
  private available(node: Consumer): boolean {
    const pending: Consumer[] = [node],
      seen = new Set<Consumer>();
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (!current.live || (current.kind === "run" && !current.eligible)) return false;
      for (const input of current.inputs) if (!input.live || input.pending) return false;
      for (const parent of current.parents) pending.push(parent);
    }
    return true;
  }
  private erase(node: Consumer): void {
    const pending: Consumer[] = [node];
    while (pending.length) {
      const current = pending.pop()!;
      if (current.kind === "run") {
        if (current.eligible) {
          current.eligible = false;
          this.detach(current);
        }
        continue; // Run still exists until supervisor reports its actual outcome/abandonment.
      }
      if (!current.live) continue;
      current.live = false;
      for (const user of current.users) pending.push(user);
      current.users.clear();
      this.detach(current);
      current.scope.entries.delete(current.key);
      this.entries--;
      this.resultHandles.delete(current.token);
      this.output.drop(current.payload);
    }
  }
  validatePreparation(
    workspace: CacheWorkspace,
    key: string,
    inputRefs: readonly CacheObservation[],
    parentRefs: readonly CacheResultRef[],
  ): boolean {
    const scope = this.scope(workspace);
    this.key(key);
    if (inputRefs.length + parentRefs.length > this.limits.edges) return false;
    for (const ref of inputRefs)
      if (this.input(ref).scope !== scope) throw new Error("cache input belongs to another workspace");
    for (const ref of parentRefs) {
      const parent = this.result(ref);
      if (!parent) return false;
      if (parent.scope !== scope) throw new Error("cache result belongs to another workspace");
    }
    return true; // Handle/size validation only, never source freshness or eligibility.
  }
  begin(
    workspace: CacheWorkspace,
    key: string,
    inputRefs: readonly CacheObservation[],
    parentRefs: readonly CacheResultRef[],
  ): CacheRunTicket | undefined {
    const scope = this.scope(workspace);
    this.key(key);
    if (inputRefs.length + parentRefs.length > this.limits.edges) return undefined;
    const inputs = new Set(inputRefs.map((ref) => this.input(ref))),
      parents = new Set<ResultState>();
    for (const input of inputs) if (input.scope !== scope) throw new Error("cache input belongs to another workspace");
    for (const ref of parentRefs) {
      const parent = this.result(ref);
      if (!parent) return undefined;
      if (parent.scope !== scope) throw new Error("cache result belongs to another workspace");
      parents.add(parent);
    }
    if (this.runs.size >= this.limits.runs || this.edges + inputs.size + parents.size > this.limits.edges)
      return undefined;
    if (this.order === Number.MAX_SAFE_INTEGER) throw new Error("cache ticket generation exhausted; restart cold");
    const token = Object.freeze({}) as CacheRunTicket;
    const run: RunState = {
      kind: "run",
      token,
      scope,
      key,
      inputs,
      parents,
      live: true,
      eligible: true,
      order: ++this.order,
    };
    if (!this.available(run)) return undefined;
    this.runs.add(run);
    this.runHandles.set(token, run);
    this.knownRuns.add(token);
    this.connect(run);
    return token;
  }
  canJoin(ticket: CacheRunTicket): boolean {
    const run = this.run(ticket);
    return !!run && this.available(run);
  }
  abandon(ticket: CacheRunTicket): void {
    const run = this.run(ticket);
    if (!run) return;
    run.live = false;
    run.eligible = false;
    this.detach(run);
    this.runs.delete(run);
    this.runHandles.delete(ticket);
  }
  publish(ticket: CacheRunTicket, outcome: CacheOutcome): CacheResultRef | undefined {
    const run = this.run(ticket);
    if (!run) return undefined;
    this.key(outcome.executionId);
    this.key(outcome.startedAt);
    this.key(outcome.endedAt);
    const start = Date.parse(outcome.startedAt),
      end = Date.parse(outcome.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new Error("cache execution provenance has invalid timing");
    if (!this.available(run)) {
      this.abandon(ticket);
      return undefined;
    }
    const payload = this.output.store(outcome.output);
    if (!payload) {
      this.abandon(ticket);
      return undefined;
    }
    const previous = run.scope.entries.get(run.key);
    if (previous) this.erase(previous);
    while (this.entries >= this.limits.entries) {
      const victim = [...this.scopes.values()].flatMap((scope) => [...scope.entries.values()])[0];
      if (!victim) throw new Error("cache graph entry accounting is inconsistent");
      this.erase(victim);
    }
    // Replacement/eviction may have invalidated one of THIS run's execution dependencies.
    if (!this.available(run)) {
      this.output.drop(payload);
      this.abandon(ticket);
      return undefined;
    }
    const token = Object.freeze({}) as CacheResultRef;
    const result: ResultState = {
      kind: "result",
      token,
      scope: run.scope,
      key: run.key,
      inputs: new Set(run.inputs),
      parents: new Set(run.parents),
      live: true,
      payload,
      users: new Set(),
      execution: Object.freeze({
        executionId: outcome.executionId,
        startedAt: outcome.startedAt,
        endedAt: outcome.endedAt,
      }),
    };
    this.abandon(ticket);
    this.connect(result);
    this.resultHandles.set(token, result);
    this.knownResults.add(token);
    result.scope.entries.set(result.key, result);
    this.entries++;
    for (const other of this.runs)
      if (other.scope === run.scope && other.key === run.key && other.order < run.order) this.erase(other);
    return token;
  }
  acquire(workspace: CacheWorkspace, key: string) {
    const scope = this.scope(workspace);
    this.key(key);
    const result = scope.entries.get(key);
    if (!result || !this.available(result)) return undefined;
    const delivery = this.output.pin(result.payload);
    if (!delivery) return undefined;
    return { ref: result.token, execution: result.execution, delivery };
  }
  remove(ref: CacheResultRef): void {
    const result = this.result(ref);
    if (result) this.erase(result);
  }
  clear(workspace?: CacheWorkspace): void {
    const scopes = workspace ? [this.scope(workspace)] : [...this.scopes.values()];
    for (const scope of scopes) {
      for (const entry of [...scope.entries.values()]) this.erase(entry);
      for (const run of this.runs) if (run.scope === scope) this.erase(run);
      for (const input of scope.inputs.values()) {
        input.live = false;
        if (input.pending) this.dirtyHandles.delete(input.pending);
        this.inputHandles.delete(input.token);
        this.observations--;
      }
      scope.inputs.clear();
    }
  }
  stats() {
    return {
      workspaces: this.scopes.size,
      observations: this.observations,
      entries: this.entries,
      runs: this.runs.size,
      edges: this.edges,
      output: this.output.stats(),
    };
  }
}
