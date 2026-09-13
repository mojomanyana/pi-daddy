import { GRANT_ENV_KEYS } from "../src/propagation.ts";

/** One extension instance's root baseline and its latest child-only publication. */
export interface ReloadLifecycle { root: Record<string, string | undefined>; published?: Record<string, string | undefined> }
const PENDING_RELOAD = Symbol.for("pi-daddy.pending-extension-reload.v3");
function slot(): { pending?: ReloadLifecycle } {
  const global = globalThis as unknown as Record<PropertyKey, { pending?: ReloadLifecycle } | undefined>;
  return global[PENDING_RELOAD] ?? (global[PENDING_RELOAD] = {});
}
function snapshot(): Record<string, string | undefined> { return Object.fromEntries(GRANT_ENV_KEYS.map(key => [key, process.env[key]])); }
function same(left: Record<string, string | undefined>, right: Record<string, string | undefined>): boolean { return GRANT_ENV_KEYS.every(key => left[key] === right[key]); }

/** A reload is identified by Pi's prior `session_shutdown` event, not by a reused API object or env equality. */
export function beginExtensionLifecycle(): { environment: NodeJS.ProcessEnv; lifecycle: ReloadLifecycle } {
  const pending = slot().pending;
  if (pending) { delete slot().pending; return { environment: { ...process.env, ...pending.root }, lifecycle: pending }; }
  const lifecycle = { root: snapshot() };
  return { environment: process.env, lifecycle };
}
export function rememberChildPublication(lifecycle: ReloadLifecycle): void { lifecycle.published = snapshot(); }
/** Preserve a changed root environment, but only when Pi explicitly reports this instance is reloading. */
export function markReload(lifecycle: ReloadLifecycle): void {
  const current = snapshot();
  slot().pending = lifecycle.published && !same(current, lifecycle.published) ? { root: current } : lifecycle;
}
