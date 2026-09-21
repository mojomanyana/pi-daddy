# Glossary

One line per term. This file exists because a fresh session should never have to open the session log or
the risk register to learn what a word means. When a term is retired by the consolidation programme
(ADR-0076), its line says so and names the replacement. Historical documents keep their original wording.

## Governance core

- **grant** — the set of capabilities a session holds, as `tool:<name>`, `agent:<name>`, `workspace:<id>` entries or `tool:*`; carried to children in the environment and only ever narrowed.
- **ceiling** — a definition's `allowed-tools` field; the most a child spawned from that definition may hold.
- **effective** — what a child actually receives: `(requested ∩ parentGrant ∩ ceiling) \ (gated \ approved)`.
- **gated** — a capability that needs a human's approval before a child may hold it; `tool:bash` by default, closed under subsumption.
- **attenuation** — the invariant that grant, depth, fan-out budget and approvals can only shrink going down a delegation tree (ADR-0008).
- **definition** — an Agent Skills `SKILL.md` file whose `allowed-tools` is the ceiling and whose body is the child's system prompt (ADR-0016, ADR-0017).
- **catalog** — the list of definitions and tools the current session can name, derived from pi's own tool surface and the discovered SKILL.md files.
- **ledger** — the append-only, hash-chained record of every capability decision and child lifecycle, `.pi/pi-daddy/grants.jsonl` since ADR-0076 PR 3c; one record format across stores arrives with PR 3d.
- **refusal** — a thrown error with a stable code (`CAPABILITY_ESCALATION`, `GATED_UNAPPROVED`, `CHILD_TIMED_OUT`, …); thrown rather than returned because pi discards a returned `isError`.
- **approval** — a human's answer to a gate: once, for the session, or "always" for 30 days for a named definition; the task text is never stored (ADR-0010, ADR-0014, ADR-0021).
- **correlation** — caller-supplied metadata (schema version `1.0`, an assurance scope) recorded beside a decision and never used as authority.
- **executor** — the way a child process is started: directly as a `pi` process, or inside a Herdr pane.
- **Herdr** — the terminal agent host at herdr.dev used as an executor and as the dashboard's window; not required.
- **tripwire** — a `tool_call` hook that blocks known third-party spawn tools so an ungoverned spawn cannot happen silently.
- **workspace lease** — an exclusive writer lock on a routed workspace directory; an exclusion mechanism, not a shared-memory mechanism (ADR-0034, ADR-0035).
- **named check / check runner** — a check a controller asks pi-daddy to run, whose receipt is returned to the caller and not persisted (ADR-0034).
- **retention (execution retention)** — opt-in storage of a child's stdout, stderr and result bytes with a manifest.

## Products around the core

- **ordinary** — the plain `delegate`, `delegate_all` and `delegate_chain` path and its children, as opposed to measured, factory or producer paths.
- **original** — the in-memory object or handle that created something (a session, a child, a controller), as opposed to state recovered from disk; the **original owner** is the process holding that handle.
- **exact** — bound by digest or identity to one specific artifact, tree or display frame, so a repaint or re-read cannot substitute another.
- **admission / hold** — permission for a new ordinary child to start; a hold blocks new admission without stopping active children.
- **quiescence / quiescent** — every tracked child has settled and no boundary failure or coverage gap is recorded (`ordinary-children.ts`); the condition for showing a closing review.
- **intent (intent request)** — a versioned request to change what work should run (pause, resume, scope, priority), applied through CAS.
- **CAS** — compare-and-swap on a state revision; a request carrying a stale revision refuses.
- **work / work setup / work run** — a saved DAG of one to eight tasks with explicit model, effort and dependencies, run through the ordinary path (`/grants work`).
- **work ledger** — the append-only record of work declarations and attempts; merges into the single ledger in ADR-0076 PR 3.
- **activity timeline** — the local record of parent turns, child lifecycles and skill-file reads, `.pi/pi-daddy/activity.jsonl`; merges into the single ledger in ADR-0076 PR 3.
- **control journal** — the append-only record of dashboard control actions; merges into the single ledger in ADR-0076 PR 3.
- **daily host / daily panel / dashboard host** — the in-process controller `/grants host` starts, reachable over a private socket, and the Herdr panel that projects it.
- **Sol, Terra** — the model IDs `openai-codex/gpt-5.6-sol` and `openai-codex/gpt-5.6-terra`. "Sol-approved" in a dated document means a review run by that model passed; it does not name a human.
- **P01 … P15** — work-package numbers from the operator's 2026-09-14 product proposal, which is not in this repository. Referenced in code and documents: P01 (work-setup builders and the selected work snapshot), P03 (daily-view projection contract), P05 (ordinary admission hold), P08 (retained-host debrief bridge), P11 (experiment controller and cancellation handles), P15 (factory orders). Other numbers are not referenced here.

## Learning (requires skill-harness)

- **skill-harness** — a separate npm package (`mojomanyana/skill-harness`): a test-and-optimise loop for agent skills. pi-daddy's learning, debrief and connected-host features depend on it. Pinned to one commit hash until ADR-0076 PR 4 makes it an optional versioned peer.
- **learning workspace** — the skill-harness workspace bound to one work snapshot, archive, population and author (`/grants learning`).
- **debrief** — skill-harness's blinded review of retained work cases: a quality choice is recorded before model and cost are revealed.
- **blind (card, intervention)** — a comparison shown without model identity until the quality choice is recorded.
- **attention slot** — one of five per-session opportunities the dashboard may use to ask the human a blind question.
- **trust store / trust labels** — skill-harness's journal of independent labels; whether earned attention may be spent depends on it.
- **adoption / rollback** — applying, or reverting, a model-and-effort policy for later orders through the work policy registry.

## Introduced by ADR-0076

- **kernel, governance, executors, advisors, products** — the five source layers with a mechanically enforced import direction.
- **advisor / Decider / advice** — a non-generative classifier (`choice`, `score`, `noul`) whose output can select, rank, annotate or propose and can never widen a grant, satisfy a gate or replace a human answer; each use is an `advice` ledger event.
- **Jev** — TypeSafe's decision model, reached through OpenRouter's decisions endpoint; the first advisor adapter.
- **context handoff** — what a child receives beyond its definition body and task: `none`, `files`, `pruned`, `summary` or `fork`, capped by an inherited ceiling (ADR-0078, forthcoming).
- **content store** — the content-addressed blob directory `.pi/pi-daddy/content/` shared by retention, activity content and, later, an artifact store.

## Retired names kept in the historical record

- **DTCM (Dynamic Tool & Context Management)** — the token-economics thesis ADR-0007 retired; kept verbatim in every dated document as evidence, never find-and-replaced.
- **pi-agent-grants** — the package's name before ADR-0027; the one rename that did go through the record, with what it made untrue listed there.
- **primary / shadow (variants)** — RETIRED 2026-09-21 (cleanup, deleted from the package): a `delegate_all` mode where one primary child's result is returned and shadow children's results are accounted separately.
- **producer** — RETIRED 2026-09-21 (cleanup, deleted from the package): three senses: (1) the opt-in model-free **producer IPC** child that emits one `{id,sequence:1}` line; (2) the "producer requirement register", `REQUIREMENTS.md`, the 2026-09-14 product delivery; (3) in chains and DAGs, the predecessor whose output is handed to the next step.
- **effect profile / digest profile** — RETIRED 2026-09-21 (cleanup, deleted from the package): `linux-bwrap-digest-v1`, a fixed non-shell operation inside a bwrap namespace that hashes at most 16 KiB.
- **factory order** — RETIRED 2026-09-21 (cleanup, deleted from the package): a DAG of one to sixteen nodes whose only supported operation is the digest profile (`contracts/factory-order/v1`).
- **measured order / measured session** — RETIRED 2026-09-21 (cleanup, deleted from the package): a DAG of tool-less SDK sessions on the two Sol and Terra model IDs with predeclared output hashes and recorded provider usage (ADR-0072).
