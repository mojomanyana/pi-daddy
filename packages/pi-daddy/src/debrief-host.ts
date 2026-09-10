import { isAbsolute } from "node:path";
import { createDebriefPresenter, type DebriefPersistence } from "./debrief.ts";
import { closed, detached, freeze, sha, type BlindChoice, type BlindPort, type ReviewPort } from "./debrief-contract.ts";
/** Host supplies its loaded harness module, not worker metadata or a permission-shaped receipt.
 * Ordinary integration consumes exact638494af... source bytes; this structural port is not module authentication. */
export interface DebriefHarness {
  createWorkCaseReviewer(root: string, batchId: string, author: string): ReviewPort;
  createWorkSignalReviewer(root: string, batchId: string, author: string): ReviewPort;
  retainBlindIntervention(root: string, manifest: unknown, evidence: unknown[], qualification: unknown, author: string): string;
  openBlindIntervention(root: string, id: string, author: string): BlindPort & { quality(): unknown };
}
export interface DurableBlindBinding { comparisonId: string; author: string }
export type CaseSelection = { version: "work-case-v2"; batchId: string } | { version: "work-signals-v1"; batchId: string; observationId: string };
function location(root: string, author: string) {
  if (typeof root !== "string" || !isAbsolute(root) || typeof author !== "string" || !author || author.length > 512 || /[\u0000-\u001f\u007f]/.test(author)) throw new Error("explicit archive and independent operator author required");
}
function binding(input: DurableBlindBinding): DurableBlindBinding {
  const value = detached(input); closed(value, ["comparisonId", "author"]);
  if (!sha(value.comparisonId) || typeof value.author !== "string") throw new Error("exact retained comparison binding required");
  return freeze(value);
}
/** Explicit host retention action only. Caller must retain returned identity independently before exposure. */
export function retainDebriefBlind(harness: DebriefHarness, root: string, input: { manifest: unknown; evidence: unknown[]; qualification: unknown }, author: string): DurableBlindBinding {
  location(root, author);
  const comparisonId = harness.retainBlindIntervention(root, input.manifest, input.evidence, input.qualification, author);
  return binding({ comparisonId, author });
}
/** No choose/reveal/archive/seed/role/cost capability is given to a pre-reveal consumer. */
export function openDebriefBlindPreview(harness: DebriefHarness, root: string, input: DurableBlindBinding) {
  const b = binding(input); location(root, b.author);
  const port = harness.openBlindIntervention(root, b.comparisonId, b.author);
  return Object.freeze({ view: port.view.bind(port), readArtifact: port.readArtifact.bind(port), quality: port.quality.bind(port) });
}
/** Existing presenter + existing durable writers. No second decision history or automatic retention/reveal. */
export function createRetainedDebrief(harness: DebriefHarness, input: {
  archiveRoot: string; scope: string; author: string; cases: CaseSelection; blind?: DurableBlindBinding;
  persistence: DebriefPersistence; offset?: number;
}) {
  const root = input.archiveRoot, author = input.author, selection = freeze(detached(input.cases)); location(root, author);
  if (selection.version !== "work-case-v2" && selection.version !== "work-signals-v1") throw new Error("explicit case version required");
  closed(selection, selection.version === "work-signals-v1" ? ["version", "batchId", "observationId"] : ["version", "batchId"]);
  if (!sha(selection.batchId) || selection.version === "work-signals-v1" && !sha(selection.observationId)) throw new Error("exact selected batch/observation required");
  const reviewer = selection.version === "work-signals-v1" ? harness.createWorkSignalReviewer(root, selection.batchId, author) : harness.createWorkCaseReviewer(root, selection.batchId, author);
  const blindBinding = input.blind ? binding(input.blind) : undefined;
  if (blindBinding && blindBinding.author !== author) throw new Error("blind author differs from independent operator");
  const open = harness.openBlindIntervention.bind(harness);
  const blind = blindBinding ? { ...openDebriefBlindPreview(harness, root, blindBinding),
    choose: (choice: BlindChoice) => open(root, blindBinding.comparisonId, author).choose(choice),
    reveal: () => open(root, blindBinding.comparisonId, author).reveal() } : undefined;
  return createDebriefPresenter({ scope: input.scope, offset: input.offset, operatorIdentity: author, reviewer, blind, blindBinding,
    signals: selection.version === "work-signals-v1" ? { batchId: selection.batchId, observationId: selection.observationId } : undefined,
    persistence: input.persistence });
}
