# ADR-0024: a gated `agent:` id asks before the definition runs

**Date:** 2026-08-14
**Status:** Accepted (2026-08-14, by the user, Option 1 over a steelmanned Option 3 — keep the warning)
**Driver:** R-47, half-closed by a warning on 2026-08-14 and now closed properly. **Coupled to ADR-0023**,
which shipped `agent:*` without the exception this provides.

## Context

`PI_GRANTS_GATED` names capabilities that may not enter a child's grant without a human saying so.
`gatedBlocked` is computed as a filter over `requested` — and for `delegate({agent: X})`, `requested` is
**X's ceiling**, the capabilities its `allowed-tools` declares. The id that *authorises* X, `agent:X`, is
checked in a separate and **ungated** branch (`maySpawnDefinition`, ADR-0017).

So `PI_GRANTS_GATED=agent:deploy` — written by an operator who read ADR-0017's *"it attenuates like any
other capability"* and meant *"ask me before deploy runs"* — produces no dialog, no refusal, and nothing in
the ledger marking the gate inert. It **does** bite when some *other* definition passes `agent:deploy` down
in its own `allowed-tools`, so the flag half-works, which is worse than not working at all. R-25's shape,
in the namespace ADR-0017 had just promoted out of exactly that state.

**Why this stopped being an isolated nit.** ADR-0023 added `agent:*`, and its consequences section now
records the problem: once an operator writes `agent:*`, `PI_GRANTS_GATED=agent:<name>` is the **only** route
back to per-definition control. So the menu was *enumerate every definition by hand* or *authorise all of
them with no carve-out*. That decision removed one cliff and left the operator on the next one.

## Options considered

### Option 1 — enforce it *(chosen)*

The authorising id is evaluated against the gate. A gated, unapproved `agent:X` blocks the spawn and raises
the ordinary dialog.

**Buys:** `agent:*` finally has an "except", which is the configuration this pair was always meant to
express — *authorise broadly, ask about the few that matter*. The subject is the **definition itself**, an
operator-authored file the session must hold `agent:X` to name, so by ADR-0019 it is a human-authored
subject and `always` is on offer: the operator answers once per 30 days, not once per spawn. It reuses the
whole existing path — `gatedBlocked`, `shouldSeekApproval`, `obtainApprovals`, the ledger's
`approvalSources` — rather than adding a second gate mechanism.

**Costs:** a behaviour change. A configuration that does nothing today starts asking, which is the correct
direction but is not a no-op for anyone who wrote it and moved on. Mitigated by the fact that the warning
shipped hours earlier tells them it currently does nothing.

### Option 2 — refuse the configuration at startup

Treat an `agent:` id in `PI_GRANTS_GATED` as malformed configuration: disable spawning and name the fix, the
way an unreadable `PI_GRANTS_MAX_DEPTH` already does.

**Buys:** consistent with existing fail-closed handling, adds no gate semantics, and cannot surprise anyone
at spawn time.
**Why it lost:** it makes *"any definition except the risky ones"* permanently unexpressible, which is the
gap ADR-0023 created. Refusing a configuration because the code does not implement it is honest, but here
the configuration is the reasonable one and the code is the gap.

### Option 3 — keep the warning *(steelmanned)*

**The case:** it is already honest, it costs nothing, and it points at a control that *does* work — withhold
`agent:X` from the grant. Every gate is a place a human can be asked, and there is a real argument that
*which definitions may run* is a **grant-time** decision (a property of the configuration) rather than a
**spawn-time** one (a property of the moment). Gates exist for capabilities that are dangerous *to hand
down*; a definition is dangerous *to run*, which is a different question.
**Why it lost:** because the two are not alternatives in practice. Withholding works only when the operator
enumerates, and `agent:*` exists precisely because enumerating does not scale. Leaving the warning means
shipping a wildcard whose only carve-out is a message telling you the carve-out does nothing.

## Decision

**A gated `agent:<name>` blocks a `delegate({agent: name})` spawn until a human approves it**, through the
existing approval path: it joins `gatedBlocked`, `shouldSeekApproval` raises the ordinary dialog, and the
approval is keyed to the definition — so `once`, `session` and `always` all apply, and a rewritten body
voids a stored yes exactly as ADR-0019 and ADR-0022 specify. `agent:*` in `PI_GRANTS_GATED` gates **every**
definition, so *"ask me before any definition runs"* is one variable.

The authorising id is **deliberately not added to `requested` or `effective`**. It is the parent's authority
to run this definition now, not a capability the child receives — putting it in `effective` would place it
in the child's own grant and let the child spawn that definition recursively without being asked. For v1
this means the ledger records the refusal in `gatedBlocked` and the approval in `approvalSources`, while the
child's grant is unchanged.

## Consequences

**Positive.** `agent:*,tool:read` plus `PI_GRANTS_GATED=agent:deploy` is now a coherent and expressible
policy: any of our definitions, narrow tools, and a human in the loop for the one that ships things. R-47
is closed, and ADR-0023's recorded gap with it.

**Negative.** A behaviour change for anyone already setting this. And a second gate *point* — the capability
gate and the authorisation gate now both raise dialogs, so an operator gating both `tool:bash` and
`agent:deploy` is asked twice for one spawn. That is correct (they are different questions) and it is
friction; `always` on both makes it once per 30 days.

**Neutral.** `delegate({tools})` is untouched — it names no definition, so there is no authorising id to
gate.

**Deliberate non-goals.** No prefix matching (`agent:review-*`) — ADR-0023 rejected that and this inherits
the reasoning. No separate variable: `PI_GRANTS_GATED` already means *"ask a human about this id"* and
splitting it would be two spellings of one idea.

## Revisit trigger

An operator disabling gating entirely (`PI_GRANTS_GATED=""`) *after* adopting this, which would mean the
double dialog is worse than the control is worth — the R-25 failure, arriving through the fix for R-47.
Measurable in the ledger, which now records `approvalSources` per capability: a rising ratio of `prompt` to
`persisted` on `agent:` ids is the leading indicator.
