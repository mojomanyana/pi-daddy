/** Assemble the qualified owner and primary final channel; optional observations cannot replace either. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOwnedChild, type OwnedChildRunRequest, type OwnedChildRunResult } from "./owned-worker.ts";
import type { BoundedReadCleanupError } from "../kernel/bounded-read.ts";
import { ChildFinalCapture, type ChildFinal } from "./child-final.ts";
export interface CapturedExecutionResult extends OwnedChildRunResult {
  final: ChildFinal;
  diagnostics: string;
  diagnosticsTruncated: boolean;
}
export async function runCapturedExecution(
  request: Omit<OwnedChildRunRequest, "ownershipDir" | "captureStdout"> & {
    sessionPath: string;
    onReadCleanup?: (error: BoundedReadCleanupError) => void;
  },
): Promise<CapturedExecutionResult> {
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "pi-daddy-owner-"));
  } catch (error) {
    const reason = `ownership directory unavailable before helper launch: ${String(error)}`;
    return {
      code: null,
      text: "",
      truncated: false,
      timedOut: false,
      aborted: false,
      spawnError: reason,
      cleanup: { state: "not-started", reason },
      final: { state: "unavailable", reason },
      diagnostics: "",
      diagnosticsTruncated: false,
    };
  }
  const capture = new ChildFinalCapture(request.onOutput, request.onReadCleanup);
  const args = [...request.args.slice(0, -1), "--mode", "json", request.args.at(-1)!];
  const output = await runOwnedChild({
    ...request,
    args,
    ownershipDir: join(directory, "ownership"),
    captureStdout: false,
    stopOnOutputLimit: false,
    onObservation: (stream, bytes) => {
      if (stream === "stdout") capture.observe(Buffer.from(bytes));
      request.onObservation?.(stream, bytes);
    },
  });
  const fork = args.indexOf("--fork") >= 0;
  const id = args.indexOf("--session-id");
  const final = await capture.finish(request.sessionPath, fork && id >= 0 ? args[id + 1] : undefined);
  return {
    ...output,
    final,
    truncated: false,
    diagnostics: output.text,
    diagnosticsTruncated: output.truncated,
    text: final.state === "complete" ? final.text : (final.diagnosticText ?? ""),
  };
}
