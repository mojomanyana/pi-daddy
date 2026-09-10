import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";
const sourceRoot = new URL("fixtures/debrief-durable-host/", import.meta.url);
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
/** Actual pinned sources compiled in an owned directory; only package import specifiers are mapped. */
export async function durableHarness(root: string) {
  const modules = join(root, "compiled-harness"); await mkdir(modules, { mode: 0o700 });
  await writeFile(join(modules, "package.json"), '{"type":"module"}');
  const pins = JSON.parse(await readFile(new URL("provenance.json", sourceRoot), "utf8"));
  for (const pin of pins) {
    const raw = await readFile(new URL(pin.target, sourceRoot), "utf8");
    if (hash(raw) !== pin.sha256 || pin.commit !== "638494af0a0058edf9a9b1b02e57af894ab46ed6") throw new Error("pinned harness source drift");
    const result = ts.transpileModule(raw.replaceAll('from "@skill-harness/core"', 'from "./core-port.js"'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
    if (result.diagnostics?.length) throw new Error("harness compilation diagnostics");
    await writeFile(join(modules, pin.target.replace(/\.ts\.txt$/, ".js")), result.outputText);
  }
  await writeFile(join(modules, "core-port.js"), 'export * from "./work-capture.js"; export * from "./work-signals.js"; export * from "./intervention.js";');
  const load = (name: string) => import(pathToFileURL(join(modules, name + ".js")).href);
  const api = Object.assign({}, ...await Promise.all(["work-case-review", "work-signal-observation", "work-signal-cases", "blind-intervention", "evidence-archive", "work-case-archive", "core-port"].map(load)));
  const archiveRoot = join(root, "archive"); await mkdir(archiveRoot, { mode: 0o700 });
  return { api, archiveRoot, modules, pins };
}
export function signalInputs(scopeValid = true) {
  const obligations = Array.from({ length: 7 }, (_, i) => ({ id: "obligation:" + i, digest: hash("o" + i), intentDigest: hash("i" + i), policyDigest: hash("p" + i), artifactDigest: hash("a" + i), acceptance: "unaccepted", coverage: i === 6 ? "unknown" : "available" }));
  return { snapshot: { snapshotDigest: hash("scope"), scopeValid, obligations }, facts: { scopeDigest: hash("scope"), version: "fixture-v1", population: "selected-fixture", expectedWaits: [],
    checkpoints: obligations.map(o => ({ obligationDigest: o.digest, deadlineMs: 1, observedAt: 2, status: "pending", evidence: hash("checkpoint" + o.id) })),
    violations: [{ obligationDigest: obligations[0].digest, status: "FAIL", evidence: hash("violation") }],
    priorAccepted: [{ obligationDigest: obligations[1].digest, intentDigest: obligations[1].intentDigest, policyDigest: obligations[1].policyDigest, artifactDigest: obligations[1].artifactDigest, acceptanceEvidence: hash("prior") }] } };
}
export async function blindInputs(api: any) {
  const manifest = JSON.parse(await readFile(new URL("../contracts/debrief/v1/intervention/fixtures/manifest.json", import.meta.url), "utf8"));
  const texts = [Buffer.from("Two columns\n"), Buffer.from("Single column\n")], artifacts = new Map(texts.map(b => [hash(b), b]));
  const evidence = ["a", "b"].map((armId, i) => ({ armId, inputDigest: manifest.inputDigest, artifactDigests: [hash(texts[i])],
    cells: [{ caseId: "A1", repetition: 0, delivery: "PASS", objective: "PASS", criteria: ["PASS"], suspect: false, artifactSha256: hash(texts[i]) }], cost: i + 1, costUnit: "wall_ms" }));
  const qualification = { manifestId: manifest.id, proposer: { requested: "fixture:proposer", canonical: "fixture-proposer" }, judge: { requested: "fixture:judge", canonical: "fixture-judge" },
    subjects: { a: { requested: "fixture:a", canonical: "fixture-subject-a" }, b: { requested: "fixture:b", canonical: "fixture-subject-b" } }, evidenceDigests: Object.fromEntries(evidence.map(e => [e.armId, api.interventionEvidenceDigest(e)])), artifacts };
  return { manifest, evidence, qualification };
}
