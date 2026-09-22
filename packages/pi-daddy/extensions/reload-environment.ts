import { GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";

/** The root baseline and latest child publication for one real Pi session owner. */
export interface ReloadLifecycle {
  root: Record<string, string | undefined>;
  published?: Record<string, string | undefined>;
  activityRootId?: string;
  /**
   * The destination pin this owner settled on (ADR-0042), which must survive an extension reload.
   *
   * **Here rather than on the session, because a reload builds a NEW session.** `session.pinSettled` closed
   * the `/grants init` re-mint, which reuses one session object, and left the reload open: a fresh object has
   * no flag, a root legitimately inherited nothing and sits at depth 0, so it minted a second time — against
   * whatever the registry said by then, which a child with `tool:write` had had the whole session to rewrite.
   * A security review reproduced it. That is the same rule-on-the-object, second-path-builds-another-object
   * shape this package keeps finding, three times in this feature alone.
   *
   * The lifecycle is keyed by owner in a `WeakMap` and is already the thing that "recovers its root rather
   * than its child publication", so it is where settled-ness belongs.
   */
  workspacePin?: ReadonlyMap<string, string>;
}
type SessionOwner = object;

interface ReloadState {
  owners: WeakMap<SessionOwner, ReloadLifecycle>;
  latestChildPublication?: { lifecycle: ReloadLifecycle; environment: Record<string, string | undefined> };
}
const RELOAD_STATE = Symbol.for("pi-daddy.reload-environment.v1");
function state(): ReloadState {
  const global = globalThis as typeof globalThis & { [key: symbol]: ReloadState | undefined };
  return global[RELOAD_STATE] ?? (global[RELOAD_STATE] = { owners: new WeakMap() });
}

function snapshot(): Record<string, string | undefined> {
  return Object.fromEntries(GRANT_ENV_KEYS.map((key) => [key, process.env[key]]));
}
function same(left: Record<string, string | undefined>, right: Record<string, string | undefined>): boolean {
  return GRANT_ENV_KEYS.every((key) => left[key] === right[key]);
}
function withRoot(root: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...process.env, ...root };
}

/** Factory-time state is provisional: ExtensionAPI is recreated before the stable session owner is known. */
export function beginExtensionLifecycle(): { environment: NodeJS.ProcessEnv; lifecycle: ReloadLifecycle } {
  return { environment: process.env, lifecycle: { root: snapshot() } };
}

/**
 * Bind an extension lifecycle to Pi's stable owner at session_start.
 *
 * A matching latest publication is child state from a known owner, not an explicit replacement for this
 * owner. An unmatched environment change is an explicit root replacement for THIS owner only.
 */
export function bindReloadLifecycle(
  owner: SessionOwner,
  provisional: ReloadLifecycle,
): {
  lifecycle: ReloadLifecycle;
  environment: NodeJS.ProcessEnv;
} {
  const holder = state();
  const existing = holder.owners.get(owner);
  if (!existing) {
    holder.owners.set(owner, provisional);
    return { lifecycle: provisional, environment: withRoot(provisional.root) };
  }

  const current = snapshot();
  if (!holder.latestChildPublication || !same(current, holder.latestChildPublication.environment)) {
    // No pi-daddy lifecycle published what is currently in process.env, so this is an explicit change to
    // this owner's root rather than another bound session's child state.
    existing.root = current;
  }
  return { lifecycle: existing, environment: withRoot(existing.root) };
}

/** Publish only parent-level child state, and retain which owner made the process-global publication. */
export function rememberChildPublication(lifecycle: ReloadLifecycle): void {
  const environment = snapshot();
  lifecycle.published = environment;
  state().latestChildPublication = { lifecycle, environment };
}
