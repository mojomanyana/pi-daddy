/**
 * Build the session's advisor from its committed settings (ADR-0077).
 *
 * Composition, because everything here is I/O or policy the layers must not hold: reading the settings file,
 * reaching for the key in the environment, and writing the `advice` record to the ledger. The advisors layer does
 * none of that — it is handed a decider and a recorder.
 *
 * An advisor with no ledger records nothing and still answers. That is deliberate and worth saying: the ledger is
 * opt-in (ADR-0037), and making advice conditional on it would mean an ungoverned session behaved differently from
 * a governed one for reasons that have nothing to do with the advisor.
 */
import { createAdvisor, type AdviceRecord, type Advisor } from "../src/advisors/advisor.ts";
import { nullDecider } from "../src/advisors/decider.ts";
import { jevDecider } from "../src/advisors/jev.ts";
import { ADVISOR_KEY_ENV, advisorSettingsFrom, type AdvisorSettings } from "../src/advisors/settings.ts";
import { appendRecord } from "../src/governance/record.ts";

export interface AdvisorSession {
  readonly settings: AdvisorSettings;
  readonly advisor: Advisor;
  /**
   * Which decider was actually constructed — `"none"` or `"jev"`.
   *
   * Exposed because a test asserting only `settings` could not tell: review measured that removing the key check
   * here left every test green, since the disabled wrapper returns before touching the decider. A named breaking
   * change that does not break the test is decoration (AGENTS.md).
   */
  readonly deciderName: string;
}

export function createAdvisorSession(input: {
  /** The `advisor` block of `.pi/pi-daddy/settings.json`, or undefined when there is none. */
  block: unknown;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  episodeId?: string;
}): AdvisorSession {
  const env = input.env ?? process.env;
  const settings = advisorSettingsFrom(input.block, env);
  const record = async (entry: AdviceRecord): Promise<void> => {
    if (!input.ledgerPath) return;
    // Never strict: advice is an observation beside a decision that has already been taken, so a ledger failure
    // must not change what the caller does — `execute-child`'s rule for a terminal lifecycle append.
    await appendRecord(input.ledgerPath, "advice", entry).catch(() => undefined);
  };
  const decider =
    settings.enabled && settings.decider === "jev"
      ? jevDecider({
          // Trimmed for the reason `settings` trims when validating: a key exported with a trailing newline
          // passed validation and was then sent verbatim.
          apiKey: env[ADVISOR_KEY_ENV]?.trim() ?? "",
          ...(settings.model ? { model: settings.model } : {}),
        })
      : nullDecider;
  return {
    settings,
    deciderName: decider.name,
    advisor: createAdvisor({
      decider,
      record,
      enabled: settings.enabled,
      ...(input.episodeId ? { episodeId: input.episodeId } : {}),
      ...(settings.timeoutMs ? { timeoutMs: settings.timeoutMs } : {}),
    }),
  };
}
