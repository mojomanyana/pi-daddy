/** Owner-bound access to the exact visible final of a settled initiative task. */
import { openOperationArtifacts, readOperationArtifact } from "../src/governance/operation-artifacts.ts";
import type { InitiativeAttempt } from "../src/kernel/initiative.ts";

type ArtifactScope = { cwd: string; workspaceId: string | null };
export type HandoffScope = ArtifactScope & { taskId: string; taskRevision: string };

export async function retainedInitiativeHandoff(
  directory: string,
  attempt: InitiativeAttempt,
  authorize: (scope: ArtifactScope) => Promise<void>,
) {
  const store = openOperationArtifacts(directory, attempt.owner);
  const history = store.history(attempt.operationId, false);
  const artifact = history?.artifact,
    op = history?.operation,
    runtime = op?.runtime;
  if (
    !artifact ||
    !op ||
    attempt.state === "not-admitted" ||
    history.requestDigest !== attempt.requestDigest ||
    op.executionId !== attempt.executionId ||
    op.state !== "settled" ||
    runtime?.control === "failed" ||
    runtime?.work !== "succeeded" ||
    runtime.cleanup?.state !== "settled" ||
    runtime.cleanup.executionId !== attempt.executionId ||
    runtime.final?.state !== "complete" ||
    !runtime.final.sha256
  )
    return;
  const finalSha256 = runtime.final.sha256;
  const scope = { cwd: op.cwd, workspaceId: op.workspaceId };
  const readText = async () => {
    await authorize(scope);
    const { final } = readOperationArtifact(artifact, { agentDirectory: directory });
    if (!final || final.sha256 !== finalSha256 || !final.text.trim()) throw Error("Exact retained handoff unavailable");
    return final.text;
  };
  const assertCurrent = async () => {
    await readText();
  };
  await assertCurrent();
  return {
    reference: {
      owner: "pi-daddy" as const,
      reference: {
        kind: "retained-handoff" as const,
        operationId: attempt.operationId,
        executionId: attempt.executionId,
        manifestSha256: artifact.manifest.sha256,
        finalSha256,
      },
    },
    assertCurrent,
    readText,
  };
}
