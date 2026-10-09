/** Assemble the qualified owner and primary final channel; optional observations cannot replace either. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  runOwned: typeof runOwnedChild = runOwnedChild,
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
  const args = [...request.args];
  if (request.terminalUi) {
    const extension = (name: string) =>
      fileURLToPath(new URL("./" + name + (import.meta.url.endsWith(".ts") ? ".ts" : ".js"), import.meta.url));
    // Pi enables editor commands before awaiting session_start handlers. The view guard must be first;
    // the event observer remains last so earlier message transformations are captured exactly.
    const firstExtension = args.findIndex(
      (arg, index) => index < args.length - 1 && ["--no-extensions", "-ne", "-e", "--extension"].includes(arg),
    );
    args.splice(firstExtension < 0 ? args.length - 1 : firstExtension, 0, "-e", extension("owned-pi-view"));
    args.splice(args.length - 1, 0, "-e", extension("owned-pi-ui"), "--tui-mode", "regular");
  } else args.splice(args.length - 1, 0, "--mode", "json");
  const output = await runOwned({
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
