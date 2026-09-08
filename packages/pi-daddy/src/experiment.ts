import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MAX_CHILDREN_PER_CALL } from "./fanout.ts";
import { openResourceBudget, resourceBindingDigest, type ExperimentBudgetBinding, type BudgetSnapshot } from "./resource-budget.ts";
import { isDigestProfile, reserveDigestProfileBatch, type DigestProfile, type ReservedDigestRun } from "./effect-profile.ts";
import { readIntentWork, resolveIntent } from "./intent-application.ts";
import { freezeWork } from "./work-ledger-json.ts";
import { byteHash, cloneExperiment, experimentAuthority, experimentCancellation, experimentCancellationDigest, experimentCharter, experimentCharterDigest,
  type ExperimentAuthority, type ExperimentCancellation, type ExperimentCharter } from "./experiment-contract.ts";
import { createExperimentStore, experimentBindingDigest, experimentStore, ownedDirectory, readExperimentFile, writeExperimentFile, type ExperimentBinding } from "./experiment-store.ts";
import { replayExperiment, type VariantRecord } from "./experiment-state.ts";
export { experimentCharterDigest, experimentCancellationDigest, parseExperimentCharter, type ExperimentCharter, type ExperimentAuthority, type ExperimentCancellation } from "./experiment-contract.ts";
export { experimentBindingDigest, type ExperimentBinding } from "./experiment-store.ts";
export interface ExperimentView {
  version: "experiment-view-v1"; experimentId: string; mode: ExperimentCharter["mode"]; variants: readonly VariantRecord[];
  budget: Readonly<BudgetSnapshot> | null; cancellations: readonly { request: ExperimentCancellation; outcome: "requested-or-unknown" | "observed-cancelled" | "finished-without-cancel" }[];
  diagnostics: readonly string[]; acceptance: "not-assessed"; configuration: { model: null; effort: null; skills: null }; freshness: "snapshot-unknown";
}
function approved(a: ExperimentAuthority | null, b: ExperimentBudgetBinding, c: ExperimentCharter) {
  if (!a || a.authorityDigest !== b.authorityDigest || !a.charterDigests.includes(experimentCharterDigest(c))) throw new Error("independent exact experiment authority unavailable");
}
async function common(c: ExperimentCharter, bytes: Uint8Array) {
  if (bytes.length !== c.common.bytes || byteHash(bytes) !== c.common.sha256) throw new Error("common input drift");
  if (c.common.work) {
    const text = await readIntentWork(c.common.work);
    if (byteHash(text) !== c.common.workTextDigest) throw new Error("common P01 work drift");
    resolveIntent(text, c.common.work.selection, c.common.work.priorities);
  }
}
export async function createExperiment(input: { directory: string; budget: ExperimentBudgetBinding; charter: ExperimentCharter; bytes: Uint8Array; authority: ExperimentAuthority | null }): Promise<ExperimentBinding> {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length > 16384) throw new TypeError("bounded common bytes required");
  const c = experimentCharter(input.charter), budget = openResourceBudget(input.budget).binding, a = experimentAuthority(input.authority), bytes = Buffer.from(input.bytes), directory = input.directory;
  if (budget.version !== "4.0" || resourceBindingDigest(budget) !== c.budgetDigest) throw new Error("explicit experiment budget required");
  approved(a, budget, c); await common(c, bytes); await openResourceBudget(budget).inspect();
  return createExperimentStore(directory, budget, c, bytes);
}
export interface ExperimentRun { readonly primary: Promise<VariantRecord>; readonly completion: Promise<ExperimentView>; readonly started: readonly Promise<"spawned" | "settled-without-spawn">[] }
/** A separate owned controller, not delegate_all and not a model-facing launch/callback loader. */
export function openExperiment(input: ExperimentBinding, hostAuthority: ExperimentAuthority | null) {
  const store = experimentStore(input), b = store.binding, c = b.charter, a = experimentAuthority(hostAuthority), owner = randomUUID(), digest = experimentBindingDigest(b);
  const budget = openResourceBudget(b.budget), handles = new Map<string, AbortController>();
  let live: ExperimentRun | null = null, starting = false;
  const artifact = (id: string) => join(b.directory, "variant-" + byteHash(id), "result.json");
  const load = async () => {
    const data = await store.read(), state = replayExperiment(c, data.events);
    if (state.cancellations.some(r => r.bindingDigest !== digest)) throw new Error("cancellation binding mismatch");
    return state;
  };
  const append = (event: unknown) => store.transaction(async (events, write) => { replayExperiment(c, [...events, cloneExperiment(event) as Record<string, unknown>]); await write(event); });
  const unknown = (): ExperimentView => ({ version: "experiment-view-v1", experimentId: c.experimentId, mode: c.mode,
    variants: c.variants.map(v => ({ variantId: v.variantId, kind: v.kind, operation: v.operation, executionId: v.executionId, state: "unknown", artifactDigest: null, spawned: false })), budget: null, cancellations: [], diagnostics: ["controller-or-storage-unknown"], acceptance: "not-assessed", configuration: { model: null, effort: null, skills: null }, freshness: "snapshot-unknown" });
  const inspect = async (): Promise<ExperimentView> => {
    const state = await load(), diagnostics: string[] = [], accounting = await budget.inspect();
    for (const v of state.variants) {
      if (v.artifactDigest) {
        try { await ownedDirectory(join(b.directory, "variant-" + byteHash(v.executionId))); if (byteHash(await readExperimentFile(artifact(v.executionId), 16384)) !== v.artifactDigest) throw new Error("artifact mismatch"); }
        catch { diagnostics.push("artifact-unavailable:" + v.executionId); v.state = "unknown"; v.artifactDigest = null; }
      } else if (state.claim && (!handles.has(v.executionId) || state.claim.owner !== owner)) v.state = "unknown";
    }
    return freezeWork({ version: "experiment-view-v1", experimentId: c.experimentId, mode: c.mode, variants: state.variants, budget: accounting,
      cancellations: state.cancellations.map(request => { const v = state.variants.find(v => v.executionId === request.executionId)!; return { request,
        outcome: v.state === "cancelled" ? "observed-cancelled" : v.artifactDigest ? "finished-without-cancel" : "requested-or-unknown" }; }),
      diagnostics, acceptance: "not-assessed", configuration: { model: null, effort: null, skills: null }, freshness: "snapshot-unknown" }) as ExperimentView;
  };
  return Object.freeze({ binding: b, inspect, reconcile: inspect,
    async readArtifact(executionId: string): Promise<Uint8Array> {
      const row = (await load()).variants.find(v => v.executionId === executionId);
      if (!row?.artifactDigest) throw new Error("exact byte-backed artifact unavailable");
      await ownedDirectory(join(b.directory, "variant-" + byteHash(executionId)));
      const bytes = await readExperimentFile(artifact(executionId), 16384);
      if (byteHash(bytes) !== row.artifactDigest) throw new Error("artifact digest mismatch");
      return Uint8Array.from(bytes);
    },
    async cancel(input: ExperimentCancellation): Promise<ExperimentView> {
      const request = experimentCancellation(input);
      approved(a, b.budget, c);
      if (request.bindingDigest !== digest || !c.variants.some(v => v.executionId === request.executionId) || !a!.cancellationDigests.includes(experimentCancellationDigest(request))) throw new Error("independent exact cancellation authority unavailable");
      const fresh = await store.transaction(async (events, write) => {
        const state = replayExperiment(c, events), old = state.cancellations.find(r => r.requestId === request.requestId);
        if (old) { if (experimentCancellationDigest(old) !== experimentCancellationDigest(request)) throw new Error("conflicting cancellation ID"); return false; }
        replayExperiment(c, [...events, { type: "cancel", request }]); await write({ type: "cancel", request }); return true;
      });
      if (fresh) handles.get(request.executionId)?.abort("operator-cancellation"); // Only an original live handle; no PID/idle/pane lookup.
      return inspect();
    },
    async start(profile: DigestProfile): Promise<ExperimentRun> {
      approved(a, b.budget, c);
      if (!isDigestProfile(profile) || profile.bindingDigest !== c.budgetDigest) throw new Error("profile budget mismatch");
      if (live) return live;
      if (starting) throw new Error("controller start pending; inspect, do not retry effects"); starting = true;
      let reserved: readonly ReservedDigestRun[] = [];
      try {
        const bytes = await readExperimentFile(join(b.directory, "common.bin"), 16384); await common(c, bytes);
        const claimed = await store.transaction(async (events, write) => {
          const state = replayExperiment(c, events); if (state.claim) return false;
          await write({ type: "claim", owner, deadlineAt: Date.now() + c.deadlineMs }); return true;
        });
        if (!claimed) {
          const view = await inspect(); return Object.freeze({ primary: Promise.resolve(view.variants[0]), completion: Promise.resolve(view), started: [] });
        }
        reserved = await reserveDigestProfileBatch(profile, c.variants.map(v => ({ attempt: { attemptId: v.executionId, orderId: c.orderId, experimentId: c.experimentId, kind: v.kind, parentAttemptId: v.parentExecutionId }, bytes: Buffer.concat([bytes, Buffer.from(v.suffixBase64, "base64")]), operation: v.operation })));
        await append({ type: "admitted" });
        const state = await load(), used = new Set<number>();
        let resolvePrimary!: (value: VariantRecord) => void;
        const primary = { promise: new Promise<VariantRecord>(resolve => { resolvePrimary = resolve; }), resolve: (value: VariantRecord) => resolvePrimary(value) };
        for (const v of c.variants) { const handle = new AbortController(); handles.set(v.executionId, handle); if (state.cancellations.some(r => r.executionId === v.executionId)) handle.abort("operator-cancellation"); }
        // Close the read-to-handle-install race without adding a control/observation transport.
        for (const request of (await load()).cancellations) handles.get(request.executionId)?.abort("operator-cancellation");
        const abort = (reason = "controller-failure") => handles.forEach(h => h.abort(reason));
        const timer = setTimeout(() => abort("deadline"), Math.max(1, state.claim!.deadlineAt - Date.now()));
        let fault = false;
        const settled = c.variants.map(() => {
          let resolve!: (success: boolean) => void;
          return { promise: new Promise<boolean>(done => { resolve = done; }), done: (success: boolean) => resolve(success) };
        });
        const one = async (i: number) => {
          const v = c.variants[i]; let success = false;
          try {
            if (v.kind === "retry" && await settled[c.variants.findIndex(p => p.executionId === v.parentExecutionId)].promise) handles.get(v.executionId)!.abort("retry-not-needed");
            await append({ type: "dispatch", executionId: v.executionId });
            used.add(i);
            const running = reserved[i].run(handles.get(v.executionId)!.signal);
            // Consume both promises even on bookkeeping failure. No untracked rejection or worker.
            const observed = reserved[i].started.then(async value => { if (value === "spawned") await append({ type: "spawn", executionId: v.executionId }); });
            const [result, observation] = await Promise.allSettled([running, observed]);
            if (result.status === "rejected" || observation.status === "rejected") throw new Error("runtime/accounting/observation unknown");
            const data = Buffer.from(JSON.stringify(result.value) + "\n"), out = result.value.output;
            const cancelled = out.aborted && (Boolean(out.signal) || await reserved[i].started === "settled-without-spawn");
            await ownedDirectory(join(b.directory, "variant-" + byteHash(v.executionId))); await writeExperimentFile(artifact(v.executionId), data);
            await append({ type: "result", executionId: v.executionId, artifactDigest: byteHash(data), state: out.timedOut || cancelled && handles.get(v.executionId)?.signal.reason === "deadline" ? "timed-out" : cancelled ? "cancelled" : result.value.digest ? "completed" : "failed" });
            success = Boolean(result.value.digest);
          } catch { fault = true; abort(); }
          finally {
            settled[i].done(success); handles.delete(v.executionId);
            if (i === 0) { const view = await inspect().catch(unknown); primary.resolve(view.variants[0]); }
          }
        };
        const completion = (async () => {
          try {
            for (let i = 0; i < c.variants.length; i += MAX_CHILDREN_PER_CALL) {
              await common(c, await readExperimentFile(join(b.directory, "common.bin"), 16384));
              await Promise.all(c.variants.slice(i, i + MAX_CHILDREN_PER_CALL).map((_, n) => one(i + n)));
              if (fault) break;
            }
          } catch { fault = true; abort(); }
          finally {
            clearTimeout(timer); abort();
            for (let i = 0; i < reserved.length; i++) if (!used.has(i)) {
              used.add(i); await reserved[i].run(AbortSignal.abort()).catch(() => { fault = true; });
            }
            handles.clear();
            if (fault) await append({ type: "controller-unknown" }).catch(() => {});
          }
          const view = await inspect().catch(unknown); primary.resolve(view.variants[0]); return view;
        })();
        live = Object.freeze({ primary: primary.promise, completion, started: Object.freeze(reserved.map(r => r.started)) }); return live;
      } catch (error) {
        for (const run of reserved) await run.run(AbortSignal.abort()).catch(() => {});
        const state = await load().catch(() => null); if (state?.claim?.owner === owner) await append({ type: "controller-unknown" }).catch(() => {});
        throw error;
      } finally { starting = false; }
    },
  });
}
