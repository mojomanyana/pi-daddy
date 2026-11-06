/** Bounded traversal of one trusted producer owner. No recursive discovery or dispatch. */
import { opendirSync, realpathSync, statSync, type Dir } from "node:fs";
import { join } from "node:path";
import { operationArtifactsDir } from "../kernel/project-paths.ts";
import {
  MAX_OPERATION_MANIFEST_BYTES,
  type OperationArtifactOwner,
  type OperationArtifactRef,
} from "../kernel/operation-artifact.ts";
import { readBoundedTextSync } from "../kernel/bounded-read-sync.ts";
import { artifactHash, privateArtifactDirectory } from "./operation-artifact-io.ts";
import { openOperationArtifacts } from "./operation-artifacts.ts";
export function operationArtifactInstance(agentDirectory: string): string {
  const canonical = realpathSync(agentDirectory),
    identity = statSync(canonical, { bigint: true });
  return artifactHash(
    JSON.stringify([canonical, identity.dev.toString(), identity.ino.toString(), identity.birthtimeNs.toString()]),
  );
}
export function openOperationArtifactScan(agentDirectory: string, owner: OperationArtifactOwner) {
  const store = openOperationArtifacts(agentDirectory, owner);
  const root = join(
    operationArtifactsDir(realpathSync(agentDirectory)),
    artifactHash(JSON.stringify([owner.sessionId, owner.cwd])),
  );
  let directory: Dir | undefined,
    complete = false;
  try {
    privateArtifactDirectory(root);
    directory = opendirSync(root, { bufferSize: 64 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    complete = true;
  }
  const close = () => {
    directory?.closeSync();
    directory = undefined;
    complete = true;
  };
  return {
    close,
    next(limit = 32) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw Error("invalid artifact scan limit");
      const references: OperationArtifactRef[] = [];
      let scanned = 0,
        uncertain = 0,
        issues = 0;
      while (!complete && scanned < limit) {
        const entry = directory!.readSync();
        if (!entry) {
          close();
          break;
        }
        scanned++;
        try {
          if (!entry.isDirectory() || !/^([a-f0-9]{64})$/.test(entry.name)) throw Error("invalid entry");
          const path = join(root, entry.name);
          privateArtifactDirectory(path);
          const admission = JSON.parse(
            readBoundedTextSync(join(path, "admission.json"), {
              maxBytes: MAX_OPERATION_MANIFEST_BYTES,
              confinedRoot: path,
            }).text,
          );
          const id = admission?.request?.operationId;
          if (typeof id !== "string" || artifactHash(id) !== entry.name) throw Error("invalid identity");
          const retained = store.history(id, false);
          if (retained?.artifact) references.push(retained.artifact);
          else uncertain++;
        } catch {
          issues++;
        }
      }
      return { references, scanned, uncertain, issues, complete };
    },
  };
}
