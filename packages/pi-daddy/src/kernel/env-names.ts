/**
 * Every environment variable this package reads or writes, in one place (ADR-0076).
 *
 * Everything uses `PI_DADDY_*`. `test/env-names.test.ts` enforces that every key the planner
 * writes into a child's environment is in `GOVERNANCE_ENV_KEYS` and no retired prefix survives.
 */

// Governance state pushed at a child by the spawn plan. Stripped from the parent's environment first, so a
// child holds exactly what the plan decided (see GRANT_ENV_KEYS in propagation.ts).
export const ENV_GRANT = "PI_DADDY_GRANT";
export const ENV_DEPTH = "PI_DADDY_DEPTH";
export const ENV_MAX_DEPTH = "PI_DADDY_MAX_DEPTH";
export const ENV_GATED = "PI_DADDY_GATED";
export const ENV_LEDGER = "PI_DADDY_LEDGER";
export const ENV_APPROVED = "PI_DADDY_APPROVED";
export const ENV_AUTO_MODE = "PI_DADDY_AUTO_MODE";
export const ENV_AUTO_MODE_REF = "PI_DADDY_AUTO_MODE_REF";
/** Bounded working-style metadata, supplied explicitly for each governed child. */
export const ENV_WORK_MODE = "PI_DADDY_WORK_MODE_V1";
export const ENV_FANOUT = "PI_DADDY_FANOUT";
export const ENV_PARENT_ID = "PI_DADDY_PARENT_ID";
export const ENV_EXECUTION_ID = "PI_DADDY_EXECUTION_ID";
export const ENV_EPISODE_ID = "PI_DADDY_EPISODE_ID";
export const ENV_EPISODE_COST_CEILING = "PI_DADDY_EPISODE_COST_CEILING";

// Child-facing work attribution. These duplicate no authority: they let work produced outside pi-daddy carry the
// same identities as the ledger records that governed it.
export const ENV_CHILD_EPISODE = "PI_DADDY_EPISODE";
export const ENV_CHILD_DEFINITION = "PI_DADDY_DEFINITION";
export const ENV_CHILD_EXECUTION = "PI_DADDY_EXECUTION";
export const CHILD_ATTRIBUTION_ENV_KEYS = [ENV_CHILD_EPISODE, ENV_CHILD_DEFINITION, ENV_CHILD_EXECUTION] as const;

// Operator preferences a child inherits unchanged. Still governance: they decide deadlines and gates.
export const ENV_CHILD_TIMEOUT = "PI_DADDY_CHILD_TIMEOUT";
export const ENV_CHILD_IDLE_TIMEOUT = "PI_DADDY_CHILD_IDLE_TIMEOUT";
export const ENV_APPROVAL_TIMEOUT = "PI_DADDY_APPROVAL_TIMEOUT";
/** Kill switch for the one automatic retry of a replay-safe child (2026-11-17); literal `0` turns it off. */
export const ENV_REPLAY_RETRY = "PI_DADDY_REPLAY_RETRY";
export const ENV_ALLOW_UNRESOLVED_MODELS = "PI_DADDY_ALLOW_UNRESOLVED_MODELS";
export const ENV_WORKSPACE_REGISTRY = "PI_DADDY_WORKSPACE_REGISTRY";
export const ENV_WORKSPACE_LEASE_DIR = "PI_DADDY_WORKSPACE_LEASE_DIR";
/** ADR-0042: what each authorised workspace id MEANT when the grant was established. Authority, not metadata. */
export const ENV_WORKSPACE_PIN = "PI_DADDY_WORKSPACE_PIN";
/**
 * Parent-run tools (decision of 2026-11-17). Three variables, three owners.
 *
 * `ENV_PARENT_TOOLS` is the operator's kill switch: unset or literal `1` leaves the path on, literal `0` turns it
 * off, and any other value is malformed and also off. `ENV_PROXIED_TOOLS` is written by the planner for one child:
 * the public name, description and argument schema of each tool that child may ask the root to run.
 * `ENV_PROXIED_TOOLS_KEY` is written at launch for that one execution: the secret a request must present beside
 * its execution id.
 *
 * The two child-facing names are in `GRANT_ENV_KEYS` as well, so a grandchild never inherits its parent's.
 */
export const ENV_PARENT_TOOLS = "PI_DADDY_PARENT_TOOLS";
export const ENV_PROXIED_TOOLS = "PI_DADDY_PROXIED_TOOLS";
export const ENV_PROXIED_TOOLS_KEY = "PI_DADDY_PROXIED_TOOLS_KEY";
/** Explicit operator-only local public-response capture; never inherited by a captured child. */
export const ENV_PUBLIC_EVIDENCE_DIR = "PI_DADDY_PUBLIC_EVIDENCE_DIR";
export const ENV_EXECUTION_ARCHIVE = "PI_DADDY_EXECUTION_ARCHIVE";
export const ENV_NATIVE_SESSION_ROOT = "PI_DADDY_NATIVE_SESSION_ROOT";
export const ENV_RETAIN_NATIVE_SESSIONS = "PI_DADDY_RETAIN_NATIVE_SESSIONS";
export const ENV_GOVERNANCE = "PI_DADDY_GOVERNANCE";
/** Optional SSH target and key path for the local dashboard telemetry probe. */
export const ENV_LLM_TELEMETRY_SSH_TARGET = "PI_DADDY_LLM_TELEMETRY_SSH_TARGET";
export const ENV_LLM_TELEMETRY_SSH_IDENTITY = "PI_DADDY_LLM_TELEMETRY_SSH_IDENTITY";
export const ENV_LLM_TELEMETRY_SERVICE = "PI_DADDY_LLM_TELEMETRY_SERVICE";
/**
 * The advisor's API key (ADR-0077).
 *
 * In `GOVERNANCE_ENV_KEYS` so the `childEnv` hook cannot set it — a product that could inject a key could send a
 * session's own description to a third party of its choosing — **and in `GRANT_ENV_KEYS` so it is stripped from
 * every child.** The first draft had only the former and claimed "it is never written for a child", which was true
 * of the planner and false in effect: `mergeChildEnv` strips only `GRANT_ENV_KEYS`, so a child granted `tool:bash`
 * inherited a paid credential its grant never named. Measured in review.
 */
export const ENV_ADVISOR_KEY = "PI_DADDY_ADVISOR_KEY";
/**
 * Which advisor is in force, or absent for none (ADR-0077).
 *
 * **The enable lives here rather than in the project settings file, and that is a correction.** 0.34.0 read it from
 * `.pi/pi-daddy/settings.json`, which `grant-store.ts` is explicit about: that file is writable by any child
 * holding `tool:write`, so it is "the reviewable record of the decision, not the thing the enforcer reads". A
 * grant is kept outside the workspace for exactly that reason, and an advisor switch needs the same treatment for a
 * neighbouring one — a child that could flip it on would make the operator's NEXT session ship its own description
 * to a third party. The settings file may still narrow (a model, a timeout, or `enabled: false`); it can no longer
 * turn one on.
 */
export const ENV_ADVISOR = "PI_DADDY_ADVISOR";
/** Overrides the adapter's pinned model. In the environment, never the workspace file: a model is a destination. */
export const ENV_ADVISOR_MODEL = "PI_DADDY_ADVISOR_MODEL";
/** Exact `raw` opts into sending task text; absent or any other value uses a structural digest. */
export const ENV_ADVISOR_TASK_EGRESS = "PI_DADDY_ADVISOR_TASK_EGRESS";

/** Every variable that shapes governance. The `childEnv` hook may set none of these. */
export const GOVERNANCE_ENV_KEYS: readonly string[] = Object.freeze([
  ENV_GRANT,
  ENV_DEPTH,
  ENV_MAX_DEPTH,
  ENV_GATED,
  ENV_LEDGER,
  ENV_APPROVED,
  ENV_AUTO_MODE,
  ENV_AUTO_MODE_REF,
  ENV_WORK_MODE,
  ENV_FANOUT,
  ENV_PARENT_ID,
  ENV_EXECUTION_ID,
  ENV_EPISODE_ID,
  ENV_EPISODE_COST_CEILING,
  ...CHILD_ATTRIBUTION_ENV_KEYS,
  ENV_CHILD_TIMEOUT,
  ENV_CHILD_IDLE_TIMEOUT,
  ENV_APPROVAL_TIMEOUT,
  ENV_REPLAY_RETRY,
  ENV_ALLOW_UNRESOLVED_MODELS,
  ENV_WORKSPACE_REGISTRY,
  ENV_WORKSPACE_LEASE_DIR,
  ENV_WORKSPACE_PIN,
  ENV_PARENT_TOOLS,
  ENV_PROXIED_TOOLS,
  ENV_PROXIED_TOOLS_KEY,
  ENV_PUBLIC_EVIDENCE_DIR,
  ENV_EXECUTION_ARCHIVE,
  ENV_NATIVE_SESSION_ROOT,
  ENV_RETAIN_NATIVE_SESSIONS,
  ENV_GOVERNANCE,
  ENV_LLM_TELEMETRY_SSH_TARGET,
  ENV_LLM_TELEMETRY_SSH_IDENTITY,
  ENV_LLM_TELEMETRY_SERVICE,
  ENV_ADVISOR_KEY,
  ENV_ADVISOR,
  ENV_ADVISOR_MODEL,
  ENV_ADVISOR_TASK_EGRESS,
]);
