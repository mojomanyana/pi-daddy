/** Exact public extension-return capture. Opt-in local observation, never an authority/acceptance source.
 * Existing operator-created root must be canonical, private and owned by this uid. Held directory
 * descriptors anchor every exclusive write; successful refs are returned only after fsync and close.
 * Hashes detect accidental edits; this does not authenticate against a hostile process with the same uid.
 */
import { randomUUID, createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DefinitionSourceSnapshot } from "../kernel/definition-sources.ts";
export const PUBLIC_EVIDENCE_SCHEMA = "pi-daddy-public-evidence-v1";
export const MAX_PUBLIC_EVIDENCE_BYTES = 64 * 1024 * 1024;
export const MAX_PUBLIC_EVIDENCE_FILES = 64;
export interface PublicEvidenceRef {
  path: string;
  sha256: string;
  bytes: number;
}
export interface PublicEvidenceOwner {
  readonly directory: string;
  readonly ownerId: string;
}
export interface PublicDefinitionEvidence {
  agent: string;
  definitionId: string;
  sourceHash: string | null;
  bodySha256: string;
  binding: Readonly<{ package: string; phase: string }> | null;
  snapshot?: DefinitionSourceSnapshot;
}
export interface PublicEvidenceRequest {
  ordinal: number;
  agent: string | null;
  requestedDefinitionId: string | null;
  definitionId: string | null;
  executionId: string | null;
}
export interface PublicFinalEvidence {
  ordinal: number;
  executionId: string | null;
  final: {
    state: "complete";
    text: string;
    sessionId: string;
    messageId: string;
    leafId: string;
    sha256: string;
  } | null;
}
export interface PublicEvidenceInput {
  toolCallId: string;
  tool: "delegate_describe" | "delegate" | "delegate_all" | "delegate_chain";
  response: { isError: boolean; content: readonly { type: "text"; text: string }[] };
  requested: readonly PublicEvidenceRequest[];
  runtimeEvidence: unknown;
  definitions: readonly PublicDefinitionEvidence[];
  finals: readonly PublicFinalEvidence[];
}
export function createPublicEvidenceOwner(directory: string | undefined): PublicEvidenceOwner | undefined {
  return directory === undefined || directory === "off"
    ? undefined
    : Object.freeze({ directory, ownerId: randomUUID() });
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n", "utf8");
/** No schema accepts arbitrary filenames, output paths, raw arguments, environment, or native details. */
export function capturePublicEvidence(owner: PublicEvidenceOwner, input: PublicEvidenceInput): PublicEvidenceRef {
  const directory = owner.directory;
  if (
    process.platform !== "linux" ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    realpathSync(directory) !== directory
  )
    throw Error("public evidence root must be an existing canonical absolute Linux directory");
  const rootFd = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const root = fstatSync(rootFd);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0)
      throw Error("public evidence root must be owned by this user and private (mode 0700)");
    const captureId = randomUUID(),
      target = join(directory, captureId);
    const rootPath = `/proc/self/fd/${rootFd}`;
    mkdirSync(join(rootPath, captureId), { mode: 0o700 });
    const captureFd = openSync(
      join(rootPath, captureId),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let manifest: PublicEvidenceRef;
    try {
      let bytes = 0,
        files = 0;
      const put = (name: string, content: Buffer): PublicEvidenceRef => {
        bytes += content.byteLength;
        files += 1;
        if (bytes > MAX_PUBLIC_EVIDENCE_BYTES || files > MAX_PUBLIC_EVIDENCE_FILES)
          throw Error("public evidence capture exceeds its byte/file limit; no complete manifest published");
        const fd = openSync(
          join(`/proc/self/fd/${captureFd}`, name),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o600,
        );
        try {
          if (!fstatSync(fd).isFile()) throw Error("public evidence target is not an ordinary file");
          writeFileSync(fd, content);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return { path: join(target, name), sha256: sha256(content), bytes: content.byteLength };
      };
      const response = put("response.json", json(input.response));
      const finals = input.finals.map((outcome) => {
        if (!outcome.final) return { ordinal: outcome.ordinal, executionId: outcome.executionId, final: null };
        const { text, ...identity } = outcome.final;
        const bytes = Buffer.from(text, "utf8");
        if (sha256(bytes) !== identity.sha256) throw Error("attributed final bytes do not match the native final hash");
        if (!text || !input.response.content.some((block) => block.text.includes(text)))
          throw Error("attributed final is not present in the public returned content");
        return {
          ordinal: outcome.ordinal,
          executionId: outcome.executionId,
          final: { ...identity, content: put(`outcome-${outcome.ordinal}-final.txt`, bytes) },
        };
      });
      const definitions = input.definitions.map((definition, index) => {
        if (!definition.snapshot) throw Error(`selected source snapshot unavailable for ${definition.agent}`);
        const resources = definition.snapshot.resources.map((source, resource) => ({
          kind: source.kind,
          path: source.path,
          copy: put(`definition-${index}-source-${resource}.bin`, Buffer.from(source.base64, "base64")),
        }));
        const { snapshot: _snapshot, ...identity } = definition;
        return {
          ...identity,
          resources,
          body: put(`definition-${index}-body.txt`, Buffer.from(definition.snapshot.body, "utf8")),
        };
      });
      manifest = put(
        "manifest.json",
        json({
          schema: PUBLIC_EVIDENCE_SCHEMA,
          version: 1,
          captureId,
          ownerId: owner.ownerId,
          toolCallId: input.toolCallId,
          tool: input.tool,
          state: "returned",
          response,
          requested: input.requested,
          runtimeEvidence: input.runtimeEvidence,
          finals,
          definitions,
        }),
      );
      fsyncSync(captureFd);
    } finally {
      closeSync(captureFd);
    }
    fsyncSync(rootFd);
    const current = statSync(directory);
    if (realpathSync(directory) !== directory || current.dev !== root.dev || current.ino !== root.ino)
      throw Error("public evidence root changed before reference publication");
    return manifest;
  } finally {
    closeSync(rootFd);
  }
}
