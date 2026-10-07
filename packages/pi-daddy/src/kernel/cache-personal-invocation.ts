/** Exact trusted shell execution identity; no authorisation or profile eligibility is inferred here. */
export interface PersonalCacheInvocation {
  cwd: string;
  shell: string;
  command: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}
export function frozenPersonalInvocation(value: PersonalCacheInvocation): Readonly<PersonalCacheInvocation> {
  if (
    !value ||
    !value.cwd?.startsWith("/") ||
    !value.shell?.startsWith("/") ||
    typeof value.command !== "string" ||
    Buffer.byteLength(value.command) > 65536 ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs <= 0 ||
    value.timeoutMs > 21600000 ||
    !value.env ||
    typeof value.env !== "object" ||
    Array.isArray(value.env)
  )
    throw Error("personal cache invocation malformed");
  // Order is observable at execve and participates in identity; do not sort for more hits.
  // Record environments retain ECMAScript enumeration (array-index names first), not arbitrary vectors.
  const env = Object.fromEntries(Object.entries(value.env));
  if (
    Object.entries(env).some(
      ([key, text]) =>
        !key || key.includes("=") || key.includes("\0") || typeof text !== "string" || text.includes("\0"),
    ) ||
    Buffer.byteLength(JSON.stringify(env)) > 1048576
  )
    throw Error("personal cache environment malformed or oversized");
  return Object.freeze({
    cwd: value.cwd,
    shell: value.shell,
    command: value.command,
    timeoutMs: value.timeoutMs,
    env: Object.freeze(env),
  });
}
