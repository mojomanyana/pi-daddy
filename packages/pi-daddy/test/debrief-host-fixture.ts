import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";
import type { DebriefCheckpoint, DebriefPersistence } from "../src/debrief.ts";
import { withFileLock } from "../src/file-lock.ts";
import { dataDigest, detached } from "../src/debrief-contract.ts";
const fixtures = new URL("fixtures/debrief-host/", import.meta.url), contract = new URL("../contracts/debrief/v1/", import.meta.url);
const json = async (p: string) => JSON.parse(await readFile(new URL(p, contract), "utf8"));
/** Exact immutable upstream bodies; import specifiers only are mapped into this disposable module set.
 * No installs, package lifecycle, foreign source edits, worker calls, or executing fixture generators. */
export async function harnessFixture(root: string) {
  const modules = join(root, "host-modules"); await mkdir(modules, { mode: 0o700 });
  await writeFile(join(modules, "package.json"), '{"type":"module"}');
  const pins = JSON.parse(await readFile(new URL("provenance.json", fixtures), "utf8"));
  for (const pin of pins) {
    const raw = await readFile(new URL(pin.target, fixtures), "utf8");
    if (createHash("sha256").update(raw).digest("hex") !== pin.sha256) throw new Error("upstream fixture byte drift");
    const source = raw.replaceAll('from "@skill-harness/core"', 'from "./work-capture.js"');
    const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 }, fileName: pin.target.slice(0, -4), reportDiagnostics: true });
    if (result.diagnostics?.length) throw new Error("foreign fixture transpile diagnostics");
    await writeFile(join(modules, pin.target.replace(/\.ts\.txt$/, ".js")), result.outputText);
  }
  const archive = await import(pathToFileURL(join(modules, "evidence-archive.js")).href);
  const capture = await import(pathToFileURL(join(modules, "work-case-archive.js")).href);
  const review = await import(pathToFileURL(join(modules, "work-case-review.js")).href);
  const intervention = await import(pathToFileURL(join(modules, "intervention.js")).href);
  const archiveRoot = join(root, "harness-archive"); await mkdir(archiveRoot, { mode: 0o700 });
  const cases = await json("work-capture/fixtures/cases.json"), batch = await json("work-capture/fixtures/batch.json");
  const candidateIds = cases.map((c: unknown) => capture.retainWorkCandidate(archiveRoot, c));
  if (JSON.stringify(candidateIds) !== JSON.stringify(batch.candidateIds)) throw new Error("actual host archive fixture IDs drift");
  const batchId = archive.retainArchiveSource(archiveRoot, { sourceId: "fixture-batch", parser: { id: "work-candidate-batch", version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify(batch)) }).manifestId;
  const reviewer = review.createWorkCaseReviewer(archiveRoot, batchId, "operator:fixture");
  const manifest = await json("intervention/fixtures/manifest.json"), blindView = await json("intervention/fixtures/blind-view.json");
  // Same explicit synthetic evidence/roles as the immutable fixture producer; not host authentication.
  const artifacts = new Map<string, Buffer>();
  for (const c of blindView.cards) for (const digest of c.artifactDigests) artifacts.set(digest, await readFile(new URL(`intervention/fixtures/artifact-${digest}.txt`, contract)));
  const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
  const evidence = ["a", "b"].map((armId, i) => { const digest = sha(`Synthetic Layout ${armId.toUpperCase()}\n`); return { armId, inputDigest: manifest.inputDigest, artifactDigests: [digest],
    cells: [{ caseId: "A1", repetition: 0, delivery: "PASS", objective: "PASS", criteria: ["PASS"], suspect: false, artifactSha256: digest }], cost: i + 1, costUnit: "wall_ms" }; });
  const qualification = { manifestId: manifest.id, proposer: { requested: "fixture:proposer", canonical: "fixture-proposer" }, judge: { requested: "fixture:judge", canonical: "fixture-judge" },
    subjects: { a: { requested: "fixture:a", canonical: "fixture-subject-a" }, b: { requested: "fixture:b", canonical: "fixture-subject-b" } }, evidenceDigests: Object.fromEntries(evidence.map(e => [e.armId, intervention.interventionEvidenceDigest(e)])), artifacts };
  const assessment = intervention.assessIntervention(manifest, evidence, qualification);
  const blind = intervention.createBlindComparison(manifest, assessment, "0".repeat(64));
  return { reviewer, blind, archiveRoot, batchId, review, view: blindView };
}
/** Host-owned fixture attention transport. Labels never live here; real reviewer owns decision history.
 * Fixture host uses the existing non-expiring lock and synced append; not a deployed host service. */
export function attentionFixture(root: string): DebriefPersistence {
  const path = join(root, "fixture-host-attention.json"); let known = false;
  return { durability: "host-owned", async load() {
    try { const text = await readFile(path, "utf8");
      if (!text.endsWith("\n")) throw new Error("partial attention journal");
      let value: DebriefCheckpoint | null = null;
      for (const line of text.trimEnd().split("\n")) { const record = JSON.parse(line); if (record.prior !== (value ? dataDigest(value) : null)) throw new Error("attention history changed"); value = record.next; }
      known = true; return value; }
    catch (error) { if (!known && (error as { code?: string }).code === "ENOENT") return null; throw error; }
  }, async compareAndSwap(expected, next) {
    await withFileLock(path, "fixture host attention", async () => {
      const prior = await this.load() as DebriefCheckpoint | null;
      if ((prior ? dataDigest(prior) : null) !== expected) throw new Error("stale host checkpoint");
      const file = await open(path, "a", 0o600);
      try { await file.writeFile(JSON.stringify({ prior: expected, next: detached(next) }) + "\n"); await file.sync(); } finally { await file.close(); }
      known = true;
    }, { staleRecovery: "disabled" });
  } };
}
