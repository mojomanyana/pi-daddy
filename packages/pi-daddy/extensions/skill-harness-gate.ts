/**
 * Mechanical settle gate for Skill Harness evaluations (tracked by skill + scenario).
 *
 * A passing rerun clears ONLY the matching (skill, scenario) pair so an unrelated
 * passing scenario cannot mask a still-failing one. Automatic settle holds are
 * bounded; once exhausted, an explicit unresolved operator decision is surfaced
 * instead of looping forever or silently clearing the failure.
 */

export const MAX_SKILL_HARNESS_AUTO_RETRIES = 3;

export interface SkillHarnessScenarioResult {
  readonly id: string;
  readonly verdict: string;
  readonly expected?: readonly string[];
  readonly observed?: string;
}

export interface SkillHarnessEvalEvent {
  readonly version?: number;
  readonly skill?: string;
  readonly keepTaskOpen?: boolean;
  readonly coverage?: { readonly label?: string; readonly scenariosRun?: readonly string[] };
  readonly scenarios?: readonly SkillHarnessScenarioResult[];
}

export interface FailedScenarioEntry {
  readonly skill: string;
  readonly scenarioId: string;
  readonly coverageLabel: string;
  readonly expected?: readonly string[];
  readonly observed?: string;
}

export type SkillHarnessSettleDecision =
  | { readonly action: "allow" }
  | {
      readonly action: "hold";
      readonly retryNumber: number;
      readonly maxRetries: number;
      readonly customType: "pi-daddy-skill-harness-gate";
      readonly content: string;
      readonly remaining: readonly FailedScenarioEntry[];
    }
  | {
      readonly action: "unresolved-decision";
      readonly retryNumber: number;
      readonly maxRetries: number;
      readonly customType: "pi-daddy-skill-harness-unresolved";
      readonly content: string;
      readonly remaining: readonly FailedScenarioEntry[];
    };

const UNSPECIFIED_SCENARIO = "__unspecified__";
const keyOf = (skill: string, scenarioId: string) => `${skill}\0${scenarioId}`;

function formatRemaining(entries: readonly FailedScenarioEntry[]): string[] {
  const bySkill = new Map<string, FailedScenarioEntry[]>();
  for (const item of entries) {
    const list = bySkill.get(item.skill) ?? [];
    list.push(item);
    bySkill.set(item.skill, list);
  }
  const blocks: string[] = [];
  for (const [skill, list] of bySkill) {
    const label = list[0]?.coverageLabel ?? "focused";
    const rows = list.map((f) => {
      const exp = f.expected?.length ? `expected [${f.expected.join(" | ")}]` : "expected [PASS]";
      const obs = `observed [${f.observed ?? "FAIL"}]`;
      return `  - ${f.scenarioId}: ${exp}, ${obs}`;
    });
    blocks.push(`Skill "${skill}" (${label}) has failing scenario(s):\n${rows.join("\n")}`);
  }
  return blocks;
}

export function createSkillHarnessGate(maxAutoRetries = MAX_SKILL_HARNESS_AUTO_RETRIES) {
  const failed = new Map<string, FailedScenarioEntry>();
  let retriesUsed = 0;

  return {
    recordResult(payload: unknown): void {
      const ev = payload as SkillHarnessEvalEvent | null | undefined;
      if (!ev || typeof ev.skill !== "string" || !ev.skill.trim()) return;
      const skill = ev.skill.trim();
      const coverageLabel = ev.coverage?.label ?? "focused";
      const scenarios = Array.isArray(ev.scenarios) ? ev.scenarios : [];

      if (scenarios.length > 0) {
        // Named scenarios update only their exact (skill, scenarioId) slots.
        failed.delete(keyOf(skill, UNSPECIFIED_SCENARIO));
        for (const s of scenarios) {
          if (!s || typeof s.id !== "string" || !s.id.trim()) continue;
          const id = s.id.trim();
          const key = keyOf(skill, id);
          if (s.verdict === "PASS") {
            failed.delete(key);
          } else {
            failed.set(key, {
              skill,
              scenarioId: id,
              coverageLabel,
              ...(s.expected ? { expected: [...s.expected] } : {}),
              ...(s.observed !== undefined ? { observed: s.observed } : {}),
            });
          }
        }
        return;
      }

      const fallbackKey = keyOf(skill, UNSPECIFIED_SCENARIO);
      if (ev.keepTaskOpen) {
        failed.set(fallbackKey, { skill, scenarioId: UNSPECIFIED_SCENARIO, coverageLabel, observed: "FAIL" });
      } else {
        failed.delete(fallbackKey);
      }
    },

    remaining(): FailedScenarioEntry[] {
      return [...failed.values()];
    },

    retriesUsed(): number {
      return retriesUsed;
    },

    onBeforeSettle(): SkillHarnessSettleDecision {
      if (failed.size === 0) return { action: "allow" };
      const remaining = [...failed.values()];
      const details = formatRemaining(remaining);

      if (retriesUsed < maxAutoRetries) {
        retriesUsed++;
        const content = [
          `Skill Harness reported failed evaluation scenario(s) (automatic retry ${retriesUsed}/${maxAutoRetries}); ` +
            "this task remains open:",
          "",
          ...details,
          "",
          "Fix the in-scope skill regression and rerun the affected scenario(s) with skill_check_run, " +
            "or explain why the evaluation needs updating before changing it if behavior intentionally changed.",
        ].join("\n");
        return {
          action: "hold",
          retryNumber: retriesUsed,
          maxRetries: maxAutoRetries,
          customType: "pi-daddy-skill-harness-gate",
          content,
          remaining,
        };
      }

      const content = [
        `Unresolved Skill Harness evaluation failure(s) remain after ${maxAutoRetries} automatic retries ` +
          "(operator decision required):",
        "",
        ...details,
        "",
        "Automatic retries are exhausted; the failing evaluation(s) have NOT been cleared. " +
          "Operator decision needed: continue fixing the skill, approve updating the evaluation spec for an " +
          "intentional behavior change, or explicitly accept stopping with failing evaluations.",
      ].join("\n");
      return {
        action: "unresolved-decision",
        retryNumber: retriesUsed,
        maxRetries: maxAutoRetries,
        customType: "pi-daddy-skill-harness-unresolved",
        content,
        remaining,
      };
    },

    resetTurn(): void {
      retriesUsed = 0;
    },

    resetSession(): void {
      retriesUsed = 0;
      failed.clear();
    },
  };
}
