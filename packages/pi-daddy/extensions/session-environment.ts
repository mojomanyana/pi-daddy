import { parseInherited } from "../src/kernel/approval.ts";
import { DELEGATE_CAPABILITY } from "../src/kernel/delegate.ts";
import { budgetFromEnv } from "../src/kernel/fanout.ts";
import { isEpisodeId } from "../src/kernel/episode-id.ts";
import { WILDCARD } from "../src/kernel/pi-tools.ts";
import {
  depthConfig,
  deriveOwnGrant,
  gatedFromEnv,
  ENV_APPROVED,
  ENV_DEPTH,
  ENV_EXECUTION_ID,
  ENV_EPISODE_ID,
  ENV_FANOUT,
  ENV_GATED,
  ENV_GRANT,
  ENV_LEDGER,
  ENV_MAX_DEPTH,
  ENV_PARENT_ID,
  parseList,
} from "../src/kernel/propagation.ts";
import { storedGrantSessionState } from "./stored-grant-session.ts";
import { chooseExecutor, ENV_HERDR } from "../src/executors/executor.ts";
import { ENV_ALLOW_UNRESOLVED_MODELS } from "../src/kernel/model-preflight.ts";
import type { ReloadLifecycle } from "./reload-environment.ts";
import { ENV_GOVERNANCE, type GrantsSession } from "./session.ts";

/** Rebuild every authority-bearing factory input once session_start identifies its real SDK owner. */
export function reconcileSessionEnvironment(
  session: GrantsSession,
  environment: NodeJS.ProcessEnv,
  lifecycle: ReloadLifecycle,
): void {
  const grantRaw = environment[ENV_GRANT];
  const stored = storedGrantSessionState(grantRaw, session.storeCwd);
  const bounds = depthConfig(environment[ENV_DEPTH], environment[ENV_MAX_DEPTH]);
  const ledgerRaw = environment[ENV_LEDGER];
  session.ledgerFromEnvironment = ledgerRaw !== undefined;
  const governanceOff = environment[ENV_GOVERNANCE]?.trim() === "off" || environment[ENV_GOVERNANCE]?.trim() === "0";
  session.governed = !governanceOff;
  session.inherited = governanceOff ? stored.inherited : stored.governed ? stored.inherited : [WILDCARD];
  session.depth = bounds.depth;
  session.maxDepth = bounds.maxDepth;
  session.malformedBounds = bounds.malformed;
  session.gated = session.governed ? gatedFromEnv(environment[ENV_GATED]) : parseList(environment[ENV_GATED]);
  session.ledgerPath = ledgerRaw !== undefined ? ledgerRaw : stored.defaultLedger;
  session.executor = chooseExecutor(environment[ENV_HERDR], null);
  session.ownSpawnId = environment[ENV_PARENT_ID]?.trim() || `d${session.depth}`;
  session.ownExecutionId = environment[ENV_EXECUTION_ID]?.trim() || undefined;
  const inheritedEpisodeId = environment[ENV_EPISODE_ID]?.trim();
  session.episodeId = isEpisodeId(inheritedEpisodeId)
    ? inheritedEpisodeId
    : isEpisodeId(lifecycle.episodeId)
      ? lifecycle.episodeId
      : session.episodeId;
  lifecycle.episodeId = session.episodeId;
  session.fanoutBudget = budgetFromEnv(environment[ENV_FANOUT]);
  session.mayDelegate =
    !session.governed || session.inherited.includes(DELEGATE_CAPABILITY) || session.inherited.includes(WILDCARD);
  session.allowUnresolvedModels = environment[ENV_ALLOW_UNRESOLVED_MODELS] === "1";
  session.reloadLifecycle = lifecycle;
  session.activityRootId = lifecycle.activityRootId ?? session.activityRootId;
  lifecycle.activityRootId = session.activityRootId;
  session.inheritedApprovals = parseInherited(environment[ENV_APPROVED]);
  session.ownGrant = deriveOwnGrant(session.inherited, null);
  session.observed = false;
  session.observedTools = null;
  session.modelResolutionCache.clear();
  if (stored.refusal) session.grantStoreRefusal = stored.refusal;
  else delete session.grantStoreRefusal;
}
