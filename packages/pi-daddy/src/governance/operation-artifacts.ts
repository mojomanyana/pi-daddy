/** Durable producer outcomes; opening/reading never starts governance, work, or Bookie registration. */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { readBoundedTextSync } from "../kernel/bounded-read-sync.ts";
import { operationArtifactsDir } from "../kernel/project-paths.ts";
import { validOperationId, type OperationRequest, type OperationReference } from "../kernel/dispatch-operation.ts";
import {
  MAX_OPERATION_ARTIFACT_BYTES,
  MAX_OPERATION_MANIFEST_BYTES,
  type OperationArtifactOwner,
  type OperationArtifactRef,
  type OperationArtifactManifest,
  type OperationArtifactOutcome,
  type RetainedOperationFinal,
} from "../kernel/operation-artifact.ts";
import {
  artifactHash,
  artifactJson,
  privateArtifactDirectory,
  publishArtifact,
  readArtifactBytes,
} from "./operation-artifact-io.ts";
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const bounded = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function ownerCheck(owner: OperationArtifactOwner) {
  if (!object(owner) || !bounded(owner.sessionId, 512) || !bounded(owner.cwd) || !owner.cwd.startsWith("/"))
    throw Error("invalid operation artifact owner");
}
function requestCheck(request: OperationRequest) {
  if (
    !object(request) ||
    !validOperationId(request.operationId) ||
    !digest(request.requestDigest) ||
    !bounded(request.executionId, 128) ||
    !request.executionId.startsWith("exec:") ||
    !bounded(request.cwd) ||
    !request.cwd.startsWith("/") ||
    !(request.workspaceId === null || bounded(request.workspaceId, 512))
  )
    throw Error("invalid operation artifact request");
}
const requestFields = ["operationId", "executionId", "requestDigest", "cwd", "workspaceId"] as const;
const sameRequest = (a: OperationRequest, b: OperationRequest) => requestFields.every((key) => a?.[key] === b?.[key]);
const cleanRequest = (request: OperationRequest): OperationRequest => ({
  operationId: request.operationId,
  executionId: request.executionId,
  requestDigest: request.requestDigest,
  cwd: request.cwd,
  workspaceId: request.workspaceId,
});
interface ResolvedScope {
  version: 1;
  executionId: string;
  cwd: string;
  workspaceId: string | null;
}
function resolvedScope(path: string, admission: Admission): ResolvedScope | null {
  try {
    const scope = JSON.parse(
      readBoundedTextSync(join(path, "scope.json"), {
        maxBytes: MAX_OPERATION_MANIFEST_BYTES,
        confinedRoot: path,
      }).text,
    );
    if (
      !object(scope) ||
      scope.version !== 1 ||
      scope.executionId !== admission.request.executionId ||
      !bounded(scope.cwd) ||
      !scope.cwd.startsWith("/") ||
      scope.workspaceId !== admission.request.workspaceId ||
      (scope.workspaceId === null && scope.cwd !== admission.request.cwd)
    )
      throw Error("invalid resolved operation scope");
    return scope as ResolvedScope;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function location(directory: string | undefined, owner: OperationArtifactOwner, operationId: string) {
  ownerCheck(owner);
  if (!validOperationId(operationId)) throw Error("invalid operation artifact operationId");
  const root = operationArtifactsDir(directory === undefined ? undefined : realpathSync(directory));
  return join(root, artifactHash(JSON.stringify([owner.sessionId, owner.cwd])), artifactHash(operationId));
}
interface Admission {
  version: 1;
  producer: "pi-daddy";
  owner: OperationArtifactOwner;
  request: OperationRequest;
  admittedAt: string;
}
function parseAdmission(text: string, owner: OperationArtifactOwner, id: string): Admission {
  const v = JSON.parse(text);
  if (
    !object(v) ||
    v.version !== 1 ||
    v.producer !== "pi-daddy" ||
    v.owner?.sessionId !== owner.sessionId ||
    v.owner?.cwd !== owner.cwd ||
    v.request?.operationId !== id ||
    !bounded(v.admittedAt, 64)
  )
    throw Error("invalid operation admission manifest");
  requestCheck(v.request);
  return v as Admission;
}
function admissionAt(path: string, owner: OperationArtifactOwner, id: string): Admission | null {
  try {
    privateArtifactDirectory(path);
    return parseAdmission(
      readBoundedTextSync(join(path, "admission.json"), {
        maxBytes: MAX_OPERATION_MANIFEST_BYTES,
        confinedRoot: path,
      }).text,
      owner,
      id,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function manifestCheck(v: unknown, admission: Admission, path: string): OperationArtifactManifest {
  if (
    !object(v) ||
    v.version !== 1 ||
    v.producer !== "pi-daddy" ||
    v.owner?.sessionId !== admission.owner.sessionId ||
    v.owner?.cwd !== admission.owner.cwd ||
    !sameRequest(v.request, admission.request) ||
    !object(v.operation) ||
    v.operation.operationId !== admission.request.operationId ||
    v.operation.executionId !== admission.request.executionId ||
    !["settled", "not-started", "uncertain"].includes(v.operation.state) ||
    !bounded(v.observedAt, 64) ||
    !bounded(v.operation.cwd) ||
    !(v.operation.workspaceId === null || bounded(v.operation.workspaceId, 512)) ||
    !bounded(v.operation.startedAt, 64) ||
    !bounded(v.operation.updatedAt, 64) ||
    v.operation.artifact !== undefined
  )
    throw Error("invalid operation result manifest");
  const expectedScope = resolvedScope(path, admission) ?? admission.request;
  if (v.operation.cwd !== expectedScope.cwd || v.operation.workspaceId !== expectedScope.workspaceId)
    throw Error("operation result scope does not match its admitted execution");
  if (v.final) {
    const observed = v.operation.runtime?.final;
    if (
      !object(v.final) ||
      v.final.state !== "complete" ||
      !digest(v.final.sha256) ||
      !["sessionId", "messageId", "leafId"].every((k) => bounded(v.final[k], 512)) ||
      v.final.content?.path !== join(path, "final.txt") ||
      v.final.content?.sha256 !== v.final.sha256 ||
      observed?.state !== "complete" ||
      !["sessionId", "messageId", "leafId", "sha256"].every((k) => observed[k] === v.final[k])
    )
      throw Error("operation native final identity mismatch");
  }
  if (v.partial && v.partial.path !== join(path, "partial.txt")) throw Error("invalid partial artifact path");
  if (v.final && v.partial) throw Error("exact final and partial evidence cannot be conflated");
  return v as OperationArtifactManifest;
}
function refFor(manifest: OperationArtifactManifest, content: OperationArtifactRef["manifest"]): OperationArtifactRef {
  return {
    version: 1,
    producer: "pi-daddy",
    owner: { ...manifest.owner },
    operationId: manifest.request.operationId,
    executionId: manifest.request.executionId,
    manifest: content,
  };
}
export interface ReadOperationArtifactOptions {
  /** Trusted selected agent directory, never inferred from the reference. */
  agentDirectory?: string;
  /** Maximum returned authored bytes. Metadata has its own 64 KiB bound. */
  maxBytes?: number;
}
/** Exact immutable read; a successful read is not current applicability or execution authority. */
export function readOperationArtifact(reference: OperationArtifactRef, options: ReadOperationArtifactOptions = {}) {
  if (!object(reference) || reference.version !== 1 || reference.producer !== "pi-daddy")
    throw Error("unsupported operation artifact reference");
  const path = location(options.agentDirectory, reference.owner, reference.operationId);
  if (reference.manifest?.path !== join(path, "result.json"))
    throw Error("operation artifact path does not match owner");
  const admission = admissionAt(path, reference.owner, reference.operationId);
  if (!admission || reference.executionId !== admission.request.executionId)
    throw Error("operation artifact admission identity mismatch");
  const manifest = manifestCheck(
    JSON.parse(readArtifactBytes(reference.manifest, path, MAX_OPERATION_MANIFEST_BYTES)),
    admission,
    path,
  );
  const maxBytes = options.maxBytes ?? MAX_OPERATION_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_OPERATION_ARTIFACT_BYTES)
    throw Error("invalid operation artifact read limit");
  let final: RetainedOperationFinal | undefined;
  let partial: { text: string; sha256: string } | undefined;
  if (manifest.final) {
    const { content, ...identity } = manifest.final;
    final = { ...identity, text: readArtifactBytes(content, path, maxBytes) };
  }
  if (manifest.partial)
    partial = { text: readArtifactBytes(manifest.partial, path, maxBytes), sha256: manifest.partial.sha256 };
  return { manifest, ...(final ? { final } : {}), ...(partial ? { partial } : {}) };
}
export interface OperationArtifactHistory {
  operation: OperationReference;
  requestDigest: string;
  reason?: string;
  artifact?: OperationArtifactRef;
  final?: RetainedOperationFinal;
  partial?: { text: string; sha256: string };
}
export function openOperationArtifacts(agentDirectory: string, owner: OperationArtifactOwner) {
  ownerCheck(owner);
  const directory = realpathSync(agentDirectory);
  privateArtifactDirectory(operationArtifactsDir(directory), true);
  const history = (operationId: string, includeFinal = true): OperationArtifactHistory | null => {
    const path = location(directory, owner, operationId);
    const admission = admissionAt(path, owner, operationId);
    if (!admission) return null;
    let text: string;
    try {
      text = readBoundedTextSync(join(path, "result.json"), {
        maxBytes: MAX_OPERATION_MANIFEST_BYTES,
        confinedRoot: path,
      }).text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const scope = resolvedScope(path, admission) ?? admission.request;
      const operation: OperationReference = {
        operationId,
        executionId: admission.request.executionId,
        cwd: scope.cwd,
        workspaceId: scope.workspaceId,
        state: "uncertain",
        startedAt: admission.admittedAt,
        updatedAt: admission.admittedAt,
      };
      return {
        operation,
        requestDigest: admission.request.requestDigest,
        reason: "admission retained without a published result; no retry or no-start proof",
      };
    }
    const manifest = manifestCheck(JSON.parse(text), admission, path);
    const artifact = refFor(manifest, {
      path: join(path, "result.json"),
      sha256: artifactHash(text),
      bytes: Buffer.byteLength(text),
    });
    const content = includeFinal ? readOperationArtifact(artifact, { agentDirectory: directory }) : undefined;
    return {
      operation: { ...manifest.operation, artifact },
      artifact,
      requestDigest: admission.request.requestDigest,
      ...(content?.final ? { final: content.final } : {}),
      ...(content?.partial ? { partial: content.partial } : {}),
    };
  };
  return {
    owner: Object.freeze({ ...owner }),
    history,
    admit(request: OperationRequest) {
      requestCheck(request);
      request = cleanRequest(request);
      const existing = history(request.operationId, false);
      if (existing) {
        if (existing.requestDigest !== request.requestDigest)
          throw Error("Operation identity conflict with retained request");
        return { created: false, ...existing };
      }
      const path = location(directory, owner, request.operationId);
      privateArtifactDirectory(path, true);
      const admission: Admission = {
        version: 1,
        producer: "pi-daddy",
        owner: { ...owner },
        request: { ...request },
        admittedAt: new Date().toISOString(),
      };
      try {
        publishArtifact(path, "admission.json", artifactJson(admission), false);
      } catch (error) {
        const winner = history(request.operationId, false);
        if (!winner) throw error;
        if (winner.requestDigest !== request.requestDigest)
          throw Error("Operation identity conflict with retained request");
        return { created: false, ...winner };
      }
      return { created: true };
    },
    started(request: OperationRequest, cwd: string, workspaceId: string | null) {
      requestCheck(request);
      const path = location(directory, owner, request.operationId),
        admission = admissionAt(path, owner, request.operationId);
      if (
        !admission ||
        !sameRequest(admission.request, request) ||
        !bounded(cwd) ||
        !cwd.startsWith("/") ||
        workspaceId !== request.workspaceId ||
        (workspaceId === null && cwd !== request.cwd)
      )
        throw Error("resolved operation scope does not match its admitted request");
      publishArtifact(
        path,
        "scope.json",
        artifactJson({ version: 1, executionId: request.executionId, cwd, workspaceId }),
      );
    },
    finish(request: OperationRequest, outcome: OperationArtifactOutcome): OperationArtifactRef {
      requestCheck(request);
      request = cleanRequest(request);
      const path = location(directory, owner, request.operationId);
      const admission = admissionAt(path, owner, request.operationId);
      if (!admission || !sameRequest(admission.request, request))
        throw Error("operation result does not own its admission");
      const { artifact: _artifact, ...operation } = outcome.operation as OperationReference;
      const manifest: OperationArtifactManifest = {
        version: 1,
        producer: "pi-daddy",
        owner: { ...owner },
        request: { ...request },
        operation,
        observedAt: operation.updatedAt,
      };
      if (outcome.final) {
        const { text, ...identity } = outcome.final;
        if (
          typeof text !== "string" ||
          Buffer.byteLength(text) > MAX_OPERATION_ARTIFACT_BYTES ||
          artifactHash(text) !== identity.sha256
        )
          throw Error("invalid or oversized exact final");
        manifest.final = {
          ...identity,
          content: { path: join(path, "final.txt"), sha256: identity.sha256, bytes: Buffer.byteLength(text) },
        };
      } else if (outcome.partial !== undefined) {
        if (typeof outcome.partial !== "string" || Buffer.byteLength(outcome.partial) > MAX_OPERATION_ARTIFACT_BYTES)
          throw Error("oversized partial output");
        manifest.partial = {
          path: join(path, "partial.txt"),
          sha256: artifactHash(outcome.partial),
          bytes: Buffer.byteLength(outcome.partial),
        };
      }
      manifestCheck(manifest, admission, path);
      if (manifest.final) publishArtifact(path, "final.txt", outcome.final!.text);
      if (manifest.partial) publishArtifact(path, "partial.txt", outcome.partial!);
      const text = artifactJson(manifest);
      if (Buffer.byteLength(text) > MAX_OPERATION_MANIFEST_BYTES) throw Error("oversized operation manifest");
      return refFor(manifest, publishArtifact(path, "result.json", text));
    },
  };
}
export type OperationArtifactStore = ReturnType<typeof openOperationArtifacts>;
