# ADR-0025: retire `pi-token-audit`

**Date:** 2026-08-14
**Status:** Accepted (2026-08-14, by the user, Option 1 over a steelmanned Option 3 — keep it, labelled)
**Driver:** scope. Raised by `product-strategist` in both red-team passes; sharpened by R-59, which showed
the package's *documentation* cost more than the package returned.

## Context

`pi-token-audit` is one 223-line extension that reports where a session's tokens and money went. It was
built for the thesis **ADR-0007 retired**: that tool definitions cost enough context to be worth managing
dynamically. G10 falsified its headline on 2026-08-10 — the "tool-definition share" was
`toolChars / payloadChars`, a character ratio with `promptTokens` cancelling exactly, presented as a share
of tokens — and `5c593fb` **fixed it the same day**: the token estimate is deleted, the arithmetic of the
mistake is preserved in a comment, and the report now says *"% of request CHARACTERS … not a token
measurement"*.

**So the case for deletion is not that it lies.** It does not, and that matters, because both reviewers and
this session's assistant said otherwise — repeatedly — from a stale line in `CLAUDE.md` (R-59). Deciding
this on the false premise would have been deciding it for the wrong reason.

What is true:

- **No tests.** Verified against one provider's payload shape only.
- **Nothing depends on it.** `pi-agent-grants` does not import it; no shared code, no shared types.
- **It is publishable.** `0.1.0`, no `private: true`, and it ships an extension pi will load.
- **It serves a retired thesis**, and this repository is judged on control correctness (ADR-0007).
- **It has a documentation footprint out of proportion to its size.** R-59 is the evidence: four documents
  described a defect it no longer had, two independent reviewers repeated the claim, and the assistant
  repeated it three times in one session. A second package in a single-product repository is a second thing
  every orienting document must keep true.

## Options considered

### Option 1 — delete it *(chosen)*

**Buys:** one package to document instead of two. The G10 falsification — the actually valuable artifact —
stays in `docs/probes/` and in git history, where it is *evidence*, not something that must be kept in step
with a shipped README. Removes an untested, publishable extension.
**Costs:** *"where did my tokens and money go?"* is a genuinely useful question, and the answer is orthogonal
to the thesis that motivated it. Anyone wanting it again must recover it from history.

### Option 2 — keep it and write tests

**Buys:** makes it defensible as a shipped package — unit tests for the accounting, fixtures for more than
one provider.
**Why it lost:** it spends a session on something the project is not judged on, and the first question the
tests would have to answer is whether a character share is worth reporting at all now the token estimate is
gone. Investing to find out is the wrong order.

### Option 3 — keep it, labelled unsupported *(steelmanned)*

A header saying: untested, one provider, not part of the governance product.

**The case, and it is real:** it costs ten minutes, it is honest, it is reversible, and the tool works. The
cost-visibility question survives the retired thesis intact — knowing where the tokens went does not depend
on tool definitions being the answer. Deleting working, honest code because its *motivation* was retired is
how a repository loses things it later wants.
**Why it lost:** the labelled-unsupported state is exactly what produced R-59. A package nobody maintains
but everybody must document is the shape that let a fixed defect be described as live for four days, in the
file every reader and every reviewer starts from. The label would have to be maintained too.

## Decision

**`packages/pi-token-audit` is deleted**, along with every reference that describes it as a current
artifact — `CLAUDE.md`, both READMEs and the session log's open-items table. `docs/probes/` keeps the G10
measurement and its arithmetic unchanged, and this ADR plus `5c593fb` are the pointer for anyone who wants
the code back. For v1 this repository ships exactly one package, `pi-agent-grants`.

**Not deleted, and this is the distinction:** the *finding*. G10 is one of this project's better pieces of
evidence — a headline number that survived review, reached `SESSION-LOG.md` as a verified fact and fed
ADR-0006 before anyone noticed `promptTokens` cancels. That belongs in the probes forever. The code that
produced it does not have to stay installed for the lesson to stay learned.

## Consequences

**Positive.** One package to keep documents true about, which R-59 shows is the real cost. No untested
publishable artifact. `CLAUDE.md`'s "Where Things Live" shrinks to what this project actually is.

**Negative.** Cost visibility goes with it. If it is wanted back it must be restored from git rather than
maintained continuously — and it will come back untested, because that is how it left.

**Neutral.** No code change to `pi-agent-grants`; nothing imported it.

**Deliberate non-goal.** No replacement. If cost visibility is wanted later it should be a separate decision
with its own justification, not this package restored on momentum.

## Revisit trigger

A concrete need to answer *"where did this session's tokens and money go?"* — for instance, the measurement
ADR-0020 asks for, which counts `persisted` against `prompt` in the ledger and needs no token accounting at
all. If that measurement or a successor turns out to need real token counts, restore from `5c593fb` **and
write the tests this decision declined to fund**, rather than reinstating it as it stood.
