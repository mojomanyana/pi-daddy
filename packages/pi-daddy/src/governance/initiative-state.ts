/** Bounded private snapshot under the existing Daddy agent state; callers hold the existing OS lock. */
import { randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { readBoundedTextSync } from "../kernel/bounded-read-sync.ts";
import { initiativeStateDir } from "../kernel/project-paths.ts";
import { validOperationId } from "../kernel/dispatch-operation.ts";
import {
  validInitiativeId,
  validEffectReceipt,
  sameEffectTarget,
  validInitiativeTask,
  type InitiativeRecord,
} from "../kernel/initiative.ts";
import { artifactHash, privateArtifactDirectory } from "./operation-artifact-io.ts";
const MAX_BYTES = 512 * 1024;
export const initiativeRevision = (record: InitiativeRecord): string => artifactHash(JSON.stringify(record));
export function initiativeLocation(directory: string, id: string, create = false) {
  if (!validInitiativeId(id)) throw Error("invalid initiative identity");
  const root = initiativeStateDir(realpathSync(directory));
  privateArtifactDirectory(root, create);
  return { root, path: join(root, artifactHash(id) + ".json") };
}
export function validateInitiative(v: unknown, id: string): InitiativeRecord {
  const r = v as InitiativeRecord;
  if (
    !r ||
    r.version !== 1 ||
    r.initiativeId !== id ||
    !Number.isSafeInteger(r.generation) ||
    r.generation < 1 ||
    !r.owner ||
    typeof r.owner.sessionId !== "string" ||
    !r.owner.sessionId ||
    r.owner.sessionId.length > 512 ||
    typeof r.owner.cwd !== "string" ||
    !r.owner.cwd.startsWith("/") ||
    r.owner.cwd.length > 4096 ||
    !["owned", "released"].includes(r.state) ||
    !Array.isArray(r.tasks) ||
    r.tasks.length > 256
  )
    throw Error("invalid initiative record");
  const keys = new Set<string>(),
    operations = new Set<string>();
  let attempts = 0;
  for (const t of r.tasks) {
    const key = JSON.stringify([t.taskId, t.taskRevision]);
    if (
      !validInitiativeTask(t) ||
      keys.has(key) ||
      !Number.isSafeInteger(t.generation) ||
      t.generation < 1 ||
      t.generation > r.generation ||
      !Array.isArray(t.attempts)
    )
      throw Error("invalid initiative task record");
    keys.add(key);
    for (const a of t.attempts) {
      const key = JSON.stringify([a.owner?.sessionId, a.owner?.cwd, a.operationId]);
      if (
        ++attempts > 1024 ||
        operations.has(key) ||
        !validOperationId(a.operationId) ||
        typeof a.executionId !== "string" ||
        !a.executionId.startsWith("exec:") ||
        a.executionId.length > 128 ||
        typeof a.requestDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(a.requestDigest) ||
        !a.owner?.sessionId ||
        a.owner.sessionId.length > 512 ||
        typeof a.owner.cwd !== "string" ||
        !a.owner.cwd.startsWith("/") ||
        a.owner.cwd.length > 4096 ||
        !["pending", "not-admitted"].includes(a.state) ||
        (a.effectReceipt !== undefined && !validEffectReceipt(a.effectReceipt)) ||
        (a.effectReceipt?.observation !== undefined &&
          !sameEffectTarget(t.effectTarget, a.effectReceipt.observation.target))
      )
        throw Error("invalid initiative attempt record");
      operations.add(key);
    }
  }
  return r;
}
export function readInitiativeState(directory: string, id: string) {
  try {
    const { path, root } = initiativeLocation(directory, id);
    const record = validateInitiative(
      JSON.parse(readBoundedTextSync(path, { maxBytes: MAX_BYTES, confinedRoot: root }).text),
      id,
    );
    return { record, revision: initiativeRevision(record) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const root = initiativeStateDir(realpathSync(directory));
      if (existsSync(join(root, artifactHash(id) + ".json.initialized")))
        throw Error("initiative state missing; restore trusted state");
      return null;
    }
    throw error;
  }
}
export function saveInitiative(path: string, root: string, record: InitiativeRecord) {
  validateInitiative(record, record.initiativeId);
  const text = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(text) > MAX_BYTES) throw Error("initiative record exceeds bound");
  privateArtifactDirectory(root);
  const temporary = path + "." + randomUUID();
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
