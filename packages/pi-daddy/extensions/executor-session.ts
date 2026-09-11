import { chooseExecutor, needsProbe, ENV_HERDR } from "../src/executor.ts";
import { probeHerdr } from "../src/herdr-cli.ts";
import type { GrantsSession } from "./session.ts";

/** Settle one executor at session start; a later daemon change never relocates siblings. */
export async function resolveExecutor(session:GrantsSession):Promise<void>{
 const raw=process.env[ENV_HERDR];
 session.executor=chooseExecutor(raw,needsProbe(raw)?await probeHerdr():null);
}
