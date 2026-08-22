/**
 * Capability ids: their grammar, and the two authority predicates over them.
 *
 * Split out of `delegate.ts` when ADR-0024 pushed that file past the 400-line ceiling and
 * `test/file-size.test.ts` refused it — for the second time, and answered the same way as the first: split
 * the file the way the failure message says rather than raise the cap on the guard.
 *
 * The seam is not arbitrary. Three modules outside `delegate.ts` already imported these
 * (`extensions/session.ts` for `DELEGATE_CAPABILITY`, `extensions/delegation.ts` and
 * `extensions/run-delegation.ts` for `maySpawnDefinition`), which is the evidence that they were a separate
 * concern living in the wrong file: *what an id means and who may use it* is a different question from
 * *what one delegation does*.
 */

import { AGENT_WILDCARD, WORKSPACE_WILDCARD, type Capability } from "./resolve.ts";
import { WILDCARD } from "./pi-tools.ts";
import { GovernanceRefusal, refusal } from "./refusals.ts";

/** The capability that authorises spawning a definition (ADR-0017). `tool:*` satisfies any of them. */
export const agentCapability = (name: string): Capability => `agent:${name}`;

/**
 * May this grant spawn that definition? (ADR-0017.)
 *
 * `resolve()` is exact-match plus subsumption and has no wildcard rule — a wildcard session works only
 * because `deriveOwnGrant` *enumerates* its observed tools alongside `tool:*`. Definitions are not tools,
 * so nothing enumerates them, and the wildcard has to be honoured here explicitly. Without that an
 * UNGOVERNED session would stop being able to spawn, and "governance is opt-in" is the one rule this
 * package must never break by accident.
 */
export function maySpawnDefinition(ownGrant: Capability[], name: string): boolean {
  // ADR-0023 adds the middle case. `tool:*` is authority to grant every tool and satisfies this too;
  // `agent:*` is authority to spawn any definition and grants no tools at all, which is the configuration
  // an operator wanting "any of our definitions, narrow tools" previously had to fake with `tool:*`.
  return (
    ownGrant.includes(WILDCARD) ||
    ownGrant.includes(AGENT_WILDCARD) ||
    ownGrant.includes(agentCapability(name))
  );
}

/** The tool name that confers the ability to delegate further. */
export const DELEGATE_CAPABILITY: Capability = "tool:delegate";

/**
 * Every namespace a capability id may carry, as its literal prefix.
 *
 * **One list, because there were three and adding a namespace only updated some of them.** ADR-0035 taught
 * `normaliseCapability` about `workspace:` and left `ceilingForDefinition` (which mangled it into
 * `tool:workspace:<id>`) and `isSafeCapability` (which called it malformed) behind. The two places that parse
 * an id's namespace read this, so a fifth namespace is one entry rather than a third divergence.
 *
 * **Not every prefix decision in the package.** Inline `startsWith("` tests on a capability namespace are
 * scattered across `src/` and `extensions/`; this list is read by two of them. **The number is deliberately
 * not written here** — SPEC first claimed the list was "what every site reads", a correction said "six"
 * while its own enumeration listed seven, this docstring then said "nine" in the sentence claiming it gave
 * no number, and a re-derivation found fourteen files containing such a test. Run the grep; do not quote a
 * predecessor. Consolidating the sites is a separate change, and a count nobody re-derives is the defect
 * this list exists to prevent.
 *
 * `docs/SPEC.md`'s grammar section is the prose statement of the same list and is kept in step with it.
 */
export const CAPABILITY_NAMESPACE_PREFIXES = ["tool:", "ext:", "skill:", "agent:", "workspace:"] as const;

/** Accept `read` or `tool:read` or `ext:pkg/tool` and normalise to a capability id. */
export function normaliseCapability(raw: string): Capability {
  const value = raw.trim();
  if (CAPABILITY_NAMESPACE_PREFIXES.some((prefix) => value.startsWith(prefix))) return value;
  return `tool:${value}`;
}

/** The capability that authorises routing a child to one registered workspace (ADR-0035). */
export function workspaceCapability(workspaceId: string): Capability {
  return `workspace:${workspaceId}`;
}

/**
 * May this session route a child to workspace `id`?
 *
 * Mirrors `maySpawnDefinition` deliberately — same shape, same wildcard handling, same reason. Routing was
 * the one governance dimension that did not attenuate (R-131, measured in
 * `docs/probes/g36-workspace-attenuation`): the registry inherited into every child and nothing checked the
 * caller's authority, so a child routed to `staging` could route its grandchild to `prod`.
 *
 * `tool:*` satisfies it because governance is opt-in — an ungoverned session holds the wildcard and must
 * keep working exactly as before.
 */
export function mayRouteToWorkspace(ownGrant: readonly Capability[], workspaceId: string): boolean {
  const held = new Set(ownGrant);
  return held.has(WILDCARD)
    || held.has(WORKSPACE_WILDCARD)
    || held.has(workspaceCapability(workspaceId));
}

/**
 * Characters that make a capability id mean something OTHER than one capability.
 *
 * A capability id is never a list. `PI_GRANTS_GRANT` is comma-separated and `parseList` trims and splits
 * it, so a comma inside a single id means the child reads it as several — including ones nothing granted.
 * Newlines are here for the same reason one level out: the grant travels through an environment variable
 * and, via `assertGrantIsWritable`, a shell-sourced file.
 *
 * **Measured, on the published 0.18.0.** A root holding `agent:*` (or `tool:*`) that requested
 * `agent:x,tool:bash` had it admitted by the wildcard's prefix rule, written verbatim into the child's
 * grant, and split by the child into `agent:x` + `tool:bash` — minting a capability the root never held,
 * with `denied: []` so nothing recorded an escalation and the ledger line looked clean.
 *
 * Deliberately a blocklist of structurally dangerous characters rather than the full grammar whitelist in
 * `isSafeCapability`. That whitelist is right where it lives — the boundary that GENERATES a grant — but
 * this is the enforcement path, which must keep accepting whatever ids operators already have. A security
 * patch to a released version should close the hole without inventing a new way to refuse a legitimate
 * setup. `grant-env.ts` predicted this channel: "the third channel — whatever it turns out to be — should
 * cost a refusal rather than an injection."
 */
const CAPABILITY_ID_SEPARATORS = /[,\r\n\0]/;

/** False when an id would be read as more than one capability by any channel that carries it. */
export function isWellFormedCapability(id: string): boolean {
  return id.length > 0 && !CAPABILITY_ID_SEPARATORS.test(id) && id.trim() === id;
}

/**
 * The STRICT grammar: a whitelist of what a capability id may look like, not a blocklist of what it may not.
 *
 * **Two consumers, and they are two different reasons for the same rule.** It lives here rather than in
 * either of them because it shipped in one and was needed by both:
 *
 *  1. `skill-packages.ts` — the boundary that GENERATES a grant. R-77/R-78: a package declaring
 *     `allowed-tools: Read,ext:x";touch /tmp/pwned;PI_GRANTS_GRANT="` produced a `.pi/grants.env` that ran
 *     arbitrary code the moment an operator sourced the line `init` prints.
 *  2. `workspace.ts` — the operator registry, since ADR-0035 made a registry id the tail of a capability id
 *     (`workspace:<id>`). That made the registry an input to this grammar, and it got the LOOSE
 *     `isWellFormedCapability` blocklist instead, which review showed costs three things:
 *     an id of literally `*` loaded and minted `WORKSPACE_WILDCARD`, so an operator naming ONE worktree held
 *     routing authority over every id in the registry including ones added later;
 *     an id containing a space became TWO capabilities, because `ceilingForDefinition` splits `allowed-tools`
 *     on `[\s,]+` — `allowed-tools: read, workspace:prod bash` measured as
 *     `['tool:bash','tool:read','workspace:prod']`, i.e. routing over production plus a shell, neither typed
 *     by anyone (0.18.1's comma, one namespace over);
 *     and quote/`$()`/backtick ids reached the `ROUTABLE WORKSPACES` block of the generated file, whose own
 *     instructions tell the operator to paste them into `PI_GRANTS_GRANT`.
 *
 * **A blocklist was the wrong shape for this and the comment on `isWellFormedCapability` says why it is the
 * right shape THERE**: that one guards the enforcement path, which must keep accepting whatever ids operators
 * already have. A registry is a file the operator writes and can rename, so refusing a hostile id costs
 * nothing — and `grant-env.ts`'s standing warning applies to it exactly: *"the third channel — whatever it
 * turns out to be — should cost a refusal rather than an injection."* The registry was the third channel.
 */
/**
 * A workspace registry id, which is NOT a tool name and needed its own rule.
 *
 * `isSafeCapability` was reused here first, and that was the error: it is the grammar for a *tool* name, and
 * it refused ids that published 0.18.1 accepted — `feature/x` above all. Git worktrees are routinely named
 * after their branch, so a slash is the ordinary case, and a slash splits nothing: not the comma-separated
 * grant, not `allowed-tools`' `[\s,]+`. Refusing it bought no safety and broke the common setup.
 *
 * What is refused, and why each one earns it:
 *  - **whitespace** — `ceilingForDefinition` splits `allowed-tools` on `[\s,]+`, so `workspace:prod bash`
 *    measured as `['tool:bash','tool:read','workspace:prod']`: routing over production plus a shell, neither
 *    typed by anyone. 0.18.1's comma, one namespace over.
 *  - **comma, CR, LF, NUL** — split a grant.
 *  - **`*`** — collides with `WORKSPACE_WILDCARD`, so registering a worktree as `*` and granting
 *    `workspace:*` believing it named that one root minted routing authority over the whole registry.
 *  - **quotes, `$`, backticks, `;`, `&`, `|`, `<`, `>`, `(`, `)`, `\`, `#`** — reach the ROUTABLE WORKSPACES
 *    block of a generated `.pi/grants.env`, whose own instructions tell the operator to paste the id into
 *    `PI_GRANTS_GRANT`. Sourcing the file was safe; following its instructions executed. R-77/R-78.
 *  - **control characters and non-ASCII** — the generated file is reviewed in an editor and `/grants` prints
 *    these; backspace and ANSI escapes let one id render as another. This is the one refusal that costs a
 *    legitimate user something (a non-English worktree name), and it is a deliberate trade recorded as
 *    breaking rather than asserted to cost nothing.
 */
export function isSafeWorkspaceId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id);
}

export function isSafeCapability(id: Capability): boolean {
  const segment = "[A-Za-z0-9][A-Za-z0-9._-]*";
  // `workspace:` delegates to the WORKSPACE grammar rather than reusing `segment`, and that is the fifth
  // site of the same defect. `isSafeWorkspaceId` allows a slash because a git worktree is routinely named
  // after its branch; `segment` does not, so this function refused `workspace:feature/x` — dropping the whole
  // definition, exiting 1, and telling the operator "a capability id is tool:/skill:/agent:<name> or
  // ext:<pkg>/<tool>", which does not even mention the namespace. Meanwhile the CHANGELOG told them slashes
  // are fine. **The boundary that GENERATES grants could not emit the id shape the release advertises**, so
  // the migration path for a breaking change was closed by the commit that documented it as open.
  if (id.startsWith("workspace:")) return isSafeWorkspaceId(id.slice("workspace:".length));
  return (
    new RegExp(`^(tool|skill|agent):${segment}$`).test(id) ||
    new RegExp(`^ext:(@${segment}/)?${segment}/${segment}$`).test(id)
  );
}

/**
 * The write-side backstop, for every channel that joins capabilities into one string.
 *
 * `covered()` already refuses to GRANT a malformed id, so this should be unreachable — which is exactly
 * why it exists. `grant-env.ts` says it better than I can: "the third channel — whatever it turns out to
 * be — should cost a refusal rather than an injection. A guard that depends on my enumeration being
 * complete is not a guard." The propagation channel turned out to be that third channel, and it had no
 * backstop while the file-writing channel did.
 *
 * Loud rather than silently filtered: a malformed id here means something upstream admitted one, and
 * dropping it quietly would hide the defect that produced it.
 */
export function assertCapabilitiesArePropagatable(grant: readonly Capability[]): void {
  const malformed = grant.filter((c) => !isWellFormedCapability(c));
  if (malformed.length === 0) return;
  throw new GovernanceRefusal(refusal(
    "GRANT_ID_MALFORMED",
    `refusing to build a child environment: ${JSON.stringify(malformed)} contain characters that are not ` +
    `part of a capability id. The grant is comma-separated, so a child would read these as several ` +
    `capabilities — including ones nothing granted. Report this: a malformed id reached propagation, ` +
    `which means a guard upstream admitted it.`,
    { malformed: malformed.join(" ") },
  ));
}
