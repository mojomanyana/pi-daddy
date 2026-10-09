import type { childExecutionLimits } from "./dashboard-settings.ts";
/** Operator-facing execution settings; display never changes admission, deadlines or retention. */
import { timeoutFromEnv, idleTimeoutFromEnv } from "../src/kernel/run-child.ts";
import { timeoutMsFromEnv } from "../src/governance/approval-prompt.ts";
import {
  ENV_APPROVAL_TIMEOUT,
  ENV_CHILD_TIMEOUT,
  ENV_CHILD_IDLE_TIMEOUT,
  ENV_EXECUTION_ARCHIVE,
} from "../src/kernel/env-names.ts";

export function renderExecutionControls(
  nativeSessionRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  limits?: ReturnType<typeof childExecutionLimits>,
): string[] {
  let approval: string;
  try {
    const timeout = timeoutMsFromEnv(env[ENV_APPROVAL_TIMEOUT]);
    approval = timeout === undefined ? "wait for human; no deadline" : `${timeout / 1000}s configured deadline`;
  } catch {
    approval = `${ENV_APPROVAL_TIMEOUT} invalid; a needed new prompt will refuse`;
  }
  const source = (key: string) => (env[key] === undefined ? "default" : `from ${key}; zero/invalid uses default`);
  const wallSource = limits?.wallSource === "session" ? "session override; future children" : source(ENV_CHILD_TIMEOUT);
  const idleSource =
    limits?.idleSource === "session" ? "session override; future children" : source(ENV_CHILD_IDLE_TIMEOUT);
  return [
    `  child wall ${(limits?.wallMs ?? timeoutFromEnv(env[ENV_CHILD_TIMEOUT])) / 1000}s (${wallSource})`,
    `  child idle ${(limits?.idleMs ?? idleTimeoutFromEnv(env[ENV_CHILD_IDLE_TIMEOUT])) / 1000}s (${idleSource})`,
    "             process safety controls; no time/token budget is added to the model prompt",
    `  approval   ${approval}`,
    `  transcripts ${
      nativeSessionRoot === undefined
        ? "off"
        : nativeSessionRoot
          ? `opted in at ${JSON.stringify(nativeSessionRoot)}; destination checked at dispatch`
          : "opted in but native session root is missing"
    }`,
    `  diagnostics ${
      env[ENV_EXECUTION_ARCHIVE]
        ? `configured at ${JSON.stringify(env[ENV_EXECUTION_ARCHIVE])}; check each result's retention status`
        : "off"
    }`,
    "             local diagnostic retention is separate from JEV/LoRA consent",
  ];
}
