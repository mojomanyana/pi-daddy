import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { assessIntervention, createBlindComparison, interventionCanonicalJson, type BlindQualityChoice, type InterventionManifest, type InterventionEvidence, type InterventionQualification } from "@skill-harness/core";
import { readArchiveSource, retainArchiveSource } from "./evidence-archive.js";
const SHA = /^[a-f0-9]{64}$/;
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const encode = interventionCanonicalJson;
const copy = <T>(value: T): T => JSON.parse(encode(value));
function keys(value: unknown, names: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== names.sort().join()) throw new Error("invalid blind record fields");
}
function authorValid(author: string): void {
  if (typeof author !== "string" || !author.length || author.length > 512 || /[\u0000-\u001f\u007f]/.test(author)) throw new Error("explicit blind author required");
}
type Claims = Omit<InterventionQualification, "artifacts">;
interface Bundle { version: "retained-blind-intervention-v1"; manifest: InterventionManifest; evidence: InterventionEvidence[]; qualification: Claims; artifacts: Array<{ hash: string; manifestId: string }>; seed: string; author: string }
function claimsValid(claims: Claims, manifest: InterventionManifest): void {
  keys(claims, ["manifestId", "proposer", "judge", "subjects", "evidenceDigests"]);
  for (const role of [claims.proposer, claims.judge]) keys(role, ["requested", "canonical"]);
  keys(claims.subjects, manifest.arms.map(a => a.id));
  keys(claims.evidenceDigests, manifest.arms.map(a => a.id));
  for (const role of Object.values(claims.subjects)) keys(role, ["requested", "canonical"]);
}
/** Explicit private retention. Host role declarations are NOT authentication. No provider is called. */
export function retainBlindIntervention(root: string, manifest: InterventionManifest, evidence: InterventionEvidence[], qualification: InterventionQualification, author: string): string {
  authorValid(author);
  const descriptors = Object.getOwnPropertyDescriptors(qualification);
  if (Reflect.ownKeys(descriptors).some(k => typeof k !== "string" || !descriptors[k].enumerable || !Object.hasOwn(descriptors[k], "value"))) throw new Error("plain qualification required");
  keys(qualification, ["manifestId", "proposer", "judge", "subjects", "evidenceDigests", "artifacts"]);
  const { artifacts: artifactDescriptor, ...rest } = descriptors;
  const claims = copy(Object.fromEntries(Object.entries(rest).map(([k, d]) => [k, d.value]))) as Claims;
  const stableManifest = copy(manifest), stableEvidence = copy(evidence);
  claimsValid(claims, stableManifest);
  if (!(artifactDescriptor.value instanceof Map)) throw new Error("retained artifact map required");
  const artifacts = new Map<string, Buffer>(); let total = 0;
  for (const [hash, bytes] of Map.prototype.entries.call(artifactDescriptor.value) as Iterable<[string, Uint8Array]>) {
    if (typeof hash !== "string" || !SHA.test(hash) || !(bytes instanceof Uint8Array) || bytes.byteLength > 8 * 1024 * 1024 || artifacts.size >= 4096 || (total += bytes.byteLength) > 64 * 1024 * 1024) throw new Error("bounded blind artifacts required");
    const stable = Buffer.from(bytes);
    if (createHash("sha256").update(stable).digest("hex") !== hash) throw new Error("blind artifact digest mismatch");
    artifacts.set(hash, stable);
  }
  const assessment = assessIntervention(stableManifest, stableEvidence, { ...claims, artifacts });
  const seed = randomBytes(32).toString("hex");
  createBlindComparison(stableManifest, assessment, seed); // Refuse incomplete inputs BEFORE writes.
  const referenced = new Set(stableEvidence.flatMap(e => e.artifactDigests));
  if ([...artifacts.keys()].some(h => !referenced.has(h))) throw new Error("unreferenced blind artifact");
  const refs = [...artifacts].sort(([a], [b]) => a.localeCompare(b)).map(([hash, bytes]) => ({ hash,
    manifestId: retainArchiveSource(root, { sourceId: `blind-artifact-${hash}`, parser: { id: "blind-artifact", version: "1" }, retention: "exact", bytes }).manifestId }));
  const bundle: Bundle = { version: "retained-blind-intervention-v1", manifest: stableManifest, evidence: stableEvidence, qualification: claims, artifacts: refs, seed, author };
  return retainArchiveSource(root, { sourceId: `blind-${stableManifest.id}`, parser: { id: "blind-intervention", version: "1" }, retention: "exact", bytes: Buffer.from(encode(bundle)) }).manifestId;
}
function load(root: string, id: string, author: string) {
  authorValid(author);
  const source = readArchiveSource(root, id);
  if (source.status !== "available" || source.reference.retention !== "exact" || source.reference.parser.id !== "blind-intervention" || source.reference.parser.version !== "1") throw new Error("blind input unavailable");
  let bundle: Bundle;
  try { const text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes); bundle = JSON.parse(text); if (encode(bundle) !== text) throw new Error(); }
  catch { throw new Error("invalid blind input JSON"); }
  keys(bundle, ["version", "manifest", "evidence", "qualification", "artifacts", "seed", "author"]);
  if (bundle.version !== "retained-blind-intervention-v1" || bundle.author !== author) throw new Error("blind author or version mismatch");
  claimsValid(bundle.qualification, bundle.manifest);
  if (!Array.isArray(bundle.artifacts) || bundle.artifacts.length > 4096) throw new Error("invalid blind artifacts");
  const artifacts = new Map<string, Buffer>(); let total = 0;
  for (const ref of bundle.artifacts) {
    keys(ref, ["hash", "manifestId"]);
    if (!SHA.test(ref.hash) || artifacts.has(ref.hash)) throw new Error("invalid blind artifact identity");
    const artifact = readArchiveSource(root, ref.manifestId);
    if (artifact.status !== "available" || artifact.reference.retention !== "exact" || artifact.reference.parser.id !== "blind-artifact" || artifact.reference.parser.version !== "1" || artifact.reference.sha256 !== ref.hash || (total += artifact.bytes.length) > 64 * 1024 * 1024) throw new Error("blind artifact unavailable");
    artifacts.set(ref.hash, artifact.bytes);
  }
  return createBlindComparison(bundle.manifest, assessIntervention(bundle.manifest, bundle.evidence, { ...bundle.qualification, artifacts }), bundle.seed);
}
function directory(path: string): void {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) throw new Error("private blind directory required");
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function readChoice(root: string, id: string): BlindQualityChoice | null {
  const parent = join(root, "blind-decisions"), dir = join(parent, id);
  try { directory(parent); directory(dir); } catch (e) { if (missing(e)) return null; throw e; }
  let fd: number;
  try { fd = openSync(join(dir, "choice.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (missing(e)) throw new Error("blind choice incomplete; explicit recovery required"); throw e; }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid()) || s.size > 16384) throw new Error("invalid blind choice file");
    const bytes = Buffer.alloc(16385); let used = 0;
    while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, used); if (!n) break; used += n; }
    if (used > 16384) throw new Error("invalid blind choice bound");
    try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)); const value = JSON.parse(text); if (encode(value) !== text) throw new Error(); return value; }
    catch { throw new Error("invalid blind choice JSON; explicit recovery required"); }
  } finally { closeSync(fd); }
}
/** One immutable quality choice per comparison. Reopening cannot reset the reveal gate. */
export function openBlindIntervention(root: string, id: string, author: string) {
  if (!SHA.test(id)) throw new Error("invalid blind comparison identity");
  const current = () => load(root, id, author);
  return Object.freeze({
    view: () => current().view(),
    quality() { const blind = current(), choice = readChoice(root, id); return choice ? blind.choose(choice) : null; },
    readArtifact: (label: string, hash: string) => current().readArtifact(label, hash),
    choose(input: BlindQualityChoice) {
      const blind = current(), choice = blind.choose(input);
      const before = readChoice(root, id);
      if (before) { blind.choose(before); if (encode(before) !== encode(choice)) throw new Error("blind quality choice locked"); return before; }
      const parent = join(root, "blind-decisions"), dir = join(parent, id);
      try { mkdirSync(parent, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      directory(parent);
      // Atomic mkdir is the single-writer claim. Never remove or recover an incomplete claim automatically.
      mkdirSync(dir, { mode: 0o700 });
      const fd = openSync(join(dir, "choice.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { const data = Buffer.from(encode(choice)); let offset = 0;
        while (offset < data.length) { const n = writeSync(fd, data, offset, data.length - offset); if (!n) throw new Error("blind choice write stalled"); offset += n; }
        fsyncSync(fd);
      } finally { closeSync(fd); }
      syncDirectory(dir); syncDirectory(parent); syncDirectory(root); return choice;
    },
    reveal() { const blind = current(), choice = readChoice(root, id); if (!choice) throw new Error("durable quality choice required before reveal"); blind.choose(choice); return blind.reveal(); },
  });
}
