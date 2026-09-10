#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildWorkRevisionEvent, buildWorkSnapshotEvent, buildWorkOccurrenceEvent, buildWorkAcceptanceEvent,
  type RevisionRef, type WorkRevision, type WorkRevisionEvent, type WorkFrozen,
} from "../src/work-ledger.ts";

/** Pure, deterministic wire examples. No authority context, input claims, loader or I/O. The four
 * standalone objects illustrate shapes, not a complete graph or an authenticated acceptance. */
export function buildLedgerV4ContractFixtures() {
  const now = new Date("2026-09-06T12:00:00.000Z"), digest = "a".repeat(64);
  const ref = (kind: RevisionRef["kind"]): RevisionRef => ({ kind, id: kind, revision: 1, digest });
  const revision = buildWorkRevisionEvent({ eventId: "revision", now, revision: {
    kind: "scope", id: "scope", scopeId: "scope", revision: 1, predecessor: null,
    contentDigest: digest, parent: null, dependencies: [], ownerId: "owner", permittedEffects: ["write", "read"], policy: null,
  } });
  const scope = { ...ref("scope"), digest: revision.payload.revision.digest };
  const binding = { intent: ref("goal"), obligation: ref("obligation"), artifact: ref("artifact"), policy: ref("policy") };
  const snapshot = buildWorkSnapshotEvent({ eventId: "snapshot", now, snapshot: {
    snapshotId: "snapshot", scope, revisions: [ref("goal"), ref("obligation"), ref("artifact"), ref("policy")], bindings: [binding],
  } });
  const occurrence = buildWorkOccurrenceEvent({ eventId: "occurrence", now, payload: {
    scope, obligation: ref("obligation"), executionId: "exec:00000000-0000-4000-8000-000000000001",
    parentExecutionId: null, childId: null, variantId: null, artifact: ref("artifact"), provenance: "observed", state: "completed",
    labels: { sessionId: null, branchLeafId: null, toolCallId: null, taskId: null, workspaceId: null,
      definitionDigest: null, configurationDigest: null, modelId: null, effortId: null },
  } });
  const acceptance = buildWorkAcceptanceEvent({ eventId: "acceptance", now, payload: {
    authorityId: "authority", binding: { ...binding, scope,
      snapshot: { id: "snapshot", digest: snapshot.payload.snapshot.digest }, artifactDigest: digest,
      evidence: [{ id: "evidence", digest, event: { eventId: occurrence.eventId, digest: occurrence.digest } }],
    },
  } });
  return { "work-revision.json": revision, "work-snapshot.json": snapshot,
    "work-occurrence.json": occurrence, "work-acceptance.json": acceptance };
}

/** Complete generic layout evidence, not a trusted controller or three model launches.
 * The returned ARRAY contains individual production-builder events; explicitly serialize each to JSONL.
 * Positive authority/availability exists only in the independently declared test fixture controller. */
export function buildLayoutOptionsFixture() {
  const now = new Date("2026-09-06T12:00:00.000Z"), digest = "a".repeat(64);
  const ref = (event: WorkFrozen<WorkRevisionEvent>): RevisionRef => {
    const { kind, id, revision, digest } = event.payload.revision; return { kind, id, revision, digest };
  };
  const revision = (kind: WorkRevision["kind"], id: string, patch: Partial<Omit<WorkRevision, "digest">> = {}) =>
    buildWorkRevisionEvent({ eventId: `${id}:1`, now, revision: {
      kind, id, scopeId: "layout", revision: 1, predecessor: null, contentDigest: digest,
      parent: null, dependencies: [], ownerId: "layout-owner", permittedEffects: [], policy: null, ...patch,
    } });
  const scope = revision("scope", "layout"), policy = revision("policy", "layout-policy"), artifact = revision("artifact", "layout-image");
  const goal = revision("goal", "layout-goal", { parent: ref(scope) });
  const intent = revision("node", "layout-options", { parent: ref(goal) });
  const obligation = revision("obligation", "layout-choice", { parent: ref(intent), policy: ref(policy) });
  const revisions = [scope, policy, artifact, goal, intent, obligation];
  const binding = { intent: ref(intent), obligation: ref(obligation), artifact: ref(artifact), policy: ref(policy) };
  const snapshot = buildWorkSnapshotEvent({ eventId: "layout:snapshot", now, snapshot: {
    snapshotId: "layout-selected", scope: ref(scope), revisions: revisions.slice(1).map(ref), bindings: [binding],
  } });
  const occurrences = ["a", "b", "c"].map((variant, i) => buildWorkOccurrenceEvent({ eventId: `layout:observation:${variant}`, now, payload: {
    scope: ref(scope), obligation: binding.obligation,
    executionId: i === 2 ? "exec:00000000-0000-4000-8000-000000000022" : "exec:00000000-0000-4000-8000-000000000021",
    parentExecutionId: null, childId: "layout-designer", variantId: `layout:${variant}`, artifact: binding.artifact,
    provenance: "observed", state: "completed", labels: { sessionId: i === 2 ? "layout-session:b" : "layout-session:a",
      branchLeafId: i === 2 ? "layout-leaf:b" : "layout-leaf:a", toolCallId: null, taskId: null, workspaceId: null,
      definitionDigest: null, configurationDigest: null, modelId: null, effortId: null },
  } }));
  const claim = buildWorkAcceptanceEvent({ eventId: "layout:claim", now, payload: { authorityId: "layout-controller", binding: {
    ...binding, scope: ref(scope), snapshot: { id: snapshot.payload.snapshot.snapshotId, digest: snapshot.payload.snapshot.digest }, artifactDigest: digest,
    evidence: [{ id: "layout-proof", digest: "d".repeat(64), event: { eventId: occurrences[0].eventId, digest: occurrences[0].digest } }],
  } } });
  return Object.freeze([...revisions, snapshot, ...occurrences, claim]);
}

function explicitPath(value: string): void {
  if (typeof value !== "string" || !value || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError("an explicit target/source absolute path is required");
  }
}

/** Caller selects the fixture directory. There is deliberately no repository/cwd default. */
export async function writeLedgerV4ContractFixtures(target: string): Promise<void> {
  explicitPath(target);
  const fixtures = { ...buildLedgerV4ContractFixtures(), "layout-options.json": buildLayoutOptionsFixture() };
  await mkdir(target, { recursive: true });
  for (const [name, event] of Object.entries(fixtures)) {
    await writeFile(join(target, name), JSON.stringify(event, null, 2) + "\n", "utf8");
  }
}

/** Copy the hand-authored schema verbatim and emit builder fixtures into an explicit contract root.
 * An optional explicit schema source supports initial authoring/staging; it is never authority input.
 * No schema is derived from permissive runtime serialization, and no v2/v3 generator is invoked. */
export async function generateLedgerV4Contract(target: string,
  schemaSource = fileURLToPath(new URL("../contracts/ledger/v4/ledger-event.schema.json", import.meta.url))): Promise<void> {
  explicitPath(target); explicitPath(schemaSource);
  const schema = await readFile(schemaSource); // Read before creating any output; preserve authored bytes.
  await mkdir(target, { recursive: true });
  if (resolve(schemaSource) !== resolve(target, "ledger-event.schema.json")) {
    await writeFile(join(target, "ledger-event.schema.json"), schema);
  }
  await writeLedgerV4ContractFixtures(join(target, "fixtures"));
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || args.some(arg => !arg || arg.startsWith("-"))) {
    throw new TypeError("explicit target directory required: generate-ledger-v4-contract.ts TARGET [SCHEMA_SOURCE]");
  }
  await generateLedgerV4Contract(resolve(args[0]), args[1] === undefined ? undefined : resolve(args[1]));
}
