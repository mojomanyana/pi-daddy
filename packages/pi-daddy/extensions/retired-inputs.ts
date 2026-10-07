/** Closed compatibility list. Preparation precedes Pi schema validation; active arguments still validate. */
export function withoutRetiredDelegationArguments<T>(args: unknown): T {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args as T;
  const clean = { ...(args as Record<string, unknown>) };
  delete clean.episodeCostCeiling;
  return clean as T;
}
