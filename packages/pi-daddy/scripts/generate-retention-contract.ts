import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildExecutionRetentionManifest, RETENTION_SCHEMA } from "../src/retention-contract.ts";
import { missingNativeSession, parseNativeSessionBytes } from "../src/native-session.ts";
import type { ExecutionRetentionManifest, RetainedContent } from "../src/execution-retention.ts";

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const missing = (): RetainedContent => ({ status: "missing", path: null, sha256: null, bytes: null });
const fixedSession = "11111111-1111-4111-8111-111111111111";
const nativeText = [
  { type: "session", version: 3, id: fixedSession, cwd: "/fixture/work", timestamp: "2026-09-08T00:00:00.000Z", parentSession: "/fixture/private/parent.jsonl" },
  { type: "message", id: "aaaaaaaa", parentId: null, timestamp: "2026-09-08T00:00:01.000Z", message: { role: "user", content: "Choose a layout", timestamp: 1788825601000 } },
  { type: "message", id: "bbbbbbbb", parentId: "aaaaaaaa", timestamp: "2026-09-08T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Layout A" }],
    api: "openai-responses", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 1788825602000,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
].map(x => JSON.stringify(x) + "\n").join("");

/** Pure deterministic producer fixtures. Fixed declarations are examples, never native-issued authority. */
export function buildRetentionContractFiles(): Readonly<Record<string, string>> {
  const files: Record<string, string> = { "manifest.schema.json": JSON.stringify(RETENTION_SCHEMA, null, 2) + "\n" };
  const retained = (kind: string, bytes: string): RetainedContent => {
    const sha256 = sha(bytes), path = `${kind}-${sha256}.bin`;
    files[`fixtures/${path}`] = bytes;
    return { status: "retained", path, sha256, bytes: Buffer.byteLength(bytes) };
  };
  const base = (n: number): ExecutionRetentionManifest => ({
    version: "2.0", archiveId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    identity: { executionId: `exec:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      parentExecutionId: "exec:00000000-0000-4000-8000-000000000099", childId: "layout-worker", toolCallId: `call:layout:${n}`,
      executor: "herdr", taskDigest: sha("Choose a layout"), definitionDigest: null, configurationDigest: sha("fixture-explicit-configuration"), workspaceId: "layout" },
    native: { pid: null, paneId: `w1:p${n}`, agentName: "layout-worker", tabId: `w1:t${n}`, sessionId: null, sessionPath: null, branchLeafId: null },
    nativeSession: missingNativeSession(), state: "terminal",
    outcome: { code: 0, signal: null, timedOut: false, aborted: false, truncated: false, failed: false },
    content: { stdout: missing(), stderr: missing(), paneSnapshot: missing(), result: missing(), checkReceipt: missing(), session: missing() },
    coverage: { complete: false, losses: ["native-session-unavailable", "active-branch-unknown"] }, acceptance: "not-assessed",
  });
  const emit = (name: string, m: ExecutionRetentionManifest) => { files[`fixtures/${name}.json`] = JSON.stringify(buildExecutionRetentionManifest(m), null, 2) + "\n"; };
  emit("missing-native-session", base(1));
  const idOnly = base(2);
  idOnly.nativeSession = { ...missingNativeSession(), source: "herdr-id", sessionId: fixedSession, reason: "native-session-path-unavailable" };
  idOnly.native.sessionId = fixedSession; emit("native-id-without-bytes", idOnly);
  for (const [n, name, live, partial] of [[3, "native-file-unknown-branch", false, false], [4, "native-live-branch", true, false], [5, "interrupted-native-bytes", false, true]] as const) {
    const m = base(n), bytes = partial ? nativeText.slice(0, -10) : nativeText;
    const capture = parseNativeSessionBytes(Buffer.from(bytes), { path: "/fixture/private/child.jsonl", source: live ? "pi-session-manager" : "herdr-path",
      ...(live ? { liveLeaf: { sessionId: fixedSession, leafId: "aaaaaaaa" } } : {}) });
    m.nativeSession = capture.observation;
    m.native.sessionId = capture.observation.sessionId; m.native.sessionPath = capture.observation.sessionPath; m.native.branchLeafId = capture.observation.branchLeafId;
    m.content.session = retained("session", bytes); m.content.result = retained("result", "Layout A\n");
    m.coverage.losses = ["not-acceptance-evidence", ...(capture.observation.reason ? [capture.observation.reason] : [])];
    if (partial) m.outcome = { code: null, signal: "SIGTERM", timedOut: false, aborted: true, truncated: true, failed: true };
    emit(name, m);
  }
  const replaced = base(6); replaced.nativeSession = { ...missingNativeSession(), source: "herdr-path", status: "changed", sessionPath: "/fixture/private/child.jsonl", reason: "native-session-file-replaced" };
  replaced.native.sessionPath = replaced.nativeSession.sessionPath; replaced.coverage.losses.push("native-session-file-replaced"); emit("replaced-native-session", replaced);
  return Object.freeze(files);
}

/** Explicit fresh destination only. Imports never read/write fixtures; --check is entirely read-only. */
export async function writeRetentionContract(target: string): Promise<void> {
  await mkdir(target); await mkdir(join(target, "fixtures"));
  for (const [name, bytes] of Object.entries(buildRetentionContractFiles())) await writeFile(join(target, name), bytes, { flag: "wx" });
}
export async function checkRetentionContract(target: string): Promise<void> {
  const files = buildRetentionContractFiles();
  for (const [name, bytes] of Object.entries(files)) if (await readFile(join(target, name), "utf8") !== bytes) throw new Error(`retention contract differs: ${name}`);
  const expected = Object.keys(files).filter(p => p.startsWith("fixtures/")).map(p => p.slice(9)).sort();
  if (JSON.stringify((await readdir(join(target, "fixtures"))).sort()) !== JSON.stringify(expected)) throw new Error("retention fixture inventory differs");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, target, extra] = process.argv.slice(2);
  if (!target || extra || !["--write", "--check"].includes(mode)) throw new Error("usage: generate-retention-contract.ts --write|--check EXPLICIT_DIRECTORY");
  if (mode === "--check") await checkRetentionContract(resolve(target)); else await writeRetentionContract(resolve(target));
}
