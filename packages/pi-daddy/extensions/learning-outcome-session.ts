import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { inspectWorkRun, type WorkRunInitial } from "../src/products/work-run.ts";
import type { ControlBinding } from "../src/products/control-journal.ts";
import { readProductJson } from "../src/products/product-files.ts";
import { readDailySnapshot } from "../src/products/daily-view-input.ts";
import { experimentHash } from "../src/products/experiment-contract.ts";
import type { LearningHarness, LearningWorkspace } from "../src/products/learning-connection.ts";
import type { DeclaredWorkState } from "../src/products/work-command.ts";
import type { ProductionObservation } from "../src/products/vendor/adoption.ts";

/** Link actual later-run bytes/pin; only an explicit independent human supplies outcome labels. */
export async function linkLatestWorkOutcome(ctx: ExtensionCommandContext, state: DeclaredWorkState, workspace: LearningWorkspace, harness: LearningHarness) {
  const binding = await readProductJson(join(ctx.cwd, ".pi", "work-last-run.json")) as ControlBinding<WorkRunInitial> | null;
  if (!binding) throw Error("No retained later bounded order is available");
  const run = await inspectWorkRun(binding), pin = binding.initial.policyPin;
  if (!pin?.adoptionId) throw Error("This run was not pinned to an adoption. It cannot establish an adopted outcome.");
  const comparisons = workspace.inspect(Date.now()).comparisons.filter(c => c.state !== "deferred" && workspace.preparedAdoption(c.name)?.id === pin.adoptionId);
  if(!comparisons.length)throw Error("No ready learning comparison matches this run's actual adoption pin. Reconnect original evidence before linking outcomes.");
  const labels = comparisons.map((c, i) => `${i + 1}. ${c.title}`), picked = await ctx.ui.select("Observed adoption", labels), comparison = comparisons[labels.indexOf(picked ?? "")]; if (!comparison) return;
  const rows = run.tasks.filter(t => t.resultPath && t.resultDigest), tasks = rows.map((t, i) => `${i + 1}. ${t.id}: ${t.state}`), selected = await ctx.ui.select("Actual retained output", tasks), row = rows[tasks.indexOf(selected ?? "")]; if (!row) return;
  if (row.resultPath !== join(binding.directory, `${row.id}.txt`)) throw Error("retained result path changed");
  const source = await readDailySnapshot(row.resultPath, 1024 * 1024);
  if (source.status !== "read" || source.sha256 !== row.resultDigest) throw Error("retained output missing or mismatched");
  await ctx.ui.editor("Complete retained output (controls escaped; editor edits discarded)", new TextDecoder("utf8", { fatal: true }).decode(source.bytes).replace(/[\p{Cc}\p{Cf}]/gu, c => c === "\n" || c === "\t" ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4,"0")}`));
  const outcomes = ["Unknown / not independently judged", "Independently confirmed success", "Independently confirmed defect"], outcome = await ctx.ui.select("Observed quality — runtime success is not a label", outcomes); if (!outcome) return;
  const note = await ctx.ui.editor("Independent observation note / evidence (do not infer acceptance)", ""); if (!note?.trim()) return;
  if (!await ctx.ui.confirm("Retain this scoped observation?", "This records an explicit human observation of these exact later-work bytes. Acceptance remains absent. It does not calibrate a detector, certify held-out improvement or trigger rollback.")) return;
  const root = workspace.configuration().archiveRoot;
  const artifact = harness.retainArchiveSource(root, { sourceId: `later-output-${source.sha256.slice(0,24)}`, parser: { id: "producer-work-output", version: "1" }, retention: "exact", bytes: source.bytes }).manifestId;
  const evidence = harness.retainArchiveSource(root, { sourceId: `later-observation-${randomUUID()}`, parser: { id: "producer-work-observation", version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify({ run: binding.initial, task: row, note, author: workspace.configuration().author })) }).manifestId;
  const input: ProductionObservation = { id: `work-observation-${experimentHash({run:binding.initial.runId,task:row.id,note,outcome}).slice(0,24)}`, adoptionId: pin.adoptionId, candidateDigest: pin.candidateDigest, scopeDigest: pin.scopeDigest, originalRequirementDigest: binding.initial.selectionDigest, currentRequirementDigest: state.selectedSnapshot.snapshot.digest, outcome: outcomes.indexOf(outcome) === 1 ? "success" : outcomes.indexOf(outcome) === 2 ? "confirmed-defect" : "unknown", acceptanceDigest: null, acceptedArtifactDigest: null, observedArtifactDigest: source.sha256, evidence: [artifact, evidence] };
  const preview = workspace.previewObservation(comparison.name, input);
  if (!await ctx.ui.confirm("Confirm classified outcome", JSON.stringify(preview.classification))) return;
  const retained = workspace.observe(comparison.name, input, [preview.digest]);
  ctx.ui.notify(`Observed outcome retained (${retained.manifestId.slice(0,12)}). No acceptance, calibration or automatic rollback inferred.`, "info");
}
