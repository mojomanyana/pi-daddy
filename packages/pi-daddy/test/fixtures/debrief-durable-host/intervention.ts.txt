import { createHash, randomBytes } from "node:crypto";
const SHA = /^[a-f0-9]{64}$/;
const text = (x: unknown, max = 512): x is string => typeof x === "string" && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
const closed = (x: unknown, names: string[]): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).sort().join() === [...names].sort().join();
function canonical(x: unknown, depth = 0): string {
  if (depth > 16) throw new Error("intervention data exceeds depth");
  if (x === null || typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))) return JSON.stringify(x);
  if (!x || typeof x !== "object" || (!Array.isArray(x) && ![Object.prototype, null].includes(Object.getPrototypeOf(x)))) throw new Error("plain intervention JSON required");
  const d = Object.getOwnPropertyDescriptors(x);
  if (Array.isArray(x)) {
    if (x.length > 4096 || Reflect.ownKeys(x).length !== x.length + 1) throw new Error("bounded dense array required");
    return `[${Array.from({ length: x.length }, (_, i) => { if (!d[i] || !Object.hasOwn(d[i], "value")) throw new Error("plain array required"); return canonical(d[i].value, depth + 1); }).join(",")}]`;
  }
  return `{${Reflect.ownKeys(d).sort((a, b) => String(a) < String(b) ? -1 : 1).map(k => { if (typeof k !== "string" || !d[k].enumerable || !Object.hasOwn(d[k], "value")) throw new Error("plain object required"); return `${JSON.stringify(k)}:${canonical(d[k].value, depth + 1)}`; }).join(",")}}`;
}
/** Plain, bounded JSON encoding for retained intervention inputs; not semantic validation. */
export function interventionCanonicalJson(value: unknown): string {
  const bytes = canonical(value);
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error("intervention data exceeds byte bound");
  return bytes;
}
const digest = (value: unknown) => createHash("sha256").update(interventionCanonicalJson(value)).digest("hex");
function frozen<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
const clone = <T>(value: T): T => JSON.parse(canonical(value));
export type InterventionAxis = "model" | "effort" | "skill" | "prompt" | "configuration";
export interface InterventionDraft {
  family: "intervention"; investigationSha256: string; resourceMetric: "usd" | "wall_ms" | "tool_calls"; axes: InterventionAxis[];
  common: { mode: "green" | "force"; scenarioSha256: string; rubricSha256: string; fixtureSha256: string; heldoutSha256: string; harnessSha256: string; judgePolicySha256: string };
  proposer: string; judge: string;
  cases: Array<{ id: string; criteria: number; reps: number; threshold: number; critical: boolean }>;
  arms: Array<{ id: string; configuration: Record<InterventionAxis, string> }>;
}
export interface InterventionManifest extends InterventionDraft { version: "intervention-comparison-v1"; id: string; inputDigest: string; changedAxes: InterventionAxis[]; deterministicSampling: false }
const axes: InterventionAxis[] = ["model", "effort", "skill", "prompt", "configuration"];
export function freezeIntervention(input: InterventionDraft): InterventionManifest {
  const d = clone(input);
  if (!closed(d, ["family", "investigationSha256", "resourceMetric", "axes", "common", "proposer", "judge", "cases", "arms"]) || d.family !== "intervention" || !SHA.test(d.investigationSha256)
    || !["usd", "wall_ms", "tool_calls"].includes(d.resourceMetric)
    || !Array.isArray(d.axes) || !d.axes.length || new Set(d.axes).size !== d.axes.length || d.axes.some(a => !axes.includes(a))
    || !closed(d.common, ["mode", "scenarioSha256", "rubricSha256", "fixtureSha256", "heldoutSha256", "harnessSha256", "judgePolicySha256"])
    || !["green", "force"].includes(d.common.mode) || Object.entries(d.common).some(([k, v]) => k !== "mode" && !SHA.test(v))
    || !text(d.proposer) || !text(d.judge) || !Array.isArray(d.arms) || d.arms.length < 2 || d.arms.length > 8
    || !Array.isArray(d.cases) || !d.cases.length || d.cases.length > 128) throw new Error("invalid intervention manifest");
  for (const arm of d.arms) if (!closed(arm, ["id", "configuration"]) || !text(arm.id, 128) || !closed(arm.configuration, axes)
    || !text(arm.configuration.model) || !text(arm.configuration.effort) || ["skill", "prompt", "configuration"].some(k => !SHA.test(arm.configuration[k as InterventionAxis]))) throw new Error("invalid intervention arm");
  if (new Set(d.arms.map(a => a.id)).size !== d.arms.length || new Set(d.cases.map(c => c.id)).size !== d.cases.length) throw new Error("duplicate intervention identity");
  for (const c of d.cases) if (!closed(c, ["id", "criteria", "reps", "threshold", "critical"]) || !text(c.id, 128)
    || !Number.isSafeInteger(c.criteria) || c.criteria < 1 || c.criteria > 128 || !Number.isSafeInteger(c.reps) || c.reps < 1 || c.reps > 20
    || !Number.isFinite(c.threshold) || c.threshold <= 0 || c.threshold > 1 || typeof c.critical !== "boolean"
    || ((c.critical || c.id.startsWith("B")) && c.threshold !== 1)) throw new Error("invalid frozen case policy");
  const changedAxes = axes.filter(axis => d.arms.some(a => a.configuration[axis] !== d.arms[0].configuration[axis]));
  if (changedAxes.some(axis => !d.axes.includes(axis))) throw new Error("undeclared intervention axis");
  const body = { ...d, version: "intervention-comparison-v1" as const, inputDigest: digest({ common: d.common, cases: d.cases }), changedAxes, deterministicSampling: false as const };
  return frozen({ ...body, id: digest(body) });
}
export interface InterventionCell { caseId: string; repetition: number; delivery: "PASS" | "NOT-MEASURED" | "ERROR"; objective: "PASS" | "FAIL" | "ERROR" | "NOT-MEASURED"; criteria: Array<"PASS" | "FAIL" | "UNKNOWN">; suspect: boolean; artifactSha256: string | null }
export interface InterventionEvidence { armId: string; inputDigest: string; artifactDigests: string[]; cells: InterventionCell[]; cost: number | null; costUnit: string }
export const interventionEvidenceDigest = (value: InterventionEvidence): string => digest(value);
export interface InterventionQualification {
  manifestId: string; proposer: { requested: string; canonical: string }; judge: { requested: string; canonical: string };
  subjects: Record<string, { requested: string; canonical: string }>; evidenceDigests: Record<string, string>;
  /** Actual independently retained output bytes, not an availability flag supplied by an arm. */
  artifacts: ReadonlyMap<string, Uint8Array>;
}
export interface InterventionAssessment {
  manifestId: string; complete: boolean; arms: Array<{ armId: string; state: "MEASURED" | "FAILED" | "MISSING" | "ERROR" | "NOT-MEASURED" | "UNRESOLVED"; eligible: boolean; artifactDigests: string[]; cost: number | null; costUnit: string }>;
  cheapestEligible: string | null; routingDefault: null; adoptionAuthorized: false;
}
const assessments = new WeakSet<object>();
const assessmentArtifacts = new WeakMap<object, ReadonlyMap<string, Buffer>>();
function manifestValid(m: InterventionManifest): void {
  const detached = clone(m);
  const { version, id: _id, inputDigest: _inputs, changedAxes: _axes, deterministicSampling, ...draft } = detached;
  if (version !== "intervention-comparison-v1" || deterministicSampling !== false || canonical(freezeIntervention(draft)) !== canonical(detached)) throw new Error("frozen intervention changed");
}
/** Pre-spend role gate: consumes independently resolved host facts, never guesses aliases or calls a provider. */
export function assertInterventionRoles(manifest: InterventionManifest, qualification: InterventionQualification | null): asserts qualification is InterventionQualification {
  manifestValid(manifest);
  if (!qualification || !qualification.proposer || !qualification.judge || !qualification.subjects || qualification.manifestId !== manifest.id || qualification.proposer.requested !== manifest.proposer || qualification.judge.requested !== manifest.judge
    || !text(qualification.proposer.canonical) || !text(qualification.judge.canonical)) throw new Error("independent role qualification required");
  const reserved = new Set([qualification.proposer.canonical, qualification.judge.canonical]);
  if (reserved.size !== 2 || manifest.arms.some(a => !Object.hasOwn(qualification.subjects, a.id) || qualification.subjects[a.id].requested !== a.configuration.model
    || !text(qualification.subjects[a.id].canonical) || reserved.has(qualification.subjects[a.id].canonical))) throw new Error("role identity conflict or unresolved role");
}
/** Inspects separately host-qualified evidence; does not obtain qualification or execute a model. */
export function assessIntervention(manifest: InterventionManifest, evidence: readonly InterventionEvidence[], qualification: InterventionQualification | null): InterventionAssessment {
  assertInterventionRoles(manifest, qualification);
  if (evidence.length > manifest.arms.length || new Set(evidence.map(e => e.armId)).size !== evidence.length || evidence.some(e => !manifest.arms.some(a => a.id === e.armId))) throw new Error("unexpected intervention evidence identity");
  const retained = new Map<string, Buffer>(); let retainedBytes = 0;
  const arms: InterventionAssessment["arms"] = manifest.arms.map(arm => {
    const e = evidence.find(e => e.armId === arm.id); let admitted = false;
    const result = (state: InterventionAssessment["arms"][number]["state"]) => ({ armId: arm.id, state, eligible: state === "MEASURED", artifactDigests: admitted ? [...e!.artifactDigests] : [], cost: admitted ? e!.cost : null, costUnit: admitted ? e!.costUnit : "unknown" });
    if (!e) return result("MISSING");
    if (qualification.evidenceDigests[arm.id] !== interventionEvidenceDigest(e) || !closed(e, ["armId", "inputDigest", "artifactDigests", "cells", "cost", "costUnit"])
      || e.inputDigest !== manifest.inputDigest || !Array.isArray(e.artifactDigests) || e.artifactDigests.length > 4096 || e.artifactDigests.some(h => !SHA.test(h))
      || !(e.cost === null || (Number.isFinite(e.cost) && e.cost >= 0)) || e.costUnit !== manifest.resourceMetric || !Array.isArray(e.cells)
      || new Set(e.artifactDigests).size !== e.artifactDigests.length || e.cells.length !== manifest.cases.reduce((n, c) => n + c.reps, 0)) return result("ERROR");
    admitted = true;
    const cells = new Map<string, InterventionCell>(); let error = false, unmeasured = false, unresolved = false, missingOutput = false;
    for (const c of e.cells) {
      const spec = manifest.cases.find(s => s.id === c.caseId), id = `${c.caseId}:${c.repetition}`;
      if (!closed(c, ["caseId", "repetition", "delivery", "objective", "criteria", "suspect", "artifactSha256"]) || !spec || !Number.isSafeInteger(c.repetition) || c.repetition < 0 || c.repetition >= spec.reps || cells.has(id)
        || !["PASS", "NOT-MEASURED", "ERROR"].includes(c.delivery) || !["PASS", "FAIL", "ERROR", "NOT-MEASURED"].includes(c.objective) || !Array.isArray(c.criteria) || typeof c.suspect !== "boolean") { error = true; continue; }
      cells.set(id, c);
      if (c.artifactSha256 !== null && (typeof c.artifactSha256 !== "string" || !SHA.test(c.artifactSha256) || !e.artifactDigests.includes(c.artifactSha256))) error = true;
      if (c.delivery === "PASS" && c.objective === "PASS" && c.artifactSha256 === null) missingOutput = true;
      if (c.delivery !== "PASS" || c.objective !== "PASS") {
        if (c.criteria.length) error = true;
        if (c.delivery === "NOT-MEASURED") unmeasured = true;
        if (c.delivery === "ERROR" || c.objective === "ERROR" || (c.objective === "NOT-MEASURED" && c.delivery !== "NOT-MEASURED")) error = true;
      } else if (c.criteria.length !== spec.criteria || c.criteria.some(v => !["PASS", "FAIL", "UNKNOWN"].includes(v))) error = true;
      else if (c.suspect || c.criteria.includes("UNKNOWN")) unresolved = true;
    }
    if (error) return result("ERROR"); if (unmeasured) return result("NOT-MEASURED"); if (unresolved) return result("UNRESOLVED"); if (missingOutput) return result("MISSING");
    const passed = manifest.cases.every(spec => Array.from(cells.values()).filter(c => c.caseId === spec.id && c.objective === "PASS" && c.criteria.every(v => v === "PASS")).length / spec.reps >= spec.threshold);
    if (!passed) return result("FAILED");
    if (!e.artifactDigests.length) return result("MISSING");
    for (const hash of e.artifactDigests) {
      const bytes = qualification.artifacts?.get(hash);
      if (bytes === undefined) return result("MISSING");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 8 * 1024 * 1024) return result("ERROR");
      const stable = Buffer.from(bytes);
      if (createHash("sha256").update(stable).digest("hex") !== hash) return result("ERROR");
      if (!retained.has(hash)) {
        if (retainedBytes + bytes.byteLength > 64 * 1024 * 1024) return result("ERROR");
        retained.set(hash, stable); retainedBytes += stable.byteLength;
      }
    }
    return result("MEASURED");
  });
  const eligible = arms.filter(a => a.eligible), knownCosts = eligible.length && eligible.every(a => a.cost !== null && a.costUnit === eligible[0].costUnit);
  const cheapestEligible = knownCosts ? [...eligible].sort((a, b) => a.cost! - b.cost! || (a.armId < b.armId ? -1 : 1))[0].armId : null;
  const result: InterventionAssessment = frozen({ manifestId: manifest.id, complete: arms.every(a => a.state === "MEASURED" || a.state === "FAILED"), arms, cheapestEligible, routingDefault: null, adoptionAuthorized: false });
  assessments.add(result); assessmentArtifacts.set(result, retained); return result;
}
export type BlindQualityChoice = { kind: "one" | "tie" | "none" | "insufficient"; labels: string[] };
/** Only this view omits identity/cost; arbitrary artifact content can still leak clues and must be reviewed. */
export function createBlindComparison(manifest: InterventionManifest, assessment: InterventionAssessment, fixtureOrPersistedSeed?: string) {
  manifestValid(manifest);
  if (!assessments.has(assessment) || assessment.manifestId !== manifest.id || !assessment.complete) throw new Error("complete recomputed intervention assessment required");
  const seed = fixtureOrPersistedSeed ?? randomBytes(32).toString("hex");
  if (!SHA.test(seed)) throw new Error("invalid private blinding seed");
  const assessmentId = digest(assessment);
  const eligible = assessment.arms.filter(a => a.eligible).sort((a, b) => {
    const left = digest([seed, manifest.id, assessmentId, a.armId]), right = digest([seed, manifest.id, assessmentId, b.armId]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const mapping = new Map(eligible.map((a, i) => [`variant-${digest([seed, manifest.id, assessmentId, i]).slice(0, 16)}`, a.armId]));
  if (mapping.size !== eligible.length) throw new Error("opaque label collision");
  const cards = [...mapping].map(([label, armId]) => ({ label, artifactDigests: assessment.arms.find(a => a.armId === armId)!.artifactDigests }));
  let choice: BlindQualityChoice | null = null, revealed = false;
  return Object.freeze({
    view: () => frozen({ version: "blind-intervention-view-v1", cards, limitations: ["artifact-content-may-disclose-identity"] }),
    readArtifact(label: string, hash: string) {
      const armId = mapping.get(label), arm = assessment.arms.find(a => a.armId === armId);
      if (!arm || !arm.artifactDigests.includes(hash)) throw new Error("artifact outside blind view");
      const bytes = assessmentArtifacts.get(assessment)?.get(hash);
      if (!bytes) throw new Error("retained blind artifact missing");
      return Buffer.from(bytes);
    },
    choose(input: BlindQualityChoice) {
      const value = clone(input);
      if (!closed(value, ["kind", "labels"]) || !["one", "tie", "none", "insufficient"].includes(value.kind) || !Array.isArray(value.labels)
        || new Set(value.labels).size !== value.labels.length || value.labels.some(l => !mapping.has(l))
        || (value.kind === "one" ? value.labels.length !== 1 : value.kind === "tie" ? value.labels.length < 2 : value.labels.length !== 0)) throw new Error("invalid blind quality choice");
      value.labels.sort();
      if (revealed && canonical(choice) !== canonical(value)) throw new Error("quality choice locked after reveal");
      choice = frozen(value); return choice;
    },
    reveal() {
      if (!choice) throw new Error("quality choice required before reveal"); revealed = true;
      return frozen({ manifestId: manifest.id, choice, arms: [...mapping].map(([label, armId]) => ({ label, armId, configuration: manifest.arms.find(a => a.id === armId)!.configuration,
        cost: assessment.arms.find(a => a.armId === armId)!.cost, costUnit: assessment.arms.find(a => a.armId === armId)!.costUnit })), routingDefault: null });
    },
  });
}
