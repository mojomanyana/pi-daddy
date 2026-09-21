/**
 * Herdr reserves agent names across all parents until their tabs close.
 * A counter alone is process-local: parallel parents and module reloads repeat it.
 * Keep the readable base separate from a fresh, 80-bit execution suffix.
 */
import { randomBytes } from "node:crypto";

const AGENT_NAME_MAX = 32;

/** Valid Herdr identity independent of process counters, parent labels and reloads. */
export function uniqueAgentName(base: string): string {
  const suffix = "-" + randomBytes(10).toString("hex");
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z]+/, "");
  const room = AGENT_NAME_MAX - suffix.length;
  const head = cleaned.slice(0, room).replace(/[-_]+$/, "") || "agent";
  return head + suffix;
}
