/**
 * Child executor selection (Layer 2: executors).
 *
 * Governed children always run via captured subprocesses (hardened native worker on Linux x64,
 * portable child runner on macOS and Windows) with zero external terminal-multiplexer dependency.
 */

export { EXECUTOR_KINDS, type ExecutorKind } from "../kernel/delegate-types.ts";
import type { ExecutorKind } from "../kernel/delegate-types.ts";

export interface ExecutorChoice {
  kind: ExecutorKind;
  forced: boolean;
  probed: boolean;
  refusal?: string;
  disclosure: string;
}

export function chooseExecutor(): ExecutorChoice {
  return {
    kind: "process",
    forced: false,
    probed: false,
    disclosure: "captured subprocess — cross-OS (Linux/macOS/Windows)",
  };
}
