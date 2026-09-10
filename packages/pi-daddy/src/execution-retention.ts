import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { buildExecutionRetentionManifest } from "./retention-contract.ts";
import { missingNativeSession, readNativeSession, type NativeSessionObservation, type NativeSessionManager, type NativeSessionCapture } from "./native-session.ts";
export { buildExecutionRetentionManifest, parseExecutionRetentionManifest, RETENTION_SCHEMA } from "./retention-contract.ts";
export { ENV_NATIVE_SESSION_ROOT, readNativeSession, parseNativeSessionBytes, type NativeSessionObservation, type NativeSessionManager } from "./native-session.ts";

/** Operator-owned archive boundary; never a model-facing parameter or an authority source. */
export const ENV_EXECUTION_ARCHIVE = "PI_GRANTS_EXECUTION_ARCHIVE";
export const RETENTION_VERSION = "2.0";
const LIMIT = 1024 * 1024;
const MAX_ACTIVE = 32;
let active = 0;
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export interface RetentionIdentity {
  executionId: string;
  parentExecutionId: string | null;
  childId: string;
  toolCallId: string | null;
  executor: "process" | "herdr" | "check";
  taskDigest: string | null;
  definitionDigest: string | null;
  configurationDigest: string;
  workspaceId: string | null;
}
export interface RetainedContent {
  status: "retained" | "missing";
  path: string | null;
  sha256: string | null;
  bytes: number | null;
}
export interface ExecutionRetentionManifest {
  version: "2.0";
  archiveId: string;
  identity: RetentionIdentity;
  native: { pid: number | null; paneId: string | null; agentName: string | null; tabId: string | null;
    sessionId: string | null; sessionPath: string | null; branchLeafId: string | null };
  nativeSession: NativeSessionObservation;
  state: "running" | "terminal";
  outcome: { code: number | null; signal: string | null; timedOut: boolean; aborted: boolean;
    truncated: boolean; failed: boolean } | null;
  content: Record<"stdout" | "stderr" | "paneSnapshot" | "checkReceipt" | "result" | "session", RetainedContent>;
  coverage: { complete: false; losses: string[] };
  /** Retention is observation, never a work-v4 acceptance decision. */
  acceptance: "not-assessed";
}
export interface RetentionStatus { manifestPath: string | null; status: "disabled" | "pending" | "retained" | "lost" }
const drains = new WeakMap<RetentionStatus, () => Promise<RetentionStatus>>();
/** Original live status only; drains admitted observations, not producer completeness or fsync. */
export function drainExecutionRetention(status: RetentionStatus): Promise<RetentionStatus> {
  const drain = drains.get(status);
  if (!drain) return Promise.reject(new TypeError("original live retention status required"));
  return drain();
}
const missing = (): RetainedContent => ({ status: "missing", path: null, sha256: null, bytes: null });

/** Hash only an explicitly selected configuration. Callers must not pass environment/auth objects. */
export const retentionConfigurationDigest = (configuration: unknown): string => digest(JSON.stringify(configuration));

/**
 * A bounded, coalescing observation queue. No worker-control path awaits publication. A failed or stalled
 * archive never changes required ledger/lease semantics. `flush` is exclusively for external archival at
 * quiescence; it is NOT called by the spawner. Missing terminal publication means incomplete observation.
 */
export function beginExecutionRetention(identity: RetentionIdentity, directory = process.env[ENV_EXECUTION_ARCHIVE]) {
  const archiveId = randomUUID();
  const valid = Boolean(directory && isAbsolute(directory) && !directory.split(/[\\/]/).includes(".pi"));
  const admitted = valid && active < MAX_ACTIVE;
  const root = admitted ? join(directory!, archiveId) : null;
  const manifestPath = root ? join(root, "manifest.json") : null;
  let status: RetentionStatus["status"] = !directory ? "disabled" : admitted ? "pending" : "lost";
  const manifest: ExecutionRetentionManifest = {
    version: RETENTION_VERSION, archiveId, identity: {
      executionId: identity.executionId, parentExecutionId: identity.parentExecutionId, childId: identity.childId,
      toolCallId: identity.toolCallId, executor: identity.executor, taskDigest: identity.taskDigest,
      definitionDigest: identity.definitionDigest, configurationDigest: identity.configurationDigest, workspaceId: identity.workspaceId,
    },
    native: { pid: null, paneId: null, agentName: null, tabId: null, sessionId: null, sessionPath: null, branchLeafId: null },
    nativeSession: missingNativeSession(),
    state: "running", outcome: null,
    content: { stdout: missing(), stderr: missing(), paneSnapshot: missing(), checkReceipt: missing(), result: missing(), session: missing() },
    coverage: { complete: false, losses: ["native-session-content-unavailable", "active-branch-unknown"] },
    acceptance: "not-assessed",
  };
  const buffers = new Map<keyof typeof manifest.content, Buffer>();
  const written = new Set<string>();
  let total = 0;
  let dirty = false;
  let running: Promise<void> | undefined;
  let finished = false;
  let released = false;
  let nativeTask: Promise<void> | undefined;
  let nextNative: { source: "herdr-id" | "herdr-path" | "pi-session-file" | "pi-session-manager"; value: string; manager?: NativeSessionManager } | undefined;
  let pinnedSessionId: string | undefined;
  let pinnedFile: NativeSessionCapture["fileIdentity"];
  const loss = (reason: string) => { if (!manifest.coverage.losses.includes(reason)) manifest.coverage.losses.push(reason); };
  const release = () => { if (admitted && !released) { active--; released = true; } };
  if (admitted) active++;
  else if (directory) loss("archive-unavailable-or-capacity-exceeded");
  const publish = async () => {
    try {
      await mkdir(root!, { recursive: true, mode: 0o700 });
      while (dirty) {
        dirty = false;
        // Detached checkpoint: asynchronous I/O cannot mix later outcome/content into this generation.
        const checkpoint: ExecutionRetentionManifest = JSON.parse(JSON.stringify(manifest));
        const contents = [...buffers];
        for (const [kind, bytes] of contents) {
          const sha256 = digest(bytes);
          const name = `${kind}-${sha256}.bin`;
          if (!written.has(name)) {
            await writeFile(join(root!, name), bytes, { flag: "wx", mode: 0o600 });
            written.add(name);
          }
          checkpoint.content[kind] = { status: "retained", path: name, sha256, bytes: bytes.length };
        }
        await writeFile(join(root!, "manifest.pending"), JSON.stringify(buildExecutionRetentionManifest(checkpoint)) + "\n", { mode: 0o600 });
        await rename(join(root!, "manifest.pending"), manifestPath!);
        status = "retained";
      }
    } catch {
      status = "lost";
      loss("archive-write-failed");
      buffers.clear();
      release();
    } finally {
      running = undefined;
      if (finished && !nativeTask) { buffers.clear(); release(); }
    }
  };
  const schedule = () => {
    if (!admitted || status === "lost" || released) return;
    dirty = true;
    status = "pending";
    if (!running) running = Promise.resolve().then(publish);
  };
  const observeSession = (reference: NonNullable<typeof nextNative>) => {
    if (finished || !admitted || released || status === "lost") return;
    if (nextNative && (nextNative.source !== reference.source || nextNative.value !== reference.value)) loss("native-session-reference-coalesced");
    nextNative = { source: reference.source, value: reference.value, ...(reference.manager ? { manager: reference.manager } : {}) };
    if (nativeTask) return;
    nativeTask = Promise.resolve().then(async () => {
      while (nextNative) {
        const current = nextNative; nextNative = undefined;
        const captured: NativeSessionCapture = current.source === "herdr-id"
          ? { observation: { ...missingNativeSession(), source: current.source, status: "missing" as const,
              sessionId: current.value, reason: "native-session-path-unavailable" } }
          : await readNativeSession({ path: current.value, source: current.source, manager: current.manager, expectedSessionId: pinnedSessionId, expectedFile: pinnedFile });
        if (captured.observation.sessionId && captured.fileIdentity) pinnedFile ??= captured.fileIdentity;
        let observation = captured.observation;
        if (pinnedSessionId && observation.sessionId && pinnedSessionId !== observation.sessionId) {
          observation = { ...missingNativeSession(), source: current.source, status: "changed", reason: "native-session-id-changed" };
        }
        if (observation.sessionId) pinnedSessionId ??= observation.sessionId;
        manifest.nativeSession = { ...observation };
        manifest.native.sessionId = observation.sessionId;
        manifest.native.sessionPath = observation.sessionPath;
        manifest.native.branchLeafId = observation.branchLeafId;
        buffers.delete("session");
        if (captured.bytes && observation === captured.observation) buffers.set("session", captured.bytes);
        if (observation.reason) loss(observation.reason);
        schedule();
      }
    }).catch(() => { loss("native-session-observation-failed"); }).finally(() => { nativeTask = undefined; schedule(); });
  };
  const drain = async (): Promise<RetentionStatus> => {
    while (nativeTask || running) { if (nativeTask) await nativeTask; if (running) await running; }
    return { manifestPath, status };
  };
  schedule();
  return {
    /** Read-only native API reference; never derive IDs from the locator or a displayed name. */
    observeSession,
    observeSessionManager(manager: NativeSessionManager) {
      try {
        const value = manager.getSessionFile();
        if (value) observeSession({ source: "pi-session-manager", value, manager });
        else { loss("native-session-not-persisted"); schedule(); }
      } catch { loss("native-session-manager-unavailable"); schedule(); }
    },
    status: (): RetentionStatus => { const value = { manifestPath, status }; drains.set(value, drain); return value; },
    native(value: Partial<Pick<ExecutionRetentionManifest["native"], "pid" | "paneId" | "agentName" | "tabId">>) {
      if (finished) return;
      for (const key of ["pid", "paneId", "agentName", "tabId"] as const) {
        const item = value[key];
        if (key === "pid") { if (typeof item === "number" && Number.isSafeInteger(item) && item > 0) manifest.native.pid = item; }
        else if (typeof item === "string" && item.length <= 4096) manifest.native[key] = item;
      }
      schedule();
    },
    capture(kind: "stdout" | "stderr" | "paneSnapshot" | "checkReceipt" | "result", bytes: Uint8Array, replace = false) {
      if (finished || !admitted || status === "lost") return;
      const indivisible = kind === "checkReceipt" || kind === "result";
      if (indivisible) replace = true;
      const old = buffers.get(kind) ?? Buffer.alloc(0);
      const available = indivisible ? LIMIT : LIMIT - total + (replace ? old.length : 0);
      // Receipts and assembled results each have reserved capacity and are never partially published.
      if (indivisible && bytes.length > available) { loss(`${kind === "checkReceipt" ? "check-receipt" : kind}-not-retained-capacity`); schedule(); return; }
      const kept = Buffer.from(bytes.subarray(0, Math.max(0, available)));
      if (kept.length !== bytes.length) loss(`${kind}-observation-dropped`);
      if (kind === "paneSnapshot") loss("pane-snapshot-not-full-transcript");
      const next = replace ? kept : Buffer.concat([old, kept]);
      if (!indivisible) total += next.length - old.length;
      buffers.set(kind, next);
      schedule();
    },
    finish(outcome: NonNullable<ExecutionRetentionManifest["outcome"]>) {
      if (finished) return;
      manifest.outcome = { code: outcome.code, signal: outcome.signal, timedOut: outcome.timedOut,
        aborted: outcome.aborted, truncated: outcome.truncated, failed: outcome.failed };
      manifest.state = "terminal";
      if (outcome.truncated) loss("executor-output-truncated");
      if (outcome.aborted || outcome.timedOut) loss("execution-interrupted");
      finished = true;
      schedule();
    },
    /** Observation-only diagnostic; never establishes successful execution or accepted work. */
    coverage: () => ({ complete: false as const, losses: [...manifest.coverage.losses] }),
    flush: drain,
  };
}
export type ExecutionRetention = ReturnType<typeof beginExecutionRetention>;

/** Public consumer check: neither a reference nor a wire status supplies the missing bytes. */
export function verifyRetainedBytes(reference: RetainedContent, bytes?: Uint8Array): "retained" | "missing" | "mismatch" {
  if (reference.status !== "retained" || bytes === undefined) return "missing";
  if (reference.bytes !== bytes.byteLength || reference.sha256 !== digest(bytes)) return "mismatch";
  return "retained";
}
