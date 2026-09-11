import { dataDigest, detached, freeze, sha } from "./debrief-contract.ts";
import { controlShape } from "./dispatch-control.ts";
import type { DebriefHarness, DurableBlindBinding, CaseSelection } from "./debrief-host.ts";
import type { WorkProjectionContext, WorkFrozen } from "./work-ledger.ts";
import type { DispatchAuthority } from "./dispatch-control.ts";
import type { OrdinaryAuthority } from "./ordinary-children.ts";
import type { ExperimentAuthority } from "./experiment-contract.ts";
export const DASHBOARD_HARNESS_PIN = "127b349310dd8f28e5d6b12148a063fce66a77dd";
export interface HostEvent { id: string; prior: string | null; value: Record<string, unknown> }
export interface HostJournal { read(): HostEvent[]; append(prior: string, value: Record<string, unknown>): HostEvent }
/** Loaded trusted ports; an interface or caller-supplied pin is NOT module/human authentication. */
export interface DashboardHarness extends DebriefHarness {
  learningJournal(path: string, initial?: Record<string, unknown>): HostJournal;
  openTrustLifecycle(path: string): { history(): HostEvent[]; inspect(now: number): { policyId: string; attentionUsed: number; tip: string; grantExpansion: false }; expose(id: string, now: number): { mode: string; reason: string; replayed: boolean } };
  archivePolicyBinding(path: string, source: string): { policySha256: string; archiveRoot: string };
  ingestPolicySource(path: string, source: string, previous?: string, expectedPolicy?: string): { checkpointId: string; sourceStatus: string; issues?: string[]; [key: string]: unknown };
  readArchiveCheckpoint(root: string, checkpoint: string): { checkpoint: { sourceManifestId: string; issues: string[]; [key: string]: unknown } };
  readArchiveSource(root: string, id: string): { status: string; bytes?: Uint8Array; reference?: { retention: string; sha256: string; [key: string]: unknown } };
  captureArchivedWorkSignals(root: string, id: string, context: WorkFrozen<WorkProjectionContext>, facts: unknown): { caseBatchId: string; observationId: string; linkageManifestId: string };
  readRetainedExecution(root: string, id: string): { projection: unknown };
  projectRetainedExecutions(values: readonly unknown[]): unknown;
}
export interface DashboardHostConfig {
  version: "producer-dashboard-host-v1"; trustDirectory: string; trustPolicyId: string; archiveRoot: string; scope: string; author: string;
  policyPath: string; policySha256: string; sources: { id: string; kind: "work" | "retention" | "facts" }[];
  selection: WorkProjectionContext["selectedSnapshot"]; cases: CaseSelection | null; blind: DurableBlindBinding | null;
  budgetDigest: string; experimentDigest: string | null; harnessArtifactDigest: string;
  ordinaryDigest?: string;
}
export interface DashboardHostRequest { version: "1.0"; requestId: string; hostDigest: string; expectedTip: string; selectionDigest: string; operation: "observe" | "present" | "presented" | "defer" | "debrief" | "dispatch" | "intent" | "cancel" | "dispatch-reconcile" | "intent-reconcile" | "ordinary-cancel"; payload: unknown }
export interface DashboardHostAuthority {
  hostDigests: readonly string[]; requestDigests: readonly string[];
  workContext: WorkFrozen<WorkProjectionContext>; dispatch: DispatchAuthority | null; experiment: ExperimentAuthority | null;
  ordinary?: OrdinaryAuthority | null;
}
export const dashboardHostDigest = (c: DashboardHostConfig): string => dataDigest(c);
export const dashboardSelectionDigest = (selection: DashboardHostConfig["selection"]): string => dataDigest(selection);
export function dashboardHostRequest(input: DashboardHostRequest) {
  const r=detached(input);controlShape(r,["version","requestId","hostDigest","expectedTip","selectionDigest","operation","payload"]);
  if(r.version!=="1.0"||!/^[a-zA-Z0-9:_-]{1,128}$/.test(r.requestId)||![r.hostDigest,r.expectedTip,r.selectionDigest].every(sha)||!["observe","present","presented","defer","debrief","dispatch","intent","cancel","dispatch-reconcile","intent-reconcile","ordinary-cancel"].includes(r.operation)||Buffer.byteLength(JSON.stringify(r))>60000)throw Error("bounded exact dashboard request required");return freeze(r);
}
export const dashboardHostRequestDigest = (r: DashboardHostRequest): string => dataDigest(dashboardHostRequest(r));
