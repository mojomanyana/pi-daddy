# Changelog — pi-daddy

Newest first. **Breaking changes are marked and say what to do about them.**

This file exists because the README had grown ninety lines of stacked version banners before a reader
reached what the package *does* — churn documentation in front of product documentation. The banners are
the record of how the package got here and are worth keeping; they are not worth reading first.

> **0.13.0 is the first PUBLISHED release.** Every version below it was developed in this repository and
> never shipped to npm, so if you are reading this as a new user, **none of the breaking changes described
> below can have affected you** — there was no earlier version to install. They are kept because they are
> the record of how the package arrived at what it does, and because the reasoning behind each one is
> usually the clearest statement of why the current behaviour is what it is.

## 0.14.0 — `pi-daddy init`, and a startup line that names what it will and will not spawn

> **Reviewed before release by five independent agents, one hypothesis each. All five found something, and
> nine defects were fixed here** — including one that executed arbitrary code from the file this feature
> tells you to commit (R-78), one that overwrote an operator's file and wrote through symlinks (R-79), and
> one where the startup line blamed your `SKILL.md` files for a misconfigured environment variable (R-81).
> **ADR-0029 came out of that review**: the generated grant is read-only by default. The reasoning for each
> is in `docs/03-risks.md` R-78 through R-82.

The pi-daddy half of making this package and a package of skills work together out of the box
(`docs/HANDOFF-principal-pi-skills-integration.md`, items B1/B2/B4; **ADR-0028**). Nothing about grant
resolution, enforcement, approvals or the ledger changed — this is the part before and around them.

- **The generated grant is READ-ONLY by default** (ADR-0029). `init` grants what the copied skills declare
  minus anything that can change your machine — `bash`, `write`, `edit` and the universal capabilities are
  written **commented**, naming the definitions that need them. `init` + `source` gives a working read-only
  setup; widening costs one deliberate uncomment. The reason: `PI_GRANTS_GRANT` is what *bounds* a declared
  ceiling, so generating it from those ceilings would give the bound and the bounded one author, and it
  would not be you.

- **`npx pi-daddy init` scaffolds a governed project.** It reads `<cwd>/node_modules` for packages declaring
  skills in their own `package.json` (`"pi": {"skills": [...]}`, pi's convention), copies each declared
  `SKILL.md` into `.pi/skills/`, and writes an annotated `.pi/grants.env`. That replaces, per skill: make a
  directory, copy the body, hand-write frontmatter, choose a capability set with no guidance, and assemble a
  `PI_GRANTS_GRANT` string by hand — seven times for `principal-pi-skills`.

  **It chooses no ceiling, and that boundary is the whole design.** A skill that declares `allowed-tools` is
  copied byte for byte; one that declares none is copied with a *commented* placeholder and stays
  unspawnable until a human fills it in. The placeholder is deliberately not a working example, so
  uncommenting it unedited fails loudly instead of granting something nobody decided. An existing file is
  **kept**, never overwritten — that edit is the capability decision, and a second `init` run is exactly
  when it would be destroyed. `--force` exists and says what it costs.

- **Session start says how many definitions are spawnable, and names the withheld ones.** The line reported
  the grant and never the definitions, so *"governance is working"* and *"did the install fail?"* looked
  identical:

  ```
  grants: 1 of 7 definitions spawnable — review
    withheld: architect, build, … — need agent:architect, …, which this session does not hold
  ```

  Classified by the same planner a real spawn comes through (no human is asked, stored approvals count), and
  it speaks even when **nothing** is spawnable — which is the state most worth being told about. It is an
  upper bound: it runs before the tool surface is observed, and `/grants` is the settled answer.

- **A worked `principal-pi-skills` example in the README**, replacing the invented one, with every line
  produced by running the commands (`docs/probes/b2-init-principal-pi-skills`).

- **Fixed before release: a skill's `allowed-tools` VALUE could execute code from the generated grant file**
  (R-78). `ceilingForDefinition` passes `ext:`/`skill:`/`agent:` entries through as written — correct for
  enforcement, where the catalog refuses what it does not know — so a package declaring
  `allowed-tools: Read,ext:x";touch /tmp/pwned;PI_GRANTS_GRANT="` produced a `.pi/grants.env` that ran the
  payload when sourced: silently, exit 0, with the variable left looking plausible. It survives
  `--ignore-scripts` and travels in the file you commit. Declared ids are whitelisted now, `tool:*`/`agent:*`
  from a package are refused, and the assembled grant is charset-checked before the file is written at all.

- **Fixed before release: `init` overwrote an operator's file and wrote through symlinks** (R-79). The
  presence probe was `readFile`, which treats *unreadable* as *absent* — so a permissions-restricted
  `SKILL.md` was replaced and its ceiling **widened**, with no `--force`. And `writeFile` follows symlinks, so
  a dangling link at a target path created the file outside the project while reporting an in-project path.
  Both are one `open(path, "wx")`. `--force` no longer regenerates `.pi/grants.env`, and `pi-daddy init
  --Force` is no longer accepted as a silent no-op.

- **Fixed before release: the startup line blamed your files for a session-level refusal** (R-81). A session
  at its depth limit, or with a malformed `PI_GRANTS_MAX_DEPTH`, was told its `SKILL.md` files were written
  wrong — two lines above `/grants` saying "delegation is disabled (maxDepth 0)". A session with no
  `tool:delegate`, which has no delegate tool at all, was told definitions were spawnable.

- **Fixed before release: a skill's directory name could write a capability into the generated grant**
  (R-77). A name is interpolated into a comma-separated `PI_GRANTS_GRANT`, into a file the operator sources,
  and into a path. A package shipping a directory called `a,tool:bash` produced
  `PI_GRANTS_GRANT="agent:a,tool:bash,…"` — `tool:bash` in an operator's grant, declared by no definition.
  Names are now whitelisted at discovery and a refusal is printed with its reason.

- **Fixed before release: `npx pi-daddy init` printed nothing and exited 0 for every installed copy** (R-73).
  npm installs a bin as a symlink, so `process.argv[1]` is the link and the entry-point guard compared it
  against the real file's URL. Caught by the smoke test, which now runs the installed bin — the same class of
  defect as the `exports` map that worked in the tree and threw for every consumer, and the second time that
  script has caught it.

## 0.15.0 — `/grants init`, a grant that survives without an env var, and a setup that was wrong

**Setup is two steps instead of five, and one of the five was wrong.**

```bash
pi install npm:pi-daddy
pi install npm:principal-pi-skills
pi
/grants init
```

- **`pi install`, not `npm install`.** This package's own documentation said `npm install`, and that is not
  how pi packages are installed: `pi install` registers the package in pi's settings, which is what makes
  the extension auto-load, and it installs to `$PI_CODING_AGENT_DIR/npm/node_modules` rather than the
  project. **`init` searched only the project and so found nothing for anyone who followed pi's own
  instructions** — telling them to install a package they had just installed. It now searches both roots,
  project first so a pinned copy outranks the machine-wide one.
- **`/grants init`** scaffolds definitions, asks about the capabilities that can change your machine, and
  applies the answer to the session you are already in — **no `source`, no restart**.
- **A grant can now come from a store**, at `$PI_CODING_AGENT_DIR/grants/<project>.json` — **outside** your
  project, because a ceiling a child holding `tool:write` could rewrite is not a ceiling. `PI_GRANTS_GRANT`
  **always wins**: it is how a child is governed and how CI is configured. `.pi/grants.env` is still written
  and still worth committing — it is the reviewable record, no longer what the enforcer reads. (ADR-0030)
- **The dialog does not ask questions whose answers cannot matter.** `tool:bash` subsumes `write` and
  `edit`, so once bash is granted those are conferred; asking anyway let an operator answer *no* to
  `tool:write` and then watch `build` be allowed it. It now reports them as already conferred instead.
- **An unknown `/grants` subcommand is refused rather than ignored.** `/grants init` used to print the
  ordinary status screen with the word silently dropped, so a command that did not exist looked like it had
  worked.
- **`init` counted authorisations and called them declarations** — "7 skill(s), 3 declaring allowed-tools"
  when all seven declared.

## 0.13.0 — the approvals file gets the lock the ledger already had, and two silences end

Closing the last items that were open rather than out of scope, then **red-teaming the result**: an
operator review and four independent agents, each given one hypothesis to attack. Between them they found
eight further defects **in that work**, all repaired here before release. The two worth knowing about
as a user of this package:

- **The file lock admitted two writers into the critical section.** `rm(lockPath)` deletes whatever is at
  the path, not the lock this process created, so a broken stale lock cascaded: the old holder freed the new
  owner's lock on the way out, and the next arrival — which raced nothing — walked in beside it. Reproduced
  across real OS processes. Every lock now carries a token and proves ownership before deleting.
- **The ledger over-claimed human approval under concurrency.** One *Allow for this session* answered under
  a fan-out of eight wrote eight lines each recording `approvalSource: "prompt"`. Riders now record
  `session`, which is what actually happened.

One breaking change, and it is a type.

- **BREAKING: `revokeApproval` returns `"revoked" | "absent" | "failed" | "busy"`**, not a boolean. It had
  two outcomes for four facts, and `/grants revoke` printed *"no persisted approval named X"* whenever the
  write failed — telling an operator that the approval they are revoking does not exist **while it is still
  in effect**. The most alarming outcome wore the most reassuring message. `busy` is separate because a lock
  timeout happens *before* the load, so nothing was looked at and nothing may be claimed about the entry.
  Callers switching on the boolean must switch on the string; `"revoked"` is the only success.
- **Approval writes hold a lock (R-49).** Every write is load → modify → write and none of them was
  serialised, so session 1 could load, session 2 could revoke, and session 1's next save would restore the
  revoked entry for the rest of its 30 days. The lock is the ledger's, moved to `src/file-lock.ts` and used
  by both — one implementation, two callers, opposite failure policies: the ledger fails a delegation closed
  when it cannot take the lock, the approvals store never fails your work, because it is a convenience cache.
- **`/grants ledger` counts where each approval came from.** ADR-0020 keeps the persistence layer on an
  asserted fatigue argument and named the evidence that would settle it — `persisted` against `prompt` over
  real use. The data was already recorded and nothing read it. **Two numbers, both labelled**: raw records
  are an *upper bound* on prompts avoided, because within one session only the first would have been a
  prompt and the rest come from the in-memory session cache; distinct `capability@subject` pairs are the
  closer estimate. Reporting records alone overstated the layer twentyfold in the obvious case (R-63).
  Records written before per-capability sources existed are reported as *not counted* rather than folded in,
  because that older scalar over-claimed `prompt`.
- **A revoke is documented as taking effect at the next gate check**, not "immediately". A spawn whose gate
  check already passed is not retracted by a revoke arriving microseconds later — inherent to revoking
  anything, and no lock closes it.
- **An unreadable ledger no longer silences session start (R-60).** `verifyLedger` rethrows on anything but
  a missing file, and that call sat inside an empty catch — so a `PI_GRANTS_LEDGER` pointing at a directory
  produced no alarm, no warning, and not even the line saying governance was on.
- **Herdr panes opened by a killed process are closed at exit.** Coverage is exact and documented in
  `src/pane-reaper.ts`: normal exit and `process.exit()` are covered; SIGKILL is not, and neither is a
  SIGTERM nothing else in the process is listening for. **No signal handler is installed**, deliberately —
  one here would suppress Node's default termination and turn pi's "interrupt this turn" into "exit pi".

## 0.11.0 is a breaking change: per-project approvals, and an inherited yes names its instructions

Four decisions taken together after the first independent review of this package's approval layer
(ADR-0020…ADR-0023). Two of them break compatibility.

- **Approvals are stored one file per project**, under `$PI_CODING_AGENT_DIR/grants-approvals/`. The
  single shared file could not express two checkouts holding an approval for a same-named definition —
  `review`, `deploy`, i.e. what happens the moment you reuse your own conventions — and every write
  touched every project's data, which is where four defects came from. **The old file is ignored, not
  migrated**, and reported once; re-approve when next asked.
- **`PI_GRANTS_APPROVED` carries a body digest**: `capability@subject#sha256`. A child verifies it against
  the definition **it** loaded, because a child is a fresh process that re-reads from disk — so a
  `git pull` mid-tree could otherwise let a descendant run rewritten instructions under a yes given about
  the old ones. A 0.10 parent and a 0.11 child do not understand each other's format.
- **The task is never stored.** `taskAtApproval` is gone: it put model-authored text in an always-on file
  outside your repository for 30 days, which this package's own rule forbids — and it displayed as though
  it scoped the approval, which it never did.
- **`agent:*` exists.** "May spawn any of our definitions, but never hand over `write`" was previously
  unexpressible; the only wildcard was `tool:*`, which is authority to grant every tool. `agent:*` confers
  no tool authority. Do not pair it with `tool:bash`.

## 0.9.0 / 0.10.0: an approval is pinned to the *instructions* as well as the tools

**ADR-0018 and ADR-0019.** Two changes, and the second was a repair.

**Every spawn naming a definition now records a `definitionDigest`** — `{name, source, sha256}` over the
body, which is the exact text passed to the child as `--append-system-prompt`. So the ledger answers *"did
these four children run the same instructions?"* and *"has this definition changed since?"*. It does not
answer *what the instructions said*: the digest identifies text without reproducing it. **The task string
is never recorded, in any field, by decision** — it is assembled by the model from the parent's context and
could carry anything the parent could see.

**`always` approvals were unreachable and are not any more.** `offeredScopes` gated that scope on the
interceptor path, which 0.7.0 deleted — so **no version from 0.7.0 to 0.9.0 could create a persisted
approval at all**, and the whole store was guarding a file nothing could write. `delegate({agent: X})` now
approves against **`X`** and offers `always`; `delegate({tools: […]})` keeps the fixed `<delegate>` subject
and is still never offered it. A persisted entry pins the definition's `allowed-tools` **and** its body
digest, so rewriting what a child is told to do voids the approval (`instructions-changed`) — strictly
stronger than ADR-0010 designed, since the ceiling check alone could never have seen a body change. An
entry carrying no body pin fails closed: unverifiable is not unchanged.

## 0.8.0 is a breaking change: spawning a definition requires `agent:<name>`

**ADR-0017.** The catalog has always emitted `agent:<name>` for every definition and the parser has always
accepted it, but **nothing ever checked it** (R-35). The only gate on `delegate({agent: "deploy"})` was
whether that definition's `allowed-tools` fitted inside the session's grant — so governance covered what a
child *can do* and never *which operator-authored instructions it was given*, and an operator could not
say "this session may spawn `review` but not `deploy`".

**What you must change:** an enumerated `PI_GRANTS_GRANT` now needs an `agent:` id per definition it may
spawn. `PI_GRANTS_GRANT="tool:read,tool:delegate"` can spawn nothing by name; add `agent:review` to allow
that one. `tool:*` satisfies any of them, so an **ungoverned session is unaffected** and `delegate({tools:
[…]})` is untouched. The refusal names the missing capability and lists what the session *may* spawn.

It attenuates like every other capability: a definition's own `allowed-tools` may list `agent:other`,
which is how a delegator is told which definitions **it** may spawn — and a parent can never hand down one
it does not hold. The id authorises; it is never passed to `--tools`.

**Also fixed, and required for the above (R-36):** `deriveOwnGrant` filtered the inherited grant against
the session's *observed tools*, which silently dropped `skill:` and `agent:` capabilities at the first
provider request. A child holding `skill:review` therefore could not re-grant it, and `/grants` stopped
listing it. Only `tool:` and `ext:` are filtered now — an observation says nothing about a namespace that
is not tools.

## 0.7.0 is a breaking change: this package is now the spawner, not a fence

**ADR-0016.** Earlier versions were a governance layer wrapped around `@tintinweb/pi-subagents`: the
product was a `tool_call` interceptor that decided whether *someone else's* spawn was permissible. It
could refuse or allow, never narrow, because that package's `Agent` tool has no `tools` parameter — a
ceiling no amount of local work could lift.

This version spawns children itself, so **the grant is an argument rather than a veto**. What changed:

- **`delegate({agent, task})` spawns a definition by name.** Definitions are **Agent Skills
  (`SKILL.md`)** files — the open standard, already read by 16+ tools — and their `allowed-tools` field
  becomes the grant. The spec calls that field *"pre-approved"* and **experimental**; it declares intent
  and blocks nothing. Passed through `--tools` it becomes structural. **The standard declares intent;
  this package makes it enforced.**
- **`delegate_all` runs several children concurrently**, each with its own grant, its own instructions,
  and no knowledge of the others.
- **Two executors, one plan**: a captured child process (default) or a visible, attachable **herdr** pane
  (`PI_GRANTS_HERDR=1`).
- **Skills and context files are no longer inherited.** Previously a child spawned with `--tools read`
  still loaded every skill the operator had, plus `CLAUDE.md` — measured, `docs/probes/g16-herdr`. So the
  `skill:` capability namespace enforced nothing. It does now.
- **A cardinality bound.** A subtree *budget* caps how many descendants may exist at all, because the old
  `delegate` bounded that to one only by accident of being blocking.
- **Removed:** the pi-subagents ceiling port (`agent-types.ts`, `interceptor.ts`). The `tool_call` hook
  remains as a **tripwire** that refuses third-party spawn tools — installing one is a single command,
  and a silently ungoverned descendant is the thing this package exists to prevent.

Built because that guarantee does not exist elsewhere. `@tintinweb/pi-subagents` provisions statically per
agent type and cannot be narrowed per spawn; `pi-fabric` provisions dynamically but **cannot constrain a
recursive child at all** (measured: `docs/probes/pi-fabric-eval`).

## Earlier

### 0.6.0

- **The approvals store moved out of the workspace** and a legacy in-workspace file is ignored with a
  warning (see *Approving a gated capability*).
- **`PI_GRANTS_APPROVED` carries `capability@subject` pairs** and `once` no longer crosses a boundary
  (**ADR-0014**). A 0.5.x parent and a 0.6.x child do not understand each other's format.
- **`bash` is gated by default** in a governed session, and gating is closed under subsumption, so
  `PI_GRANTS_GATED=tool:write` also gates `bash` (**ADR-0012**). Set `PI_GRANTS_GATED=""` for the old
  behaviour.
- **`delegate` is registered only when the session may delegate**, which is what the docs always claimed.
- Library entry points are compiled to `dist/`, so consumer imports work at all.

### 0.5.0 — hardening from two independent reviews

- **G1 · the argv channel.** Closed; see *Propagation is race-free by construction*.
- **G6 · the ledger.** It reported allowed wildcard spawns as escalation attempts, and dropped every
  refusal decided before resolution. Both fixed at the type level, so a new early exit cannot reintroduce
  them.
- **G7 · configuration.** Malformed bounds fail closed and say so; ungoverned sessions publish nothing; the
  catalog is awaited rather than raced.
- **G8 · child processes.** Caps, timeout, abort-before-spawn, real errors for failed children.
- **ADR-0011 · universal capabilities** are refused on every path, and a wildcard-holding delegator no
  longer bypasses a configured gate. Spawns that succeeded in 0.4.0 therefore fail — and **that reliance was
  never sound**, since each of them handed a child either the entire catalog or a capability an operator had
  explicitly gated. There is deliberately no override flag; the ledger names the capability and the reason.

---

Requires pi ≥ 0.83.0, Node ≥ 22.19. MIT.
