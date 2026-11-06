/** Cooperative local continuation identity; never a capability, task acceptance, or external-effect proof. */
import type { OperationArtifactOwner } from "./operation-artifact.ts";
export interface InitiativeTask {
  taskId: string;
  taskRevision: string;
  effectScope: "local" | "external" | "unknown";
  effectTarget?: InitiativeEffectTarget;
}
export interface InitiativeAttempt {
  owner: OperationArtifactOwner;
  operationId: string;
  executionId: string;
  requestDigest: string;
  state: "pending" | "not-admitted";
  effectReceipt?: InitiativeEffectReceipt;
}
export interface InitiativeTaskRecord extends InitiativeTask {
  generation: number;
  attempts: InitiativeAttempt[];
}
export interface InitiativeRecord {
  version: 1;
  initiativeId: string;
  generation: number;
  owner: OperationArtifactOwner;
  state: "owned" | "released";
  tasks: InitiativeTaskRecord[];
}
export interface InitiativeObservation {
  status: "observed";
  initiativeId: string;
  taskId: string;
  taskRevision: string;
  ownerGeneration: number;
  claim: "unclaimed" | "owned" | "other-owner" | "uncertain";
  execution: "none" | "running" | "settled" | "unknown";
  reconciliationRequired: boolean;
  effectObservation?: InitiativeEffectObservation;
  assertCurrent(): void | Promise<void>;
}
export interface InitiativeTaskIdentity {
  initiativeId: string;
  taskId: string;
  taskRevision: string;
}
export const validInitiativeId = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(v);
export const validTaskId = validInitiativeId;
export const validTaskRevision = (v: unknown): v is string =>
  typeof v === "string" && /^(?:sha256:)?[a-f0-9]{64}$/.test(v);
export function validInitiativeTask(v: unknown): v is InitiativeTask {
  const t = v as InitiativeTask;
  return (
    !!t &&
    validTaskId(t.taskId) &&
    validTaskRevision(t.taskRevision) &&
    ["local", "external", "unknown"].includes(t.effectScope) &&
    (t.effectTarget === undefined || validEffectTarget(t.effectTarget))
  );
}

/** Exact selected canonical receipt. It records reconciliation, never task acceptance or a permission. */
export interface InitiativeEffectReceipt {
  reference: string;
  sha256: string;
  observation?: InitiativeEffectReported;
}
export interface InitiativeEffectIdentity extends InitiativeTaskIdentity {
  owner: OperationArtifactOwner;
  operationId: string;
  executionId: string;
  effectScope: InitiativeTask["effectScope"];
}
export interface InitiativeEffectReconciliation extends InitiativeEffectIdentity {
  receipt: InitiativeEffectReceipt;
}
export function validEffectReceipt(value: unknown): value is InitiativeEffectReceipt {
  const r = value as InitiativeEffectReceipt;
  return (
    !!r &&
    typeof r.reference === "string" &&
    r.reference.length > 0 &&
    r.reference.length <= 2048 &&
    !/[\x00-\x1f\x7f]/.test(r.reference) &&
    typeof r.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(r.sha256) &&
    (r.observation === undefined || validEffectReported(r.observation))
  );
}

/** Neutral target identity supplied by its responsible owner; Daddy does not interpret its domain. */
export interface InitiativeEffectTarget {
  owner: string;
  kind: string;
  reference: string;
}
export interface InitiativeEffectReported {
  target: InitiativeEffectTarget;
  outcome: "applied" | "not-applied" | "unknown";
  provenance: "operator-attested" | "owner-verified";
}
export interface InitiativeEffectObservation {
  target: InitiativeEffectTarget;
  outcome: "pending" | InitiativeEffectReported["outcome"];
  provenance: "not-observed" | InitiativeEffectReported["provenance"];
  receipt?: { reference: string; sha256: string };
  attempt?: { owner: OperationArtifactOwner; operationId: string; executionId: string };
}
const displayIdentity = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export function validEffectTarget(value: unknown): value is InitiativeEffectTarget {
  const t = value as InitiativeEffectTarget;
  return !!t && displayIdentity(t.owner, 48) && displayIdentity(t.kind, 80) && displayIdentity(t.reference, 2048);
}
export function sameEffectTarget(a?: InitiativeEffectTarget, b?: InitiativeEffectTarget) {
  return !a || !b ? a === b : a.owner === b.owner && a.kind === b.kind && a.reference === b.reference;
}
export function validEffectReported(value: unknown): value is InitiativeEffectReported {
  const o = value as InitiativeEffectReported;
  return (
    !!o &&
    validEffectTarget(o.target) &&
    ["applied", "not-applied", "unknown"].includes(o.outcome) &&
    ["operator-attested", "owner-verified"].includes(o.provenance)
  );
}
