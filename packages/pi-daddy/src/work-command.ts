import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  appendWorkLedgerEventOnce,
  buildWorkOccurrenceEvent,
  buildWorkRevisionEvent,
  buildWorkSnapshotEvent,
  parseWorkLedgerText,
  projectWorkLedger,
  type EventRef,
  type RevisionRef,
  type WorkFrozen,
  type WorkOccurrencePayload,
  type WorkProjectionContext,
  type WorkRevision,
} from "./work-ledger.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const eventRef = (event: { eventId: string; digest: string }): EventRef => ({ eventId: event.eventId, digest: event.digest });
const revisionRef = (event: { payload: { revision: { kind: WorkRevision["kind"]; id: string; revision: number; digest: string } } }): RevisionRef => {
  const { kind, id, revision, digest } = event.payload.revision;
  return { kind, id, revision, digest };
};

export interface DeclaredWorkState {
  readonly version: "pi-daddy-declared-work-v1";
  readonly id: string;
  readonly outcomeDigest: string;
  readonly ledgerPath: string;
  readonly statePath: string;
  readonly grantLedgerPath: string | null;
  readonly selectedSnapshot: NonNullable<WorkProjectionContext["selectedSnapshot"]>;
  readonly scope: RevisionRef;
  readonly intent: RevisionRef;
  readonly obligation: RevisionRef;
  readonly policy: RevisionRef;
}

interface StoredDeclaredWorkState extends Omit<DeclaredWorkState, "statePath"> {}

export interface DeclareWorkInput {
  cwd: string;
  id: string;
  outcome: string;
  ledgerPath?: string;
  statePath?: string;
  grantLedgerPath?: string | null;
}

function paths(input: DeclareWorkInput): { ledgerPath: string; statePath: string; grantLedgerPath: string | null } {
  const root = resolve(input.cwd);
  return {
    ledgerPath: resolve(root, input.ledgerPath ?? join(".pi", "work.jsonl")),
    statePath: resolve(root, input.statePath ?? join(".pi", "work-current.json")),
    grantLedgerPath: input.grantLedgerPath === undefined ? null : input.grantLedgerPath === null ? null : resolve(root, input.grantLedgerPath),
  };
}

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
};
const validRef = (value: unknown, kind: WorkRevision["kind"]): value is RevisionRef => {
  if (!value || typeof value !== "object" || !exactKeys(value, ["kind", "id", "revision", "digest"])) return false;
  const ref = value as RevisionRef;
  return ref.kind === kind && ID.test(ref.id) && Number.isSafeInteger(ref.revision) && ref.revision > 0 && DIGEST.test(ref.digest);
};

export async function loadDeclaredWork(statePath: string): Promise<WorkFrozen<DeclaredWorkState> | null> {
  let text: string;
  try { text = await readFile(statePath, "utf8"); }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
  try {
    const value = JSON.parse(text) as StoredDeclaredWorkState;
    if (!value || typeof value !== "object" || !exactKeys(value, [
      "version", "id", "outcomeDigest", "ledgerPath", "grantLedgerPath", "selectedSnapshot", "scope", "intent", "obligation", "policy",
    ]) || value.version !== "pi-daddy-declared-work-v1" || !ID.test(value.id) || !DIGEST.test(value.outcomeDigest) ||
      typeof value.ledgerPath !== "string" || !isAbsolute(value.ledgerPath) ||
      (value.grantLedgerPath !== null && (typeof value.grantLedgerPath !== "string" || !isAbsolute(value.grantLedgerPath))) ||
      !validRef(value.scope, "scope") || !validRef(value.intent, "goal") || !validRef(value.obligation, "obligation") || !validRef(value.policy, "policy") ||
      !value.selectedSnapshot || typeof value.selectedSnapshot !== "object" ||
      !exactKeys(value.selectedSnapshot, ["snapshot", "event"]) ||
      !exactKeys(value.selectedSnapshot.snapshot, ["id", "digest"]) || !ID.test(value.selectedSnapshot.snapshot.id) || !DIGEST.test(value.selectedSnapshot.snapshot.digest) ||
      !exactKeys(value.selectedSnapshot.event, ["eventId", "digest"]) || !ID.test(value.selectedSnapshot.event.eventId) || !DIGEST.test(value.selectedSnapshot.event.digest)) {
      throw new Error("shape");
    }
    const expectedLedger = resolve(dirname(statePath), "work.jsonl");
    if (resolve(value.ledgerPath) !== expectedLedger) throw new Error("relocated");
    const ledger = await readFile(value.ledgerPath, "utf8");
    const ingestion = parseWorkLedgerText(ledger);
    const projection = projectWorkLedger(ledger, { selectedSnapshot: value.selectedSnapshot, authority: null });
    const obligation = projection.obligations.find(item => item.binding.obligation.digest === value.obligation.digest);
    if (!ingestion.complete || projection.scopeState !== "valid" || !obligation || projection.selectedSnapshot?.digest !== value.selectedSnapshot.snapshot.digest) throw new Error("unbound");
    return Object.freeze({ ...value, statePath: resolve(statePath) });
  } catch {
    throw new Error("invalid declared work state; no task was selected");
  }
}

export async function declareWork(input: DeclareWorkInput): Promise<WorkFrozen<DeclaredWorkState>> {
  if (!input || typeof input !== "object" || !ID.test(input.id) || typeof input.outcome !== "string" || !input.outcome.trim()) {
    throw new TypeError("work declaration requires an identifier and non-empty outcome");
  }
  const resolved = paths(input), outcomeDigest = sha256(input.outcome.trim());
  const existing = await loadDeclaredWork(resolved.statePath);
  if (existing) {
    if (existing.id === input.id && existing.outcomeDigest === outcomeDigest) return existing;
    throw new Error(`declared work id ${input.id} already names a different outcome`);
  }
  await mkdir(dirname(resolved.ledgerPath), { recursive: true });
  await mkdir(dirname(resolved.statePath), { recursive: true });
  const now = new Date();
  const revision = (kind: WorkRevision["kind"], name: string, patch: Partial<Omit<WorkRevision, "digest">> = {}) =>
    buildWorkRevisionEvent({ eventId: `work:${input.id}:${name}:1`, now, revision: {
      kind, id: `work:${input.id}:${name}`, revision: 1, scopeId: `work:${input.id}:scope`, predecessor: null,
      contentDigest: sha256(`${name}\0${outcomeDigest}`), parent: null, dependencies: [], ownerId: "local-operator",
      permittedEffects: [], policy: null, ...patch,
    } });
  const scope = revision("scope", "scope");
  const policy = revision("policy", "policy");
  const intent = revision("goal", "goal", { parent: revisionRef(scope) });
  const obligation = revision("obligation", "obligation", { parent: revisionRef(intent), policy: revisionRef(policy) });
  const binding = { intent: revisionRef(intent), obligation: revisionRef(obligation), artifact: null, policy: revisionRef(policy) };
  const snapshot = buildWorkSnapshotEvent({ eventId: `work:${input.id}:snapshot:1`, now, snapshot: {
    snapshotId: `work:${input.id}:selected`, scope: revisionRef(scope), revisions: [revisionRef(policy), revisionRef(intent), revisionRef(obligation)], bindings: [binding],
  } });
  for (const event of [scope, policy, intent, obligation, snapshot]) {
    await appendWorkLedgerEventOnce({ path: resolved.ledgerPath, grantLedgerPath: resolved.grantLedgerPath }, event);
  }
  const stored: StoredDeclaredWorkState = {
    version: "pi-daddy-declared-work-v1", id: input.id, outcomeDigest, ledgerPath: resolved.ledgerPath,
    grantLedgerPath: resolved.grantLedgerPath,
    selectedSnapshot: { snapshot: { id: snapshot.payload.snapshot.snapshotId, digest: snapshot.payload.snapshot.digest }, event: eventRef(snapshot) },
    scope: revisionRef(scope), intent: revisionRef(intent), obligation: revisionRef(obligation), policy: revisionRef(policy),
  };
  const temporary = `${resolved.statePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, resolved.statePath);
  return Object.freeze({ ...stored, statePath: resolved.statePath });
}

export type DeclaredOccurrenceIdentity = Pick<WorkOccurrencePayload["labels"], "toolCallId" | "taskId" | "workspaceId" | "definitionDigest" | "configurationDigest" | "modelId" | "effortId"> & {
  executionId: string;
  parentExecutionId: string | null;
  childId: string | null;
  variantId: string | null;
  now: Date;
};

export async function appendDeclaredWorkOccurrence(state: WorkFrozen<DeclaredWorkState>, identity: DeclaredOccurrenceIdentity,
  occurrenceState: WorkOccurrencePayload["state"]): Promise<void> {
  const { executionId, parentExecutionId, childId, variantId, now, ...rawLabels } = identity;
  const label = (name: string, value: string | null): string | null => value === null ? null : ID.test(value) ? value : `${name}:${sha256(value)}`;
  const labels = {
    toolCallId: label("toolcall", rawLabels.toolCallId), taskId: label("task", rawLabels.taskId),
    workspaceId: label("workspace", rawLabels.workspaceId), definitionDigest: rawLabels.definitionDigest,
    configurationDigest: rawLabels.configurationDigest, modelId: label("model", rawLabels.modelId), effortId: label("effort", rawLabels.effortId),
  };
  const event = buildWorkOccurrenceEvent({
    eventId: `work:${state.id}:attempt:${identity.executionId}:${occurrenceState}`,
    now,
    payload: {
      scope: state.scope, obligation: state.obligation, executionId,
      parentExecutionId, childId, variantId: label("variant", variantId), artifact: null,
      provenance: "observed", state: occurrenceState,
      labels: { sessionId: null, branchLeafId: null, ...labels },
    },
  });
  await appendWorkLedgerEventOnce({ path: state.ledgerPath, grantLedgerPath: state.grantLedgerPath }, event);
}
