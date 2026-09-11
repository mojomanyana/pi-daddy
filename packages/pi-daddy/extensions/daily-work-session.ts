import type { DeclaredWorkState } from "../src/work-command.ts";
import { ENV_DAILY_SELECTION, ENV_DAILY_WORK } from "../src/dashboard-cli.ts";

export interface PublishedDailyWork { work?: string; selection?: string }

/** Replace only values this extension instance published; an operator override is never deleted. */
export function replacePublishedDailyWork(
  env: Record<string, string | undefined>,
  published: PublishedDailyWork,
  state: Pick<DeclaredWorkState, "ledgerPath" | "selectedSnapshot"> | undefined,
): void {
  if (published.work && env[ENV_DAILY_WORK] === published.work) delete env[ENV_DAILY_WORK];
  if (published.selection && env[ENV_DAILY_SELECTION] === published.selection) delete env[ENV_DAILY_SELECTION];
  delete published.work; delete published.selection;
  if (!state) return;
  published.work = state.ledgerPath;
  published.selection = JSON.stringify(state.selectedSnapshot);
  env[ENV_DAILY_WORK] = published.work;
  env[ENV_DAILY_SELECTION] = published.selection;
}
