import { GRANT_ENV_KEYS } from "../src/propagation.ts";

/** The root baseline and latest child publication for one real Pi session owner. */
export interface ReloadLifecycle { root: Record<string, string | undefined>; published?: Record<string, string | undefined> }
type SessionOwner = object;

const owners = new WeakMap<SessionOwner, ReloadLifecycle>();
// `process.env` has one latest writer. This records that writer; it is never a reload handoff and is never
// consumed. The WeakMap above, keyed by ctx.sessionManager, is the only place a reload obtains its root.
let latestChildPublication: { lifecycle: ReloadLifecycle; environment: Record<string, string | undefined> } | undefined;

function snapshot(): Record<string, string | undefined> {
  return Object.fromEntries(GRANT_ENV_KEYS.map(key => [key, process.env[key]]));
}
function same(left: Record<string, string | undefined>, right: Record<string, string | undefined>): boolean {
  return GRANT_ENV_KEYS.every(key => left[key] === right[key]);
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
export function bindReloadLifecycle(owner: SessionOwner, provisional: ReloadLifecycle): {
  lifecycle: ReloadLifecycle;
  environment: NodeJS.ProcessEnv;
} {
  const existing = owners.get(owner);
  if (!existing) {
    owners.set(owner, provisional);
    return { lifecycle: provisional, environment: withRoot(provisional.root) };
  }

  const current = snapshot();
  if (!latestChildPublication || !same(current, latestChildPublication.environment)) {
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
  latestChildPublication = { lifecycle, environment };
}
