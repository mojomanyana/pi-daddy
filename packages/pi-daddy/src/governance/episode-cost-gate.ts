/** Per-episode cost threshold state shared by every child started by one session. */
import { readFile } from "node:fs/promises";
import { readRecords } from "./record.ts";

export const DEFAULT_EPISODE_COST_CEILING = 5;

export type EpisodeCostGateAnswer =
  | { cost: number; ceiling: number; outcome: "continued"; newCeiling: number }
  | { cost: number; ceiling: number; outcome: "stopped" };

export interface EpisodeCostGateHooks {
  warn(message: string): void;
  pause?(): Promise<unknown> | unknown;
  ask?(): Promise<number | null>;
  resume?(): Promise<unknown> | unknown;
  stop?(): Promise<unknown> | unknown;
  gate(event: EpisodeCostGateAnswer): Promise<unknown> | unknown;
}

export function episodeCostCeilingFromSettings(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_EPISODE_COST_CEILING;
  const ceiling = (value as Record<string, unknown>).episodeCostCeiling;
  return typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling > 0
    ? ceiling
    : DEFAULT_EPISODE_COST_CEILING;
}

export class EpisodeCostGate {
  #ceiling: number;
  #costs = new Map<string, number>();
  #warned = false;
  #usageWarning = false;
  #decision?: Promise<"continue" | "stop">;

  constructor(ceiling: number) {
    this.#ceiling = ceiling;
  }

  get ceiling(): number {
    return this.#ceiling;
  }

  setCeiling(ceiling: number): void {
    if (Number.isFinite(ceiling) && ceiling > 0 && !this.#decision) this.#ceiling = ceiling;
  }

  seedCost(executionId: string, cost: number): void {
    if (Number.isFinite(cost) && cost >= 0) this.#costs.set(executionId, cost);
  }

  async observe(
    executionId: string,
    cost: number | undefined,
    terminal: boolean,
    hooks: EpisodeCostGateHooks,
  ): Promise<"continue" | "stop"> {
    if (cost === undefined) {
      if (terminal && !this.#usageWarning) {
        this.#usageWarning = true;
        hooks.warn("pi-daddy: provider reported no token usage; the episode cost gate cannot fire");
      }
      return "continue";
    }
    this.#costs.set(executionId, cost);
    const total = [...this.#costs.values()].reduce((sum, value) => sum + value, 0);
    if (!this.#warned && total >= this.#ceiling / 2) {
      this.#warned = true;
      hooks.warn(`pi-daddy: episode cost reached 50% of the $${this.#ceiling} ceiling`);
    }
    if (total <= this.#ceiling) return "continue";
    if (this.#decision) {
      const decision = await this.#decision;
      if (decision === "stop") await hooks.stop?.();
      return decision;
    }
    this.#decision = this.#decide(total, hooks);
    return this.#decision;
  }

  async #decide(cost: number, hooks: EpisodeCostGateHooks): Promise<"continue" | "stop"> {
    await hooks.pause?.();
    const answer = await hooks.ask?.();
    if (answer !== undefined && answer !== null && Number.isFinite(answer) && answer > cost) {
      const prior = this.#ceiling;
      this.#ceiling = answer;
      try {
        await hooks.gate({ cost, ceiling: prior, outcome: "continued", newCeiling: answer });
      } catch (error) {
        await hooks.stop?.();
        throw error;
      }
      await hooks.resume?.();
      return "continue";
    }
    try {
      await hooks.gate({ cost, ceiling: this.#ceiling, outcome: "stopped" });
    } finally {
      await hooks.stop?.();
    }
    return "stop";
  }
}

export async function loadEpisodeCosts(path: string, episodeId: string): Promise<Map<string, number>> {
  try {
    const parsed = readRecords(await readFile(path, "utf8"));
    if (parsed.damage) return new Map();
    const costs = new Map<string, number>();
    for (const record of parsed.records) {
      const body = record.body as Record<string, unknown>;
      if (body?.event !== "child_lifecycle" || body.episodeId !== episodeId) continue;
      if (body.state !== "completed" && body.state !== "failed") continue;
      const usage = body.usage as { cost?: { total?: unknown } } | undefined;
      const cost = usage?.cost?.total;
      if (typeof body.executionId === "string" && typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        costs.set(body.executionId, cost);
      }
    }
    return costs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}
