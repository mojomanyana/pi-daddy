/** Small private, immutable files. Cooperative local integrity, not a hostile same-uid boundary. */
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  lstatSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { readBoundedTextSync } from "../kernel/bounded-read-sync.ts";
import type { OperationArtifactContent } from "../kernel/operation-artifact.ts";
export const artifactHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const artifactJson = (value: unknown) => JSON.stringify(value) + "\n";
export function privateArtifactDirectory(path: string, create = false): string {
  if (create) {
    const first = mkdirSync(path, { recursive: true, mode: 0o700 });
    if (first) {
      let parent = dirname(path);
      while (true) {
        const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        if (parent === dirname(first)) break;
        parent = dirname(parent);
      }
    }
  }
  if (realpathSync(path) !== path) throw Error("operation artifact directory must be canonical without symlinks");
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw Error("operation artifact directory must be private and owned by this uid");
  return path;
}
export function readArtifactBytes(reference: OperationArtifactContent, root: string, maxBytes: number): string {
  if (
    !reference ||
    typeof reference.path !== "string" ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 0 ||
    reference.bytes > maxBytes
  )
    throw Error("invalid or oversized operation artifact reference");
  const text = readBoundedTextSync(reference.path, { maxBytes, confinedRoot: root }).text;
  if (Buffer.byteLength(text) !== reference.bytes || artifactHash(text) !== reference.sha256)
    throw Error("operation artifact content identity mismatch");
  return text;
}
/** Publish without overwrite. A losing writer may reuse only byte-identical content. */
export function publishArtifact(path: string, name: string, text: string, reuse = true): OperationArtifactContent {
  privateArtifactDirectory(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const held = `/proc/self/fd/${fd}`;
  const temporary = `${name}.${randomUUID()}.tmp`;
  try {
    const info = fstatSync(fd);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077)
      throw Error("invalid artifact owner");
    const file = openSync(
      join(held, temporary),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(file, text);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    const reference = { path: join(path, name), sha256: artifactHash(text), bytes: Buffer.byteLength(text) };
    try {
      linkSync(join(held, temporary), join(held, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !reuse) throw error;
      readArtifactBytes(reference, path, reference.bytes);
    }
    fsyncSync(fd);
    const current = lstatSync(path);
    if (realpathSync(path) !== path || current.ino !== info.ino || current.dev !== info.dev)
      throw Error("artifact directory changed before publication");
    return reference;
  } finally {
    try {
      try {
        unlinkSync(join(held, temporary));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } finally {
      closeSync(fd);
    }
  }
}
