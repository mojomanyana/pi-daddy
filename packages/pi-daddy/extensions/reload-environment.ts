import { GRANT_ENV_KEYS } from "../src/propagation.ts";

/** Same-process Pi reloads must not consume this extension's child-only publication as root inheritance. */
const ROOT_ENVIRONMENT = Symbol.for("pi-daddy.root-governance-environment.v1");
type RootEnvironment = { root: Record<string, string | undefined>; published?: Record<string, string | undefined> };

export function sourceEnvironment(): NodeJS.ProcessEnv {
  const root = globalThis as unknown as Record<PropertyKey, RootEnvironment | undefined>;
  const state = root[ROOT_ENVIRONMENT]
    ?? (root[ROOT_ENVIRONMENT] = { root: Object.fromEntries(GRANT_ENV_KEYS.map(key => [key, process.env[key]])) });
  const selfPublished = state.published && GRANT_ENV_KEYS.every(key => process.env[key] === state.published![key]);
  return selfPublished ? { ...process.env, ...state.root } : process.env;
}

export function rememberChildPublication(): void {
  const state = (globalThis as unknown as Record<PropertyKey, RootEnvironment | undefined>)[ROOT_ENVIRONMENT]!;
  state.published = Object.fromEntries(GRANT_ENV_KEYS.map(key => [key, process.env[key]]));
}
