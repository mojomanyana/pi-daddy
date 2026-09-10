import { isExecutionId } from "./execution-id.ts";
import { canonicalWorkJson, workDigest, type WorkJson } from "./work-ledger-json.ts";
import { WorkInputError, type WorkLedgerEvent } from "./work-ledger-types.ts";

type ObjectValue = { [key: string]: WorkJson };
const kinds = ["scope", "goal", "node", "obligation", "artifact", "policy"];
const fail = (): never => { throw new WorkInputError("WORK_SCHEMA_INVALID"); };
function require(value: boolean): asserts value { if (!value) fail(); }
export function workObject(value: WorkJson): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  return value;
}
function closed(value: WorkJson, keys: string[]): ObjectValue {
  const object = workObject(value);
  require(Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key)));
  return object;
}
function id(value: WorkJson): void { require(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,127}$/.test(value)); }
function digest(value: WorkJson): void { require(typeof value === "string" && /^[0-9a-f]{64}$/.test(value)); }
function integer(value: WorkJson): void { require(typeof value === "number" && Number.isSafeInteger(value) && value >= 1); }
function member(value: WorkJson, values: string[]): void { require(typeof value === "string" && values.includes(value)); }
function nullable(value: WorkJson, validate: (value: WorkJson) => void): void { if (value !== null) validate(value); }
function reference(value: WorkJson, allowed = kinds): void {
  const ref = closed(value, ["kind", "id", "revision", "digest"]);
  member(ref.kind, allowed); id(ref.id); integer(ref.revision); digest(ref.digest);
}
function identity(value: WorkJson): void {
  const ref = closed(value, ["id", "digest"]); id(ref.id); digest(ref.digest);
}
function eventRef(value: WorkJson): void {
  const ref = closed(value, ["eventId", "digest"]); id(ref.eventId); digest(ref.digest);
}
/** Internal validation for the exact out-of-band selectedSnapshot shape; no authority is constructed. */
export function validateWorkSelection(value: WorkJson): void {
  if (value === null) return;
  const selected = closed(value, ["snapshot", "event"]);
  identity(selected.snapshot); eventRef(selected.event);
}

function timestamp(value: WorkJson): void {
  require(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));
  require(!value.startsWith("0000") && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}

/** Builder sorts detached copies; reader refuses noncanonical sets instead of repairing them. */
function set(value: WorkJson, validate: (item: WorkJson) => void, building: boolean,
  key: (item: WorkJson) => string = canonicalWorkJson): void {
  require(Array.isArray(value));
  value.forEach(validate);
  const keyed = value.map(item => ({ item, key: key(item) }));
  const sorted = [...keyed].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (let i = 1; i < sorted.length; i++) require(sorted[i - 1].key !== sorted[i].key);
  if (building) value.splice(0, value.length, ...sorted.map(entry => entry.item));
  else require(keyed.every((entry, i) => entry.key === sorted[i].key));
}
function ownKeys(keys: string[], building: boolean): string[] { return building ? keys : [...keys, "digest"]; }

function revision(value: WorkJson, building: boolean): void {
  const r = closed(value, ownKeys(["kind", "id", "revision", "scopeId", "predecessor", "contentDigest",
    "parent", "dependencies", "ownerId", "permittedEffects", "policy"], building));
  member(r.kind, kinds); id(r.id); integer(r.revision); id(r.scopeId); id(r.ownerId); digest(r.contentDigest);
  nullable(r.predecessor, v => reference(v));
  nullable(r.parent, v => reference(v));
  nullable(r.policy, v => reference(v, ["policy"]));
  set(r.dependencies, v => reference(v, ["obligation"]), building);
  set(r.permittedEffects, id, building, v => v as string);
  if (r.revision === 1) require(r.predecessor === null);
  else {
    require(r.predecessor !== null);
    const predecessor = workObject(r.predecessor);
    require(predecessor.kind === r.kind && predecessor.id === r.id &&
      (predecessor.revision as number) === (r.revision as number) - 1);
  }
  const noDependencies = (r.dependencies as WorkJson[]).length === 0;
  if (r.kind === "scope") require(r.scopeId === r.id && r.parent === null && noDependencies && r.policy === null);
  if (r.kind === "artifact" || r.kind === "policy") {
    require(r.parent === null && noDependencies && r.policy === null && (r.permittedEffects as WorkJson[]).length === 0);
  }
  if (r.kind === "goal" || r.kind === "node" || r.kind === "obligation") {
    reference(r.parent, r.kind === "goal" ? ["scope", "goal"] : ["goal", "node"]);
    if (r.kind === "obligation") reference(r.policy, ["policy"]);
    else require(noDependencies && r.policy === null);
  }
  if (!building) digest(r.digest);
}
function obligationBinding(value: WorkJson): void {
  const b = closed(value, ["intent", "obligation", "artifact", "policy"]);
  reference(b.intent, ["goal", "node"]); reference(b.obligation, ["obligation"]);
  nullable(b.artifact, v => reference(v, ["artifact"])); reference(b.policy, ["policy"]);
}
function snapshot(value: WorkJson, building: boolean): void {
  const s = closed(value, ownKeys(["snapshotId", "scope", "revisions", "bindings"], building));
  id(s.snapshotId); reference(s.scope, ["scope"]);
  set(s.revisions, v => reference(v, kinds.filter(k => k !== "scope")), building);
  set(s.bindings, obligationBinding, building, v => canonicalWorkJson(workObject(v).obligation));
  if (!building) digest(s.digest);
  // Inventory/ancestor/predecessor resolution requires the complete event snapshot, not a guessed head.
}
function occurrence(value: WorkJson): void {
  const p = closed(value, ["scope", "obligation", "executionId", "parentExecutionId", "childId", "variantId",
    "artifact", "provenance", "state", "labels"]);
  reference(p.scope, ["scope"]); reference(p.obligation, ["obligation"]);
  require(isExecutionId(p.executionId));
  require(p.parentExecutionId === null || isExecutionId(p.parentExecutionId));
  require(p.executionId !== p.parentExecutionId);
  nullable(p.childId, id); nullable(p.variantId, id); nullable(p.artifact, v => reference(v, ["artifact"]));
  member(p.provenance, ["declared", "observed"]);
  member(p.state, ["unknown", "starting", "running", "completed", "failed"]);
  const labels = closed(p.labels, ["sessionId", "branchLeafId", "toolCallId", "taskId", "workspaceId",
    "definitionDigest", "configurationDigest", "modelId", "effortId"]);
  for (const [key, value] of Object.entries(labels)) nullable(value, key.endsWith("Digest") ? digest : id);
}
function evidence(value: WorkJson): void {
  const e = closed(value, ["id", "digest", "event"]);
  id(e.id); digest(e.digest); nullable(e.event, eventRef);
}
function acceptance(value: WorkJson, building: boolean): void {
  const p = closed(value, ["authorityId", "binding"]); id(p.authorityId);
  acceptanceBinding(p.binding, building);
}
function acceptanceBinding(value: WorkJson, building: boolean): void {
  const b = closed(value, ["snapshot", "scope", "intent", "obligation", "artifact", "artifactDigest", "policy", "evidence"]);
  identity(b.snapshot); reference(b.scope, ["scope"]); reference(b.intent, ["goal", "node"]);
  reference(b.obligation, ["obligation"]); reference(b.artifact, ["artifact"]);
  digest(b.artifactDigest); reference(b.policy, ["policy"]);
  set(b.evidence, evidence, building); require((b.evidence as WorkJson[]).length > 0);
}

/** Validate a detached host context. Receipt/availability order and duplicate deliveries have no priority. */
export function validateWorkContext(value: WorkJson): void {
  const c = closed(value, ["selectedSnapshot", "authority"]);
  validateWorkSelection(c.selectedSnapshot);
  if (c.authority === null) return;
  const a = closed(c.authority, ["snapshot", "decisions", "availability"]);
  identity(a.snapshot);
  require(Array.isArray(a.decisions)); require(Array.isArray(a.availability));
  for (const value of a.decisions) {
    const d = closed(value, ["receiptId", "authorityId", "claim", "binding", "decision"]);
    id(d.receiptId); id(d.authorityId); eventRef(d.claim); acceptanceBinding(d.binding, false);
    member(d.decision, ["accept", "reject"]);
  }
  for (const value of a.availability) {
    const row = closed(value, ["kind", "id", "digest", "available"]);
    member(row.kind, ["artifact", "evidence"]); id(row.id); digest(row.digest);
    require(typeof row.available === "boolean");
  }
}

function ownDigest(object: ObjectValue, building: boolean): void {
  const { digest: supplied, ...body } = object;
  const computed = workDigest(body);
  if (building) object.digest = computed;
  else if (supplied !== computed) throw new WorkInputError("WORK_DIGEST_MISMATCH");
}

/** All closed shapes/domain checks finish before any own digest is computed or verified. */
export function validateWorkEvent(value: WorkJson, building = false): WorkLedgerEvent {
  const e = workObject(value);
  if (e.ledgerVersion !== 4) throw new WorkInputError("WORK_VERSION_UNSUPPORTED");
  closed(e, ownKeys(["ledgerVersion", "event", "eventId", "ts", "payload"], building));
  member(e.event, ["work_revision", "work_snapshot", "work_occurrence", "work_acceptance"]);
  id(e.eventId); timestamp(e.ts);
  let nested: ObjectValue | undefined;
  if (e.event === "work_revision") {
    nested = workObject(closed(e.payload, ["revision"]).revision); revision(nested, building);
  } else if (e.event === "work_snapshot") {
    nested = workObject(closed(e.payload, ["snapshot"]).snapshot); snapshot(nested, building);
  } else if (e.event === "work_occurrence") occurrence(e.payload);
  else acceptance(e.payload, building);
  if (!building) digest(e.digest);
  if (nested) ownDigest(nested, building);
  ownDigest(e, building);
  return e as unknown as WorkLedgerEvent;
}
