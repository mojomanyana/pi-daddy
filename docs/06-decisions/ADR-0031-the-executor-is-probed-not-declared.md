# ADR-0031: the executor is probed, not declared

**Date:** 2026-08-17
**Status:** Accepted (2026-08-17, by the user — probe with refusal on a demanded-but-unreachable herdr)
**Driver:** the operator ran a real governed fan-out on a machine where herdr hosts the entire workspace, and
saw no panes. Nothing was broken — `PI_GRANTS_HERDR` was unset, which is the documented default. This changes
**where a governed child executes when the operator has not said**, which ADR-0016 point 6 decided the other
way, so it is recorded as a reversal rather than shipped as a convenience.

## Context

ADR-0016 point 6 made herdr *a supported execution backend, not the only one*. `planSpawn` produces the argv;
`runChild` and `runHerdrPane` are two ways to run it. The selection is one environment variable read once at
load time (`extensions/session.ts:224`), and `docs/SPEC.md:398` states the policy in full:

> Opt-in, never auto-detected from `herdr` being on `PATH`: where a governed child executes is an operator
> decision.

**What that produced, observed 2026-08-17.** A session in `/home/alavanja/repos/bookie-pi-skills`, governed by
a stored grant (ADR-0030), holding seven `agent:` capabilities, running inside a herdr pane, asked for a
parallel fan-out. Every child ran as a captured subprocess with no terminal. The operator's question was "why
is herdr not spawning these as agents I can switch between", and the answer was that they had never been told
the variable existed. **The default is the invisible executor on a machine where the visible one is the whole
workspace.**

### Two facts measured for this decision

**A reachable herdr server is directly observable.** `herdr tab list` replies immediately with a JSON envelope
— twenty tabs, one of them the pi session that ran the probe, `agent_status: "working"`. So "can this machine
run a governed child in a pane right now" is a *question with an answer*, not an inference from `PATH`.

**`--no-extensions` does not stop a governed child appearing as a herdr agent.** This was the hazard that
would have sunk the whole idea, and it is false. `docs/probes/g16-herdr/README.md:40-47` records a child
launched as exactly `pi --no-session --no-extensions --tools read`, with herdr emitting `agent_started`
carrying that argv verbatim and a live `state_change_seq`. Herdr registers the agent because
`herdr agent start --kind pi` was called, not because the herdr integration extension loaded inside the child.
`src/spawn.ts:76` can keep stripping ambient extensions — R-32's whole point — and the child still shows up in
herdr's agent list.

### Why the original refusal is answerable rather than wrong

`docs/SPEC.md:398`'s reasoning is *"a run that silently relocates because a binary appeared is exactly the kind
of invisible change this package exists to prevent."* Two words carry it, and they fail differently.

**"Relocates" does not describe a capability change.** `planSpawn` produces one plan and both executors enforce
it; ADR-0016 point 6 says so itself. The argv differs in exactly one respect — `interactive: session.useHerdr`
withholds `--print` — and that difference is already threaded through the plan rather than patched afterwards,
*because the argv is what the ledger records*. Nothing about the grant, the depth bound, the gate or the
ledger changes with the executor. A child in a pane is more exposed to a *human* (`docs/SPEC.md:42` — a pane is
attachable by design), and humans are explicitly not this project's threat model.

**"Silently" is the half that was right, and it is fixable.** It is fixable by disclosure, which is
ADR-0032's subject: naming the executor at session start and in `/grants`, and recording it per spawn in the
ledger. A choice announced twice and audited once is not silent.

**What remains genuinely dangerous is a naive probe.** `which herdr` succeeding while the herdr server is down
would turn every delegation on this machine from working into failing, at the moment a binary was installed
and never used. That is a real regression and it is why option C below is rejected.

## Options considered

### Option A — probe for a usable herdr, fall back to the process executor (CHOSEN)

Unset means *decide for me*: one `herdr tab list` at session start with a short timeout. Answered ⇒ panes.
Anything else ⇒ subprocess. Costs one cheap round-trip per session and a new failure surface (a probe that
hangs). Buys the behaviour the operator asked for on the machine they actually use, and CI is untouched
because there is no herdr there.

### Option B — keep it opt-in (status quo)

**The steelman is strong and it is this project's own house style.** A package whose entire subject is making
capability changes visible has no business making *any* change on its own initiative, and "the operator
decides where their code runs" is a defensible line to hold even when the operator would rather not decide.
Holding it also keeps R-62 at Low.

Rejected because the thing being decided is not a capability, and because the operator hit the failure. A
default nobody discovers is not a decision they made; it is a decision made for them by omission — and this
project has a name for a control that reads as a choice and is not one (**R-25**, where the human learns to
ignore it). The honest version of B is "you must choose", which would mean *refusing to spawn* until
`PI_GRANTS_HERDR` is set either way. Nobody wants that, and its absence is what makes B's line rhetorical.

### Option C — auto-detect from `herdr` on `PATH`

Rejected. It has A's shape with none of its safety: a machine where herdr is installed but its server is not
running silently loses every delegation, and the diagnostic would be `herdr tab create failed` on a path the
operator never chose. A probe that asks the wrong question is worse than no probe.

### Option D — a key in `~/.pi/agent/settings.json` instead of an environment variable

Rejected as orthogonal. It changes where the answer is written, not whether one is required, so an operator
who has not written it is in exactly the state that produced this ADR. It is also machine-wide, and the
executor is a per-invocation concern.

## Decision

**`PI_GRANTS_HERDR` becomes a three-state control, and its absence means "probe".**

| Value | Behaviour |
| :--- | :--- |
| unset | Probe once at session start (`herdr tab list`, short timeout). Reachable ⇒ herdr panes. Otherwise ⇒ captured subprocess. The outcome and its reason are disclosed (ADR-0032). |
| `1` | Force herdr. **The probe still runs**, and a failure is reported once at session start naming the variable and the probe's own error. Every delegation then refuses with that reason. **There is no fallback** — an operator who named the executor gets it or gets an error, never a substitution. |
| `0` | Force the captured subprocess. No probe runs. |

Absent, `1` and `0` are deliberately distinguishable, which is the same discipline `PI_GRANTS_GATED` already
uses for absent-versus-empty (`extensions/session.ts:222`).

**Decided 2026-08-17 by the operator, against the alternative of falling back loudly.** The reasoning that
carried it: a fallback the operator stops reading is R-25's shape, and the audit story is worth the broken
session — the ledger can then never contain a child that ran somewhere nobody chose. The cost is accepted
knowingly: a stale `export PI_GRANTS_HERDR=1` in a shell profile breaks delegation on any machine without
herdr, including CI, until it is found. **The session-start warning is what makes that cost findable in
seconds rather than minutes**, which is why it is part of the decision rather than a nicety.

**The probe runs once per session, never per spawn.** A herdr server that dies mid-session produces a failed
`tab create` on the next delegation, reported as the spawn error it is. Re-probing per spawn would mean a
fan-out's children could run under two different executors, and the ledger would be describing two things
under one call.

**The ledger records which executor ran each child.** Non-negotiable given the above: the argv already differs
between the two paths, so a record that omits the executor cannot be read back reliably. "Which executor ran
this?" must be answerable from the trail rather than from a variable's value at some past moment.

## What this makes untrue, and it is a documented claim

`docs/SPEC.md:398`: *"Opt-in, never auto-detected from `herdr` being on `PATH`: where a governed child
executes is an operator decision."*

**False as written.** The claim it becomes: *where a governed child executes is an operator decision they may
decline to make, and declining is answered by probing for a reachable herdr server — never by the presence of
a binary — with the result disclosed at session start and recorded per spawn.* The distinction between "on
`PATH`" and "answering" is the whole of why this is not option C.

`docs/SPEC.md:438`'s environment table row for `PI_GRANTS_HERDR` (`unset | herdr executor`) needs the three
states spelled out.

**ADR-0016 point 6 is amended, not superseded.** Everything else in it stands: herdr is a backend rather than
the only one, `planSpawn` owns the argv, `runChild` needs nothing installed and remains the fallback that
keeps the package working. Only the selection mechanism changes. A dated note goes on ADR-0016 pointing here;
its Decision is not edited.

**R-62's severity rating rests on a premise this removes.** It reads *"Low severity throughout: the herdr
executor is opt-in and `PI_GRANTS_HERDR` is off by default"* (`docs/03-risks.md:953`). After this, the pane
path is the **default** on any machine running herdr, so an orphaned pane after SIGKILL stops being an
opt-in-only hazard. R-62 must be re-rated in the same change. Nothing here fixes it, and ADR-0032 does not
either — SIGKILL runs no `exit` handler, by design.

## Consequences

**Positive.** The operator's real machine does the visible thing without configuration, and CI does the
headless thing without configuration, because the probe distinguishes them on the property that actually
matters.

**Negative — a delegation's argv now depends on a runtime observation.** Two runs of the same fan-out on the
same machine can record different argv if herdr was restarted between them. That is why the executor is
recorded: the trail stays *readable*, at the cost of no longer being reproducible from the ledger alone.

**Negative — a new hang surface at session start.** A wedged herdr server would block the probe. It is bounded
by an explicit timeout, and a probe that times out means the subprocess executor, which is the safe direction.

**Negative — R-62's blast radius grows.** See above. This ADR is the reason, so it carries the debt.

**Neutral — CI, containers and any machine without herdr behave exactly as today**, having answered the probe
in the negative.

**Deliberate non-goals.** herdr does not become a dependency, optional or otherwise. The probe is not
re-run per spawn. Nothing detects herdr from `PATH`, from an environment variable herdr sets, or from being
inside a pane — only from a server that answered.

## Revisit trigger

- **A delegation that fails on the pane path after the probe said yes.** That means the boundary between
  "usable" and "reachable" is in the wrong place, and the probe is testing the wrong thing.
- **R-62 recurring in ordinary use** — orphaned panes after an interrupt — now that panes are the common path
  rather than the opt-in one. This decision is what would have made it common.
- **Anyone reporting they did not know their children were running in panes.** That is option B's objection
  landing, and it means ADR-0032's disclosure is insufficient rather than that this choice was wrong.
- **A second executor.** Two candidates are a probe; three is a resolution order, and that wants deciding
  rather than accreting.
