import { join, resolve } from "node:path";
import { intentKey } from "./intent-control.ts";
import { loadDeclaredWork, type DeclaredWorkState } from "./work-command.ts";
import { readProductJson, writeProductJson } from "./product-files.ts";
import { loadedDashboardHarnessDigest } from "./dashboard-harness.ts";
import type { DashboardHarness } from "./dashboard-host-contract.ts";
import {
  buildAdoptionBinding,
  type AdoptionAuthority,
  type AdoptionBinding,
  type AdoptionFacts,
  type AdoptionReceipt,
  type RollbackRequest,
  type ProductionObservation,
} from "./vendor/adoption.ts";

export interface LearningConfiguration {
  archiveRoot: string;
  scopeDigest: string;
  population: string;
  author: string;
}
export interface LearningUI {
  select(title: string, choices: string[]): Promise<string | undefined>;
  input(title: string, initial?: string): Promise<string | undefined>;
  editor(title: string, text: string): Promise<string | undefined>;
  confirm(title: string, detail: string): Promise<boolean>;
  notify(text: string, level?: "info" | "warning" | "error"): void;
}
export interface LearningComparisonContext {
  caseReference: unknown | null;
  hypothesisManifestId: string | null;
  adoptionBinding: AdoptionBinding | null;
}
export interface LearningWorkspace {
  configuration(): LearningConfiguration;
  inspect(now: number): {
    version: string;
    configuration: LearningConfiguration;
    cases: { name: string; title: string; state?: string; reason?: string }[];
    comparisons: { name: string; title: string; state?: string; reason?: string }[];
    trust: Record<string, unknown>;
    [key: string]: unknown;
  };
  dashboardBinding(): { trustDirectory: string | null; trustPolicyId: string | null };
  bindCases(input: { name: string; title: string; version: 2 | 3; batchId: string }): unknown;
  comparisonContext(name: string): LearningComparisonContext;
  linkComparisonContext(name: string, context: LearningComparisonContext): unknown;
  hypotheses(): { name: string; manifestId: string; hypothesis: { id: string } }[];
  decisionStatus(name: string): { current: { disposition: string } | null };
  reveal(name: string): {
    manifestId: string;
    choice: { kind: string; labels: readonly string[] };
    arms: readonly { label: string; configuration: { configuration: string } }[];
  };
  preparedAdoption(name: string): AdoptionReceipt | null;
  previewObservation(
    name: string,
    input: ProductionObservation,
  ): { observation: ProductionObservation; classification: unknown; digest: string };
  observe(name: string, input: ProductionObservation, authorized: readonly string[]): { manifestId: string };
  prepareAdoption(
    name: string,
    authority: AdoptionAuthority | null,
    facts: AdoptionFacts,
    now: number,
  ): AdoptionReceipt;
  linkActivation(name: string, manifest: string, independentlyAuthorized: readonly string[]): unknown;
  previewRollback(
    name: string,
    reason: "operator-request" | "confirmed-escape",
    evidence: string[],
    expiresAt?: number,
  ): RollbackRequest;
  prepareRollback(
    name: string,
    request: RollbackRequest,
    authority: AdoptionAuthority | null,
    now: number,
    current: { adoptionId: string; candidateDigest: string; scopeDigest: string },
  ): unknown;
  linkRollback(name: string, manifest: string, independentlyAuthorized: readonly string[]): unknown;
}
export interface LearningHarness extends DashboardHarness {
  createLearningWorkspace(directory: string, input: LearningConfiguration): LearningWorkspace;
  openLearningWorkspace(directory: string): LearningWorkspace;
  runLearningWizard(input: { directory: string; cwd: string; ui: LearningUI }): Promise<unknown>;
}
export function learningHarness(harness: DashboardHarness): LearningHarness {
  if (
    !loadedDashboardHarnessDigest(harness) ||
    ["createLearningWorkspace", "openLearningWorkspace", "runLearningWizard"].some(
      (key) => typeof (harness as unknown as Record<string, unknown>)[key] !== "function",
    )
  )
    throw Error(
      "Learning services are unavailable in the loaded skill-harness. " +
        "Load the compatible learning-workspace-v1 release and start a fresh Pi session " +
        "(the existing immutable bridge survives /reload); no private adapter is needed.",
    );
  return harness as LearningHarness;
}
/** Author only the missing binding from validated public readback after a durable choice. No authority is generated. */
export function bindLearningAdoption(
  workspace: LearningWorkspace,
  name: string,
  input: {
    candidateDigest: string;
    rollbackCandidateDigest: string;
    assessmentPolicyDigest: string;
    expiresAt: number;
  },
): AdoptionBinding {
  const context = workspace.comparisonContext(name);
  if (context.adoptionBinding) throw Error("Adoption proposal is already bound; it cannot be replaced");
  if (!context.caseReference || !context.hypothesisManifestId)
    throw Error("Link the comparison's original confirmed case and hypothesis in Learning first");
  const original = workspace.hypotheses().find((h) => h.manifestId === context.hypothesisManifestId);
  if (!original || workspace.decisionStatus(name).current?.disposition !== "adopt")
    throw Error("Retained original hypothesis and explicit adopt intent required");
  const reveal = workspace.reveal(name);
  if (
    !["one", "tie"].includes(reveal.choice.kind) ||
    !reveal.arms.some(
      (a) => reveal.choice.labels.includes(a.label) && a.configuration.configuration === input.candidateDigest,
    )
  )
    throw Error("Candidate is not the exact configuration selected by the full-artifact quality choice");
  const binding = buildAdoptionBinding({
    ...input,
    hypothesisDigest: original.hypothesis.id,
    experimentDigest: reveal.manifestId,
    scopeDigest: workspace.configuration().scopeDigest,
    activationBoundary: "next-orders",
  });
  workspace.linkComparisonContext(name, { ...context, adoptionBinding: binding });
  return binding;
}
export interface LearningConnection {
  version: "producer-learning-connection-v1";
  directory: string;
  configuration: LearningConfiguration;
  selection: DeclaredWorkState["selectedSnapshot"];
}
export const learningScopeDigest = (state: DeclaredWorkState) => state.selectedSnapshot.snapshot.digest;
export async function bindLearningConnection(
  cwd: string,
  state: DeclaredWorkState,
  directory: string,
  harness: LearningHarness,
  author: string,
): Promise<LearningConnection> {
  if (resolve(directory) !== directory) throw Error("absolute learning workspace directory required");
  const current = await loadDeclaredWork(state.statePath);
  if (intentKey(current?.selectedSnapshot ?? null) !== intentKey(state.selectedSnapshot))
    throw Error("selected work changed before learning connection; reopen Learning");
  const configuration = harness.openLearningWorkspace(directory).configuration();
  if (configuration.scopeDigest !== learningScopeDigest(state) || configuration.author !== author)
    throw Error("learning workspace belongs to another work scope or author; not rebound");
  const connection: LearningConnection = {
    version: "producer-learning-connection-v1",
    directory,
    configuration,
    selection: state.selectedSnapshot,
  };
  await writeProductJson(join(resolve(cwd), ".pi", "learning-workspace.json"), connection, true);
  return connection;
}
export async function loadLearningConnection(
  cwd: string,
  state: DeclaredWorkState,
  harness: LearningHarness,
  author: string,
): Promise<{ connection: LearningConnection; workspace: LearningWorkspace } | null> {
  const c = (await readProductJson(join(resolve(cwd), ".pi", "learning-workspace.json"))) as LearningConnection | null;
  if (!c) return null;
  if (
    Object.keys(c).sort().join() !== "configuration,directory,selection,version" ||
    c.version !== "producer-learning-connection-v1" ||
    typeof c.directory !== "string" ||
    resolve(c.directory) !== c.directory ||
    intentKey(c.selection) !== intentKey(state.selectedSnapshot)
  )
    throw Error(
      "Learning connection is stale for selected work. Reconnect deliberately with /grants learning; no evidence was carried forward.",
    );
  const workspace = harness.openLearningWorkspace(c.directory),
    actual = workspace.configuration();
  if (
    intentKey(actual) !== intentKey(c.configuration) ||
    actual.scopeDigest !== learningScopeDigest(state) ||
    actual.author !== author
  )
    throw Error("learning archive/population/scope/author mismatch");
  return { connection: c, workspace };
}
