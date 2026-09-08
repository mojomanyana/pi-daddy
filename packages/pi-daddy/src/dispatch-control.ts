import { createHash } from "node:crypto";
import { canonicalWorkJson, copyWorkJson, parseWorkJson } from "./work-ledger-json.ts";

export interface DispatchRequest {
  version: "1.0"; requestId: string; bindingDigest: string; expectedRevision: number;
  action: "pause-dispatch" | "resume-dispatch" | "cancel-execution" | "revise-scope" | "reprioritize" | "select-alternative";
  targetExecutionId: string | null;
}
/** Independent trusted host declarations, NOT a wire request field or a file loaded by the controller. */
export interface DispatchAuthority { authorityDigest: string; requestDigests: readonly string[] }
export interface DispatchRecord {
  request: Readonly<DispatchRequest>; digest: string;
  decision: "approved" | "authority-unavailable" | "unsupported" | "stale" | "busy";
  application: "pending" | "applied" | "not-applied";
  outcome: "boundary-pending" | "paused" | "enabled" | "refused";
}
export interface DispatchState { revision: number; paused: boolean; records: DispatchRecord[] }
export interface DispatchSnapshot {
  version: "dispatch-control-snapshot-v1"; bindingDigest: string; freshness: "snapshot-unknown"; revision: number; paused: boolean;
  admission: "blocked-pending" | "paused" | "enabled"; acceptance: "not-assessed";
  records: readonly Readonly<DispatchRecord>[];
}
const hex = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const id = (x: unknown): x is string => typeof x === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(x);
export function controlShape(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length || keys.some(k => { const d = Object.getOwnPropertyDescriptor(value, k); return !d?.enumerable || !Object.hasOwn(d, "value"); })) throw new TypeError("closed dispatch control data required");
}
export function dispatchRequest(input: DispatchRequest): Readonly<DispatchRequest> {
  controlShape(input, ["version", "requestId", "bindingDigest", "expectedRevision", "action", "targetExecutionId"]);
  if (input.version !== "1.0" || !id(input.requestId) || !hex(input.bindingDigest) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 128 ||
    !["pause-dispatch", "resume-dispatch", "cancel-execution", "revise-scope", "reprioritize", "select-alternative"].includes(input.action) ||
    !(input.targetExecutionId === null || id(input.targetExecutionId)) || (input.action === "cancel-execution" ? input.targetExecutionId === null : input.targetExecutionId !== null)) throw new TypeError("invalid dispatch request");
  return Object.freeze({ version: input.version, requestId: input.requestId, bindingDigest: input.bindingDigest,
    expectedRevision: input.expectedRevision, action: input.action, targetExecutionId: input.targetExecutionId });
}
export function parseDispatchRequest(text: string): Readonly<DispatchRequest> {
  if (typeof text !== "string" || Buffer.byteLength(text) > 4096) throw new TypeError("bounded dispatch JSON required");
  return dispatchRequest(parseWorkJson(text) as unknown as DispatchRequest);
}
export function dispatchRequestDigest(input: DispatchRequest): string {
  return createHash("sha256").update(canonicalWorkJson(copyWorkJson(dispatchRequest(input)))).digest("hex");
}
export function dispatchAuthority(input: DispatchAuthority | null): Readonly<DispatchAuthority> | null {
  if (input === null) return null;
  controlShape(input, ["authorityDigest", "requestDigests"]);
  const copy = copyWorkJson(input.requestDigests);
  if (!hex(input.authorityDigest) || !Array.isArray(copy) || copy.length > 128 || !copy.every(hex) || new Set(copy).size !== copy.length) throw new TypeError("invalid independent dispatch authority");
  return Object.freeze({ authorityDigest: input.authorityDigest, requestDigests: Object.freeze([...copy] as string[]) });
}
export function dispatchDecision(state: DispatchState, request: DispatchRequest, authorized: boolean, otherPending = false): DispatchRecord["decision"] {
  if (!authorized) return "authority-unavailable";
  if (!["pause-dispatch", "resume-dispatch"].includes(request.action)) return "unsupported";
  if (request.expectedRevision !== state.revision) return "stale";
  if (otherPending || state.records.some(r => r.application === "pending")) return "busy";
  return "approved";
}
/** Replay operational controls only; no work-intent or acceptance projection is maintained here. */
export function replayDispatch(state: DispatchState, event: Record<string, unknown>, bindingDigest: string, active: number, otherPending = false): void {
  if (event.type === "control-request") {
    controlShape(event, ["type", "request", "decision"]);
    const request = dispatchRequest(event.request as DispatchRequest), decision = event.decision as DispatchRecord["decision"];
    if (state.records.length >= 128 || request.bindingDigest !== bindingDigest || state.records.some(r => r.request.requestId === request.requestId) ||
      !["approved", "authority-unavailable", "unsupported", "stale", "busy"].includes(decision) ||
      dispatchDecision(state, request, decision !== "authority-unavailable", otherPending) !== decision) throw new Error("invalid dispatch decision sequence");
    state.records.push({ request, digest: dispatchRequestDigest(request), decision,
      application: decision === "approved" ? "pending" : "not-applied", outcome: decision === "approved" ? "boundary-pending" : "refused" });
    if (decision === "approved") state.revision++;
  } else {
    controlShape(event, ["type", "requestId"]);
    const record = state.records.find(r => r.request.requestId === event.requestId);
    if (event.type !== "control-apply" || !record || record.application !== "pending" || active !== 0) throw new Error("unverified dispatch application boundary");
    state.paused = record.request.action === "pause-dispatch";
    record.application = "applied"; record.outcome = state.paused ? "paused" : "enabled";
  }
}
export function freezeDispatch(state: DispatchState, bindingDigest: string, otherPending = false): Readonly<DispatchSnapshot> {
  return Object.freeze({ version: "dispatch-control-snapshot-v1", bindingDigest, freshness: "snapshot-unknown", revision: state.revision, paused: state.paused,
    admission: otherPending || state.records.some(r => r.application === "pending") ? "blocked-pending" : state.paused ? "paused" : "enabled",
    acceptance: "not-assessed", records: Object.freeze(state.records.map(r => Object.freeze({ ...r }))) });
}
