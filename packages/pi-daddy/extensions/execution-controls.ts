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
): string[] {
  let approval: string;
  try {
    const timeout = timeoutMsFromEnv(env[ENV_APPROVAL_TIMEOUT]);
    approval = timeout === undefined ? "wait for human; no deadline" : `${timeout / 1000}s configured deadline`;
  } catch {
    approval = `${ENV_APPROVAL_TIMEOUT} invalid; a needed new prompt will refuse`;
  }
  const source = (key: string) => (env[key] === undefined ? "default" : `from ${key}; zero/invalid uses default`);
  return [
    `  child wall ${timeoutFromEnv(env[ENV_CHILD_TIMEOUT]) / 1000}s (${source(ENV_CHILD_TIMEOUT)})`,
    `  child idle ${idleTimeoutFromEnv(env[ENV_CHILD_IDLE_TIMEOUT]) / 1000}s (${source(ENV_CHILD_IDLE_TIMEOUT)})`,
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
