# ADR-0030: a grant may come from a store outside the workspace, and the environment still wins

**Date:** 2026-08-17
**Status:** Accepted (2026-08-17, by the user — store outside the workspace, dialog for withheld only)
**Driver:** the setup was five steps and a restart, and the operator said so. This changes **where the root
session's grant comes from**, which is the trust root of the package, so it is recorded rather than shipped.

## Context

Before this, a grant reached a session exactly one way: `PI_GRANTS_GRANT` in the environment, read once at
session start. That is right for a *child* — it is how a parent bounds one, and it is how CI configures a
run — but it made the smallest honest setup this:

```
npm install …                      # 1
npx pi-daddy init                  # 2
$EDITOR .pi/grants.env             # 3
source .pi/grants.env && pi        # 4   ← the restart, and the reason for it
/grants                            # 5
```

Step 4 exists only because the grant had to be in the environment **before pi started**. Nothing about
enforcement requires that: the extension already computes `session.ownGrant` at session start and publishes
it to `process.env` for children via `publishChildEnv()`. It could as easily **read** a grant at session
start and then publish it.

So the restart was never architectural. What kept it was a real question about trust, and that question is
what this ADR answers.

## Decision

**A directory may have a stored grant, and it lives outside that directory.**
`$PI_CODING_AGENT_DIR/grants/<slug>-<hash>.json`, keyed by the project path and recording it.

**`PI_GRANTS_GRANT` always wins.** The store is consulted only when the variable is absent.

**`/grants init` writes it, asking only about the withheld capabilities**, and applies the result to the
running session with no restart.

Setup becomes:

```
pi install npm:pi-daddy npm:principal-pi-skills
pi
/grants init        → three or four questions
```

### Why outside the workspace

Because a grant is a **ceiling**, and a ceiling a governed child can rewrite is not a ceiling.

`<cwd>/.pi/grants.env` is writable by any child holding `tool:write`. Storing the live grant there would let
a child widen the *next* session's ceiling — which is **ADR-0014's self-defeating case, exactly**: persisted
approvals used to live in `<cwd>/.pi/` and were moved out because *"a session that may use `write` can write
the approvals file."* The same file, the same reasoning, one field over. A narrowed child holds no write
access to `$HOME`, so the store is beyond its reach.

`.pi/grants.env` is still written and still worth committing. It is now the **reviewable record** of the
decision — diffable in a PR, which is the property a team wants — and no longer the thing the enforcer
reads. Those are different jobs and it was doing both badly.

### Why the environment still wins

The variable is how a **child** is governed. A store that could override it would let a directory quietly
re-widen a child whose parent had already bounded it, which is the one thing the whole package exists to
make impossible. It is also how CI is configured, where a file in a home directory is not a thing that
exists.

The store is consulted in exactly the case it was built for: a human at a terminal, in a directory where
they ran `/grants init`.

### Why the dialog covers only what is withheld

Asking about every capability is a dozen questions on a first run, and this project has a name for what
that produces: **R-25**, where the operator learns to click through and the control becomes decorative. The
read-only capabilities a skill declares are already bounded twice — by the ceiling its author wrote and by
pi's `--tools`. The ones that can change the machine are the decision, so they are the question.

Answering *no* is not a failure. It leaves those definitions unspawnable and says so, which is the same
outcome `init` writes by default — reached deliberately instead of by omission.

## What this makes untrue, and it is a documented claim

`docs/SPEC.md` said, of `PI_GRANTS_GRANT`: *"unset ⇒ **ungoverned**. Presence switches governance on."*

**That is now false as written.** A directory with a stored grant is governed with the variable unset. The
claim it becomes: *governance is opt-in, and there are two ways to opt in* — set the variable, or run
`/grants init` here. Both are deliberate human acts; neither happens to a directory that did nothing. The
SPEC is updated in the same change, because a spec that lags the code is worse than no spec.

## The constraint that shaped the implementation

The store is read with **`process.cwd()`, not `ctx.cwd`**, because it must be read in the extension factory
— before any hook, and therefore before `ctx` exists.

That ordering is forced by **S-5**: whether `delegate` is registered at all is decided in the factory, and a
session without `tool:delegate` must not be offered the tool. A grant arriving later could not inform that
decision, so an async read would resolve *after* the thing it exists to decide — the class of defect R-38
and R-39 both were.

Almost always the two agree. When they do not, `session_start` says so out loud rather than leaving it to be
inferred from a surprising refusal. That check is synchronous, so it is not R-60's shape.

## Options considered

**A. Store outside the workspace — CHOSEN.** Unforgeable by a governed child, at the cost of being invisible
to code review.

**B. Store inside the workspace, committed.** Genuinely attractive: a grant is a team decision, and a file in
the repository is reviewed in a PR like anything else. **Rejected because the enforcer would read a file the
enforced can write.** A child holding `tool:write` could widen the next session's ceiling, and the operator
would see a normal-looking diff or no diff at all. What it would have bought — reviewability — is kept
anyway by `.pi/grants.env`, which is committed and *is* the record; it simply is not what the enforcer
reads. That split is the whole reason B could be rejected without losing anything.

**C. Keep the environment as the only source.** No new surface at all, and the status quo. Rejected because
the cost is a restart on every change and a five-step setup that an operator has to be talked through — and
because nothing in enforcement required it.

**D. Read the grant from `.pi/grants.env` directly.** The obvious shortcut: one file, already written, no
new format. Rejected for B's reason with none of B's benefit — the file is in the workspace, so this is B
without the honesty of admitting it is a trust decision.

## Consequences

**A stored grant is not inherited.** Children are governed by the environment their parent writes, exactly as
before. The store is a *source* for a root session, never a second channel downward — which is why "the
environment wins" is not merely a precedence rule but the thing that keeps propagation single-channel.

**`adoptGrant` moves the ceiling mid-session, and only a human can reach it.** Slash commands are
user-invoked and no tool exposes it, so a model cannot widen its own session by calling something. It does
not reach children that already exist: those are separate processes whose environment was fixed when they
started, and a child's ceiling should not move under it mid-run.

**Removing the store un-governs the directory**, which is the escape hatch. `/grants` prints the path.

## Revisit trigger

Any of:

- **A report of a stored grant surprising someone** — a session governed by a decision they did not remember
  making, in a directory they did not expect. That is the failure mode B was rejected to avoid *and* the one
  A introduces, so it is the honest thing to watch.
- **A second writer of the store.** Today only `/grants init` writes it. If anything else does — a tool, a
  hook, a model-reachable path — the "only a human decides a ceiling" property is gone and this ADR is void.
- **Anyone asking for the store to be committable.** That is option B returning, and it should be re-argued
  against what `.pi/grants.env` already provides rather than granted on the grounds that it seems tidier.
