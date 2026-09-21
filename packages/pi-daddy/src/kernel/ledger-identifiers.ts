const DISPLAY_IDENTIFIER = /^[A-Za-z0-9@*][A-Za-z0-9@*._:/-]{0,511}$/;
const CORRELATION_IDENTIFIER = /^[A-Za-z0-9@*][A-Za-z0-9@*._:/-]{0,127}$/;
const CAPABILITY_TAIL = /^[A-Za-z0-9@*][A-Za-z0-9@*._/-]{0,255}$/;
const CAPABILITY_PREFIXES = ["tool:", "skill:", "agent:", "workspace:", "ext:"] as const;

/** Identifier text safe to copy onto the operator's terminal; prose belongs in no ledger display field. */
export function isLedgerDisplayIdentifier(value: unknown): value is string {
  return typeof value === "string" && DISPLAY_IDENTIFIER.test(value);
}

/** The tighter bound for model-facing correlation labels that are copied onto every event. */
export function isLedgerCorrelationIdentifier(value: unknown): value is string {
  return typeof value === "string" && CORRELATION_IDENTIFIER.test(value);
}

/** A namespaced capability id with an ASCII, non-prose tail. Namespace wildcards remain representable. */
export function isLedgerCapabilityIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const prefix = CAPABILITY_PREFIXES.find((candidate) => value.startsWith(candidate));
  return Boolean(prefix && CAPABILITY_TAIL.test(value.slice(prefix.length)));
}
