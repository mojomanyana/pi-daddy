import type { WorkFrozen } from "./work-ledger-types.ts";
import { createHash } from "node:crypto";
import { intentKey, type WorkIntentBinding } from "./intent-control.ts";
import { workIntentBinding } from "./intent-application.ts";
import { freezeWork, parseWorkJson } from "./work-ledger-json.ts";
import { orderSchedule, type OrderSchedule } from "./order-schedule.ts";
import { DIGEST_PROFILE } from "./effect-profile.ts";
export const experimentHash = (value: unknown) => createHash("sha256").update(intentKey(value)).digest("hex");
export const byteHash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const cloneExperiment = <T>(value: T): T => JSON.parse(intentKey(value));
export function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== keys.sort().join()) throw new TypeError("closed experiment data required");
}
const id = (x: unknown) => typeof x === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(x);
const hex = (x: unknown) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
export interface ExperimentVariant {
  variantId: string; executionId: string; kind: "primary" | "shadow" | "retry";
  parentExecutionId: string | null; suffixBase64: string; operation: "digest" | "hold";
  configuration: { model: null; effort: null; skills: null };
}
export interface ExperimentCharter {
  version: "fixed-experiment-v1" | "fixed-experiment-v2"; order?: OrderSchedule; experimentId: string; orderId: string; budgetDigest: string;
  profile: typeof DIGEST_PROFILE; common: { sha256: string; bytes: number; work: WorkFrozen<WorkIntentBinding> | null; workTextDigest: string | null };
  mode: "bounded-waves" | "concurrent-shadow"; deadlineMs: number; variants: readonly ExperimentVariant[];
}
export function experimentCharter(input: ExperimentCharter): ExperimentCharter {
  const c = cloneExperiment(input); closed(c, ["version", "experimentId", "orderId", "budgetDigest", "profile", "common", "mode", "deadlineMs", "variants", ...(c.version === "fixed-experiment-v2" ? ["order"] : [])]);
  if (!["fixed-experiment-v1", "fixed-experiment-v2"].includes(c.version) || !id(c.experimentId) || !id(c.orderId) || !hex(c.budgetDigest) || c.profile !== DIGEST_PROFILE || !["bounded-waves", "concurrent-shadow"].includes(c.mode) || !Number.isSafeInteger(c.deadlineMs) || c.deadlineMs < 1000 || c.deadlineMs > 30000 || Buffer.byteLength(intentKey(c)) > 48000) throw new TypeError("unsupported experiment charter/profile");
  closed(c.common, ["sha256", "bytes", "work", "workTextDigest"]);
  if (!hex(c.common.sha256) || !Number.isSafeInteger(c.common.bytes) || c.common.bytes < 0 || c.common.bytes > 16384) throw new TypeError("bounded common input required");
  if (c.common.work !== null) { c.common.work = workIntentBinding(JSON.parse(intentKey(c.common.work))); if (!hex(c.common.workTextDigest)) throw new TypeError("exact work bytes required"); }
  else if (c.common.workTextDigest !== null) throw new TypeError("unexpected work digest");
  if (!Array.isArray(c.variants) || c.variants.length < (c.version === "fixed-experiment-v2" ? 1 : 2) || c.variants.length > 32) throw new TypeError("2..32 explicit attempts required");
  const ids = new Set<string>(), variants = new Set<string>();
  for (const [i, v] of (c.variants as readonly ExperimentVariant[]).entries()) {
    closed(v, ["variantId", "executionId", "kind", "parentExecutionId", "suffixBase64", "operation", "configuration"]);
    closed(v.configuration, ["model", "effort", "skills"]);
    if (!id(v.variantId) || !id(v.executionId) || ids.has(v.executionId) || variants.has(v.variantId) || !["digest", "hold"].includes(v.operation) || Object.values(v.configuration).some(x => x !== null)) throw new TypeError("unknown/general configuration cannot execute");
    if (c.version === "fixed-experiment-v2" ? !["primary", "retry"].includes(v.kind) || (v.kind === "primary" ? v.parentExecutionId !== null : !ids.has(v.parentExecutionId!)) : i === 0 ? v.kind !== "primary" || v.parentExecutionId !== null || v.operation !== "digest" : !["shadow", "retry"].includes(v.kind) || !ids.has(v.parentExecutionId!)) throw new TypeError("explicit ordered parent/primary required");
    if (typeof v.suffixBase64 !== "string" || v.suffixBase64.length > 22000 || Buffer.from(v.suffixBase64, "base64").toString("base64") !== v.suffixBase64 || c.common.bytes + Buffer.from(v.suffixBase64, "base64").length > 16384) throw new TypeError("invalid bounded byte difference");
    ids.add(v.executionId); variants.add(v.variantId);
  }
  if (c.mode === "concurrent-shadow" && (c.variants.length !== 2 || c.variants[1].kind !== "shadow")) throw new TypeError("concurrent shadow requires exactly primary and shadow");
  if (c.version === "fixed-experiment-v2") {
    if (c.mode !== "bounded-waves" || !c.common.work) throw new Error("orders require pinned work and bounded scheduling");
    c.order = orderSchedule(c.order!, c.variants.map(v => v.executionId));
    for (const n of c.order.nodes) for (const [i,id] of n.executions.entries()) { const v=c.variants.find(v=>v.executionId===id)!; if(i ? v.kind!=="retry"||v.parentExecutionId!==n.executions[i-1] : v.kind!=="primary") throw new Error("node recovery lineage mismatch"); }
  }
  return freezeWork(c) as ExperimentCharter;
}
export const parseExperimentCharter = (text: string) => experimentCharter(parseWorkJson(text) as unknown as ExperimentCharter);
export const experimentCharterDigest = (c: ExperimentCharter) => experimentHash(experimentCharter(c));
export interface ExperimentAuthority { authorityDigest: string; charterDigests: readonly string[]; cancellationDigests: readonly string[] }
export function experimentAuthority(value: ExperimentAuthority | null): ExperimentAuthority | null {
  if (value === null) return null;
  const a = cloneExperiment(value); closed(a, ["authorityDigest", "charterDigests", "cancellationDigests"]);
  if (!hex(a.authorityDigest) || [a.charterDigests, a.cancellationDigests].some(xs => !Array.isArray(xs) || xs.length > 128 || xs.some(x => !hex(x)))) throw new TypeError("independent bounded host approvals required");
  return freezeWork(a);
}
export interface ExperimentCancellation { version: "experiment-cancel-v1"; requestId: string; bindingDigest: string; executionId: string }
export function experimentCancellation(value: ExperimentCancellation): ExperimentCancellation {
  const c = cloneExperiment(value); closed(c, ["version", "requestId", "bindingDigest", "executionId"]);
  if (c.version !== "experiment-cancel-v1" || !id(c.requestId) || !hex(c.bindingDigest) || !id(c.executionId)) throw new TypeError("exact cancellation required");
  return freezeWork(c);
}
export const experimentCancellationDigest = (c: ExperimentCancellation) => experimentHash(experimentCancellation(c));
