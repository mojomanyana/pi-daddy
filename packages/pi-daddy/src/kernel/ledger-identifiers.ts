const DISPLAY_IDENTIFIER = /^[A-Za-z0-9@*][A-Za-z0-9@*._:/-]{0,511}$/;
const CORRELATION_IDENTIFIER = /^[A-Za-z0-9@*][A-Za-z0-9@*._:/-]{0,127}$/;
const CAPABILITY_TAIL = /^[A-Za-z0-9@*][A-Za-z0-9@*._/-]{0,255}$/;
/**
 * The namespaces a ledger capability field may hold — **derived, not restated.**
 *
 * **This was a second copy of the list and it took a whole namespace down.** ADR-0078 added `context:` to
 * `CAPABILITY_NAMESPACE_PREFIXES` and nothing added it here, so `isLedgerCapabilityIdentifier("context:summary")`
 * was false. Every capability-decision event carries `requested`, `parentGrant`, `effective`, `denied`, `clipped`
 * and `gatedBlocked`, all validated with this, so a session whose grant contained ANY `context:` id could not
 * write a decision at all — and a ledger write that throws denies the delegation. The operator saw
 * `delegation refused: grants: ledger write failed, denying — TypeError: invalid ledger v3 event: capability
 * decision requested must contain capability identifiers`, with no indication that the cause was the namespace.
 *
 * 0.40.0 widened the blast radius rather than causing it: held-back definitions began contributing `context:`
 * ids to the generated grant, so far more sessions carry one.
 *
 * Importing the kernel's list is the fix, and the point. This package has spent a whole session finding the same
 * shape — one rule, two spellings, the guard on the quieter one — and a validator that restates what it
 * validates is that shape with a ledger behind it.
 */
import { CAPABILITY_NAMESPACE_PREFIXES } from "./capabilities.ts";

const CAPABILITY_PREFIXES = CAPABILITY_NAMESPACE_PREFIXES;

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
