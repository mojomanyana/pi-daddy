/** Start a Pi agent only after its newly-created Herdr pane reaches a shell prompt. */
import { parseReply, type HerdrExec } from "./herdr-cli.ts";

/** Retry cadence for Herdr's documented `agent_pane_busy` startup race. */
export const PANE_READY_POLL_MS = 300;

export async function startHerdrAgent(
  exec: HerdrExec,
  name: string,
  paneId: string,
  args: string[],
  deadline: number,
): Promise<{ result?: Record<string, unknown>; error?: string }> {
  for (;;) {
    const reply = parseReply(await exec(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", ...args]));
    if (!reply.error) return reply;
    if (!/not an available shell|agent_pane_busy/.test(reply.error) || Date.now() >= deadline) return reply;
    await new Promise<void>((resolve) => setTimeout(resolve, PANE_READY_POLL_MS));
  }
}
