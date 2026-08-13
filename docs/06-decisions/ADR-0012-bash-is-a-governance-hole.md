# ADR-0012: `bash` is a governance hole, and it may not be closable in-process

**Date:** 2026-08-10
**Status:** **Accepted 2026-08-10 — Option 2 + Option 4, plus `bash` gated by default.** Implemented the
same day; 198 unit + 8 integration tests passing.
**Driver:** Review group **G5** (findings B-C9, A-S7), from the two independent whole-codebase reviews in
`docs/archive/reviews/`. Interacts with **R-25** (`bash` subsumption), **ADR-0008** (the attenuation invariant),
and **ADR-0010** (approval semantics).

## Context

Two defects, one root cause: **`bash` is not a capability among others, it is a general-purpose execution
primitive**, and this package models it as an entry in a list.

### 1. The total bypass — measured, not theorised

A child granted `bash` can start a *completely ungoverned* pi. Verified live on 2026-08-10 against pi
0.83.0:

```bash
PI_GRANTS_GRANT="tool:bash" PI_GRANTS_DEPTH=1 PI_GRANTS_MAX_DEPTH=2 \
  pi --print --no-session --tools bash -e extensions/grants.ts \
  'Run exactly this shell command …: env -u PI_GRANTS_GRANT -u PI_GRANTS_DEPTH pi --print … '
# → UNGOVERNED_CHILD_OK
```

The descendant holds pi's full default surface. It appears in **no ledger**, its depth is **not**
incremented against `maxDepth`, and no grant is computed for it. Every guarantee this package sells is
absent from it — not weakened, absent.

The escape does not depend on `env -u`. `env -i`, a wrapper script, a shell function, `exec`, or simply
writing a file and running it all reach the same place. **The mechanism is "the child can execute
programs", and the governance state lives in that child's environment.**

### 2. Gating is not closed under subsumption

`resolve.ts:119-121` gates on exact capability names. The package's own `SUBSUMPTION` table states that
`bash` confers `write`, `edit`, `read`, `grep`, `find` and `ls`. So an operator who gates `write` — the
single most likely thing anyone gates — gets **no prompt at all** when `bash` is handed to a child that
proceeds to write files. The gate reads as satisfied because the *word* `write` never appears.

This one is straightforwardly fixable and is not the hard part.

### What makes this hard rather than merely unfixed

The package's central claim is structural: *enforcement is pi's own `--tools` allowlist, so no runtime is
needed inside the descendant.* That claim is **true and measured** for tool calls. `bash` breaks it not by
defeating the allowlist but by **going around the process boundary the allowlist protects**. Nothing this
package can compute in the parent constrains what a child's shell does.

**Assumption load:** none unvalidated. Both defects are measured or read directly from current code.

## Options considered

### Option 1 — Promote `bash` to `UNIVERSAL_CAPABILITIES`

Treat `bash` exactly as `fabric_exec` is treated: a grant containing it is not a narrow grant, and
`assertNarrowing` refuses it on both spawn paths.

- **Buys:** honesty, immediately and with a very small diff. The refusal message would state the true
  reason. It makes the invariant in ADR-0008 actually hold for every grant the package will issue.
- **Costs:** **enormous blast radius.** `bash` is in pi's default four-tool surface, so this refuses a
  large fraction of realistic delegations — very likely including the ones users most want. The package
  would become an instrument that says no to normal work.
- **Forecloses:** nothing permanently, but it would define the product as strict-first.

### Option 2 — Close the subsumption gap only, and document the bypass

Gate a capability when anything subsuming it is gated (so gating `write` gates `bash`), and state the
`bash` escape plainly in the README as a known, unclosable-in-process limit.

- **Buys:** fixes the tractable half; makes the most common gating configuration behave as the operator
  expects; costs almost nothing; keeps `bash` usable.
- **Costs:** the package still advertises containment it cannot deliver whenever `bash` is granted. A
  documented hole is still a hole, and the README's structural-guarantee framing would need real
  qualification, not a footnote.
- **Forecloses:** nothing.

### Option 3 — Require an OS sandbox for any grant containing `bash`

Refuse to issue a `bash` grant unless the child runs inside a container, namespace, or seccomp profile
that this package configures.

- **Buys:** the only option that actually closes the bypass. Containment becomes a property of the
  process, not of a string in an environment variable — which is the correct level, because that is the
  level the threat operates at.
- **Costs:** a large new dependency surface and platform matrix (WSL2 here, containers elsewhere), and it
  changes what the project *is*: from a pure-computation layer over pi's own flags into infrastructure.
  ADR-0002's stack decision did not contemplate this.
- **Forecloses:** the "no runtime inside the descendant" simplicity that makes the current design
  reviewable.

### Option 4 — Redefine the guarantee: govern the *tool surface*, not the *agent*

State explicitly that this package constrains which **tools pi exposes to a model**, and that a model
granted an execution primitive can do anything that primitive can do. Governance of `bash`-holding agents
is out of scope and belongs to the OS.

- **Buys:** an honest, defensible product boundary, with no code change. It is arguably what the package
  has always actually been, and the reviews' phrasing supports it: `--tools` enforcement is real.
- **Costs:** significantly narrows the claim. "A sub-agent can never confer more than it holds" survives;
  "a sub-agent is contained" does not. Anyone whose threat model includes a capable adversarial model gets
  much less than the README currently implies.
- **Forecloses:** nothing, and it composes with Option 2.

## Decision

**Option 2 + Option 4 together, and not Option 1 — plus a fifth element the options above did not
contain: `bash` is GATED BY DEFAULT in a governed session.**

### The threat model, stated, because everything else follows from it

**Sub-agents are cooperative but fallible.** The risk being managed is a confused or over-eager agent doing
damage by accident, or **a prompt-injected one going off-script** — not an agent that deliberately hunts
for an escape hatch.

That last clause is why the decision is not simply "document it". **A prompt-injected agent holding `bash`
*is* the adversarial case**: it will follow instructions to escape, because following instructions is
exactly what went wrong. The escape is therefore reachable in this threat model, through hostile content in
a repo a sub-agent reads. What the threat model rules out is *disproportionate* responses — an OS sandbox
(Option 3) against an adversary that is not assumed, and refusing every `bash` grant (Option 1), which
would make the package useless for the delegations people actually run.

### What was decided

1. **Gating is closed under `SUBSUMPTION`.** A capability is gated if it is gated *or if it subsumes
   something gated*. Gating `write` now gates `bash`. **The direction is load-bearing**: gating `bash` must
   *not* gate a plain `write` grant, or gating a broad capability would restrict the narrow ones and invert
   least privilege. Covered by a test that would otherwise pass either way.
2. **`bash` is gated by default** (`DEFAULT_GATED = ["tool:bash"]`), so a human is asked before any child
   receives it. With subsumption-aware gating, that one entry also covers `write`, `edit`, `read`, `grep`,
   `find` and `ls`.
3. **The guarantee is scoped to the tool surface.** The package governs *which tools pi exposes to a
   model*, enforced structurally by `--tools`. An agent granted an execution primitive can do anything that
   primitive can do; containing **that** is the operating system's job and is explicitly out of scope.

### The principle this bends, and how far

The extension's rule has been *"governance is opt-in and never silently tightens a workflow"*, with the
code default for `PI_GRANTS_GATED` empty. **That rule survives where it matters**: an ungoverned session —
no `PI_GRANTS_GRANT` — is completely untouched and still blocks nothing.

What changes is inside a session the operator *already chose to govern*. There, handing a child `bash`
hands it an ungoverned-descendant escape hatch, and doing so **silently** is the behaviour worth changing.
`PI_GRANTS_GATED=""` turns the default off; absent and explicitly-empty are deliberately distinguishable,
because without that an operator wanting no gates would have to stop governing altogether.

**`src/resolve.ts` was modified.** ADR-0011 stated that file was untouched and did not authorise changing
it. This decision does, explicitly and narrowly: gating semantics live there, and implementing
subsumption-aware gating anywhere else would mean a second gate check that could disagree with the first.

## Why not the others

**Option 2 + Option 4 rather than Option 1 alone.** Close the subsumption gap because it is a real
defect with a cheap fix and it silently defeats the most common gating configuration. Then redefine the
guarantee honestly rather than pretending a string in an environment can contain a shell.

Option 1 is rejected because refusing every `bash` grant makes the package useless for the delegations
people actually run, and it would buy honesty the documentation can supply for free. Option 3 is the only
true fix and should be recorded as the path if a threat model ever demands containment against an
adversarial model — but adopting it now would change the project's nature on the strength of a
hypothetical user.

**This recommendation is not the decision.** It narrows what the product claims, which is the user's call.

## Consequences

**If the recommendation is taken:**

- The README's guarantee needs rewriting, not annotating. "Enforced by pi's own `--tools` allowlist, so the
  guarantee is structural" stays true for tools and must stop implying containment of the agent.
- `PI_GRANTS_GATED="tool:write"` would begin gating `bash` too — a **breaking change** for anyone relying
  on the current behaviour, though that reliance was on a gate that did not work.
- **R-25 stops being a documentation note and becomes a product boundary.**

**While unresolved:**

- Any deployment granting `bash` is ungoverned in practice, while the ledger records a narrow grant. That
  is worse than no governance, because the audit trail asserts a containment that does not exist.
- The `/grants` output and every ledger entry overstate what was enforced whenever `bash` is in the grant.

## Revisit trigger

- A user states a threat model including a deliberately adversarial sub-agent → Option 3 becomes live.
- pi gaining a first-class sandbox or a restricted-shell tool → Option 3's cost collapses.
- Any evidence of the escape being used in practice, rather than in a probe.
