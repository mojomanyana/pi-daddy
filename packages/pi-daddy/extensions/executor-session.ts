import { chooseExecutor } from "../src/executors/executor.ts";
import type { GrantsSession } from "./session.ts";

/** Settle the subprocess executor at session start (cross-OS, zero external daemon dependency). */
export async function resolveExecutor(session: GrantsSession): Promise<void> {
  session.executor = chooseExecutor();
}
