# Probe — `g16-herdr` (can herdr be a governed delegation backend?)

**What it measures.** ADR-0015 Option G proposes that `pi-agent-grants` speak herdr's own CLI so that
**we** build the child's argv — `herdr agent start <NAME> --kind pi --pane <ID> -- <planSpawn args>` —
rather than going through the third-party `@andrewjacop/pi-herdr`, whose `agentArgs` and `env` are
model-controlled (R-30). That requires two things to be true: herdr must deliver our argv unmodified, and
pi's `--tools` must still be enforced inside a pane.

**Headline result: both hold.** Argv is delivered verbatim and `--tools` bites inside a pane. Option G is
sound on this machine.

**The probe also found three things it was not looking for, and two of them are defects in the shipped
product rather than properties of herdr** — a governed child today inherits the operator's skills and
`CLAUDE.md`. See findings 4-6.

## Environment

herdr **0.7.5** (client and server, protocol 17, socket `~/.config/herdr/herdr.sock`), pi **0.84.1**,
Node v24.14.0, WSL2 (Linux 6.6.87.2-microsoft-standard-WSL2). Date: 2026-08-12.
Model for the two prompted runs: `openai-codex / gpt-5.6-sol` (the machine default). Total spend ~$0.03.

Note the pi version: every earlier probe in this directory records **0.83.0**. This one is the first at
0.84.1, and finding 6 is a direct consequence of that gap.

## 1. herdr runs on Linux/WSL2 — confirmed

`@andrewjacop/pi-herdr`'s README states Windows and macOS are tested and **Linux is expected but
unverified**, which ADR-0015 carried as a risk to Option G. That caveat is about the *extension*, not
herdr. `herdr status` reports client and server both running at 0.7.5, and `herdr api snapshot` shows
herdr hosting the entire live workspace — ten workspaces, seventeen panes, including the `claude` session
that ran this probe and an idle `pi`.

**Option G does not depend on `pi-herdr` at all**, so that caveat does not transfer to it.

## 2. Argv is delivered verbatim — measured

```bash
herdr pane split w7:p6 --direction right          # -> w7:p7
herdr agent start probe-gov --kind pi --pane w7:p7 -- \
  --no-session --no-extensions --tools read
```

The reply echoes what was launched:

```json
{"result":{"agent":{"name":"probe-gov","pane_id":"w7:p7","interactive_ready":true},
 "argv":["pi","--no-session","--no-extensions","--tools","read"],"type":"agent_started"}}
```

Everything after `--` arrives unchanged and in order. **This is the property Option G rests on**: the
grant is expressed as argv we construct, and no model-facing parameter sits between `planSpawn` and the
process.

`herdr agent start` requires a pane already at an interactive shell prompt, so pane creation
(`herdr pane split`) is a prerequisite step, and a second `agent start` against a busy pane fails with
`agent_pane_busy` rather than silently reusing it — which is the right direction to fail.

## 3. `--tools` is enforced inside a pane — measured

Prompted: *"List the exact names of every tool you can call… Then say whether you have a write or bash
tool."*

```
read, parallel
I have neither a write nor a bash tool.
```

And with everything withheld (`--no-tools --no-skills --no-context-files --no-extensions`), the same
question returns:

```
NONE
```

So the enforcement floor is real inside a pane, exactly as it is for a `child_process` spawn. A pane is
an ordinary pi process; herdr supplies the terminal, not the runtime.

## 4. NEW FINDING — skills load despite `--no-extensions`

The governed pane printed at startup:

```
[Skills]
  architect, build, debug, decide, git-ops, plan, review, skill-harness
```

All eight of the operator's skills, in a child launched with `--tools read` — the narrowest useful grant.

**This is not a herdr behaviour; it is true of every child this package spawns today.** `planSpawn`
(`src/spawn.ts:50`) passes `--no-extensions` and nothing else, and its comment reasons only about
*extension* discovery. pi has separate `--no-skills` / `--skill <path>` flags that it does not pass.

**Consequence:** the `skill:` capability namespace enforces nothing, which was already suspected
(`docs/SESSION-LOG.md` item f, ADR-0013) but had never been *measured*. It is now. A grant of
`skill:review` and a grant naming no skill at all produce the identical child.

## 5. NEW FINDING — `CLAUDE.md` loads despite `--no-extensions`

Same startup block:

```
[Context]
  CLAUDE.md
```

A governed child inherits the operator's project instructions. pi has `--no-context-files` for this and
`planSpawn` does not pass it. Whether it *should* is a design question — inheriting project conventions is
often desirable — but it must be a decision rather than an accident, because a context file is
model-directing text that no grant describes and no ledger line records.

## 6. NEW FINDING — a built-in tool this package does not know about

The `--tools read` child reported **`read, parallel`**. `parallel` was absent from `PI_BUILTIN_TOOLS`,
pinned *"as of 0.83.0"* as `bash, edit, edit-diff, find, grep, ls, read, write`.

> **Path updated 2026-08-12 (later).** That constant lived in `src/agent-types.ts:20` when this was
> written; ADR-0016 deleted that module and it now lives in **`src/pi-tools.ts`**, with `parallel` added.

**It is not an enforcement hole** — `--no-tools` removed it (§3), so it is gated like any other tool. It
is a **modelling** gap: `PI_BUILTIN_TOOLS` is what `ceilingFor` subtracts to derive extension tools and
what the catalog classifies, so an unknown built-in is misclassified as an extension capability. This is
**R-31's trigger firing** — *"any pi release changing the built-in tool list"* — observed in the product
rather than in a dependency.

## 7. NEW FINDING — `herdr agent wait --until idle` races

```bash
herdr agent prompt probe-gov "…"
herdr agent wait probe-gov --until idle --timeout 100000    # returned immediately
```

The agent had not begun working, so `wait --until idle` matched the **pre-existing** idle state and
returned at once (`state_change_seq` unchanged at 212). The reply is indistinguishable from a completed
run.

**For a fan-out backend this is a correctness trap, not an inconvenience:** an orchestrator that spawns
four reviewers, prompts each, then waits for idle would "collect" four children that never ran, and the
merge step would report on empty output. Any `runHerdrPane` must wait for `working` before waiting for
`idle`, or gate on `state_change_seq`/`revision` advancing past the value observed at prompt time.

## How to rerun

```bash
herdr status                                  # server must be running
PANE=$(herdr pane split --current --direction right | python3 -c \
  "import sys,json;print(json.load(sys.stdin)['result']['pane']['pane_id'])")
herdr agent start probe-gov --kind pi --pane "$PANE" -- \
  --no-session --no-extensions --tools read   # note the echoed argv in the reply
herdr agent prompt probe-gov "List the exact names of every tool you can call."
herdr agent read probe-gov | tail -c 2000
herdr agent stop probe-gov
```

Findings 4 and 5 are visible in the startup banner of that same run — no second run needed.
For §3's floor, repeat with `--no-tools --no-skills --no-context-files` in a fresh pane.

**Cleanup.** `herdr agent stop` ends the agent but leaves the pane.

> **Corrected 2026-08-12 (later).** This section originally said `send-keys` "did not close" the panes and
> that cleanup was manual. **That was wrong, and the cause was my own usage:** `herdr agent send-keys`
> takes keys as POSITIONAL arguments, and the calls here passed a `--keys` flag that does not exist, so
> nothing was ever sent. Literal text needs `herdr pane send-text`; key names go to `herdr pane send-keys`.
> **`herdr tab close <tab-id>` closes a tab and its panes cleanly**, and that is what `runHerdrPane` uses.
> Recorded rather than silently fixed because "the tool does not work" and "I called it wrong" are
> different findings, and only one of them was true.

## What this probe does *not* establish

- **That the pane is a security boundary.** It is not. A pane is a terminal; the enforcement point is
  still pi's `--tools`, and ADR-0012's conclusion is untouched — a child granted `bash` escapes from a
  pane exactly as it escapes from a `child_process` spawn.
- **That a human cannot widen the child.** A pane is interactive and attachable — that is the *feature* —
  so a person can type into a governed child. Humans are not this project's threat model, but no claim
  here should be read as containing one.
- **Anything about concurrency.** Only one governed agent ran at a time. Fan-out behaviour, herdr's
  per-pane resource use, and R-29's approval amplification are all unmeasured here.
- **That `--no-skills` / `--no-context-files` actually fix findings 4 and 5.** The flags exist in
  `pi --help`; that they produce the intended child was **not** tested. §3's floor run passed both, but it
  also passed `--no-tools`, so the effects are not isolated.
- **Long-run stability.** Both probe agents ran for under a minute.

---

## Addendum, 2026-08-12 — building the executor found four more constraints

`src/run-herdr.ts` was written against the findings above and **failed four times end to end before it
worked.** Each failure was a fact this probe had not established, and every one is now encoded in the
executor with a test. They are recorded here because the pattern is the point: *driving a CLI by hand and
driving it from code are different measurements.*

**8. `--print` is incompatible with `herdr agent start`.** It makes pi process the prompt and exit, so the
agent never reaches the interactive readiness `agent start` waits for and is simply never detected. herdr's
own error for this is an empty reply. The plan for this executor must be built with `print: false`, which
is why `DelegationContext` gained an `interactive` flag rather than the executor patching argv afterwards.

**9. herdr cannot pass a multi-line argument.** `agent start` types argv into the pane's shell and rejects
anything it cannot encode: `invalid_agent_argument — agent arguments cannot be encoded safely for the
target shell`. Since a definition's `SKILL.md` body is always multi-line, **every `delegate({agent})` spawn
would fail on this path.** pi accepts a *file path* for `--append-system-prompt` as readily as literal text
(`resolvePromptInput` + `existsSync`, `dist/core/resource-loader.js`), so the body is staged to a temp file
and the path is passed. The workaround lives in the herdr module because the constraint is herdr's — the
direct executor passes the same text inline without trouble.

**10. A freshly created pane is not yet at a shell prompt.** `agent start` fails with
`agent_pane_busy — not an available shell`. **This was invisible in the manual probe above** and failed on
the first scripted attempt every time: the think-time between two hand-typed commands is longer than the
shell takes to start. Handled by retrying *only* that condition until the deadline, rather than sleeping a
fixed amount that every spawn would pay.

**11. `agent read` does not return herdr's JSON envelope.** It writes the terminal's text straight to
stdout. Every other command replies `{id, result}` or `{id, error}`, so a uniform parser turned every
successful read into "unparseable herdr reply" — **reporting the child's actual answer as a failure to read
it.** Worth noting how this survived: the unit fake had been written to the envelope shape, so it *agreed
with the bug*. Only the end-to-end run disagreed. A test written from an assumption tests the assumption.

### What the working run proved

```
code: 0   timedOut: false   spawnError: (none)
 Reply with exactly the word GOVERNED and nothing else.
 GOVERNED
```

A governed child, spawned from a `SKILL.md` definition, in a herdr pane: grant on the pane
(`PI_GRANTS_GRANT=tool:grep,tool:read`), the definition's body as its system prompt via a staged file,
`--tools grep,read` enforced, output harvested, pane closed.

### Two things this addendum does *not* establish

- **That cleanup is leak-proof.** One pane (`w7:pF`) survived a *failed* run and had to be closed by hand.
  Cleanup runs in a `finally`, so it covers thrown errors — but not the process being killed between
  `tab create` and that block. A fan-out that dies mid-flight can still leave panes behind, and there is
  no reaper.
- **Why the fourth run timed out.** It reported `timedOut: true` with only pi's banner in the pane, as
  though the prompt never landed. The fifth run — same code apart from the `agent read` fix, which cannot
  affect settling — succeeded. **It did not reproduce, so no cause is claimed.** A prompt delivered before
  pi is genuinely ready is the obvious suspect, and if it recurs, gating the prompt on
  `interactive_ready` is the first thing to try.
