import { createRequire } from "node:module";
import { Compile } from "typebox/compile";
import type { CorrelationMetadata } from "./correlation.ts";
import {
  isLedgerObject as object,
  isNonEmptyString as nonEmpty,
  isStringArray as strings,
  isTimestamp as timestamp,
  validateLedgerV3Event as validateV3,
  type LedgerV3Object as ObjectRecord,
} from "./ledger-v3-validation.ts";
import { isLedgerCapabilityIdentifier, isLedgerDisplayIdentifier } from "./ledger-identifiers.ts";

export type DashboardState =
  | "authorised"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "refused"
  | "incomplete"
  | "historical";

export interface DashboardRuntimeIdentity {
  herdrPaneId?: string;
  herdrAgentName?: string;
}

export interface DashboardNode {
  executionId: string;
  parentExecutionId: string | null;
  logicalParentId?: string;
  logicalChildId: string;
  depth: number;
  agentName: string;
  state: DashboardState;
  provenance: "pi-daddy-enforced" | "historical-unjoinable";
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
  durationMs: number;
  effectiveGrant: string[];
  denied: string[];
  executor?: "process" | "herdr";
  workspace?: { id: string; access: "read" | "write"; root: string };
  runtime?: DashboardRuntimeIdentity;
  correlation?: CorrelationMetadata;
  refusal?: { code?: string; message?: string };
}

export interface DashboardWorkflowFact {
  factId: string;
  source: string;
  provenance: "planned" | "observed" | "controller-validated";
  kind: "workflow_phase" | "inline_skill" | "transition";
  subject: string;
  state: "pending" | "observed" | "started" | "completed" | "blocked";
  runId: string;
  correlation: CorrelationMetadata;
}

export interface DashboardWorkflow {
  runId: string;
  label: string;
  assurance?: string;
  phases: string[];
  /** Correlation is supplied by a caller. It is a label, never controller validation or enforcement. */
  provenance: "caller-declared";
}

export interface DashboardCorruptLine {
  line: number;
  /** Raw corrupt content is deliberately excluded: it may contain forbidden task/output text. */
  reason: string;
}

export interface DashboardProjection {
  nodes: DashboardNode[];
  workflows: DashboardWorkflow[];
  workflowFacts: DashboardWorkflowFact[];
  corrupt: DashboardCorruptLine[];
  orphanEvents: number;
  active: number;
  maxDepth: number;
}

export interface DashboardProjectionOptions {
  now?: Date;
  /** A decision with no start is briefly authorised, then incomplete. */
  startGraceMs?: number;
}

const START_GRACE_MS = 5_000;
const EXECUTORS = new Set(["process", "herdr"]);
// The artifact is frozen, so projection can validate the exact published v2 contract rather than grow a
// second partial reader. `createRequire` resolves from both src/ in tests and dist/ in the installed package.
const LEDGER_V2 = Compile(createRequire(import.meta.url)("../contracts/ledger/v2/ledger-event.schema.json"));
const TERMINAL_STATES = new Set(["completed", "failed"]);

interface Occurrence {
  executionId: string;
  parentExecutionId: string | null;
  childId: string;
  firstLine: number;
  firstTs: string;
  lastTs: string;
  decision?: ObjectRecord;
  lifecycle: ObjectRecord[];
  leases: ObjectRecord[];
}

const DISPLAYED_CORRELATION_FIELDS = [
  "run_id", "task_id", "phase", "assurance", "assurance_effective", "policy_label",
] as const satisfies ReadonlyArray<keyof CorrelationMetadata>;

function correlationOf(value: unknown): CorrelationMetadata | undefined {
  if (!object(value)) return undefined;
  return DISPLAYED_CORRELATION_FIELDS.every(
    (field) => value[field] === undefined || isLedgerDisplayIdentifier(value[field]),
  ) ? value as CorrelationMetadata : undefined;
}

function legacyNode(event: ObjectRecord, line: number, now: Date): DashboardNode | null {
  if (event.event !== undefined && event.event !== "capability_decision") return null;
  if (!strings(event.denied)) return null;
  const ts = timestamp(event.ts) ? event.ts : now.toISOString();
  return {
    executionId: `legacy-line:${line}`,
    parentExecutionId: null,
    logicalParentId: nonEmpty(event.parentId) ? event.parentId : undefined,
    logicalChildId: nonEmpty(event.childId) ? event.childId : `legacy:${line}`,
    depth: Number.isInteger(event.depth) ? event.depth as number : 0,
    agentName: isLedgerDisplayIdentifier(event.agentType) ? event.agentType : "historical-delegation",
    state: event.blocked === true ? "refused" : "historical",
    provenance: "historical-unjoinable",
    startedAt: ts,
    updatedAt: ts,
    durationMs: 0,
    effectiveGrant: strings(event.effective) ? event.effective.filter(isLedgerCapabilityIdentifier) : [],
    denied: event.denied.filter(isLedgerCapabilityIdentifier),
    executor: EXECUTORS.has(String(event.executor)) ? event.executor as "process" | "herdr" : undefined,
    correlation: correlationOf(event.correlation),
    refusal: object(event.refusal) ? event.refusal as DashboardNode["refusal"] : undefined,
  };
}

function stateOf(occurrence: Occurrence, nowMs: number, graceMs: number): DashboardState {
  if (occurrence.decision?.blocked === true) return "refused";
  const latest = occurrence.lifecycle.at(-1);
  if (latest) {
    const state = String(latest.state);
    if (TERMINAL_STATES.has(state)) return state as "completed" | "failed";
    const deadline = timestamp(latest.deadlineAt) ? Date.parse(latest.deadlineAt) : Number.POSITIVE_INFINITY;
    return nowMs > deadline ? "incomplete" : state as "starting" | "running";
  }
  const age = nowMs - Date.parse(occurrence.firstTs);
  return occurrence.decision ? (age <= graceMs ? "authorised" : "incomplete") : "incomplete";
}

function nodeOf(occurrence: Occurrence, now: Date, graceMs: number): DashboardNode {
  const decision = occurrence.decision;
  const latestLifecycle = occurrence.lifecycle.at(-1);
  const firstLifecycle = occurrence.lifecycle[0];
  const lease = occurrence.leases.findLast((event) => ["acquired", "uncontended", "recovered"].includes(String(event.outcome)));
  const start = timestamp(firstLifecycle?.ts) ? firstLifecycle.ts : occurrence.firstTs;
  const terminal = latestLifecycle && TERMINAL_STATES.has(String(latestLifecycle.state)) ? latestLifecycle : undefined;
  const state = stateOf(occurrence, now.getTime(), graceMs);
  const deadline = timestamp(latestLifecycle?.deadlineAt)
    ? Date.parse(latestLifecycle.deadlineAt)
    : latestLifecycle ? undefined : Date.parse(occurrence.firstTs) + graceMs;
  const durationEnd = state === "refused"
    ? Date.parse(start)
    : terminal ? Date.parse(String(terminal.ts)) : state === "incomplete" && deadline ? deadline : now.getTime();
  const runtimeEvent = occurrence.lifecycle.findLast(
    (event) => nonEmpty(event.herdrPaneId) || nonEmpty(event.herdrAgentName),
  );
  const runtime = runtimeEvent
    ? {
        ...(nonEmpty(runtimeEvent.herdrPaneId) ? { herdrPaneId: runtimeEvent.herdrPaneId } : {}),
        ...(nonEmpty(runtimeEvent.herdrAgentName) ? { herdrAgentName: runtimeEvent.herdrAgentName } : {}),
      }
    : undefined;
  const correlation = correlationOf(decision?.correlation)
    ?? correlationOf(latestLifecycle?.correlation)
    ?? correlationOf(lease?.correlation);
  const logicalParentId = decision && nonEmpty(decision.parentId) ? decision.parentId : undefined;
  const agentName = decision && nonEmpty(decision.agentType) ? decision.agentType : "governed execution";

  return {
    executionId: occurrence.executionId,
    parentExecutionId: occurrence.parentExecutionId,
    logicalParentId,
    logicalChildId: occurrence.childId,
    depth: Number.isInteger(decision?.depth) ? decision!.depth as number : 0,
    agentName,
    state,
    provenance: "pi-daddy-enforced",
    startedAt: start,
    ...(terminal ? { endedAt: String(terminal.ts) } : {}),
    updatedAt: occurrence.lastTs,
    durationMs: Math.max(0, durationEnd - Date.parse(start)),
    effectiveGrant: strings(decision?.effective) ? decision.effective : [],
    denied: strings(decision?.denied) ? decision.denied : [],
    executor: EXECUTORS.has(String(decision?.executor ?? latestLifecycle?.executor))
      ? (decision?.executor ?? latestLifecycle?.executor) as "process" | "herdr"
      : undefined,
    ...(lease ? { workspace: { id: String(lease.workspaceId), access: lease.access as "read" | "write", root: String(lease.root) } } : {}),
    ...(runtime ? { runtime } : {}),
    ...(correlation ? { correlation } : {}),
    ...(object(decision?.refusal) ? { refusal: decision.refusal as DashboardNode["refusal"] } : {}),
  };
}

function executionParentCycles(occurrences: Map<string, Occurrence>): Set<string> {
  const cyclic = new Set<string>();
  const complete = new Set<string>();
  for (const start of occurrences.keys()) {
    if (complete.has(start)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | null = start;
    while (current && occurrences.has(current) && !complete.has(current)) {
      const position = positions.get(current);
      if (position !== undefined) {
        for (const id of path.slice(position)) cyclic.add(id);
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = occurrences.get(current)?.parentExecutionId ?? null;
    }
    for (const id of path) complete.add(id);
  }
  return cyclic;
}

function workflowsOf(nodes: DashboardNode[], facts: DashboardWorkflowFact[]): DashboardWorkflow[] {
  const groups = new Map<string, DashboardWorkflow>();
  const correlations = [
    ...nodes.map((node) => node.correlation).filter((value): value is CorrelationMetadata => Boolean(value)),
    ...facts.map((fact) => fact.correlation),
  ];
  for (const correlation of correlations) {
    const runId = correlation.run_id;
    if (!runId) continue;
    const existing = groups.get(runId);
    const phase = correlation.phase;
    if (existing) {
      if (phase && !existing.phases.includes(phase)) existing.phases.push(phase);
      continue;
    }
    groups.set(runId, {
      runId,
      label: correlation.policy_label || runId,
      ...(correlation.assurance_effective || correlation.assurance
        ? { assurance: correlation.assurance_effective || correlation.assurance }
        : {}),
      phases: phase ? [phase] : [],
      provenance: "caller-declared",
    });
  }
  return [...groups.values()]
    .map((workflow) => ({ ...workflow, phases: [...workflow.phases].sort() }))
    .sort((left, right) => left.runId.localeCompare(right.runId));
}

export function parseDashboardLedger(text: string, options: DashboardProjectionOptions = {}): DashboardProjection {
  const now = options.now ?? new Date();
  const graceMs = options.startGraceMs ?? START_GRACE_MS;
  const corrupt: DashboardCorruptLine[] = [];
  const occurrences = new Map<string, Occurrence>();
  const historical: DashboardNode[] = [];
  const workflowFacts: DashboardWorkflowFact[] = [];
  let orphanEvents = 0;

  text.split("\n").forEach((raw, index) => {
    if (raw.trim() === "") return;
    const line = index + 1;
    let event: ObjectRecord;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!object(parsed)) throw new Error("line is not a JSON object");
      event = parsed;
    } catch {
      // JSON.parse diagnostics may quote the offending input. A foreign/torn line can contain exactly the
      // task or output text this surface promises never to render, so only the failure class crosses here.
      corrupt.push({ line, reason: "invalid JSON" });
      return;
    }

    if (event.ledgerVersion === undefined && event.event === undefined) {
      const node = legacyNode(event, line, now);
      if (node) historical.push(node);
      else corrupt.push({ line, reason: "invalid legacy grant record" });
      return;
    }
    if (event.ledgerVersion === 2) {
      if (!LEDGER_V2.Check(event)) {
        corrupt.push({ line, reason: "invalid ledger v2 event" });
        return;
      }
      const node = legacyNode(event, line, now);
      if (node) historical.push(node);
      else if (["workspace_lease", "child_lifecycle", "check_receipt"].includes(String(event.event))) orphanEvents += 1;
      else corrupt.push({ line, reason: "invalid ledger v2 event" });
      return;
    }

    const invalid = validateV3(event);
    if (invalid) {
      corrupt.push({ line, reason: invalid });
      return;
    }
    if (event.event === "workflow_fact") {
      const correlation = event.correlation as CorrelationMetadata & { run_id: string };
      workflowFacts.push({
        factId: event.factId as string,
        source: event.source as string,
        provenance: event.provenance === "controller_validated" ? "controller-validated" : event.provenance as "planned" | "observed",
        kind: event.kind as DashboardWorkflowFact["kind"],
        subject: event.subject as string,
        state: event.state as DashboardWorkflowFact["state"],
        runId: correlation.run_id,
        correlation,
      });
      return;
    }
    const executionId = event.executionId as string;
    const parentExecutionId = event.parentExecutionId as string | null;
    const childId = event.childId as string;
    // Named checks have their own receipt identity and are not delegated-agent tree nodes.
    if (event.event === "check_receipt" || childId.startsWith("check:")) return;
    const seen = occurrences.get(executionId);
    if (seen && (seen.parentExecutionId !== parentExecutionId || seen.childId !== childId)) {
      corrupt.push({ line, reason: "execution identity changed parent or logical child" });
      return;
    }
    const occurrence = seen ?? {
      executionId, parentExecutionId, childId, firstLine: line,
      firstTs: event.ts as string, lastTs: event.ts as string,
      lifecycle: [], leases: [],
    };
    if (event.event === "capability_decision" && occurrence.decision) {
      corrupt.push({ line, reason: "duplicate capability decision for one executionId" });
      return;
    }
    occurrence.lastTs = event.ts as string;
    if (event.event === "capability_decision") occurrence.decision = event;
    else if (event.event === "child_lifecycle") {
      const previous = occurrence.lifecycle.at(-1);
      if (previous && TERMINAL_STATES.has(String(previous.state))) {
        corrupt.push({ line, reason: "lifecycle event appeared after terminal lifecycle state" });
        return;
      }
      if (previous && event.state === "starting") {
        corrupt.push({ line, reason: "duplicate starting lifecycle event" });
        return;
      }
      const recordedDeadline = occurrence.lifecycle.find((entry) => timestamp(entry.deadlineAt))?.deadlineAt;
      if (recordedDeadline !== undefined && timestamp(event.deadlineAt) && event.deadlineAt !== recordedDeadline) {
        corrupt.push({ line, reason: "lifecycle deadline changed within one execution" });
        return;
      }
      occurrence.lifecycle.push(event);
    } else if (event.event === "workspace_lease") occurrence.leases.push(event);
    occurrences.set(executionId, occurrence);
  });

  const cycles = executionParentCycles(occurrences);
  for (const executionId of cycles) {
    const occurrence = occurrences.get(executionId)!;
    corrupt.push({ line: occurrence.firstLine, reason: "execution parent cycle" });
  }
  const current = [...occurrences.values()]
    .filter((occurrence) => !cycles.has(occurrence.executionId))
    .map((occurrence) => nodeOf(occurrence, now, graceMs));
  const nodes = [...current, ...historical].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.executionId.localeCompare(right.executionId),
  );
  const active = nodes.filter((node) => ["authorised", "starting", "running"].includes(node.state)).length;
  return {
    nodes,
    workflows: workflowsOf(nodes, workflowFacts),
    workflowFacts,
    corrupt,
    orphanEvents,
    active,
    maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
  };
}
