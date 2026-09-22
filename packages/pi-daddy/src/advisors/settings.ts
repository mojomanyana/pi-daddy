/**
 * Whether an advisor is on, and which one (ADR-0077).
 *
 * **Default off, and off is the whole configuration when nothing says otherwise.** An advisor sends a description
 * of the caller's situation to a third party, so it is not something a package turns on for somebody: it is turned
 * on in `.pi/pi-daddy/settings.json`, the file an operator reviews and commits, beside the grant that governs
 * everything else. Malformed configuration disables the advisor and says so, which is this project's rule for
 * configuration everywhere: a typo must not be a way to enable something.
 *
 * **Not a dashboard toggle**, which is what the programme originally sketched. The dashboard is a read-only
 * renderer in a separate process that "never affects enforcement" (ADR-0036), and a control there that wrote to
 * settings would be the first thing it ever wrote. Turning an advisor on is an operator decision that belongs in
 * the reviewable file; `/grants` reports what is in force. That is a deliberate departure from the roadmap line.
 *
 * The key is never in this file. It is read from the environment, because a settings file is committed and an API
 * key must not be.
 */

// Spelled once, in the kernel's table, so this layer cannot drift from the list `childEnv` refuses to write.
export { ENV_ADVISOR_KEY as ADVISOR_KEY_ENV } from "../kernel/env-names.ts";
import { ENV_ADVISOR_KEY } from "../kernel/env-names.ts";

export interface AdvisorSettings {
  enabled: boolean;
  /** The only decider this release knows besides the null one. */
  decider: "none" | "jev";
  /** Overrides the adapter's pinned model id; absent means the adapter's own default. */
  model?: string;
  timeoutMs?: number;
  /** Why an advisor is off when the settings asked for one on — reported, never silently applied. */
  refusal?: string;
}

export const ADVISOR_OFF: AdvisorSettings = Object.freeze({ enabled: false, decider: "none" });

/**
 * Read the `advisor` block of a project settings file. Absent is off; malformed is off WITH a reason.
 *
 * The reason matters more than it looks: an operator who wrote `"enabeld": true` and got silence would conclude the
 * feature does not work, and an operator who wrote it and got an advisor anyway would have a third party reading
 * their session without having successfully asked for it. Both are worse than a sentence naming the field.
 */
export function advisorSettingsFrom(raw: unknown, env: NodeJS.ProcessEnv = process.env): AdvisorSettings {
  if (raw === undefined || raw === null) return ADVISOR_OFF;
  if (typeof raw !== "object" || Array.isArray(raw))
    return { ...ADVISOR_OFF, refusal: "settings.advisor must be an object; no advisor is enabled" };
  const block = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(block).filter((key) => !["enabled", "decider", "model", "timeoutMs"].includes(key));
  if (unknownKeys.length > 0)
    return { ...ADVISOR_OFF, refusal: `settings.advisor has unknown field(s) ${unknownKeys.join(", ")}` };
  if (block.enabled !== true) return ADVISOR_OFF;
  if (block.decider !== "jev")
    return { ...ADVISOR_OFF, refusal: `settings.advisor.decider must be "jev"; no advisor is enabled` };
  if (block.model !== undefined && typeof block.model !== "string")
    return { ...ADVISOR_OFF, refusal: "settings.advisor.model must be a string" };
  if (
    block.timeoutMs !== undefined &&
    (!Number.isInteger(block.timeoutMs) || (block.timeoutMs as number) < 1 || (block.timeoutMs as number) > 30_000)
  )
    return { ...ADVISOR_OFF, refusal: "settings.advisor.timeoutMs must be an integer between 1 and 30000" };
  const key = env[ENV_ADVISOR_KEY]?.trim();
  if (!key)
    return {
      ...ADVISOR_OFF,
      refusal: `settings.advisor is enabled but ${ENV_ADVISOR_KEY} is not set; no advisor is enabled`,
    };
  return {
    enabled: true,
    decider: "jev",
    ...(typeof block.model === "string" ? { model: block.model } : {}),
    ...(block.timeoutMs !== undefined ? { timeoutMs: block.timeoutMs as number } : {}),
  };
}
