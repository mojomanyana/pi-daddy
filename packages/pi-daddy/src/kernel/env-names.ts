/**
 * Every environment variable this package reads or writes, in one place (ADR-0076 PR 3b).
 *
 * Two namespaces existed before: `PI_GRANTS_*` for governance and `PI_DADDY_*` for products. Everything is
 * `PI_DADDY_*` now. The kernel's `childEnv` hook used to refuse product-supplied keys by prefix; with one
 * prefix it refuses by the closed list below, so the list must name every variable that shapes governance.
 * `test/env-names.test.ts` forces that: every key the planner writes into a child's environment must be in
 * GOVERNANCE_ENV_KEYS, and no `PI_GRANTS_` literal may survive anywhere except the legacy table here.
 *
 * Legacy names are adopted once per process (`adoptLegacyEnvironment`) so an operator's `export
 * PI_GRANTS_HERDR=1` keeps working for one minor release with a visible warning; the new name always wins
 * when both are set. Children are spawned with the new names only.
 */

// Governance state pushed at a child by the spawn plan. Stripped from the parent's environment first, so a
// child holds exactly what the plan decided (see GRANT_ENV_KEYS in propagation.ts).
export const ENV_GRANT = "PI_DADDY_GRANT";
export const ENV_DEPTH = "PI_DADDY_DEPTH";
export const ENV_MAX_DEPTH = "PI_DADDY_MAX_DEPTH";
export const ENV_GATED = "PI_DADDY_GATED";
export const ENV_LEDGER = "PI_DADDY_LEDGER";
export const ENV_APPROVED = "PI_DADDY_APPROVED";
export const ENV_FANOUT = "PI_DADDY_FANOUT";
export const ENV_PARENT_ID = "PI_DADDY_PARENT_ID";
export const ENV_EXECUTION_ID = "PI_DADDY_EXECUTION_ID";

// Operator preferences a child inherits unchanged. Still governance: they decide executor, deadlines, gates.
export const ENV_HERDR = "PI_DADDY_HERDR";
export const ENV_HERDR_WORKSPACE = "PI_DADDY_HERDR_WORKSPACE";
export const ENV_HERDR_KEEP_PANE = "PI_DADDY_HERDR_KEEP_PANE";
export const ENV_CHILD_TIMEOUT = "PI_DADDY_CHILD_TIMEOUT";
export const ENV_CHILD_IDLE_TIMEOUT = "PI_DADDY_CHILD_IDLE_TIMEOUT";
export const ENV_APPROVAL_TIMEOUT = "PI_DADDY_APPROVAL_TIMEOUT";
export const ENV_ALLOW_UNRESOLVED_MODELS = "PI_DADDY_ALLOW_UNRESOLVED_MODELS";
export const ENV_WORKSPACE_REGISTRY = "PI_DADDY_WORKSPACE_REGISTRY";
export const ENV_WORKSPACE_LEASE_DIR = "PI_DADDY_WORKSPACE_LEASE_DIR";
/** ADR-0042: what each authorised workspace id MEANT when the grant was established. Authority, not metadata. */
export const ENV_WORKSPACE_PIN = "PI_DADDY_WORKSPACE_PIN";
export const ENV_EXECUTION_ARCHIVE = "PI_DADDY_EXECUTION_ARCHIVE";
export const ENV_NATIVE_SESSION_ROOT = "PI_DADDY_NATIVE_SESSION_ROOT";
export const ENV_RETAIN_NATIVE_SESSIONS = "PI_DADDY_RETAIN_NATIVE_SESSIONS";
export const ENV_GOVERNANCE = "PI_DADDY_GOVERNANCE";
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

/** Every variable that shapes governance. The `childEnv` hook may set none of these. */
export const GOVERNANCE_ENV_KEYS: readonly string[] = Object.freeze([
  ENV_GRANT,
  ENV_DEPTH,
  ENV_MAX_DEPTH,
  ENV_GATED,
  ENV_LEDGER,
  ENV_APPROVED,
  ENV_FANOUT,
  ENV_PARENT_ID,
  ENV_EXECUTION_ID,
  ENV_HERDR,
  ENV_HERDR_WORKSPACE,
  ENV_HERDR_KEEP_PANE,
  ENV_CHILD_TIMEOUT,
  ENV_CHILD_IDLE_TIMEOUT,
  ENV_APPROVAL_TIMEOUT,
  ENV_ALLOW_UNRESOLVED_MODELS,
  ENV_WORKSPACE_REGISTRY,
  ENV_WORKSPACE_LEASE_DIR,
  ENV_WORKSPACE_PIN,
  ENV_EXECUTION_ARCHIVE,
  ENV_NATIVE_SESSION_ROOT,
  ENV_RETAIN_NATIVE_SESSIONS,
  ENV_GOVERNANCE,
  ENV_ADVISOR_KEY,
  ENV_ADVISOR,
  ENV_ADVISOR_MODEL,
]);

/**
 * The names retired by ADR-0076 PR 3b, old → new. Read for one minor release, never written. Test-tier
 * switches (`PI_GRANTS_IT_MODEL`, `PI_GRANTS_KEEP_TMP`) are included so an operator's shell keeps working.
 */
export const LEGACY_ENV_NAMES: Readonly<Record<string, string>> = Object.freeze({
  PI_GRANTS_GRANT: ENV_GRANT,
  PI_GRANTS_DEPTH: ENV_DEPTH,
  PI_GRANTS_MAX_DEPTH: ENV_MAX_DEPTH,
  PI_GRANTS_GATED: ENV_GATED,
  PI_GRANTS_LEDGER: ENV_LEDGER,
  PI_GRANTS_APPROVED: ENV_APPROVED,
  PI_GRANTS_FANOUT: ENV_FANOUT,
  PI_GRANTS_PARENT_ID: ENV_PARENT_ID,
  PI_GRANTS_EXECUTION_ID: ENV_EXECUTION_ID,
  PI_GRANTS_HERDR: ENV_HERDR,
  PI_GRANTS_HERDR_WORKSPACE: ENV_HERDR_WORKSPACE,
  PI_GRANTS_HERDR_KEEP_PANE: ENV_HERDR_KEEP_PANE,
  PI_GRANTS_CHILD_TIMEOUT: ENV_CHILD_TIMEOUT,
  PI_GRANTS_APPROVAL_TIMEOUT: ENV_APPROVAL_TIMEOUT,
  PI_GRANTS_ALLOW_UNRESOLVED_MODELS: ENV_ALLOW_UNRESOLVED_MODELS,
  PI_GRANTS_WORKSPACE_REGISTRY: ENV_WORKSPACE_REGISTRY,
  PI_GRANTS_WORKSPACE_LEASE_DIR: ENV_WORKSPACE_LEASE_DIR,
  PI_GRANTS_EXECUTION_ARCHIVE: ENV_EXECUTION_ARCHIVE,
  PI_GRANTS_NATIVE_SESSION_ROOT: ENV_NATIVE_SESSION_ROOT,
  PI_GRANTS_RETAIN_NATIVE_SESSIONS: ENV_RETAIN_NATIVE_SESSIONS,
  PI_GRANTS_IT_MODEL: "PI_DADDY_IT_MODEL",
  PI_GRANTS_KEEP_TMP: "PI_DADDY_KEEP_TMP",
});

/**
 * Copy each legacy variable to its new name when the new name is absent. Returns the legacy names adopted,
 * so the caller can warn once. Never overwrites a value set under the new name, and never deletes the old
 * one (a sibling process of an older release may still read it).
 */
export function adoptLegacyEnvironment(env: NodeJS.ProcessEnv): string[] {
  const adopted: string[] = [];
  for (const [legacy, current] of Object.entries(LEGACY_ENV_NAMES)) {
    if (env[legacy] !== undefined && env[current] === undefined) {
      env[current] = env[legacy];
      adopted.push(legacy);
    }
  }
  return adopted;
}

/** The one-line warning shown when legacy names were adopted. */
export function legacyEnvironmentWarning(adopted: readonly string[]): string {
  return (
    `pi-daddy: ${adopted.join(", ")} ${adopted.length === 1 ? "is" : "are"} deprecated since ADR-0076 PR 3b; ` +
    `rename to ${adopted.map((n) => LEGACY_ENV_NAMES[n]).join(", ")}. Legacy names are read for one minor release only.`
  );
}
