import { createHash } from "node:crypto";
const SHA = /^[a-f0-9]{64}$/;
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 512 && !/[\u0000-\u001f\u007f]/.test(x);
const closed = (value: object, names: string[]) => {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(fields).length === names.length && Reflect.ownKeys(fields).every(key => typeof key === "string" && names.includes(key) && fields[key].enumerable && Object.hasOwn(fields[key], "value"));
};
const hash = (value: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(Object.keys(value).sort().map(k => [k, value[k]]))).digest("hex");
export interface AdoptionInput {
  hypothesisDigest: string; experimentDigest: string; candidateDigest: string; scopeDigest: string; assessmentPolicyDigest: string;
  rollbackCandidateDigest: string; activationBoundary: "next-orders"; expiresAt: number;
}
export interface AdoptionBinding extends AdoptionInput { version: "adoption-binding-v1"; id: string }
export interface AdoptionAuthority { id: string; adoptions: readonly string[]; rollbacks: readonly string[] }
export interface AdoptionFacts { experimentDigest: string; candidateDigest: string; scopeDigest: string; assessmentPolicyDigest: string; eligible: boolean }
export function buildAdoptionBinding(input: AdoptionInput): AdoptionBinding {
  if (!input || !closed(input, ["hypothesisDigest", "experimentDigest", "candidateDigest", "scopeDigest", "assessmentPolicyDigest", "rollbackCandidateDigest", "activationBoundary", "expiresAt"])
    || ![input.hypothesisDigest,input.experimentDigest,input.candidateDigest,input.scopeDigest,input.assessmentPolicyDigest,input.rollbackCandidateDigest].every(s => typeof s === "string" && SHA.test(s))
    || input.activationBoundary !== "next-orders" || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) throw new Error("invalid scoped adoption binding");
  const body = { version: "adoption-binding-v1" as const, ...input };
  return Object.freeze({ ...body, id: hash(body) });
}
function bindingValid(binding: AdoptionBinding) {
  const { version, id, ...input } = binding;
  if (version !== "adoption-binding-v1" || buildAdoptionBinding(input).id !== id) throw new Error("adoption binding changed");
}
function authorityValid(authority: AdoptionAuthority | null): authority is AdoptionAuthority {
  return !!authority && text(authority.id) && Array.isArray(authority.adoptions) && Array.isArray(authority.rollbacks)
    && authority.adoptions.length <= 256 && authority.rollbacks.length <= 256 && [...authority.adoptions, ...authority.rollbacks].every(id => typeof id === "string" && SHA.test(id));
}
/** Independent host declarations and independently verified eligible facts are required again at use. */
export function authorizeAdoption(binding: AdoptionBinding, authority: AdoptionAuthority | null, facts: AdoptionFacts, now: number) {
  bindingValid(binding);
  if (!authorityValid(authority) || !authority.adoptions.includes(binding.id)) throw new Error("independent adoption authority required");
  if (!Number.isSafeInteger(now) || now < 0 || now >= binding.expiresAt || !facts || !closed(facts, ["experimentDigest", "candidateDigest", "scopeDigest", "assessmentPolicyDigest", "eligible"]) || facts.eligible !== true
    || facts.experimentDigest !== binding.experimentDigest || facts.candidateDigest !== binding.candidateDigest
    || facts.scopeDigest !== binding.scopeDigest || facts.assessmentPolicyDigest !== binding.assessmentPolicyDigest) throw new Error("adoption expired, ineligible or outside verified scope");
  const body = { version: "adoption-receipt-v1" as const, bindingId: binding.id, authorityId: authority.id, hypothesisDigest: binding.hypothesisDigest,
    experimentDigest: binding.experimentDigest, candidateDigest: binding.candidateDigest, scopeDigest: binding.scopeDigest,
    assessmentPolicyDigest: binding.assessmentPolicyDigest, rollbackCandidateDigest: binding.rollbackCandidateDigest,
    activationBoundary: "next-orders" as const, grantExpansion: false as const, expiresAt: binding.expiresAt };
  return Object.freeze({ ...body, id: hash(body) });
}
export type AdoptionReceipt = ReturnType<typeof authorizeAdoption>;
export function validateAdoptionReceipt(receipt: AdoptionReceipt, binding: AdoptionBinding, authority: AdoptionAuthority | null, facts: AdoptionFacts, now: number): void {
  if (authorizeAdoption(binding, authority, facts, now).id !== receipt.id) throw new Error("adoption receipt does not match current independent authority/facts");
  receiptValid(receipt);
}
function receiptValid(receipt: AdoptionReceipt) {
  const { id, ...body } = receipt;
  if (!closed(receipt, ["version", "bindingId", "authorityId", "hypothesisDigest", "experimentDigest", "candidateDigest", "scopeDigest", "assessmentPolicyDigest", "rollbackCandidateDigest", "activationBoundary", "grantExpansion", "expiresAt", "id"])
    || body.version !== "adoption-receipt-v1" || !text(body.authorityId) || body.activationBoundary !== "next-orders" || body.grantExpansion !== false || hash(body) !== id) throw new Error("adoption receipt changed");
  const binding = buildAdoptionBinding({ hypothesisDigest: body.hypothesisDigest, experimentDigest: body.experimentDigest, candidateDigest: body.candidateDigest,
    scopeDigest: body.scopeDigest, assessmentPolicyDigest: body.assessmentPolicyDigest, rollbackCandidateDigest: body.rollbackCandidateDigest, activationBoundary: body.activationBoundary, expiresAt: body.expiresAt });
  if (binding.id !== body.bindingId) throw new Error("adoption receipt binding mismatch");
}
export interface ProductionObservation {
  id: string; adoptionId: string; candidateDigest: string; scopeDigest: string;
  originalRequirementDigest: string; currentRequirementDigest: string;
  /** Only an independent host may supply confirmed outcomes; observer/model claims are not confirmation. */
  outcome: "confirmed-defect" | "success" | "unknown";
  acceptanceDigest: string | null; acceptedArtifactDigest: string | null; observedArtifactDigest: string;
  evidence: string[];
}
export function classifyProductionObservation(adoption: AdoptionReceipt, input: ProductionObservation) {
  receiptValid(adoption);
  if (!input || !text(input.id) || input.evidence.length > 256 || input.evidence.some(h => !SHA.test(h))
    || ![input.originalRequirementDigest,input.currentRequirementDigest,input.candidateDigest,input.scopeDigest,input.observedArtifactDigest].every(h => typeof h === "string" && SHA.test(h))
    || ![input.acceptanceDigest,input.acceptedArtifactDigest].every(h => h === null || (typeof h === "string" && SHA.test(h)))
    || (input.acceptanceDigest === null) !== (input.acceptedArtifactDigest === null)
    || !["confirmed-defect", "success", "unknown"].includes(input.outcome)) throw new Error("invalid production observation");
  const state = input.adoptionId !== adoption.id || input.candidateDigest !== adoption.candidateDigest || input.scopeDigest !== adoption.scopeDigest ? "out-of-scope"
    : input.originalRequirementDigest !== input.currentRequirementDigest ? "changed-requirements"
      : input.acceptedArtifactDigest !== null && input.acceptedArtifactDigest !== input.observedArtifactDigest ? "changed-artifact"
        : input.outcome === "confirmed-defect" && input.evidence.length ? input.acceptanceDigest === null ? "caught-defect" : "escape" : input.outcome === "success" ? "success" : "unknown";
  return Object.freeze({ state, adoptionId: adoption.id, hypothesisDigest: adoption.hypothesisDigest, experimentDigest: adoption.experimentDigest, observationId: input.id, acceptanceDigest: input.acceptanceDigest, acceptedArtifactDigest: input.acceptedArtifactDigest, observedArtifactDigest: input.observedArtifactDigest, automaticRollback: false });
}
export interface RollbackRequest { version: "rollback-request-v1"; id: string; adoptionId: string; scopeDigest: string; restoreCandidateDigest: string; reason: "operator-request" | "confirmed-escape"; evidence: readonly string[]; expiresAt: number }
export function buildRollbackRequest(adoption: AdoptionReceipt, reason: RollbackRequest["reason"], evidence: string[], expiresAt = adoption.expiresAt): RollbackRequest {
  receiptValid(adoption);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || !["operator-request", "confirmed-escape"].includes(reason) || !evidence.length || evidence.length > 256 || evidence.some(h => !SHA.test(h))) throw new Error("invalid rollback request");
  const body = { version: "rollback-request-v1" as const, adoptionId: adoption.id, scopeDigest: adoption.scopeDigest, restoreCandidateDigest: adoption.rollbackCandidateDigest, reason, expiresAt, evidence: Object.freeze([...new Set(evidence)].sort()) };
  return Object.freeze({ ...body, id: hash(body) });
}
/** This validates a recorded choice, not an automatic rollback action or a caller-created authority flag. */
export function authorizeRollback(adoption: AdoptionReceipt, request: RollbackRequest, authority: AdoptionAuthority | null, now: number,
  current: { adoptionId: string; candidateDigest: string; scopeDigest: string }) {
  receiptValid(adoption); const { id, ...body } = request;
  if (!authorityValid(authority) || authority.id !== adoption.authorityId || !authority.rollbacks.includes(id)) throw new Error("independent rollback authority required");
  if (hash(body) !== id || request.version !== "rollback-request-v1" || request.adoptionId !== adoption.id || request.scopeDigest !== adoption.scopeDigest
    || request.restoreCandidateDigest !== adoption.rollbackCandidateDigest || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(request.expiresAt) || now >= request.expiresAt
    || !current || current.adoptionId !== adoption.id || current.candidateDigest !== adoption.candidateDigest || current.scopeDigest !== adoption.scopeDigest) throw new Error("rollback binding changed or expired");
  return Object.freeze({ requestId: id, adoptionId: adoption.id, restoreCandidateDigest: request.restoreCandidateDigest, scopeDigest: adoption.scopeDigest, grantExpansion: false, application: "not-performed" });
}
export interface LeanOutcome {
  population: string; complete: boolean; accepted: boolean | null; repairAttempts: number | null;
  escape: "confirmed" | "none-observed" | "unknown"; requirementsChanged: boolean; decisionWaitMs: number | null; questions: number | null;
}
export function summarizeLeanOutcomes(population: string, rows: readonly LeanOutcome[]) {
  if (!text(population) || rows.length > 10000 || rows.some(r => r.population !== population || typeof r.complete !== "boolean" || typeof r.requirementsChanged !== "boolean"
    || ![true,false,null].includes(r.accepted) || !["confirmed","none-observed","unknown"].includes(r.escape)
    || [r.repairAttempts,r.decisionWaitMs,r.questions].some(n => n !== null && (!Number.isSafeInteger(n) || n < 0)))) throw new Error("invalid or incomparable lean population");
  const complete = rows.filter(r => r.complete && r.accepted !== null && r.repairAttempts !== null);
  const observed = (field: "decisionWaitMs" | "questions" | "repairAttempts") => ({ known: rows.reduce((n, r) => n + (r[field] ?? 0), 0), observed: rows.filter(r => r[field] !== null).length, total: rows.length });
  return { population, firstPassAccepted: complete.filter(r => r.accepted && r.repairAttempts === 0).length, firstPassDenominator: complete.length,
    incomplete: rows.length - complete.length, confirmedEscapes: rows.filter(r => r.escape === "confirmed" && !r.requirementsChanged).length,
    changedRequirements: rows.filter(r => r.requirementsChanged).length, recovery: observed("repairAttempts"), decisionWait: observed("decisionWaitMs"), questions: observed("questions"), universalScore: null };
}
