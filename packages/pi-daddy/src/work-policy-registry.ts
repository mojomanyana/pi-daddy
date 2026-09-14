import { createControlJournal, controlJournal, type ControlBinding } from "./control-journal.ts";
import { experimentHash, closed, cloneExperiment } from "./experiment-contract.ts";
import { buildAdoptionBinding, buildRollbackRequest, validateAdoptionReceipt, authorizeRollback, type AdoptionBinding, type AdoptionReceipt, type RollbackRequest } from "./vendor/adoption.ts";
import { factoryAuthority, requireFactoryAuthority, type FactoryAuthority } from "./factory-contract.ts";
import { WORK_EFFORTS, type WorkSetup } from "./work-setup.ts";

/** Additive profile: ONLY model/effort may change. Task IDs and definition names stay fixed. Normal definition-digest/grant checks still run; this is not a filesystem pin. */
export interface WorkPolicy { version: "ordinary-work-policy-v1"; scopeDigest: string; assessmentPolicyDigest: string; profiles: { taskId: string; agent: string | null; model: string; thinking: typeof WORK_EFFORTS[number] }[] }
export interface WorkPolicyInitial { version: "ordinary-work-registry-v1"; authorityId: string; scopeDigest: string; baseline: WorkPolicy }
export type WorkPolicyRegistry = ControlBinding<WorkPolicyInitial>;
export interface WorkPolicyActivation { version: "ordinary-work-activation-v1"; requestId: string; expectedRevision: number; expectedCandidateDigest: string; candidate: WorkPolicy; binding: AdoptionBinding; receipt: AdoptionReceipt }
const sha = (x: unknown) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
export function workPolicy(input: WorkPolicy): WorkPolicy {
  const p = cloneExperiment(input); closed(p, ["version", "scopeDigest", "assessmentPolicyDigest", "profiles"]);
  if (p.version !== "ordinary-work-policy-v1" || !sha(p.scopeDigest) || !sha(p.assessmentPolicyDigest) || !Array.isArray(p.profiles) || !p.profiles.length || p.profiles.length > 8) throw Error("unsupported ordinary policy profile");
  for (const t of p.profiles) { closed(t, ["taskId", "agent", "model", "thinking"]); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(t.taskId) || !(t.agent === null || typeof t.agent === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t.agent)) || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/@+-]+$/.test(t.model) || t.model.length > 128 || !WORK_EFFORTS.includes(t.thinking)) throw Error("invalid model/effort profile; no fallback"); }
  if (new Set(p.profiles.map(t => t.taskId)).size !== p.profiles.length) throw Error("duplicate profile task");
  return p;
}
export const workPolicyDigest = (p: WorkPolicy) => experimentHash(workPolicy(p));
export const workPolicyActivationDigest = (r: WorkPolicyActivation) => experimentHash(r);
export function policyForSetup(setup: WorkSetup, scopeDigest: string, assessmentPolicyDigest: string): WorkPolicy { return workPolicy({ version: "ordinary-work-policy-v1", scopeDigest, assessmentPolicyDigest, profiles: setup.tasks.map(({ id: taskId, agent, model, thinking }) => ({ taskId, agent, model, thinking })) }); }
function compatible(baseline: WorkPolicy, candidate: WorkPolicy) {
  const shape = (p: WorkPolicy) => p.profiles.map(t => ({ taskId: t.taskId, agent: t.agent })).sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (baseline.scopeDigest !== candidate.scopeDigest || baseline.assessmentPolicyDigest !== candidate.assessmentPolicyDigest || experimentHash(shape(baseline)) !== experimentHash(shape(candidate))) throw Error("policy changes may only select models/effort for the same scoped definitions; no instruction, capability, topology or assessment expansion");
}
function replay(binding: WorkPolicyRegistry, events: Record<string, unknown>[]) {
  const initial = binding.initial; closed(initial, ["version", "authorityId", "scopeDigest", "baseline"]);
  if (initial.version !== "ordinary-work-registry-v1" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(initial.authorityId) || initial.scopeDigest !== workPolicy(initial.baseline).scopeDigest) throw Error("invalid policy registry binding");
  let candidate = initial.baseline, revision = 0, active: WorkPolicyActivation | null = null;
  let lastChange: {operation:"activate"|"rollback";requestId:string;adoptionId:string}|null=null;
  const lineage: (WorkPolicyActivation | null)[] = [], policies = new Map([[workPolicyDigest(candidate), candidate]]), requests = new Map<string, string>(), orders = new Map<string, { candidateDigest: string; adoptionId: string | null; revision: number }>();
  for (const e of events) {
    if (e.type === "activate") {
      closed(e, ["type", "request"]); const r = e.request as unknown as WorkPolicyActivation; closed(r, ["version", "requestId", "expectedRevision", "expectedCandidateDigest", "candidate", "binding", "receipt"]);
      const { version, id, ...draft } = r.binding;
      if (r.version !== "ordinary-work-activation-v1" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(r.requestId) || requests.has(r.requestId) || r.expectedRevision !== revision || r.expectedCandidateDigest !== workPolicyDigest(candidate) || version !== "adoption-binding-v1" || buildAdoptionBinding(draft).id !== id || r.binding.scopeDigest !== initial.scopeDigest || r.binding.candidateDigest !== workPolicyDigest(r.candidate) || r.binding.rollbackCandidateDigest !== workPolicyDigest(candidate) || r.binding.assessmentPolicyDigest !== r.candidate.assessmentPolicyDigest || r.receipt.bindingId !== id || r.receipt.authorityId !== initial.authorityId) throw Error("invalid activation sequence");
      validateAdoptionReceipt(r.receipt, r.binding, { id: r.receipt.authorityId, adoptions: [r.binding.id], rollbacks: [] }, { experimentDigest: r.binding.experimentDigest, candidateDigest: r.binding.candidateDigest, scopeDigest: r.binding.scopeDigest, assessmentPolicyDigest: r.binding.assessmentPolicyDigest, eligible: true }, 0); // Structural replay only; activate/pin independently authorize again at use.
      compatible(initial.baseline, workPolicy(r.candidate)); requests.set(r.requestId, workPolicyActivationDigest(r)); lineage.push(active); active = r; candidate = r.candidate; policies.set(workPolicyDigest(candidate), candidate); revision++; lastChange={operation:"activate",requestId:r.requestId,adoptionId:r.receipt.id};
    } else if (e.type === "rollback") {
      closed(e, ["type", "request", "fromRevision"]); const r = e.request as unknown as RollbackRequest;
      if (!active || experimentHash(buildRollbackRequest(active.receipt,r.reason,[...r.evidence],r.expiresAt)) !== experimentHash(r) || e.fromRevision !== revision || requests.has(r.id) || r.adoptionId !== active.receipt.id || r.scopeDigest !== initial.scopeDigest || r.restoreCandidateDigest !== active.binding.rollbackCandidateDigest || !policies.has(r.restoreCandidateDigest)) throw Error("invalid rollback sequence");
      candidate = policies.get(r.restoreCandidateDigest)!; if(!lineage.length)throw Error("missing rollback lineage"); active = lineage.pop() ?? null; if((active?.binding.candidateDigest??workPolicyDigest(initial.baseline))!==workPolicyDigest(candidate))throw Error("rollback lineage mismatch"); requests.set(r.id, experimentHash(r)); revision++; lastChange={operation:"rollback",requestId:r.id,adoptionId:r.adoptionId};
    } else if (e.type === "order-pin") {
      closed(e, ["type", "orderId", "candidateDigest", "adoptionId", "revision"]);
      if (typeof e.orderId !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(e.orderId) || orders.has(e.orderId) || e.candidateDigest !== workPolicyDigest(candidate) || e.adoptionId !== (active?.receipt.id ?? null) || e.revision !== revision) throw Error("invalid future-order pin");
      orders.set(e.orderId, { candidateDigest: String(e.candidateDigest), adoptionId: e.adoptionId as string | null, revision });
    } else throw Error("unknown work policy registry event");
  }
  return { candidate, revision, active, requests, orders, lastChange };
}
export async function createWorkPolicyRegistry(input: { directory: string; authorityId: string; baseline: WorkPolicy }): Promise<WorkPolicyRegistry> {
  const baseline = workPolicy(input.baseline);
  return createControlJournal(input.directory, { version: "ordinary-work-registry-v1", authorityId: input.authorityId, scopeDigest: baseline.scopeDigest, baseline });
}
export function openWorkPolicyRegistry(binding: WorkPolicyRegistry) {
  const store = controlJournal(binding);
  const inspect = async () => { const s = replay(binding, (await store.read()).events); return { version: "factory-registry-view-v1" as const, profile: "ordinary-model-effort-v1", scopeDigest: binding.initial.scopeDigest, candidateDigest: workPolicyDigest(s.candidate), candidate: s.candidate, revision: s.revision, activation: s.active, lastChange:s.lastChange, application:s.lastChange?"applied":"not-performed", requestId:s.lastChange?.requestId??null, orders: [...s.orders].map(([orderId, pin]) => ({ orderId, ...pin })), acceptance: "not-assessed" }; };
  const authority = (host: FactoryAuthority | null) => requireFactoryAuthority(factoryAuthority(host), binding.initial.authorityId);
  const eligible = (r: WorkPolicyActivation, host: FactoryAuthority) => { const facts = host.facts.find(f => f.bindingId === r.binding.id)?.facts; if (!facts) throw Error("current independent eligibility facts required"); validateAdoptionReceipt(r.receipt, r.binding, host.adoption, facts, Date.now()); };
  return { inspect,
    async activate(request: WorkPolicyActivation, host: FactoryAuthority | null) {
      const r = cloneExperiment(request), a = authority(host); if (!a.activationDigests.includes(workPolicyActivationDigest(r))) throw Error("exact independent activation approval required");
      await store.transaction(async (events, append) => { eligible(r,a); const s = replay(binding, events), old = s.requests.get(r.requestId); if (old) { if (old !== workPolicyActivationDigest(r)) throw Error("immutable activation ID"); return; } const event = { type: "activate", request: r }; replay(binding, [...events, event]); await append(event); }); return inspect();
    },
    async rollback(request: RollbackRequest, host: FactoryAuthority | null) {
      const r = cloneExperiment(request), a = authority(host);
      await store.transaction(async (events, append) => { const s = replay(binding, events), old = s.requests.get(r.id); if (old) { if (old !== experimentHash(r) || !a.adoption?.rollbacks.includes(r.id)) throw Error("rollback identity/authority mismatch"); return; } if (!s.active) throw Error("no active adoption to roll back"); authorizeRollback(s.active.receipt, r, a.adoption, Date.now(), { adoptionId: s.active.receipt.id, candidateDigest: workPolicyDigest(s.candidate), scopeDigest: binding.initial.scopeDigest }); const event = { type: "rollback", request: r, fromRevision: s.revision }; replay(binding, [...events, event]); await append(event); }); return { ...await inspect(), application: "applied" as const, requestId: r.id, grantExpansion: false };
    },
    async pin(orderId: string, host: FactoryAuthority | null, expected: { revision: number; candidateDigest: string }) {
      const a = authority(host);
      return store.transaction(async (events, append) => { const s = replay(binding, events); if(s.revision!==expected.revision||workPolicyDigest(s.candidate)!==expected.candidateDigest)throw Error("registry changed before order pin"); if (s.orders.has(orderId)) throw Error("order already pinned; never relaunch on readback"); if (s.active) eligible(s.active, a); const event = { type: "order-pin", orderId, candidateDigest: workPolicyDigest(s.candidate), adoptionId: s.active?.receipt.id ?? null, revision: s.revision }; replay(binding, [...events, event]); await append(event); return { ...event, candidate: s.candidate }; });
    },
  };
}
