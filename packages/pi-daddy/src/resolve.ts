/**
 * Grant resolution — the entire security surface of capability governance, as a pure function.
 *
 * The invariant (ADR-0008): a capability set may only ever SHRINK as it passes down a delegation
 * tree. Escalation is impossible by construction rather than by policy, because a parent can never
 * confer what it does not itself hold.
 *
 *   effective = ( requested ∩ parentGrant ∩ ceiling ) \ (gated \ approved)
 *
 * Being pure — no I/O, no model, no network — this is exhaustively testable, which matters because it
 * is the only place an escalation could be introduced.
 */

/** `tool:read` · `ext:pi-web-access/web_search` · `skill:review` · `agent:researcher` */
export type Capability = string;

/**
 * Capabilities that transitively confer everything else. Granting one is equivalent to granting the
 * whole catalog, so they can never be a *narrowing* grant.
 *
 * `ext:pi-fabric/fabric_exec` is here on measured evidence, not suspicion: a child granted
 * `tools: []` (nothing at all) plus `recursive: true` still reached `pi.write` and `pi.bash` and
 * spawned a grandchild that wrote to disk. See docs/probes/pi-fabric-eval (probes 2, 4, 7, 8).
 */
export const UNIVERSAL_CAPABILITIES: readonly Capability[] = [
  "ext:pi-fabric/fabric_exec",
  "tool:fabric_exec",
];

/**
 * Capabilities that functionally contain others.
 *
 * `bash` can run `grep`, `find`, `ls`, `cat`, and `sed` — so a session holding it can already do
 * everything the file and search tools do, whatever the tool list says. Modelling this explicitly serves
 * two purposes:
 *
 *  1. It removes false escalation reports. pi's *default* surface is only `read`, `bash`, `edit`, `write`
 *     (measured, not assumed), so an agent type declaring `tools: read, grep, find, ls` would otherwise
 *     look like an escalation from any normal parent — despite being strictly weaker.
 *  2. It makes the uncomfortable truth visible rather than implied: **a grant containing `bash` is not a
 *     narrow grant.** `subsumedBy` in the result says so, so a reviewer can see what the grant really means.
 */
export const SUBSUMPTION: Readonly<Record<Capability, readonly Capability[]>> = {
  "tool:bash": [
    "tool:grep",
    "tool:find",
    "tool:ls",
    "tool:read",
    "tool:write",
    "tool:edit",
    "tool:edit-diff",
  ],
};

/** Expand a grant to everything it functionally confers. */
export function expandSubsumed(grant: Capability[]): Capability[] {
  const expanded = new Set(grant);
  for (const held of grant) {
    for (const implied of SUBSUMPTION[held] ?? []) expanded.add(implied);
  }
  return [...expanded].sort();
}

import { WILDCARD } from "./pi-tools.ts";

/**
 * "Any definition" — ADR-0023, and one of two wildcards this module understands.
 *
 * Declared here rather than beside `WILDCARD` because `pi-tools.ts` imports `Capability` from this module.
 * That import is `import type`, so it is erased and the runtime dependency runs one way only — which is
 * what makes importing `WILDCARD` back safe.
 *
 * Deliberately weaker than `tool:*`: it confers **no tool authority**, so `agent:*,tool:read` may spawn
 * every definition on disk and hand each of them nothing but `read`. It exists because the alternative was
 * `tool:*` — authority to grant every tool — which made the safe configuration the laborious one.
 */
export const AGENT_WILDCARD: Capability = "agent:*";

export interface ResolveInput {
  /** What the delegating agent asked to give the child. */
  requested: Capability[];
  /** What the delegating agent itself holds. The root's grant is configured, never defaulted to all. */
  parentGrant: Capability[];
  /** Declarative maximum for the child's agent type (its frontmatter). Omit for no ceiling. */
  ceiling?: Capability[];
  /** Destructive capabilities that may never enter a grant without explicit human approval. */
  gated?: Capability[];
  /** Gated capabilities a human has approved for this specific spawn. */
  approved?: Capability[];
  /**
   * Honour functional subsumption when deciding what the parent covers (default true).
   * Set false for a strict name-equality check.
   */
  subsumption?: boolean;
}

export interface ResolveResult {
  /** The capability set the child may hold. */
  effective: Capability[];
  /** Requested but NOT held by the parent — the escalation-attempt signal. Log every one. */
  denied: Capability[];
  /** Held by the parent but outside the child type's declared ceiling. */
  clipped: Capability[];
  /** Allowed by the tree but gated and unapproved. */
  gatedBlocked: Capability[];
  /** Universal capabilities that survived resolution — see `assertNarrowing`. */
  universal: Capability[];
  /**
   * Capabilities the parent covers only through subsumption, not by holding them directly — e.g. `grep`
   * covered because the parent holds `bash`. Non-empty means the grant is broader than its list suggests.
   */
  subsumedBy: Capability[];
}

const unique = (xs: Capability[]): Capability[] => [...new Set(xs)].sort();

/**
 * Resolve a child's grant. Total and side-effect free; every rejected capability is reported rather
 * than silently dropped, because a grant nobody can audit proves nothing.
 */
export function resolve(input: ResolveInput): ResolveResult {
  const requested = unique(input.requested);
  const held = new Set(input.parentGrant);
  const parent =
    input.subsumption === false ? held : new Set(expandSubsumed(input.parentGrant));
  /**
   * `agent:*` covers any `agent:<name>` — ADR-0023, and the ONLY wildcard rule in this function.
   *
   * `resolve` is otherwise exact-match plus subsumption, deliberately: `tool:*` works not because anything
   * here understands it, but because `deriveOwnGrant` *enumerates* a session's observed tool names beside
   * it. Definitions are not tools, so nothing enumerates them — which is why `maySpawnDefinition` had to
   * special-case the wildcard, and why this needs stating rather than falling out.
   *
   * Scoped to one namespace on purpose. There is no generalised `<ns>:*` rule, so a namespace added later
   * does not silently acquire a wildcard; adding one is a deliberate edit and another decision.
   */
  const anyDefinition = held.has(AGENT_WILDCARD);
  /**
   * `tool:*` satisfies **any** capability, including `skill:` and `agent:` ids.
   *
   * Missing until 0.11.2, and the omission broke the one rule this package must never break by accident:
   * *governance is opt-in*. An ungoverned session holds `[tool:*, …observed tools]` and nothing else, so
   * spawning a definition whose `allowed-tools` names `agent:worker` or `skill:review` — the composition
   * ADR-0017 created and ADR-0023's own example uses — was refused with **"capability escalation
   * blocked"**, and recorded as an escalation attempt, in a session that had opted out.
   *
   * `maySpawnDefinition` had always honoured `tool:*` for definition ids and `docs/SPEC.md` had always
   * claimed it "satisfies any capability". This function disagreed with both, which is R-28's shape: two
   * spellings of one rule, and the enforcing one was wrong.
   */
  const anyCapability = held.has(WILDCARD);
  const covered = (c: Capability): boolean =>
    parent.has(c) || anyCapability || (anyDefinition && c.startsWith("agent:"));
  const ceiling = input.ceiling === undefined ? null : new Set(input.ceiling);
  const gated = new Set(input.gated ?? []);
  const approved = new Set(input.approved ?? []);

  // Order is irrelevant to the outcome (set intersection is commutative), so each rejection reason is
  // reported independently rather than being masked by whichever filter happened to run first.
  const denied = requested.filter((c) => !covered(c));
  const clipped = requested.filter((c) => covered(c) && ceiling !== null && !ceiling.has(c));
  /**
   * Is this capability gated, directly or by subsuming something gated?
   *
   * ADR-0012. Exact-name gating was defeatable by handing down a broader capability: the package's own
   * `SUBSUMPTION` table says `bash` confers `write`, so gating `write` produced **no prompt** when `bash`
   * was granted instead. The gate read as satisfied because the string never appeared.
   *
   * The direction is load-bearing and easy to invert. A capability is gated when it **subsumes**
   * something gated — never when it **is subsumed by** something gated. Gating `bash` must not quietly
   * gate a plain `write` grant, which would make gating a broad capability restrict the narrow ones and
   * invert least privilege.
   */
  const isGated = (c: Capability): boolean => {
    if (gated.has(c)) return true;
    if (input.subsumption === false) return false;
    return (SUBSUMPTION[c] ?? []).some((implied) => gated.has(implied));
  };

  const gatedBlocked = requested.filter(
    (c) => covered(c) && (ceiling === null || ceiling.has(c)) && isGated(c) && !approved.has(c),
  );

  const rejected = new Set([...denied, ...clipped, ...gatedBlocked]);
  const effective = requested.filter((c) => !rejected.has(c));

  return {
    effective,
    denied,
    clipped,
    gatedBlocked,
    universal: effective.filter((c) => UNIVERSAL_CAPABILITIES.includes(c)),
    // F9: capabilities covered by a WILDCARD are not "subsumed" — this field means "the grant is broader
    // than its list suggests", which is the `bash`-covers-`grep` warning. A wildcard holder already knows
    // its grant is broad; listing every id under it would bury the signal the field exists to carry.
    subsumedBy: effective.filter((c) => !held.has(c) && !anyCapability && !(anyDefinition && c.startsWith("agent:"))),
  };
}

/**
 * Fail closed on a grant that cannot actually narrow anything.
 *
 * A universal capability in an "attenuated" grant is not a narrow grant with one extra item — it is
 * full authority wearing a narrow grant's clothing. Callers must opt in explicitly rather than
 * discover this at runtime.
 */
export function assertNarrowing(result: ResolveResult, allowUniversal = false): void {
  if (!allowUniversal && result.universal.length > 0) {
    throw new Error(
      `refusing to issue a grant containing universal capabilities: ${result.universal.join(", ")}. ` +
        `These transitively confer the whole catalog, so the grant would not narrow anything. ` +
        `Pass allowUniversal to override deliberately.`,
    );
  }
}

/**
 * Project an effective grant onto pi's `--tools` allowlist.
 *
 * pi core is the enforcement point — verified: `--tools` and `--no-tools` both hard-block extension
 * tools, and an explicitly `-e`-loaded extension cannot re-add its tool past them
 * (docs/probes/pi-fabric-eval probes 9–11). That is why enforcement needs no in-descendant runtime.
 *
 * Returns `null` when the grant contains no callable tools, meaning the caller should pass
 * `--no-tools` rather than an empty `--tools` (an empty list is not a valid allowlist).
 */
export function toPiToolsAllowlist(effective: Capability[]): string[] | null {
  const names = effective
    .filter((c) => c.startsWith("tool:") || c.startsWith("ext:"))
    // `tool:read` -> `read`; `ext:pkg/web_search` -> `web_search` (pi matches on bare tool name)
    .map((c) => (c.startsWith("tool:") ? c.slice(5) : c.slice(c.lastIndexOf("/") + 1)))
    .filter((n) => n.length > 0);
  const deduped = [...new Set(names)].sort();
  return deduped.length > 0 ? deduped : null;
}
