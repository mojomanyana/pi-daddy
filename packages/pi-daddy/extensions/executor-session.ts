import { chooseExecutor, needsProbe, ENV_HERDR } from "../src/executors/executor.ts";
import { qualifyHerdr } from "../src/executors/herdr-qualification.ts";
import { probeHerdr } from "../src/executors/herdr-cli.ts";
import type { GrantsSession } from "./session.ts";

/** Settle one executor at session start; default is Herdr-free subprocess across all OSs/terminals. */
export async function resolveExecutor(session: GrantsSession): Promise<void> {
  const raw = process.env[ENV_HERDR] ?? "0";
  session.executor = chooseExecutor(raw, needsProbe(raw) ? await qualifyHerdr(await probeHerdr()) : null);
}
