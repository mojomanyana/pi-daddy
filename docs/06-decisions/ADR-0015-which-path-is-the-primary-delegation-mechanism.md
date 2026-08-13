# ADR-0015: Which path is the primary delegation mechanism

**Date:** 2026-08-12
**Status:** Proposed — **deliberately not decided**, because the evidence the decision rests on was found
contaminated (R-28) and must be re-gathered first. See *Decision*.
**Driver:** the user's question — *"can we do all of this without third-party subagents support and rely on
our library + pi?"* — plus R-28, R-29, R-30, R-31, ADR-0013's usage argument, and `docs/SESSION-LOG.md`
item 3c (background/streaming delegation).

## Context

Two spawn paths exist, and they are not symmetric.

**The interceptor path** governs `@tintinweb/pi-subagents`' `Agent` tool. Re-measured 2026-08-12 against
**0.15.0** (every prior probe used 0.14.3, so this needed redoing, not citing):

- `SpawnOptions` still has **no `tools` field** (`src/agent-manager.ts:71-111`).
- The `Agent` tool schema still has no tools parameter — `prompt`, `description`, `subagent_type`, `model`,
  `thinking`, `max_turns`, `run_in_background`.
- Cross-extension RPC is still `ping`/`spawn`/`stop` (`src/cross-extension-rpc.ts`).
- Children are still in-process — `child_process` appears only in `worktree.ts`.

So on that path we can **allow or refuse, never narrow**, and that is a hard ceiling absent an upstream
change. What *did* change upstream since the proposal was drafted: `fallbackSubagent: "none"` shipped
(issue #183), so unresolvable types can be made to refuse rather than fall back to all-tools — which weakens
one of the proposal's own arguments and must be reworded before it is filed.

**Our path** (`delegate`) already provisions correctly today. `planSpawn` emits
`pi --print --no-session --no-extensions --tools <list> " task"` into a **separate OS process**, where pi's
own allowlist is the enforcement point and an `-e`-loaded extension cannot re-add a tool past it (measured,
`docs/probes/pi-fabric-eval` 9-11). It also carries three properties the in-process path structurally cannot:
argv neutralisation against `@file`/flag injection (`docs/probes/g1-argv`), a per-child `env` object with no
shared `process.env` to race on, and bounded execution (1 MiB cap, 10-minute wall clock, SIGTERM→SIGKILL,
abort checked before spawn).

What `delegate` lacks: it **blocks** (`runChild` resolves on `close`), so no fan-out, no background, no
result-by-id, no sessions, no worktree isolation, no UI, no cost rollup. It registers exactly one tool.

**The evidence problem, and it is the reason this ADR does not decide.** ADR-0013 preferred keeping the
interceptor on a usage argument: `Agent` used 25 times in a day, `delegate` **zero** outside probes. R-28 —
confirmed by execution this session — shows the interceptor was **refusing every narrow inheriting agent type
in an enumerated-grant session**, with a reason that misstated the file, while `/grants` reported the
opposite. Those 25 calls therefore cannot have come through a governed enumerated session; **the usage number
measures the ungoverned or wildcard case.** The single input this decision most depends on does not mean what
it says. R-28 is now fixed; the number has not been re-gathered.

Two further measured facts constrain any answer:

- **R-29 (confirmed):** the single-flight approval queue keys on `capability@subject` with a *constant*
  delegate subject, so one *Allow once* returns `granted` to every concurrent caller. Latent today because
  `delegate` blocks. **Any fan-out design must resolve this first**, and it reopens ADR-0014's decided
  property that "`once` stops at the boundary".
- **R-31:** the pi-subagents port has no version pin and no drift tripwire, and has already drifted
  (upstream 0.15.0, pi 0.84.1 vs probes' 0.83.0). Its failure direction is *permissive*.

A third mechanism entered scope this session. **herdr** (0.7.5, installed) is a terminal workspace manager
for agent panes with a CLI and a JSON-over-socket API; `herdr agent start <NAME> --kind pi --pane <ID>
[-- AGENT_ARG...]` launches a real CLI process in a pane, and `herdr agent wait --until idle|done|blocked`
plus `herdr agent read` harvest it. Panes are separate processes, so `--tools` bites. The third-party
`@andrewjacop/pi-herdr` wraps this, but exposes **model-controlled `agentArgs` and `env`** (R-30), which
reopens the g1-argv hole and allows a forged `PI_GRANTS_GRANT`.

## Options considered

### Option A — Async-minimal: background + `delegate_result` + fan-out on `runChild`
**Buys** the multi-level pattern this project exists for. **Costs** an entire lifecycle state machine that no
ADR currently specifies: the wall-clock timer lives in the *parent* process, so children orphan when pi exits;
the abort signal belongs to a tool call that has already returned, so cancellation is either absent or fires
at the turn boundary; `/grants revoke` stops reaching live children, making revocation theatre; results need a
retention and eviction policy where an evicted result must be a *retrievable error*, never an absent one
(R-03); the ledger's `childId` is a depth label wearing an id's name, so siblings are indistinguishable; and
nothing anywhere bounds **cardinality** — depth is bounded, fan-out is not, so 5×5 at `maxDepth 2` is 25
concurrent model sessions with every individual ledger line correct. **Forecloses** nothing, but requires
R-29 resolved and ADR-0008 given a cardinality companion.

### Option A′ — Bounded *synchronous* fan-out; `delegate` stays blocking
One tool call spawns up to K children concurrently and returns all K results when the last closes. No
background, no `delegate_result`, no registry, no ids in the transcript. **Buys** the whole latency win
(N×minutes → max(minutes)) and the real multi-level pattern, and it is the first genuine test of the approval
queue. **Costs** far less: because the turn still owns the children, the parent cannot exit first, the
tool-call signal is still live, the timeout timer still outlives every child, results are returned rather than
stored, and there are no ids to dangle across compaction. **Still requires** R-29 (per-spawn `once`), a
cardinality bound, a real `spawnId`, and multi-process ledger safety. The insight this option encodes:
**fan-out and background are separable, fan-out carries most of the value, and background carries nearly all
of the state-machine holes.** Option A bundled them.

### Option B — Full orchestrator: parity with pi-subagents
Background, streaming UI, result-by-id, `--session` transcripts, worktree isolation, stdin steering.
**Buys** feature parity. **Costs** a live child registry, a result store, git-worktree management, and a
streaming multiplexer that must parse model prose — which trips R-08's own trigger (>2 of {new service, new
datastore, new language, new agent fork}), with no pinned pi range and no nightly CI. Two specific new holes:
`--session` on a governed child writes a **resumable transcript** that `pi --resume` replays with the
operator's full default surface at depth 0 and no ledger line (an ungoverned re-entry point, and under
ADR-0012's stated threat model a durable store for an injected instruction); and opening stdin for steering
creates a second model-controlled parser channel whose first-character dispatch behaviour is **unmeasured**,
so `neutralisePrompt`'s positional guarantee may not cover it. **Forecloses** staying a small package.

### Option C — Curated-types fence: no new `delegate` features
`.pi/agents/*.md` frontmatter *is* a tool allowlist, so let the operator author narrow types and refuse any
non-curated type. **Buys** governance of the path carrying real traffic, at nearly zero code, and the
strategist ranked it first on exactly that basis. **But it is the most fragile option, and silently so.** The
type file lives **under the repo**, so an agent holding `write` can author `.pi/agents/anything.md` with
`tools: bash` and then request it — reintroducing the agent-writable trust root that **ADR-0014 was written to
remove**, one directory over and one ADR later. Compounding: `loadAgentTypes` runs once at `session_start` and
is never reloaded while pi-subagents re-reads from disk before execution (a TOCTOU window ADR-0013 fixed only
the *keying* of); the frontmatter parser's unsupported-YAML failure mode is *absent*, which means *all
built-ins*; and the fence has two measured bypasses that cannot be closed locally (`subagents:rpc:spawn`
producing no `tool_call`, and scheduled `Agent` executions). It buys the *appearance* of provisioning with
none of the mechanism, since we still cannot narrow.

### Option D — RPC client: use `subagents:rpc:spawn` for mechanics
**Strictly dominated.** It yields in-process children with no `tools` field, i.e. zero narrowing, trading away
the two things `delegate` has — a real process boundary and `--tools` as a hard enforcement point — to acquire
scheduling a bounded queue provides. It would also make ADR-0013 Finding 6 *self-inflicted*: our own spawns
would bypass our own `tool_call` hook, and `propagation.ts`'s race-freedom argument would stop applying to our
own path, because in-process siblings share `process.env`.

### Option E — Null: keep both paths, spend the effort elsewhere
`pi-token-audit` has **zero tests** and its headline number is already known wrong; `skill:` and `agent:`
capabilities **enforce nothing** while being shaped like controls. Both are live honesty defects that
arguably outrank any new feature. **Costs** nothing, buys nothing toward the delegation question — and, as
originally scoped, would have left R-28 shipping.

### Option F — Adopt `@andrewjacop/pi-herdr` and extend the fence over it
**Buys** every mechanic A/B would build. **Costs** putting a third-party extension in the trust path whose
model-facing parameters *are* the hole (R-30): `agentArgs` is a model-authored argv array, `env` is
model-controlled. We would be intercepting a tool designed to let the model choose both.

### Option G — Speak herdr directly from this package; **we** build the argv
`planSpawn`'s existing output goes through unchanged as `herdr agent start <NAME> --kind pi --pane <ID>
-- --print --no-session --no-extensions --tools <list> " task"`. The model never touches argv or env. A clean
seam: `runChild` (today) or `runHerdrPane`, same plan. **Buys** the mechanics *and* answers Option A's biggest
objection — **herdr becomes the registry**, so orphan reaping, child tracking, PID reuse and crash recovery
are a purpose-built supervisor's job rather than ours, and panes are visible and attachable. **Costs** an
optional dependency on an external binary and its API stability; `herdr agent start` requires an existing pane
at a shell prompt, so pane creation comes first; and the pane is a real terminal a human can type into —
steering as a feature, and a grant boundary a *human* can step over, though humans are not the threat model.
**Unverified:** upstream reports Linux as expected-but-untested, and this machine is WSL2. Needs a probe
before it is scored.

## Decision

**Not yet — and the refusal to decide is the decision.** ADR-0013 chose between these paths on a usage number
that R-28 has shown measures the *ungoverned* case, because the interceptor was refusing every narrow
inheriting type in exactly the sessions the product is for. R-28 is fixed as of this ADR's date; the number is
not re-gathered. Choosing a primary path now would repeat this project's original error — adopting a framing
whose justifying evidence had not survived contact (ADR-0007).

What **is** decided, and is not contingent:

1. **R-28's fix stands on its own merit**, independent of any option here: one `decisionContext()` builder, so
   the omission is unspellable, plus `test/interceptor-wiring.test.ts` — the first unit coverage
   `extensions/grants.ts` has had, verified by reintroducing the defect.
2. **Options D and F are rejected on evidence**, not on taste. D is dominated; F puts a model-controlled argv
   and env in the trust path.
3. **Option A is rejected as scoped**, in favour of **A′** if fan-out proceeds at all. Fan-out and background
   are separable; bundling them was an unforced error.
4. **R-29 is a hard precondition for any fan-out work**, and resolving it reopens ADR-0014. No fan-out code
   before that.
5. **The upstream proposal is demoted from blocking to optional.** It was ranked first on the reasoning that
   "no local work can lift that ceiling" — true, but it assumed *their* path had to be the provisioning path.
   Since our path already provisions, the interceptor's remaining job is to **refuse**, which needs nothing
   upstream. Still worth filing (the maintainer merged `SpawnOptions.cwd` on a caller's request in #102, and
   fixed extension-blocked-spawn reporting in #199, so the direction is welcome) — but as a gap report, not a
   dependency.

**For v1 this means** no new delegation features yet. The next actions are evidence, not code: re-measure
adoption against a *correct* interceptor, and probe herdr on Linux/WSL2 so Option G is scored on measurement
rather than on its README.

## Consequences

**Positive.** The one shipped defect on the enforcement path is fixed and covered. The option set is now
honestly scored, including two options (F, G) that did not exist when the session began, and two (A as
scoped, D) removed on evidence. A′ is a materially cheaper shape than what was on the roadmap as item 3c.

**Negative.** `delegate` remains blocking, so the multi-level fan-out pattern this project exists for still
has no implementation, and item 3c stays open. The upstream proposal remains unfiled. Deciding by not
deciding costs a session.

**Neutral / deliberate non-goals.** Containing an agent that holds `bash` remains out of scope (ADR-0012).
`subagents:rpc:spawn`'s bypass remains unclosable locally (ADR-0013 Finding 6). Cost and resource exhaustion
under fan-out is **not yet** a scoped concern — R-29's cardinality gap is recorded, and either a bound is
built or exhaustion is declared out of scope the way `bash` was; **silence is not an option.**

## Revisit trigger

- **Adoption re-measured on a fixed interceptor.** If `delegate` is still unused when narrow spawns actually
  succeed, Option C's core claim ("primary-ness is an operator configuration question, not a feature
  question") is strengthened and A′ loses its motivation.
- **A ledger entry showing one agent type needing different tool sets within one session.** That is the
  per-invocation thesis our path uniquely serves; absent it, static curation is sufficient and A′ is
  speculative.
- **A herdr probe on Linux/WSL2 succeeding**, with `--tools` verified enforced inside a pane — which would
  make Option G the cheapest route to every mechanic and reopen this ADR immediately.
- **Upstream landing a `tools` parameter** (R-31's trigger): the interceptor becomes capable of provisioning,
  and the case for a second path weakens sharply.
- **`pi-herdr` appearing in any settings `packages` list** (R-30's trigger): the fence must be extended
  before that session runs governed.
