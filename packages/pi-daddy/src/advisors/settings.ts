/**
 * Whether an advisor is on, and which one (ADR-0077).
 *
 * **Default off, and only the environment can turn it on.** An advisor sends a description of the caller's
 * situation to a third party, so enabling one is `PI_DADDY_ADVISOR=jev` plus a key — both outside the workspace,
 * both stripped from every child.
 *
 * 0.34.0 read the enable from `.pi/pi-daddy/settings.json` and that was wrong for the reason `grant-store.ts`
 * states about the same file: it is writable by any child holding `tool:write`, so it is "the reviewable record of
 * the decision, not the thing the enforcer reads". A grant lives outside the workspace precisely so a child cannot
 * widen the next session's ceiling; an advisor switch a child could flip would make the operator's next session
 * ship its own description to a third party, which is the same self-defeating shape. The settings block may still
 * NARROW — a model, a timeout, or `enabled: false` to turn an advisor off for one project — and can never turn one
 * on. Malformed configuration disables the advisor and says so: a typo must not be a way to enable anything.
 *
 * **Not a dashboard toggle**, which is what the programme originally sketched. The dashboard is a read-only
 * renderer in a separate process that "never affects enforcement" (ADR-0036), and a control there that wrote to
 * settings would be the first thing it ever wrote. Turning an advisor on is an operator decision that belongs in
 * the reviewable file; `/grants` reports what is in force. That is a deliberate departure from the roadmap line.
 *
 * The key is never in the settings file either, because that file is committed and an API key must not be.
 */

// Spelled once, in the kernel's table, so this layer cannot drift from the list `childEnv` refuses to write.
export { ENV_ADVISOR_KEY as ADVISOR_KEY_ENV } from "../kernel/env-names.ts";
import { ENV_ADVISOR, ENV_ADVISOR_KEY } from "../kernel/env-names.ts";
export { ENV_ADVISOR } from "../kernel/env-names.ts";

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
  // The environment decides WHETHER, before the workspace is consulted at all. A settings file that asks for an
  // advisor nobody enabled is not a configuration error; it is simply a project that would use one if the operator
  // turned it on, so it is reported rather than refused.
  const requested = env[ENV_ADVISOR]?.trim();
  if (!requested) return ADVISOR_OFF;
  if (requested !== "jev")
    return { ...ADVISOR_OFF, refusal: `${ENV_ADVISOR}=${requested} names no advisor this release knows` };

  const block = raw === undefined || raw === null ? {} : raw;
  if (typeof block !== "object" || Array.isArray(block))
    return { ...ADVISOR_OFF, refusal: "settings.advisor must be an object; no advisor is enabled" };
  const fields = block as Record<string, unknown>;
  const unknownKeys = Object.keys(fields).filter((key) => !["enabled", "decider", "model", "timeoutMs"].includes(key));
  if (unknownKeys.length > 0)
    return { ...ADVISOR_OFF, refusal: `settings.advisor has unknown field(s) ${unknownKeys.join(", ")}` };
  // A project may switch it OFF; it may never switch it on, which is why `false` is honoured and `true` is not read.
  if (fields.enabled === false)
    return { ...ADVISOR_OFF, refusal: "settings.advisor.enabled is false for this project" };
  if (fields.decider !== undefined && fields.decider !== "jev")
    return { ...ADVISOR_OFF, refusal: `settings.advisor.decider must be "jev"; no advisor is enabled` };
  const blockCompat = fields;
  if (blockCompat.model !== undefined && typeof blockCompat.model !== "string")
    return { ...ADVISOR_OFF, refusal: "settings.advisor.model must be a string" };
  if (
    fields.timeoutMs !== undefined &&
    (!Number.isInteger(fields.timeoutMs) || (fields.timeoutMs as number) < 1 || (fields.timeoutMs as number) > 30_000)
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
    ...(typeof fields.model === "string" ? { model: fields.model } : {}),
    ...(fields.timeoutMs !== undefined ? { timeoutMs: fields.timeoutMs as number } : {}),
  };
}
