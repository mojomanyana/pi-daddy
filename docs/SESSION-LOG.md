# Session Log

**Where things stand and what to do next.** `docs/SPEC.md` says what the product *is*; ADRs hold the
decisions; this file holds state and next actions. Newest entry on top.

---

## NEXT SESSION — read this, then pick one

**Before your first edit: `git branch --show-current`. If it says `main`, branch.** Working rule 10 — and since
2026-08-22 the *server* enforces it: `main` requires a pull request (zero approvals) with both CI legs green,
and `enforce_admins` is on, so a direct push is refused rather than merely discouraged.

**STATE, 2026-09-01. `0.20.1` is released and registry-verified.** npm `latest`, tag `v0.20.1`, the GitHub
Release and the released baseline resolve to one commit, so `git rev-list -n1 v0.20.1` is the immutable source
point and this block deliberately names no mutable `main` SHA. **Thirty-six ADRs.** This patch repairs R-172:
0.20.0's dashboard sent mutually exclusive workspace and pane selectors for a split, so Herdr refused every
first open. The breaking 0.20.0 ledger/routing contracts are unchanged. Release evidence: **727 unit · 45
integration against real pi and Herdr 0.8.2 · typecheck · installed-package smoke · 97/97 mutation guards ·
independent specification/quality approval**. Two clean packs were byte-equal. Registry verification installed
`pi-daddy@0.20.1` into a fresh project, imported it, found the plugin, found no test-control artifact, and opened
then closed a real right split beside the caller. Registry shasum
`8e8b6d7be99d0d9f17e0b3024a9f3996401d926b` matches the published tarball; its SHA-256 is
`f05e4ace823cc80d77b2f26c0d78ace18c553e3f9c4db654005454b5ff1e31bb`.

*(These lines were stale for about an hour after the release — they said "nothing is released", the tier "was
not run", and named a commit three merges back, while the paragraphs directly below them said otherwise. **That
is this project's signature defect in its most-read location**, found by re-reading the document at close rather
than by a check, because nothing mechanical watches a summary for agreement with its own body. **Then the fix
went stale on merge**: it asserted `main` is `<sha>`, and merging it moved `main` past that sha — R-156's own
trigger, firing on R-156, inside the commit that recorded it. A summary that must be updated BY commits cannot
cite a mutable `HEAD` pointer; it can cite a tag, which does not move. If you change what is true here, change
these lines in the same commit.)*

**0.20.1 dashboard repair released and registry-verified, 2026-09-01.** R-172: released 0.20.0 sent both
`--workspace` and `--target-pane` for a split plugin pane, while Herdr's API permits only the pane target for
that placement, so every first dashboard open was refused with `invalid_params`. The old unit fake accepted
and explicitly pinned the impossible combination. The regression now reproduces Herdr's rejection, the open
omits only the workspace selector, and a mutation restores it. Host verification and the returned
workspace/tab postcondition are unchanged. PR #25 merged as `eb6ef4a`; tag `v0.20.1` and the non-draft GitHub
Release point there. npm `latest` resolves to 0.20.1, and a fresh registry install exercised the production
open against Herdr 0.8.2 rather than only inspecting package bytes.

**What the product now does that it could not before:** workspace routing is a capability, so it attenuates
(ADR-0035). Before that, a child routed to `staging` could route its grandchild to `prod` with a real lease, a
validated CWD and a ledger line naming `prod` — every other dimension attenuated and the working directory did
not. That shipped in 0.18.0 and is fixed on `main`, unreleased.

**0.19.0 is RELEASED and VERIFIED FROM THE REGISTRY (2026-08-23).** Installed from npm into a scratch project
— not the packing smoke test, which installs a tarball into a project that already has the workspace's types —
and exercised: narrowing, escalation refusal, `WORKSPACE_NOT_AUTHORIZED` without `workspace:<id>` and allowed
with it, routing a child conferring nothing, **R-135's wildcard held but not inherited** (the defect live for
eleven releases), the ledger v2 contract through its export path, and the installed `bin` symlink (R-73's
defect). **The opt-in model tier ran for the first time in this project's history — 55 tests, 54 passed.** Its one
failure was a stale TEST, not the product (**R-155**): it asserted every ledger *line* carried a distinct
`childId`, which stopped being true when ADR-0034 gave each child lifecycle events as well as a capability
decision. 9 lines, 3 ids; the property held, the assertion did not. **Rule 7's mirror, and this repository had
only written down one half:** a test that can no longer *pass* is as dead as one that cannot fail, and an
opt-in tier CI cannot run is exactly where such a test hides. Fixed and re-run against a real model. **The
other 54 are the point** — a child provisioned with exactly its grant and unable to exceed it, a universal
capability refused on both grant shapes, a wildcard holder still subject to a gate, an approval from another
directory authorising nothing, a corrupt ledger reported unasked, and ADR-0035's own line: a real session reads
the registry and lists what it may route to.

**And the model gap closed:** with model turns authorised, the published package spawned real `pi` children
with a control — same prompt, same model, only the grant differing. `["tool:read"]` → the child replied
**`CANNOT_WRITE`** and wrote nothing; `["tool:read","tool:write"]` → it wrote the file. The central claim,
verified through the npm artifact against a real model. One packaging defect found and recorded as **R-154**: seven `.d.ts` files use `NodeJS.*` while
`@types/node` is only a devDependency, so a TypeScript consumer with `skipLibCheck: false` and no Node types
gets seven errors. One line in `peerDependencies` fixes it, and it needs a release decision.

**0.19.0 — the first publish since 0.18.1, and it is breaking.** Every grant that
routes a child to a registered workspace must add `workspace:<id>`; a delegation naming a workspace the session
does not hold is refused `WORKSPACE_NOT_AUTHORIZED`. **A 0.18.2 was staged and deliberately abandoned**, and the
reasoning is worth keeping: it would have fixed the retained-lease hang while leaving **R-131 — routing does not
attenuate — live in published 0.18.0 and 0.18.1**, because the fix for R-131 *is* the breaking change. One
release fixes all three; two lines would have meant supporting a version with a known escalation in it. The
CHANGELOG's 0.19.0 section records that reversal rather than quietly dropping the paragraph that argued the
other way.

**Eight review passes ran over ADR-0035 and the invariant held in the last five** — three-level transitivity on
the production path, both halves of two-authorities, every wildcard channel, the grant store, all three
delegation tools. **Every finding since the second pass was the claims layer or the runtime half.** If you read
only one, read **R-144**: the commit that *narrowed* that PR deleted a guard and left three documents selling
it, one of them R-137's own blast-radius bound, so an OPEN risk understated itself. *A commit that removes a
guard must grep for the guard's claims, exactly as one that adds a guard must add its test.*

### The checks are mechanical now, and that changed the failure mode

`.github/workflows/ci.yml` runs typecheck, the unit suite, a tree-cleanliness assertion, **the mutation
catalogue** and the installed-package smoke on every PR, across the `engines` floor (22.19.0) and the
development ceiling (24.x), with `FORCE_COLOR` pinned. Eight passes had each found guards deletable with the
whole suite green; that was never a discipline problem, it was R-34 — *a check an operator has to know to run is
not a control, it is a feature.*

**It earned itself on its first real run** by splitting the matrix: 27/27 on 24.x, **0/27 on the floor**, every
entry reporting *"the auditor could not read the output — this is NO verdict on the guard."* `node --test`
defaulted to TAP before Node 23 and this parser reads `spec`. Pinned. Three things had to be true for that to
cost five minutes instead of a sweep of 27 false "fixes": the positive control existed (R-143, and it was
unforced until a reviewer made me test it), the matrix existed, and CI ran the catalogue at all.

### NEXT SESSION — ranked

1. **The measurement ADR-0020 asks for.** Still the highest-value item and still only the operator can run it:
   govern real work for a few weeks and read `/grants ledger`'s `N prompt · N persisted` line. That ADR rests on
   an asserted fatigue argument until someone does. The machinery has existed since 0.13.0; the *usage* is what
   is missing.
2. **Watch for upgrade friction on the breaking changes.** 0.20.0 moves production ledgers to v3 occurrence
   identity, removes raw corrupt text from `LedgerReport`, and narrows rendered/check identifiers; 0.19.0's
   `workspace:<id>` requirement still applies. Four routing fixtures in this repository began refusing until
   granted, which is the one-line edit an operator faces. `pi-daddy init` scaffolds the registry but deliberately does not choose a ceiling (ADR-0028), so the
   operator writes the capability by hand. If that turns out to be the wrong trade, it is an ADR, not a patch.
3. **R-137 is the sharpest open risk.** Routing attenuates by *id*, not by *destination*: a child holding
   `workspace:staging` and `tool:write` can repoint that entry at another worktree and route its grandchild
   there, measured in `docs/probes/g37-registry-tamper`. The content pin that would close it was reverted after
   being defeated four ways, and **nothing checks who may write the registry** (R-144). ADR-0036 territory, and
   ADR-0035 explicitly declined Option 2 (strip the registry, re-supply a narrowed one) which is still
   available as defence-in-depth.
4. **R-145 needs a decision, not a patch.** A *gated* routing attempt takes the destination's exclusive writer
   lease **before** the human is asked, and holds it for an unbounded dialog — model-reachable, and it emits an
   `acquired`/`write` record for a child that never runs. Reversing the ordering means deciding what a bound
   approval binds to; ADR-0034 chose "resolve then ask" deliberately, for R-110.
5. **Cheap and open:** R-147 (a refused registry prints nothing anywhere, while a malformed `PI_GRANTS_DEPTH`
   gets a notify — rule 8), R-149 (the registry read deadline is forced by nothing, and the module classifies
   an `AbortError` no remaining code can produce), R-150 (seven guards nothing forces, one of them wired on the
   quieter of two routes), R-151 and R-148 (both herdr-executor territory), R-141's remaining relative lease
   namespace/access/reporting halves, and R-140.
6. **R-142 is closed by CI (R-153) and R-129 predates the catalogue** — reconciled 2026-08-23; do not reopen
   either without new evidence.

### Habits this project keeps re-earning

- **Verify a reported finding by execution before acting on it** — including when you agree with it. Twice in
  two days a reviewer's sentence was carried one level on unchecked, and both times re-deriving *narrowed* the
  claim (R-146's scope, R-144's blast radius).
- **A `void` return is a promise that nothing can be reported, and the caller will invent something** (R-152).
- **Ask what a fix's own return value promises**, not just whether the fix is correct. Two passes over the
  R-146 fix asked the second question and missed four defects.
- **A measurement taken while something else mutates the tree is not a measurement.** Twice: integration run
  beside a mutation sweep, and two sweeps overlapping. Also: a suite run with no `node_modules` reads as a
  merge that lost tests.
- **When a guard fails, obey it.** The 400-line ceiling fired three times on `workspace-lease.ts` in two days
  and got a seam each time (`src/lease-helper.ts`); the cap has never been raised.

## 2026-08-28 — ADR-0036 live governance dashboard candidate

**Branch `feat/observability-dashboard`, from released baseline `c364a67`; unreleased. Two critical review
rounds returned CHANGES-REQUESTED; the latest repairs await a third review.** The product brief required the smallest truthful Herdr sidebar, and the implementation keeps the
three layers separate: v3 ledger events → pure projection → ANSI terminal renderer.

**Identity changed because it had to.** Two concurrent plain delegates both legitimately occupy `d0.1`; a
production wiring regression now observes exactly that and requires distinct random `executionId` values plus
explicit `parentExecutionId`. The ID propagates on both executors and all three tools. v2 stays frozen and
readable but is never lifecycle-joined by reusable `childId`.

**Herdr is a host, not an inference.** `/grants dashboard` requires the complete pane environment, resolves
that exact pane, and checks this pi PID in `pane.process-info`; a server answering elsewhere is rejected. The
bundled `pi-daddy.dashboard` plugin opens a right split against the caller with `--no-focus`, and a locked
pane-handle file makes repeat calls reuse. The startup handshake asks the exact three choices from the brief;
only **Install and open** links software. No live plugin was linked while developing this — product code that
forbids silent installation should not violate that boundary in its own test procedure.

**Provenance is an event type, not typography.** `workflow_fact` accepts identifier-only planned, observed or
controller-validated facts with state/provenance compatibility; enforced children remain capability/lifecycle
events. The projection marks P/O/V/E/D and correlation stays caller-declared. principal-pi-skills currently has
run state and generated prompt contracts but no generated workflow-graph declaration, so this candidate renders
explicit run/phase/assurance/policy labels and facts rather than parsing its prompts.

**Known honest limits:** whole-file replay every 250 ms, with the flip at 50 MiB or 100 ms p95 (R-160); v2 is
grey/historical; plugin-core protocol is major 1 and Herdr minimum is 0.8.0; the dashboard does not render named
checks as child nodes. It never receives task text/output fields, and raw corrupt lines are withheld from the
renderer because a foreign line may contain exactly those forbidden values.

**Pre-review evidence:** every new behavior was driven red first. The first candidate ran **692/692 unit**,
**45/45 integration against real pi and Herdr 0.8.0**, typecheck, installed-package smoke (exports, both bins,
v2/v3 contracts, bundled plugin, dashboard and init), `git diff --check`, line ceiling, and **59/59 mutation
catalogue entries** from a clean disposable committed snapshot (`54ae1f6…`; an attributable HEAD was printed
inside every recorded run). A live read-only Herdr check bound the current pi PID to `w6:pJ` and reported the plugin
absent; no plugin was linked during development.

Three first runs earned the controls rather than weakening them: unit was **673/672** because three touched
modules crossed the 400-line ceiling and produced real seams (`execution-occurrence`, `delegation-ledger`,
`chain-plan`); integration was **44/45** because R-74's expected known-command list had not learned `dashboard`;
installed smoke found the new dashboard bin repeating R-73's npm-symlink no-op. The first mutation pass was
57/58 because one claimed parent-id guard was redundant; it was removed rather than force-tested. The second
was 58/60 because one remaining test asserted the right behavior under the wrong failure-name matcher. The
third is the 59/59 result above.

Five broad review attempts timed out before returning verdicts, but their partial adversarial traces identified
concrete issues that were reproduced and fixed: pane creation labelled running before agent start and prompt,
optional deadlines permitting permanent running, ANSI truncation leaving colour open, same-PID process info
from another pane, dead-pane reuse, and a newly opened pane left untracked when state persistence failed.

**Completed critical whole-change review and repair:** three focused independent reviewers plus a disposable
whole-change pass returned eight accepted findings. R-141: the documented relative ledger split a routed tree.
R-161: two capability answers on one chain step emitted duplicate decisions for one execution ID. R-162: raw
JSON parse diagnostics leaked ledger bytes, nested malformed correlation crashed rendering, and `verifyLedger`
called a string lookalike v3 line `OK`. R-163: the public workflow producer accepted arbitrary `kind` text.
R-164: a progress callback could SIGKILL the process it observed. R-165: disabled state outranked plugin root
provenance. R-166: dismissal persisted an invented Not now. Each was watched red before its repair; the progress
boundary has separate direct/fan-out and chain guards.

**Post-repair evidence:** **700/700 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, `git diff --check`, and **69/69 mutation
entries** from disposable committed snapshot `735d465…` / candidate tree `2b9d1d8…`. The first repair mutation
pass was 66/68: it proved the string-version check had a second guard and that display isolation was redundant
at two layers. The catalogue was corrected to remove both version guards together; the redundant executor
catch was removed, direct and chain reporters each gained their own regression, and the next run forced 69/69.
**There is still no independent approval of the repairs**, so the candidate is not merge-ready.

**Critical re-review and second repair:** run `c823aca8…` verified candidate tree `9044382…`. The broad
specification/quality sweeps timed out after tracing (so the finding list is not claimed exhaustive), while
four fresh focused snapshots independently reproduced ten blockers. R-162 was not actually closed:
`verifyLedger.corrupt[].text` retained 120 raw bytes and `/grants ledger` printed `SECRET_TASK`. R-167 groups
three exact-host failures — moved panes reused elsewhere, wrong-host open results persisted, and malformed
nested pane state opening duplicates. R-168: schema/runtime-valid prose in agent/capability/correlation fields
rendered task/output text, while C1 and bidi controls survived. R-169: ledger wait did not consume the
recorded timeout and a catch-path terminal append could overtake running. R-170: `Date.parse("1")` passed a
public builder and schema accepted a null assurance scope runtime rejects.

Each was driven red separately. Canonical corruption reports are content-free; reuse/open/store validate exact
host identity and complete nested state; v3 schema/runtime/builders share identifier grammars and frozen-v2
projection redacts outside them; terminal sanitation removes `Cc`/`Cf`; executors receive only the recorded
deadline remainder and terminal appends await running; public builders assert their closed wire, with one
RFC-3339 validator and a non-null top-level scope contract.

**Second-repair evidence:** **709/709 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, and **82/82 mutation entries** from
disposable committed snapshot `346bb94…` / candidate tree `fe27bb8…`. The first expanded mutation run was
76/81: the new builder assertion made two old constructor guards redundant, pane cleanup moved into a shared
helper, and identifier redaction made the old CJK width test incapable of exercising width. Those entries/tests
were re-targeted rather than weakened. The next was 80/81 because a renamed deadline test left one stale
failure-name matcher; after correcting it, 81/81 forced. Self-review then found named-check prose was refused
only after work when no ledger was configured; moving that classification before execution added the 82nd
entry, and the attributable run forced 82/82. Final handoff reran `git diff --check` and computed the
attributable candidate tree after this log edit. **There is still no independent approval of the second
repairs**, so the candidate is not merge-ready.

**Third critical attempt and repair:** run `69a7be45…` verified candidate tree `730c9e6…`. Broad whole-change
and focused slice agents timed out before a complete verdict, so their traces are not approval or an exhaustive
finding list. A fresh bounded critical adjudicator (`86bb8691…`) independently reproduced two blockers.
`REV3-QUAL-A-001`: `buildWorkflowFactEvent` was the public v3 builder omitted from the claimed final wire
assertion, and a Date-shaped JavaScript value produced `ts: "1"`, which the reader rejects. `REV3-QUAL-B-001`:
the pane key secretly included invocation `cwd`, so identical workspace/tab/ledger calls from two directories
opened two dashboards. The adjudicator rejected its third hypothesis: Node 26 does not let a final newline pass
the identifier regexes.

Both accepted findings were driven red in the writer tree. The workflow builder now asserts its completed JSON
wire like every execution-event builder; the regression forces string and non-string invalid timestamps. Pane
identity is exactly workspace/tab/ledger; `cwd` remains the first process directory and a second directory now
reuses the same pane. Each repair has its own mutation.

**Third-repair evidence:** **710/710 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, and **84/84 mutation entries** from
disposable committed snapshot `30df049…` / candidate tree `d173a31…`. The first expanded mutation run was
83/84: the pane regression failed correctly, but the catalogue searched for custom assertion text while its
parser intentionally reads the failing **test name**. Pointing the entry at that name made the second run force
84/84; no guard or test was weakened. A complete independent whole-change approval is still absent, so the
candidate is not merge-ready.

**Distributed whole-change review and fourth repair:** run `f3ede78b…` verified candidate tree `61bcd58…`.
Three independent slices covered every one of the 71 changed paths and every changed test; a fourth fresh
snapshot adjudicated their five hypotheses. Two survived. `REV3A-QUAL-001`: a validly shaped state entry whose
`ledgerPath` no longer matched its hash key still reused a live dashboard for another ledger. `REV3C-SPEC-001`:
explicit v2 bypassed its frozen schema, so missing required identity became a plausible historical row or
`orphanEvents` count rather than corruption. The adjudicator rejected protocol-scoping persisted preferences
(not specified), a hostile direct progress callback (every production caller already isolates it), and the
460-character named-check ceiling (documented and safely conservative).

Both accepted findings were driven red. Pane reuse now compares stored workspace/tab/resolved-ledger against
the request before any pane lookup and refuses a mismatch. Dashboard projection compiles the exact published
v2 schema before adapting a valid v2 event as historical/unjoinable; the v2 artifact and no-join rule are
unchanged. Separate regressions force each boundary, and each has a pinned mutation.

**Fourth-repair evidence:** **712/712 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, and **86/86 mutation entries** from
disposable committed snapshot `cea337f…` / candidate tree `5e94783…`. `git diff --check` is clean. The review
verdict remains CHANGES-REQUESTED until these two repairs receive independent approval; no PR/version/release
work is authorised.

**Critical approval retry and fifth repair:** run `f8df3aae…` verified candidate tree `9ef5dca…`. Broad agents
timed out without a complete approval, but a fresh bounded adjudicator independently reproduced all three
high-signal traces and returned CHANGES-REQUESTED. `REV4-ADJ-001`: canonical JSON Schema accepted leap-second
timestamps runtime/date arithmetic reject. `REV4-ADJ-002`: a later `running.deadlineAt` replaced the starting
bound and rendered an expired child live. `REV4-ADJ-003`: SIGTERM grace began at the recorded deadline, and a
measured ignoring process remained live **5.015 seconds past it**.

Each finding was driven red separately. V3 now centralizes a schema timestamp profile matching runtime's
seconds `00`–`59` boundary across all seven timestamp sites. Projection treats a changed occurrence deadline
as content-free corruption and remains anchored to the first bound. Process execution reserves SIGTERM grace
inside the remaining budget and has an independent hard SIGKILL timer at the recorded deadline. Three
regressions and mutations force those boundaries.

**Fifth-repair evidence:** **715/715 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, and **89/89 mutation entries** from
disposable committed snapshot `9bbdc20…` / candidate tree `687bf03…`. The first expanded mutation run forced
88/89: the new timestamp mutation omitted the literal colon present in its JSON pattern and therefore refused
as stale rather than pretending to test it. After correcting that patch, self-review found the hard timer was
still relative to the `spawn` return rather than the recorded epoch; it now receives the absolute deadline.
Unit, typecheck, integration, smoke and all 89 mutations were rerun after that correction. A fresh critical
review is still required; no PR/version/release work is authorised.

**Fifth-repair review and sixth repair:** run `b6430624…` verified candidate tree `e9ae7f1…`. Its independent
specification slice approved all three repaired contracts with 107 targeted tests. Its quality slice returned
CHANGES-REQUESTED on `REV5-QUAL-001`: a successful governed PID could exit while a detached descendant retained
its pipes; before the 100 ms settlement fallback, the new hard timer set `timedOut: true`, producing the
reproduced impossible pair `code: 0, timedOut: true` and laundering success into `CHILD_TIMED_OUT`.

The regression was driven red with successful exit deliberately 50 ms before the deadline and retained pipes
past it. The hard callback now checks the governed child's `exitCode`/`signalCode` before changing state or
sending SIGKILL. The deadline still kills a live PID, but drainage after a completed PID cannot rewrite its
outcome. A 90th mutation removes only this guard.

**Sixth-repair evidence:** **716/716 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, and **90/90 mutation entries** from
disposable committed snapshot `01eb72b…` / candidate tree `9aed467…`. The targeted process/lifecycle run was
23/23. This repair remains unapproved; no PR/version/release work is authorised.

**Sixth-repair review and seventh repair:** run `8a7f0193…` verified candidate tree `07b447f…` and returned
CHANGES-REQUESTED through two independent slices. `REV6-SPEC-001`/`REV6-QUAL-001` reproduced the same
`code: 0, timedOut: true` through the unconditional soft timeout. `REV6-QUAL-002` blocked the controller event
loop across the deadline; the timer phase then ran before libuv delivered a child exit the OS had observed 463
ms earlier, defeating the hard guard's temporarily-null `exitCode`/`signalCode`. A live-child control still
died by SIGKILL.

Both reproductions were driven red. Soft and hard callbacks now share one controller: defer one event-loop turn
for pending child-process exit delivery, then refuse to change state or signal a completed PID. Separate tests
force a successful exit 50 ms before the soft timeout and a blocked-controller hard-deadline ordering. The
existing retained-pipe test remains, and a 91st mutation removes the hard callback's shared controller.

**Seventh-repair evidence:** **718/718 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, and **91/91 mutation entries** from
disposable committed snapshot `a943216…` / candidate tree `521f533…`. The first expanded mutation run forced
90/91: replacing `setImmediate` with a microtask did not deterministically defeat the test and therefore proved
nothing about the guard. The entry now removes the hard callback's controller entirely, reproducing the exact
red path; no product test or guard was weakened. These repairs remain unapproved.

**Seventh-repair review and eighth proof repair:** run `5580ed6c…` verified candidate tree `5609304…`.
Independent quality review approved production behavior with 718/718 unit and manually defeated both existing
guards. Specification review returned CHANGES-REQUESTED on `REV7-SPEC-001`: delayed exit delivery was forced
through the hard callback, while the soft test covered only promptly delivered exit plus retained pipes. The
shared helper was proven by composition, but no mutation proved the soft callback still called it.

Production is unchanged. A new regression blocks the controller across the soft timeout while the OS child
exits, and a 92nd mutation bypasses only that callback's shared controller. The regression passed on the real
implementation and failed on the exact mutation before it entered the catalogue.

**Eighth-proof evidence:** **719/719 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, and **92/92 mutation entries** from
disposable committed snapshot `5b01bf1…` / candidate tree `78894ad…`. This proof repair remains unapproved;
no PR/version/release work is authorised.

**Eighth-proof review and ninth test repair:** run `88e06a8c…` verified candidate tree `1e4e1a3…`.
Specification review approved and independently reproduced the soft-only mutation. Quality review confirmed the
mutation but returned CHANGES-REQUESTED on `REV8-QUAL-001`: the new test busy-spun for 800 ms and assumed its
child was scheduled and exited within 500 ms, so scheduler contention could turn a correct timeout into a false
failure while the spin competed with parallel tests.

Production remains unchanged. Soft and hard delayed-delivery tests now share a child-ready handshake: the child
flushes `READY` immediately before exit, and the controller then sleeps across the deadline with `Atomics.wait`
instead of consuming a CPU core. Both synchronized tests pass, and the soft-only mutation fails the repaired
proof.

**Ninth-test evidence:** **719/719 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, and **92/92 mutation entries** from
disposable committed snapshot `01d613d…` / candidate tree `dc55a35…`. This test repair remains unapproved;
no PR/version/release work is authorised.

**Ninth-test review and tenth clock repair:** run `21ad2742…` verified candidate tree `a428627…`. Quality
review approved after repeated route/mutation runs. Specification review returned CHANGES-REQUESTED on
`REV9-SPEC-001`: the helper still set `deadline = started + 2s` before `READY`, so startup beyond that window
made the sleep zero and restored the arbitrary scheduler assumption under another number.

The real child now writes a ready file before either tested clock begins. `onSpawn` waits with short
`Atomics.wait` sleeps, establishes the soft timeout or absolute hard epoch, and releases the child; `EXITING`
output then blocks the controller across that bound. `runChild` reads the optional hard epoch after `onSpawn`,
which is identical for immutable production requests and permits the synchronized test to establish its epoch.
Both routes pass and both exact mutations remain red.

**Tenth-clock evidence:** **719/719 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, and **92/92 mutation entries** from
disposable committed snapshot `52e9459…` / candidate tree `f5c0a69…`. This repair remains unapproved; no
PR/version/release work is authorised.

**Tenth-clock review and eleventh immutability repair:** run `d63b1847…` verified candidate tree `ada4e11…`.
Specification review approved the ready-before-clock proof. Quality review returned CHANGES-REQUESTED on
`REV10-QUAL-001`: moving the hard-deadline read after `onSpawn` let that hook delete an initial 100 ms bound;
the reviewer reproduced a child exiting normally after 536 ms. The test had weakened the production property
it purported to prove.

`runChild` again snapshots `hardDeadlineAt` before spawn. The soft proof still establishes its timer only after
real child readiness. The hard proof no longer mutates input: a detached observer records Linux `Z` state or
process disappearance while `onSpawn` blocks, proving the released child has exited at the OS before the
controller schedules the already-overdue hard callback. Both route tests pass.

**Eleventh-immutability evidence:** **719/719 unit**, typecheck, **45/45 integration against real pi and Herdr
0.8.0**, installed-package smoke, generated-contract cleanliness, line ceiling, and **92/92 mutation entries**
from disposable committed snapshot `76601ca…` / candidate tree `99c4f54…`. This repair remains unapproved; no
PR/version/release work is authorised.

**Eleventh-immutability review and twelfth proof hardening:** run `cd147b42…` verified candidate tree
`32216e0…`. Specification returned CHANGES-REQUESTED on `REV11-SPEC-001`: the hard observer never mutated the
request, so moving the read after `onSpawn` remained green. Quality returned CHANGES-REQUESTED on
`REV11-QUAL-001/002`: every `/proc` error falsely meant disappearance, and the detached observer had no
independent lifetime bound.

A dedicated live-child test now deletes `hardDeadlineAt` in `onSpawn`; production still SIGKILLs at the original
snapshot, and a two-site mutation re-reading after the hook fails that exact test. The Linux observer records
`exited` only for zombie state or `ENOENT`, records other errors and a nine-second timeout distinctly, and the
controller accepts only exact `exited`; unsupported platforms fail explicitly. Focused tests pass. Full
evidence follows.

**Twelfth-proof evidence:** **720/720 unit**, typecheck, **45/45 integration against real pi and Herdr 0.8.0**,
installed-package smoke, generated-contract cleanliness, line ceiling, and **93/93 mutation entries** from
disposable committed snapshot `027f54d…` / candidate tree `d607c5f…`. This repair remains unapproved; no
PR/version/release work is authorised.

**Twelfth-proof review and thirteenth ordering repair:** run `4c9327d1…` verified candidate tree `0a67906…`.
Specification returned CHANGES-REQUESTED on `REV12-SPEC-001`: the hard deadline was due before spawn, so
expecting a later OS exit to remain successful contradicted the lifecycle bound. Quality returned
CHANGES-REQUESTED on `REV12-QUAL-001`: marker existence could race `writeFileSync` content completion.

The hard proof now establishes a future epoch, requires real-child readiness and observer-confirmed OS exit
releases the ready child before it, and blocks `EXITING` delivery across the epoch. The atomically published OS-
exit timestamp must predate that epoch before the overdue timer and pending libuv exit delivery may race.
Focused tests pass and the exact hard callback mutation is red.

**Thirteenth-ordering evidence:** **720/720 unit**, typecheck, **45/45 integration against real pi and Herdr
0.8.0**, installed-package smoke, generated-contract cleanliness, line ceiling, and **93/93 mutation entries**
from disposable committed snapshot `a21d856…` / candidate tree `eb20e18…`. This repair remains unapproved; no
PR/version/release work is authorised.

**Thirteenth-ordering review and fourteenth test-control repair:** run `62dbff71…` verified candidate tree
`63fcff2…`. Specification approved and independently reproduced both exact mutations. Quality returned
CHANGES-REQUESTED on `REV13-QUAL-001…003`: `EXITING` assumed one stream chunk, a five-second pre-spawn window
still admitted scheduler contention and cost 5.3 seconds, and failed atomic publication could retain `.tmp`.

A package-internal test control now establishes the proof hard epoch immediately after `onSpawn` observes
readiness; public `runChild` still snapshots the caller's pre-spawn deadline, and all callback/control/settlement
code remains shared. The signal matcher buffers a bounded suffix across chunks. Observer publication unlinks
the temporary in `finally`, tolerating only successful-rename `ENOENT`. Focused routes pass in under one second
each.

**Fourteenth-control evidence:** **720/720 unit**, typecheck, **45/45 integration against real pi and Herdr
0.8.0**, installed-package smoke, generated-contract cleanliness, line ceiling, and **93/93 mutation entries**
from disposable committed snapshot `c1cacb4…` / candidate tree `6470ff2…`. This repair remains unapproved; no
PR/version/release work is authorised.

**Fourteenth-control review and fifteenth internal repair:** run `76339133…` verified candidate tree
`9dae5c6…`. Specification approved. Quality returned CHANGES-REQUESTED on `REV14-QUAL-001…003`: the supported
`./run-child` export exposed the test seam, truncation happened before marker search, and the new seam/matcher/
cleanup paths had no targeted proof.

The control moved to an AsyncLocalStorage module absent from package `exports`; public `runChild` consults it,
and tests scope one invocation. Combined input is searched before retaining six overlap characters. Temporary
publication is gone: newline-terminated status is polled until a complete terminal grammar appears. Two new
mutations bypass internal control and cross-chunk state respectively; focused tests pass.

**Fifteenth-internal evidence:** **720/720 unit**, typecheck, **45/45 integration against real pi and Herdr
0.8.0**, installed-package smoke, generated-contract cleanliness, line ceiling, and **95/95 mutation entries**
from disposable committed snapshot `617bb6f…` / candidate tree `9be1c37…`. This repair remains unapproved; no
PR/version/release work is authorised.

**Fifteenth-internal review and sixteenth protocol proof:** run `92198705…` verified candidate tree
`f578838…`. Both reviewers returned CHANGES-REQUESTED: complete-status polling normally saw one synchronous
write and had no mutation; async context had no concurrent, nested, rejected or post-settlement proof.

The status poller now accepts injected read/clock/wait functions. Tests deterministically force partial then
complete status, timeout/error terminals, transient/permanent reads and expiry; a grammar mutation makes the
partial test fail. New same-process tests run controlled/uncontrolled children concurrently, nest and restore
contexts, reject a scope, and verify no later-run leakage. Focused tests pass.

**Sixteenth-protocol evidence:** **726/726 unit**, typecheck, **45/45 integration against real pi and Herdr
0.8.0**, installed-package smoke, generated-contract cleanliness, line ceiling, and **96/96 mutation entries**
from disposable committed snapshot `3b8c5bf…` / candidate tree `d012c10…`. This repair remains unapproved; no
PR/version/release work is authorised.

**Sixteenth-protocol review and seventeenth test-ownership repair:** run `15e51c34…` verified candidate tree
`199bb90…`. Specification approved. Quality returned CHANGES-REQUESTED on three points: frozen injected time
could hang status polling, the unexported control module still shipped in source/dist, and concurrent branches
selected control sequentially before either promise suspended.

Polling now has an independent attempt ceiling and frozen-clock regression. AsyncLocalStorage moved under
`test/`; production keeps only a private Node-test-context lookup. Build cleans stale `dist/`, and installed
smoke refuses the former artifact, leaving no control module in the package. Controlled/uncontrolled branches
rendezvous on a two-party barrier before either child starts; nested,
rejected and post-settlement checks remain. Focused tests pass.

**Seventeenth-ownership evidence:** **727/727 unit**, typecheck, **45/45 integration against real pi and Herdr
0.8.0**, installed-package smoke (including stale-artifact refusal), generated-contract cleanliness, line
ceiling, and **96/96 mutation entries** from disposable committed snapshot `ed5f558…` / candidate tree
`03f9631…`. This repair remained unapproved at measurement time.

**Final critical approval, 2026-08-31:** run `48da2009…` verified exact candidate tree `889fd02…`.
Specification approved. The first quality attempt timed out after successful build/pack/smoke and while running
the full mutation catalogue; a bounded retry approved with **31/31 focused tests** and no findings. Combined
with writer evidence (**727 unit · 45 integration · typecheck · installed smoke · 96/96 mutations**), ADR-0036
is approved. Version `0.20.0` and one cohesive PR were selected; release execution is authorised.

**0.20.0 released and registry-verified, 2026-08-31.** PR #23 merged as `34e977e`; tag `v0.20.0` and the
non-draft GitHub Release point there. npm published shasum `3e82a9c92640b83c5579777ac74b8c3af259272e`,
matching the reviewed release tarball, and `latest` resolves to 0.20.0. A fresh registry install imported
`pi-daddy/run-child`, contained the Herdr plugin, and contained no test-control artifact. Local publication was
initially refused by npm's 2FA policy; after the operator configured a granular token with appropriate publish
authority, the exact already-built tarball appeared in the registry. No plugin was linked during release.

## 2026-08-22 (CI) — the checks stop being opt-in

**`.github/workflows/ci.yml`, and the argument for it is the review history rather than a preference.** Eight
passes over PR #10 found guards deletable with the whole suite green — ten in one round, fourteen in another,
seven in the eighth. Every round fixed its instances; none changed the cause. R-34 had already named it: *a
check an operator has to know to run is not a control, it is a feature.*

Runs on every pull request and every push to `main`: typecheck, the unit suite, **a tree-cleanliness
assertion** (a suite that can edit the repository can make itself pass — `npm test` once overwrote tracked
contract fixtures), the **mutation catalogue**, and the installed-package smoke. Matrix over the `engines`
floor (22.19.0) and the version this is developed on (24.x) — the floor is a published claim that nothing had
ever tested.

**One line in it is R-143 and worth knowing about:** `FORCE_COLOR=0` / `NO_COLOR=1` are pinned at the workflow
level, because the catalogue parses `node --test`'s reporter and in a colouring environment reported `0/20
guards forced` with all twenty intact. CI would have inherited a control that accuses everything.

**Two honest limits.** The mutation step is `--if-present`: the catalogue was written on PR #10 and does not
exist on `main`, so it is a no-op here and real the moment that branch lands — which also pays the catalogue
debt R-146 and R-152 both recorded, for good. And **integration is not covered**: 44 tests needing a real `pi`
and a real `herdr` server, which would become decoration if faked. It stays a local gate.

**And then the operator turned protection on, so it blocks.** `main` requires a pull request with zero
approvals and both CI legs green; force-pushes and deletions are refused; **`enforce_admins` is on**, without
which the rule would bind everyone except the one account able to breach it — which is exactly how R-85's
eleven commits reached `main`. A direct push is now refused by the server rather than by a hook each clone has
to install.

**Verified by configuration and not by attempting a breach**, deliberately: bouncing a real push off `main`
would prove it end to end and would advance `main` outside a PR if the setting were wrong, which is the single
thing rule 10 exists to prevent. The first live proof is the PR carrying this entry — the first change here
that *could not* have been pushed directly. The escape hatch is named in rule 10 so nobody invents one under
pressure: one API call to lift, one to restore, and lifting it is a decision to record.

**Verified locally before pushing** (node 24, `FORCE_COLOR=0`): `npm ci` at the workspace root, then 604 unit ·
typecheck · tree clean · `--if-present` no-op · smoke. The 22.19.0 leg has no local answer — no node 22 here —
so **the PR's own run is the evidence for it**, which is the right place for that experiment.

---

## 2026-08-22 (R-152) — the fix's caller threw its answer away

**Two independent reviews of the merged R-146 work, and both found the same thing by reading the CALLER rather
than the fix.** `markRetained` returned `void`; `releaseDelegationWorkspace` wrote
`(await lease.markRetained(reason), "retained")`. One line, in a different file, discarding the result — and
with it the ledger's ability to tell three different facts apart.

So a `workspace_lease` event said `retained` — *"kept deliberately … the pane may still be live"* — when the
helper was already dead (the fact is `lost`, which is what R-103's vocabulary exists for), when the lease had
already been cleanly released, and when the retention's own record could not be written.

**The second of those is the mirror of R-146, introduced by fixing R-146.** Making retention terminal was
one-directional: `release()` checked `settled`, `markRetained` did not, so a completed handover could be
rewritten into `retained:herdr-close-failed` and the memoized answer flipped with it. Measured end to end.

**What generalises.** Both earlier passes over that fix asked *"is the fix correct?"* — and it was. Neither
asked *"what does its return value promise, and does the caller use it?"* **A `void` return is a promise that
nothing can be reported, and the caller will invent something.**

**The bounds were wrong at the top end as well, and on the wrong channel.** `MAX_SAFE_INTEGER` truncates to
1ms (`TimeoutOverflowWarning`), SIGKILLing every close before herdr can act — the exact mirror of `0` meaning
no bound. And the refusal was a `GovernanceRefusal` carrying `WORKSPACE_LEASE_STALE`, so an ADR-0034 controller
switching on codes would treat a permanent caller bug as transient and retry forever. A bad argument is not a
governance outcome: it throws `RangeError` now. The check also moved above the read-lease early return, where
it had been validating nothing.

**Verification.** 604 unit · 44 integration · typecheck · smoke · register guard · line ceiling. Each of the
four new guards forced by reverting it alone — and the record-was-written gate was **unforced on the first
attempt**, then pinned by a test that makes the lease directory unwritable. The line ceiling refused
`workspace-lease.ts` at 435 lines; split at the same seam PR #10 used (`src/lease-helper.ts`) so the branches
converge rather than diverge.

**The catalogue debt recurs:** `scripts/mutation-audit.mjs` still lives only on PR #10, so these four guards
have named regressions and no pinned entries. That is now the second time, and it is R-142's argument for CI in
one sentence.

---

## 2026-08-22 (R-146) — a retained lease detained its own process, and it shipped

**Fixed from `main`, not inside PR #10**, because it is in **published 0.18.0 and 0.18.1** and has nothing to
do with ADR-0035. Found by the sixth review pass over that PR; re-derived by execution here before being
touched, which is the habit that keeps paying.

`markRetained` leaves the kernel lock and the pane alone on purpose — the pane may still be live. It also left
the parent's three pipes to the `flock` helper referenced, and the helper was never `unref`ed, so the event
loop stayed alive and the process could not exit.

```
mode=release   release -> released · EXIT event, code 0 · exit=0
mode=retain    main() returning                         · exit=124 (timed out)
```

R-102 had accepted stranding the *worktree*; nobody wrote down that it stranded the *process*, and two
comments promised the strand lasted "until process exit", which was the one thing that could not happen.

**Then the independent review took the fix apart, and it was right twice.**

1. **The fix's own safety argument was half-false, and the fix had removed the only symptom.** "Bounded
   attempts, then release anyway" is bounded in *count*: the helper's `herdr tab close` ran through `execFile`
   with no `timeout`, so a herdr that ACCEPTS the close and never answers never calls back — the retry budget
   is unreachable, no marker is written, and the lock is held forever, which is R-102's explicitly rejected
   outcome. While the parent could not exit, an operator saw a hung `pi`; after the fix, the parent leaves in
   82ms and the strand is silent. Measured both ways (`LOCK=HELD`, no marker → `LOCK=FREE`, marker written),
   fixed with a per-attempt wall-clock bound, and forced by a test with a `herdr` that sleeps.
2. **A claim I repeated without checking.** The first draft said the wedge also killed the pane sweep for every
   pane, citing `src/cli.ts` as a host that "relies on a natural exit". That sentence came from a reviewer's
   report; `src/cli.ts` has one subcommand (`init`) and can neither hold a lease nor open a pane. Re-derived
   against pi 0.84.2: `process.exit()` ignores pending handles **and runs exit handlers**, so only hosts that
   let the loop drain are affected — print mode and library consumers, i.e. ADR-0034's external controllers.
   Interactive and rpc call `process.exit()`. The hang is real; the compounding was not general.

**That is the third time in two days a reviewer's finding was repeated one level on without being re-derived**
(R-59's shape, R-144's, now this one), and the second time the re-derivation *narrowed* the claim rather than
widening it. Verify a reported finding by execution before writing it down, including when you agree with it.

**One line of my own fix was unforced** — the block unref'ed `stdin` too, and reverting just that line left the
suite green. Removed rather than pinned; `holder.unref()` and the two output streams are each load-bearing,
verified by reverting them separately. **R-151** records what the fix newly exposes: with exit working, the
pane reaper and the lock helper now close the same retained tab, and `readCloseFailure()` — the marker reader
in the advertised recovery path — has no caller anywhere.

**Unref, not close, and only on the retain path.** The lock must outlive the call: when the parent exits the
helper sees EOF and runs what it was written for — bounded close attempts, marker file, release anyway. That
is R-102's decision and it is why letting the parent go is safe, so the regression asserts it as a second
property: a successor still acquires. Unref'ing at spawn was rejected — it would remove the accidental
guarantee that a process cannot exit while a lease is still ACTIVE, which is a different decision.

**Verification.** 598 unit (596 + two regressions) · typecheck · register guard · line ceiling
(`workspace-lease.ts` at 362). Both guards checked in both directions: the exit test fails on unmodified `main`
with `'hung' !== 'exited'` and again when the `unref` block is reverted; the strand test fails when the
`{timeout, killSignal}` options are reverted. And the file got *faster* — the first draft leaked its 10s
deadline timer, so `test/workspace.test.ts` cost 14.6s on a green run; clearing it plus both new tests is 6.7s.

**Two debts, stated rather than left implicit — and both PAID when this branch merged `main` on 2026-08-22.**
`scripts/mutation-audit.mjs` lives here and not on `main`, so R-146's two guards had named regressions and no
catalogue entries; the entries R-146's register body wrote out are now in the catalogue. And PR #10's **OPEN**
copy of R-146 was deleted in favour of the FIXED text, because two headlines for one risk means
`grep '^## R-146'` answers OPEN for something merged — R-72's shape, which this repository has a guard about.

---

## 2026-08-22 (sixth pass) — the instrument was blind, and the commit that removed a guard left three documents selling it

**Four reviewers over PR #10, at the merge of `main` into `6f327fa` (`0a62a42`).** R-143…R-150. The lenses were
the invariant, claims-versus-code, the runtime half, and — new this round — the **complement** of the mutation
catalogue rather than its contents.

**The invariant held a fourth time.** Three-level transitivity on the production path, both halves of
two-authorities, every wildcard channel, the grant store, all three delegation tools, the gate paths. Nobody
could make a child's `effective` a non-subset of its parent's. Four passes have now failed to break it; the
runtime half and the claims layer have never once come out clean.

**The instrument was blind, and it had to be fixed before anything else could be believed.**
`npm run test:mutation` — the control the fifth pass added so rule 7 would stop depending on somebody choosing
to look — printed **`0/20 guards forced a named failure`**, once per entry, *"a guard nothing forces is not a
guard"*. Every guard was intact. This project is developed in sessions that export `FORCE_COLOR=3`, so
`node --test` colours its reporter, and the failure matcher was anchored `^\s*✖` — an escape sequence is not
whitespace. Colour off: **20/20**. R-143, found twice independently.

**A blind auditor is worse than an absent one**, and this is the sharper form of R-142: it accuses twenty
guards at once, so the honest response to its output is a sweep of twenty "fixes" to code that was already
correct. The trap the reviewer named is the one that matters — under CI pressure the tempting repair is to
loosen the matcher back to `stdout.includes(expect)`, which is the exact defect removed one commit earlier.
Fixed by stripping ANSI in a parser that is itself tested, pinning the child's colour, and adding a positive
control so *"I saw nothing"* stops being reported as *"I saw no failure"*.

**R-144 is the headline, and it carries a rule this project did not have.** `ebad92a` added a uid and
world-writable guard on the registry. `e1937cf` — *"narrow PR #10 to ADR-0035"* — removed the code and edited
none of the three documents announcing it: SPEC's registry paragraph, the CHANGELOG's **BREAKING** section, and
**R-137's own "What DOES exist now"**. Three of the four reviewers found it independently. The register copy is
the damaging one, because that sentence was *bounding an open risk*: it says the attack cannot reach past a
same-uid descendant, and with no check at all any local process that can write the file repoints routing for
every descendant holding the id. The suite stayed green because the guard's tests went out with the guard.

**So: a commit that REMOVES a guard must grep for the guard's claims, exactly as a commit that adds one must
add its test.** Narrowing scope is not a documentation-free operation — and this is the fifth pass's own
narrowing, which was the right call, leaving a false security claim behind it.

**The fifth pass's closing line came true, and its prescription stands.** It said: *if a sixth pass finds a
guard deletable with the suite green, the answer is CI rather than a sixth pass.* The sixth pass found
**seven**, which is not a failure of the catalogue but of its scope — twenty pinned pairs answer "do these
hold" and nothing answered "which are missing". One has a behavioural consequence (R-150: the catalog rebuild
is wired on the quieter of two routes — R-28's shape, in a diff that fixes R-28's shape elsewhere) and one is
forced only by wedging the suite. R-149 is the sharpest: the registry read deadline is deletable with the suite
green, and the module still classifies an `AbortError` that no remaining code can produce.

**What was NOT wrong, checked because the 601/602 failure invited suspicion.** Nothing was weakened to make
this branch green. The canonical refusal enum was **extended and then made generated**, the compatibility
waiver is written down, and its factual basis verifies — no released tag ever carried the v2 contract. Of 573
new lines in `test/workspace-capability.test.ts` and 310 in `test/init.test.ts`, the reviewer looking for
tautologies and feature-deletable tests found none.

**Runtime findings, all left OPEN with candidates named** rather than patched into a branch narrowed precisely
to stop unrelated runtime work arriving where the previous round's reviewers could not see it: R-145 (a gated
routing attempt seizes the destination's exclusive writer lease *before* the human is asked, for an unbounded
dialog), **R-146 (a retained lease stops its own process exiting — re-derived here, `exit=124` against
`exit=0`; the same failure disables the pane reaper)**, R-147 (a refused registry prints nothing anywhere,
against rule 8, while a malformed depth variable gets a notify), R-148 (the herdr executor passes neither the
registry nor the lease directory, so two "exclusive" governed writers can hold one root — the measurement
R-138 item 1 had been waiting for).

**Verification, at `HEAD` printed in the same command each time.** 633 unit · 45 integration · typecheck ·
smoke · **20/20 catalogued guards, in a colouring environment** · register guard · line ceiling. The 10-test
model tier was not run and remains separately authorized.

**What has to happen before this merges.** The PR description still tells a merger that the
registry-integrity gap is closed by a content pin that was reverted two passes ago, and quotes a stale test
count and a "960 input combinations" figure the ADR's own amendment withdrew. That is the document the merge
decision is made from, so it is a blocker rather than a tidy-up. R-146 is a hang and should be the next thing
after this lands, not the thing after that. And R-142's answer — CI running `typecheck`, `test` and
`test:mutation` on every PR — now has a second requirement from R-143: **pin the reporter's environment, or CI
measures its own terminal.**

---

## 2026-08-22 (fifth pass + fixes) — the loop was the finding, so the fix is mechanical

**Six reviewers over `ee6e66e..7da7013`. Two blockers, and then a decision to stop patching the symptom.**

**The 1 MiB ceiling bounded the FILE, not the read.** `handle.readFile` re-`fstat`s the descriptor internally,
so holding one handle closed the NAME race — which the previous commit set out to do — and left the SIZE race
untouched, which it never considered. A same-uid writer grew the same inode and the loader returned **192 MiB
after measuring 29 bytes**, 467 MiB RSS, inside `session_start`; won in 848ms and in 9% of 4000 attempts. That
falsified three claims in the commit that made them, including a test whose name promised "rather than read
into memory".

**And the grammar split had a fifth site.** `isSafeCapability` — the boundary that GENERATES grants — still
used the tool-name rule, so a package declaring `allowed-tools: workspace:feature/x` was dropped whole and
`init` exited 1, telling the operator the namespace does not exist while the CHANGELOG said slashes were fine.
The release's advertised id shape was unusable through its own migration path.

**Then the scope narrowed, and that is the substance of the round.** Five passes each found defects in the
previous round's fixes, because the branch had grown a namespace grammar, registry hardening, a ledger-path fix
and `init` changes on top of "routing is a capability" — so every fix landed in code the previous fix's
reviewers had never seen. Registry ownership/mode went to R-137, the ledger and `tool:delegate` work to R-141,
two pre-existing session-start hangs to R-140. What stayed is what ADR-0035 caused.

**`npm run test:mutation` is the other half.** R-34's rule — a check an operator must know to run is not a
control — applied to rule 7: twenty pinned `(patch → the test it must break)` pairs, so adding a guard means
adding an entry and an entry that stops biting fails the run. It immediately earned itself: four bad entries in
its own catalogue, a test of mine that **passed for the wrong reason** (the race never fired; the previous
iteration's grown file tripped a different check), and a predicate bug in the harness that made its first
"20/20" meaningless — it matched the transcript, and `node --test` prints a test's name on pass too. Found by
the reviewer who proposed the script.

**Three guards are declared unforced with their reasons** rather than given entries that would not fire. That
is the one form five passes never faulted; the failure mode is always the other shape, measured-sounding prose
with no check behind it.

**Verification.** 629 unit · 45 integration · typecheck · build · smoke · probes g36 and g37 · line ceiling ·
`npm test` leaves the tree clean · **20/20 catalogued guards force a named failure**.

**R-142 is the honest remainder:** there is no CI in this repository, so the catalogue is still opt-in. If a
sixth pass finds a guard deletable with the suite green, the answer is CI rather than a sixth pass.

---

## 2026-08-22 (fourth pass + fixes) — R-136 was marked FIXED while a new function still hung

**Six reviewers over `52135ca..ee6e66e`, the third pass's fixes.** The behaviour was largely sound — the
routing invariant held on every path any reviewer could construct — and the fixes contained two shipping
blockers, fourteen revertible-with-green edits, and a fabricated measurement.

**The one that matters: `establishRegistryPin`, added by the commit that fixed the session-start hang, hung
session start.** Bare `readFile` plus a signal, which is precisely what its sibling's comment four lines away
calls insufficient, awaited *before* the readers it guarded. Three reviewers found it independently; a real
`pi` gave zero notifies and timed out at 20s. **R-136's own stated trigger is the grep that finds it.** A
trigger nobody runs is a note, not a control.

A second hang: `stat`-by-name then `readFile`-by-name is a TOCTOU, winnable by any same-uid process — so a
child with `tool:write` could wedge its parent. Both are closed by one reader holding one handle:
`open(O_RDONLY|O_NONBLOCK)`, `fstat` the descriptor, then read. `O_NONBLOCK` is what bounds a FIFO; a signal
cannot, because the block is inside `open(2)`.

**The pin is reverted and R-137 is OPEN again.** Four defeats, including a measured escalation on the herdr
executor: `mergeChildEnv` is process-path only, so a pane child re-minted the pin and its grandchild took a
real exclusive write lease on an unauthorised worktree. Also: `PI_GRANTS_WORKSPACE_PIN=` failed open
permanently, an unreadable registry left the whole tree unpinned silently, and the pin's reader bypassed all
four guards added for the same file in the same commit. The venue was the mistake — a new env var, refusal code
and inheritance rule belong in an ADR, not in a fix commit.

**`npm test` was overwriting tracked contract fixtures**, so the checked-in pin repaired builder drift instead
of failing on it, and "fast, pure" was false.

**A read-leased child was writing into the leased root**, because `ENV_LEDGER` was relative and a routed
child's cwd *is* that root. Fixed at the cause; it also repairs a pre-existing audit split where a routed
subtree's ledger went to a file `/grants ledger` never read.

**`pi-daddy init` had gone silent** about a definition it copied and cannot spawn — the CLI `report()` had no
test, so the regression landed unnoticed while the fix that caused it argued that migrations must be
discoverable.

**Fourteen reverts left every suite green, eight of them ours** — including the entire "names the file" fix
(four independent halves) and the pin's own wiring, in the commit titled *"guard the last unwired edit"*. And
the FIFO test could only **hang**, never fail: in one batch that read as `pass 620 / fail 0`, a smaller
apparently-green run.

**The discipline lesson, which is the transferable part.** Every number written in this branch has been wrong at
least once, including the corrections — and "960 input combinations" was repeated from a reviewer's report into
the ADR and this log as evidence, when nothing here reproduces it. Counts are out; the file is the list.

**Verification.** 628 unit · 45 integration · typecheck · build · smoke · probes · line ceiling. Every fix
mutation-verified individually, from a file-based harness that checks the file actually changed first.

---

## 2026-08-21 (third pass + fixes) — the fixes needed the same review the defects did

**Six reviewers over `52135ca`, the fix commit from the entry below.** Branch `fix/adr-0035-review`. The
headline: the *behaviour* was sound — attenuation holds on every path a reviewer could construct, the gate
refactor was reported behaviour-preserving over a large generated input set — a reviewer's number, which
this repository cannot reproduce and which should not have been written here as evidence — the anti-race rules hold — and the *claims*
were not, for the third pass in a row.

**Two shipping blockers, both introduced by the fix.** A blocking registry path hung `session_start`, because
making the catalog read the registry put a bare `readFile` there (R-136, R-79's class again — and
`AbortSignal.timeout` does not rescue it, which the first attempt proved by still hanging; `stat` before
`open` is the fix). And `/grants init`'s dialog granted routing live off a package declaration while the file
that same command generates said "Not granted for you" — R-28 inside the fix for R-28, in a function that had
no test at all.

**Ten single edits from the fix commit were revertible with the suite green**, two of them deletable
*together*, and one of those two was the guard stopping `init` granting routing. Its own "eleven mutations,
eleven named failures" counted what was checked rather than what was covered. Every site has a case now, and
the labels are names because the numbers implied ten sites where every document said nine — with the two
missing numbers landing exactly on the two sites that had none.

**R-137: routing attenuated by id, not by destination**, and the operator chose enforcement over recording it.
Two mechanisms, and the pair is the lesson: ownership and mode cannot close it, because a governed child runs
as the same uid as its parent. A content pin does — root pins, descendants inherit verbatim, mismatch refuses.
Detection, not prevention.

**A regression the fix created:** `governedWorkspaceAccess` turned *route this child read-only* into an
exclusive writer lease recording `access: "write"`, because making `workspace:<id>` grantable meant a non-tool
id reached a check that required every capability to be a read-only tool. Fixing only `workspace:` would not
have fixed it — `tool:delegate` tripped the same check.

**Sixteen prose claims corrected, all mine.** The one that mattered: the CHANGELOG said *"None of these ever
shipped"* over R-135, which is present in every published version, so an operator deciding whether to upgrade
was told the `tool:*` escape could not affect them. Also `CAPABILITY_NAMESPACE_PREFIXES` has two readers and
not "every site"; SPEC's enforcement taxonomy omitted `skill:`; the gate wildcard claim was true of routing
only; and the stale-warning window was eight published versions, not the six I had already corrected it to
from three.

**Verification.** 624 unit · 45 integration · typecheck · build · smoke · probes · line ceiling. Every fix in
this pass mutation-verified individually, including four re-run after extracting
`src/routing-authority.ts` — `delegate.ts` hit 403 lines and was split rather than have its rationale trimmed.
Two mutation checks initially reported success against an unmodified file because shell escaping mangled the
patch; a harness that can pass without mutating is the same category as a test that cannot fail, so both were
re-run from a file-based script.

**Left open on purpose, recorded as R-138** so it is not rediscovered as new: the herdr pane's conditional env
leak, `adoptGrant` widening a child's grant, `isGated`'s wildcard asymmetry (inherited from `agent:*`), and one
dialog conferring two authorities. R-110 also still stands, and is now in its third review unrecorded as
resolved.

---

## 2026-08-21 (review + fixes) — a namespace is nine sites, and ADR-0035 taught three

**PR #10 reviewed independently before merge, twice, then fixed.** Branch `fix/adr-0035-review` off
`92ccbb8`. The guard ADR-0035 added is correct — right place, right ordering, no lease taken and no approval
banked on a refusal, and all four of its advertised mutations genuinely fail a named test. Everything below
is what surrounded it.

**The one finding worth carrying: a capability namespace is a nine-site change.** `workspace:` was modelled
on `agent:`, and every site that already handled `agent:` was a site that needed teaching. Three were taught
(`normaliseCapability`, `resolve()`'s wildcard rule, `childEnv`'s filter). The other six each produced a
defect, which is close enough to one-for-one that the *count* is the lesson rather than any individual bug.
R-133 carries it; `test/workspace-capability.test.ts` is organised **by site** so the checklist is
executable. `CAPABILITY_NAMESPACE_PREFIXES` is read by the two id-parsing sites — it collapsed nothing, since
both already read it. Written first as "what every site reads", then as "three", then as "six"; each was
wrong, which is the argument for not writing counts.

**Severe, and it inverted the ADR's own claim.** `unknownCapabilities` never learned the namespace and
`delegationContext()` always supplies a catalog, so every requested `workspace:<id>` was refused
`UNKNOWN_TOOL` as *"a typo, or an uninstalled package"*. **No child could be granted a workspace capability
at all.** Routing did not attenuate below the root — it *terminated* there, and "two authorities, not one",
the finding PR #10's description leads with, was unreachable in production. The ADR's Context says
attenuation "comes for free". It cost an edit at every site that reads a prefix.

**Two more claims written beside fixes that were not the fixes**, which is this project's named failure mode
for the third review running: `PI_GRANTS_GATED=workspace:prod` was claimed in three places and silently
inert (measured: `ok: true`, `gatedBlocked: []`, with the control gating an ordinary tool in the same call),
and `pi-daddy init` "scaffolds the registered ids" — the stated migration path for a **breaking change** —
had never heard of the registry. Both are now implemented rather than struck, because the gate is one of the
arguments that beat Option 2 and the scaffold is what makes the breakage survivable. ADR-0035's amendment
names all three.

**R-135 is older and worse than anything ADR-0035 introduced, and the mutation battery found it, not either
reviewer.** Reverting `delegate.ts` to `result.effective` failed *no test*, which meant that call site was
unfalsifiable. Chasing why: R-26's rule — *"a root may HOLD `tool:*` but handing it down would let every
descendant reacquire the full catalog"* — was enforced only in `childEnv`, the **interceptor** path that
ADR-0016 demoted to a tripwire. `delegate.ts`, the path that actually spawns, applied no filter, and `tool:*`
is not in `UNIVERSAL_CAPABILITIES` so `assertNarrowing` did not stop it either. Measured on `92ccbb8`: a
parent holding `tool:*` delegating `tools: ["tool:*"]` gave its child `tool:*`. **Present in every published
version.** The rule had a test; the test asserted on the path where the rule was implemented, which reads
exactly like a guard on both. One exported `inheritableGrant`, called from both, is the fix.

**R-134**, also found while fixing rather than reviewing: session start warned that a gated `agent:` id
*"does NOT gate spawning that definition — a human is never asked"*. It was R-47's PARTIAL fix in 0.11.1,
false from **0.12.0** (`4673348`) when ADR-0024's gate landed — eight published versions, 0.13.0 through
0.18.1, not the three I first claimed; I first wrote
0.18.0 and was wrong, because `dde8eeb` only moved the code into `delegation-approval.ts`. ADR-0024's Costs
section leaned on that warning as its mitigation and nothing retired it when its own decision falsified it.

**And an integration test required the stale warning to exist**, which is how it survived: deleting the
warning turned `governance.it.ts` red, and the test's own comment still described the pre-ADR-0024 world. A
test pinning a superseded partial fix defends the stale claim against whoever notices. It now asserts what
ADR-0024 shipped — the gate blocks the spawn — and that the warning is absent.

**The two-PR interaction neither PR could see.** `WORKSPACE_NOT_AUTHORIZED` joined `REFUSAL_CODES` on this
branch; PR #11 landed a *closed* v2 ledger schema on `main` whose `refusalCode` enum is hand-maintained
beside that array, with a test asserting equality. So the merge of main turned the suite red, `npm run
contracts:generate` produced **no diff** (it wrote fixtures only), and the PR body's "593/593" was measured
before the merge. Worse, the v2 README's own compatibility rule says adding an **enum member** "requires a
new ledger version and a new versioned path" — so the one-line fix was forbidden as written. Resolved by
recording the carve-out (v2 has never been published; npm `latest` is 0.18.1, which predates the artifact,
so nothing can have pinned it) *and* by generating the enum from `REFUSAL_CODES`, which is what makes that
rule enforceable rather than aspirational from here on.

**Why the probe missed the severe one, recorded in its own limitations section.**
`docs/probes/g36-workspace-attenuation` appends the capability to `ownGrant` by hand and builds no catalog,
so it confirmed the mechanism while driving a path production does not take — and reported the fix as
working. A probe that constructs its own inputs can confirm a mechanism and still miss the wiring. "We
measured it" is what carried this ADR to Accepted.

**Verification.** 615 unit + typecheck green. **The mutation claim in this entry was itself wrong** — see
R-133. "Eleven mutations, eleven named failures" counted the eleven applied and hid the two sites with no
test at all, plus three docstrings naming breakers that did not break. Corrected in the follow-up commits. `test/temp-hygiene.test.ts` caught both new suites missing `after(cleanupTempDirs)`
and `test/risk-register-status.test.ts` passes on the three new entries — the local mechanical guards doing
exactly what they are for. Integration, smoke, build, the g36 probe and the line ceiling are **not** re-run
since the documentation commit; do that before pushing.

**Left open on purpose:** `correlation.workspace_id` with no routing spec (R-110) still produces a
correct-looking record naming a workspace nobody authorised. It takes no lease and sets no CWD, so it is not
the escalation — but it is half of the argument ADR-0035 used to reject Option 4, and it has now survived
three reviews unrecorded.

---

## 2026-08-20 — canonical ledger v2 contract follow-up

Started from clean `dde8eeb5632113d4a54705e16dc22ce70740fd4f` (merged PR #9, peeled `v0.18.0`)
on `feat/ledger-v2-contract-artifacts`. The handoff said npm remained at 0.17.1; re-measurement before editing
found `npm view pi-daddy` reporting `latest: 0.18.0`, published at `2026-08-20T17:13:42.521Z`, with
`gitHead` equal to the main SHA. No publication happened in this session. GitHub's latest Release object is
still `v0.17.1`, so the current split is main/tag/npm 0.18.0 versus GitHub Release 0.17.1.

The follow-up adds the actual `ledgerVersion: 2` wire contract to the next package candidate as a closed
draft 2020-12 schema and four deterministic fixtures generated through the production event builders. The installed-package smoke imports
every artifact through its public package export. ADR-0034's third amendment and SPEC define dispatch:
unversioned/undiscriminated lines are legacy 0.17 grants; explicit v2 must validate; every unsupported
explicit version fails closed rather than falling back to legacy. The known runtime limitations are unchanged.

Verification: `npm ci` completed with 0 vulnerabilities (npm blocked two dependency install scripts);
**591/591 unit** using absolute `/home/neman/.nvm/versions/node/v26.7.0/bin/node`, **44/44 non-model
integration**, typecheck, build, installed-package smoke and `git diff --check` pass. `npm pack --dry-run`
contains all six contract files (schema, README and four fixtures) among 232 entries. An independent final
review returned **APPROVE** after earlier passes found and fixed over-claimed reader validation, premature
"shipped" wording, digest-builder/schema mismatch, and empty-digest legacy downgrade. The integration command
printed the three opt-in suite declarations as skipped by their `PI_GRANTS_IT_MODEL=1` guard while its Node
summary reported 44 pass, 0 fail, 0 skipped; the ten model-driven tests behind those declarations were not
run. No commit, push, tag, GitHub Release, npm publish or version change was performed.

---

## 2026-08-20 (second review) — six reviewers over the FIXES, and the fixes claimed what the code did not do

**Asked for after the first pass, and it found more than the first pass did.** Six independent reviewers over
`40783e3..HEAD` — my own fix commits. R-119…R-129.

**The invariant held a third time.** Nobody could widen `effective`. Every finding is the runtime half, and
they share one cause: **the claim was written before the code satisfied it.** Three critical —

- the terminal `child_lifecycle` append was still `strict: true` while its own docstring, `docs/SPEC.md`, the
  ADR amendment and R-99's entry all four said otherwise, so a contended lock still destroyed a completed
  child's output (R-119);
- the `onFailure` mechanism added *to prevent silent appends* was satisfied nowhere — two empty callbacks,
  one guarding the evidence record (R-120);
- `unbankApprovals` was gated on one refusal path and revoked by key with no ownership check, so a human
  declining the second of two gated capabilities stranded a 30-day approval, and a joined gate let one
  refusal destroy a live sibling's authority (R-121).

**The marquee fix was itself undefended.** Deleting all four non-text guards from
`isCriticalAssuranceBlock` left 580/580 green — R-106, the headline of the commit that introduced it. And it
had over-corrected: `truncated` rejected a genuine 1 MB veto, breaking the pass-through ADR-0034 pins.

**A test hung the runner and that mattered more than it sounds.** With a lease guard mutated,
`test/workspace.test.ts` printed its failure then hung past 900s — the failing test never reached its
`release()`, so a live `flock` kept the event loop alive. On CI a one-line assertion failure becomes a job
timeout with no summary, which is exactly how a suite that CAUGHT a defect reads as untested. 900+s → 4s
after an `after()` reaper.

**Six of seven unpinned guards now have mutation-verified tests. The seventh I could not honestly pin** —
the fan-out infrastructure `catch` is unreachable from the wiring layer, so R-97's claim is corrected a
second time rather than satisfied, and the test I wrote for it was **deleted rather than weakened until it
passed** (R-127). Two others are ACCEPTED with reasons: R-128 (five reviewers and an editor in one working
tree — one reasonably ran `git checkout -- .` on my in-flight work, which is a sequencing error of mine, not
theirs) and R-129 (the 17-mutation audit has no artifact under `docs/probes/`, and R-127 is what that costs).

**Nine documentation claims contradicted the code, four of them introduced by the commit whose purpose was
correcting documentation.** The sharpest: I changed a SPEC sentence to say "tracked content" when the axis is
ignored-vs-not — measured, an untracked file *does* change `tree_sha`. Also corrected: "correlation values no
longer reach the binding at all" (`context_id` still does), the probe README's "precisely because" causal
claim for something it only greps, and my own test docstring calling a load-sensitive test "deterministic".

Verification: **587/587 unit**, typecheck, no module over the ceiling. The paid tier was again not run.

**What I would do differently, since it is the second time:** the mechanical guards this project already
trusts — the line ceiling, the branch guard, the refusal enumeration — have never had this failure. Prose
beside a fix has now had it twice. When a fix advertises a property, the same commit should add the check
that forces it, or the claim should not be written.

## 2026-08-20 (review) — six reviewers over the candidate: the invariant held, the runtime half did not

**Requested after the takeover below, and it changed the merge decision.** Six independent reviewers over
`git diff origin/main...feat/assurance-runtime-primitives`: general correctness, silent failures, test
coverage, type design, an adversarial architecture pass, and comment/doc accuracy. None was told what the
takeover had already found, so overlap is signal.

**The good news first, because it is the load-bearing part.** Every reviewer that looked for it confirmed
`effective = (requested ∩ parentGrant ∩ ceiling) \ (gated \ approved)` holds on every path they could
construct. Correlation never reaches `resolve()`. Bound approvals never reach `ENV_APPROVED`. Write access is
derived from the trusted requested set, not the model's label. The approval layer carries an independent
binding-equality backstop. **No fail-open in capability authority.**

**The headline finding was an absence, not a defect.** A 17-mutation audit on a confirmed-green baseline
showed **eight guards holding up ADR-0034's advertised properties could each be deleted with 558/558 still
passing** — including "a bound approval cannot cross a delegation boundary", which the ADR, the SPEC and the
README all state, and which two mutations broke silently. In a project whose own rule 7 says a test that
cannot fail is worse than none, after three recorded review rounds, that was the thing not to merge past.
**And four regressions the register claimed for R-93, R-97 and R-98 do not exist** — the tests named for them
passed for other reasons. Corrected in place by dated note, per rule 2.

**Two reviewers contradicted each other on the one thing that mattered most, and both said they had measured
it**: whether SIGKILLing the `flock` wrapper releases the lock. So it was measured here —
`docs/probes/g35-flock-fd-inheritance`. The exec'd command **inherits the lock fd**, survives the wrapper,
and keeps the lock; `-o/--close` exists because inheriting is the default and pi-daddy does not pass it. The
`FD_CLOEXEC` reading was wrong. **Do not take a reviewer's "I measured it" as measurement** — that is what
`docs/probes/` is for, and this is the second time a probe has been written to settle careful reasoning.

Fixed, and the four re-derived guards each have a test that fails when removed (the rest were tested but not mutation-audited — corrected 2026-08-20, see R-127): R-99…R-105 (the lease reporting handovers the
kernel never performed, and a ledger with no words for lost/retained/uncontended), R-106 (a child minting the
upstream controller's verdict out of a timeout), R-107…R-109 (refusals an external controller could not
identify, including ADR-0011's narrowing violation), R-110 (a bound approval spendable outside the workspace
it named — two of six identity components came from caller-supplied correlation), R-111 (correlation as a
model-writable 32 KB text channel into the append-only ledger, against that file's own header), R-112,
R-113 (a refused delegation banking a 30-day approval — the same shape as R-96, a third time),
R-114…R-117.

**Accepted with reasons, not silently:** R-101 (pid recycling in the embedded helper) and R-118 (the
worktree-membership check is defence-in-depth and I could not construct a case where it is the only guard
that fires — recorded rather than given a test that would pass for another reason).

**Not resolved, and listed in the ADR-0034 amendment so nobody mistakes this for finished:** workspace
routing is the one governance dimension that does **not** attenuate (a child in `staging` can route its
grandchild to `prod`); a persisted binding pins *text*, not tree state, so a 30-day approval replays at an
unreviewed `head_sha`, while `delegate_chain`'s per-run nonce makes *Always* unable to apply at all; the
dialog discloses three of the six bound components; `tree_sha` is blind to `.gitignore`d paths and `.git`
itself, so a check can install a hook and report an unchanged tree; and the lease key omits the lease
directory, so two agent roots each believe they are the single writer.

Verification after the fixes: **580/580 unit, 44/44 non-model integration, typecheck, build,
installed-package smoke, `git diff --check`, and both probes** (g34 and the new g35). Six new modules exist
only because four files crossed the 400-line ceiling during the work and it was split rather than raised.
The paid tier was again not run.

## 2026-08-20 — the 0.18.0 candidate was taken over and re-verified, then opened as a PR

The work below reached `origin/feat/assurance-runtime-primitives` as a single commit named `tmp work`
with **no pull request**, which is rule 10's venue missing rather than its review. Taken over here: the
commit was given a real message and the branch was opened as a PR so the diff, the rationale and a PR
number exist.

**Independently re-verified on a different machine (Node v24.14.0, not the v26.7.0 of the original
measurement):** 558/558 unit, 44/44 non-model integration, typecheck, installed-package smoke, and
`docs/probes/g34-runtime-enforcement/probe.mjs` — every finding in the committed transcript reproduced,
including both SIGTERM and SIGKILL recoveries and the literal hostile argv. The paid `PI_GRANTS_IT_MODEL=1`
tier was again **not** run.

**One claim in the entry below was false and is now true.** It said `git diff --check` passed; it did not —
three markdown hard line breaks (trailing double-spaces) in `docs/HANDOFF-principal-pi-skills-v3-assurance.md`
and `docs/probes/g34-runtime-enforcement/README.md` tripped it. Those headers are bullet lists now and the
check is clean. A verification list is worth exactly what its least-checked line is worth.

**Two notes left open for the reviewer, neither a blocker, both recorded so the PR does not imply a
cleaner read than it got.** In `workspace.ts`, `release()` swallows a failed metadata write with
`.catch(() => undefined)`, so the record stays `state:"active"` and the *next* acquirer reports
`recovered: true` when nothing was actually recovered — a false recovery signal, not a lost lock. In
`check-runner.ts`, the `finally` block calls `lease.release()`, which can itself throw
`WORKSPACE_LEASE_STALE` and mask the original error on the way out. Both fail closed.

**The operator's pass is still outstanding.** Four automated review rounds (R-91…R-98) and this
re-verification are what the PR carries; rule 10 wants a human on anything touching behaviour, and this
touches a great deal of it. Do not merge or publish without it.


## 2026-08-19 — 0.18.0 candidate: generic assurance runtime primitives

Implemented ADR-0034 against the immutable principal-pi-skills PR #31 contract at
`961f8ccbdb2a12e92db1e1b2d4ab7ca50f9d7d21` (head rechecked; `spec-lint` was green). The package remains
role/profile-agnostic: opaque correlation joins, internally computed task/capability approval bindings,
operator-registered Git worktrees, kernel-backed governed-writer leases, stable structured refusals, a
no-shell named-check runner, and v2 joinable ledger events. Correlated approvals bind task, definition,
requested/effective grant, workspace/context and parent; bound answers do not inherit. Approval ledger facts
now include source/scope and, where meaningful, persisted expiry or consumed one-use count.

Measured on Linux: same-root writers conflict before process start, distinct roots run concurrently,
SIGTERM/SIGKILL release the kernel lease, the next holder records recovery, a child starts in the validated
CWD with unchanged `--tools`, and hostile check argv remains literal. `BLOCKED_CRITICAL_ASSURANCE` emitted
by a child remains a failed delegation with the token unchanged. The herdr integration test had a pre-existing
bad readiness predicate (`/WS=\S/` matched the echoed `$HERDR_WORKSPACE_ID` command); the exact-value wait is
now measured green rather than hidden by a larger sleep.

Final verification after the review fixes: 558/558 unit, 44/44 non-model integration, typecheck, build,
installed-package smoke, `git diff --check`, and `docs/probes/g34-runtime-enforcement/probe.mjs` all pass. The paid/model tier was not
run because project policy requires separate authorization. No push, publish, tag or destructive operation
was performed. Automated reviewers found and drove fixes for R-91…R-98; the final rerun above is clean.
Next: human review and a PR; give principal-pi-skills integrators
`docs/HANDOFF-principal-pi-skills-v3-assurance.md` and keep the pinned source contract until upstream releases.

## 2026-08-18 (review) — a twenty-line docs PR, five reviewers, eleven defects

**The rule that says every change gets a PR was itself reviewed, and it needed it.** PR #6 added working rule
10. Five independent reviewers, one lens each; **eleven findings, four of them reported independently by more
than one reviewer.** The change was twenty lines of prose in two files.

**The worst finding is that the rule forbade the merge it required.** The first draft said *"never commit to
`main`"*. Landing a PR puts a commit on `main`; so does merging locally. A fresh session reading that
literally either refuses to merge at all, or — the dangerous branch — tries to *repair* the state it thinks
it created, and the two obvious repairs are `git reset --hard HEAD~11` and `git push --force`. **A
prohibition with no recovery procedure is an invitation to destroy work.** The object of the prohibition was
simply wrong: what must be forbidden is `main` being advanced by anything other than a merged PR. Rule 10 now
names the recovery explicitly, and forbids rewriting history in it.

**Second: the rule secured the artifact of a PR, not review, while justifying itself entirely on review.**
`git switch -c x && gh pr create && gh pr merge` satisfies every word in under a minute with no reviewer. The
correctly-worded version was already in this file — *"the case for never merging a self-reviewed branch"* —
and the rule had dropped it. It is now a requirement, scoped to changes that touch behaviour.

**Third: the justifying anecdote described an event that never happened.** It claimed six reviewers across
two rounds found one critical governance flaw twice *"in work already green on four suites, manually
verified, with a PR description written"*. Two different episodes: the six-reviewer round was 0.16.0 (PR #5,
eighteen defects, two shipping blockers, and that is the one with four suites and a manual check), while the
same-flaw-twice was `delegate_chain`, two rounds of three. **And `delegate_chain` never went through a PR at
all — it is the eleven commits.** The true version is a *better* argument than the invented one: the work
with the worst governance defects is the work that skipped the PR. Rule 5 and rule 6, on the sentence doing
all the persuading.

**Fourth, and the one worth generalising: the rule was prose, in a project that promotes violated rules to
guards.** Every rule here that was *actually broken in practice* — the 400-line ceiling, the session-start
guard, the risk-register headlines (R-59, then R-72) — became a mechanical check precisely because prose had
already failed once. Rule 10 is justified by the same shape of history and shipped with nothing enforcing it:
no hook, no CI, and `main` with no branch protection (404, checked). Now `hooks/pre-commit` plus
`test/branch-guard.test.ts`, which three mutations of the hook fail. **Both remaining gaps are stated in the
rule rather than implied**, because an unstated absence reads as enforcement.

**Fifth, small and purely self-inflicted: the file lost rule 9.** Inserting the new section before the
terminology one and renumbering 9 → 11 left 1-8, 10, 11 — a gap that reads as a deleted rule, in a file whose
header boasts that the risk register cites it eighteen times. **Four of the five reviewers found this
independently**, which is a useful calibration on what a single careful read misses. Fixed by appending the
section instead, so nothing renumbered at all. `CLAUDE.md`'s summary of the file ("*nine of them*",
"documentation, evidence and terminology discipline") was falsified by the very PR editing that file, three
lines below the bullet it added.

**Then the rule broke itself during verification, and that is R-85's last paragraph.** Testing whether the
hook fires, `git stash -u` swept the still-untracked hook aside, so the commit on `main` succeeded — the
guard was absent at the exact moment it was under test. Empty, unpushed, undone with `git branch -f main
origin/main`, which is the recovery the rule prescribes; the procedure was needed within minutes of being
written. **A guard a routine command can remove is a guard with a hole.**

**Then the fixes were reviewed, and the fix had reintroduced the defect it removed.** Rule 10 says a change
touching behaviour gets an independent pass, and the fixes added a hook and a test — behaviour. So one more
reviewer, on the delta only. It returned **DO NOT MERGE**, correctly. `hooks/pre-commit` refused a
**conflicted** merge on `main`: a clean merge runs `pre-merge-commit` and never reaches the hook, but a
conflicted one finishes with a literal `git commit` that does — and in that state `git switch -c`, the recovery
the hook itself prints, is rejected by git. The only escape git offers is `git merge --quit`, which throws away
the conflict resolution. **"A prohibition with no usable recovery", removed from the prose and reintroduced in
shell one commit later.** Four more: the skip condition made *deleting the hook* report `pass 0, skipped 4`
instead of failing — rule 7 inside the file citing rule 7, and precisely R-85's recorded recurrence; the R-85
trigger flagged 87 of 89 commits *and* both genuine PR merges, because GitHub puts `#N` in a prefix not a
`(#N)` suffix; a third enforcement gap (clean cherry-pick and revert never invoke `pre-commit`) was unstated
while the commit claimed both gaps were stated; and the one git-spawning test would die on any machine with
`commit.gpgsign = true`. Two of its reported surviving mutations were also worth closing: a waiver loosened to
`[ -n ]` (so `=0` and `=false` would *disable* the guard) and a `*main*` substring match (which would refuse
`docs/maintenance`). **Seven mutations now fail the suite, measured, where the docstring had claimed four and
one of those survived.**

**Recorded because rule 10 says to, on the day rule 10 landed: two outward-facing artifacts were corrupted by
shell backtick expansion.** PR #6's title lost `` `main` `` and shipped as *"docs+guard:  is only advanced..."*
until it was patched; #7's squash-commit message on `main` (`6832ac1`) lost `` `files` ``, `` `test/` `` and
`` `hooks/pre-commit` ``, leaving two broken sentences. **That one stays** — it is pushed, and rule 10 forbids
rewriting history to tidy a cosmetic defect; #7's body carries the intact text. Cause both times: backticks
inside a double-quoted shell string are command substitution, and `python3 -c "...\`x\`..."` interpolates
before Python ever sees it. **The pattern that avoids it:** write the JSON with a quoted heredoc
(`<<'PY'`) or a file, never a double-quoted `-c`. Cheap, and it failed twice in one session before being
written down — a title is visible, but a merge-commit message nobody rereads is exactly the artifact that
rots unnoticed.

**What to copy from this pass.** Assigning each reviewer a single falsifiable lens produced almost no
overlap: the factual-claims reviewer found the composited anecdote, the rendering reviewer measured the
108-character wrap and cleared the two rendering worries by *actually rendering* rather than reasoning, and
the enforcement reviewer produced the finding that changed the shape of the work. **The one thing every
reviewer found was the numbering gap** — the cheapest defect in the diff, and the one a careful author had
read past four times.

## 2026-08-18 — the chain's gate was wrong TWICE, and the pattern is the lesson

Second review round on `delegate_chain`: three reviewers, one critical, four high/medium. Fixed forward. **498 unit
tests in 9.8s, pure; 44 integration; smoke clean.**

**Every defect in both rounds is the same mistake wearing different clothes: the chain reimplemented, beside an
existing rule, a decision that rule already makes.**

| round | rule bypassed | what it cost |
| :--- | :--- | :--- |
| 1 | `resolveApprovals` keys per subject | one definition's yes authorised every other; a 30-day entry keyed to `digger` satisfied `shaper` for a month |
| 2 | `shouldSeekApproval` | a step that could never run still raised a dialog, and the yes was banked — reachable by a model appending one unheld capability |
| 2 | `once` semantics (R-29) | one *Allow once* spawned three children; the dialog described step 1, step 3 had been told "…and burn the evidence" |
| 2 | the approval record (ADR-0010) | a step that ran on a human's click recorded nothing; `/grants ledger` showed it as neither attributed nor a gap |

**So the transferable rule is sharper than "write an ADR", and this is the sentence to keep:** when a decision adds a
new **caller** of an existing mechanism, the design work is enumerating every rule that mechanism's normal caller
obeys and saying which the new caller inherits. Options-weighing cannot catch this. The evidence needed was a list of
what `runOneDelegation` does before and after it delegates — and it is one function away.

**The fix found a live defect that had nothing to do with the chain.** Making `planDelegation` filter approvals by
subject closed a **second escalation on the ordinary `delegate` path**: a human's explicit "no" for one definition
overridden by a yes for another, shipped in 0.16.0. My commit had claimed the change was *"a no-op on the pre-existing
paths"* — false, because `republishable(session)` passes every subject unfiltered into the re-plan. **R-83.** The
chain was the occasion for finding it, not the cause. **R-84** records a pre-existing hole the same probe surfaced: a
single `session` yes on the `tools:` path propagates through a whole subtree unchecked.

**Three of my tests could not fail, and one class is worth naming.** `fenceHandoff.length === 1` cannot fail because
`Function.length` stops at the first *defaulted* parameter — which is precisely what the seam was. Assert behaviour,
never arity. Two shipped fixes had **no test at all** and were freely re-breakable. And `preApproved` was pinned by
nothing, because every pure test declined and the opt-in one used `allow-session`, which satisfies the gate from
session state regardless.

**And I moved a test that could not fail instead of fixing it.** The previous round's commit admitted "step N receives
step N−1's output" only pinned a ledger field; I relocated it to the integration tier verbatim, comment included, so
the call site was uncovered in *both* tiers. **Relocating a broken test launders it.**

**Purity broke twice and both times I introduced it.** Approving a gate in a wiring test makes a step spawn a real
`pi`, which always calls a model: 2m19s, then 1m54s, on ~13s of CPU. The rule is mechanical — **a wiring test that
approves is an integration test.** Now proven with `pi`/`herdr` shims first on `PATH`: 498 pass, neither binary
invoked.

**Mutation testing, four sessions running, has found what careful tests missed every time — including a test of mine
that failed unconditionally and would have read as coverage.** Verify the mutation actually bites: my first attempt at
the executor-ordering mutation moved the check somewhere harmless and proved nothing.

---

## 2026-08-17 (chain review) — the ADR itself was wrong, and that is the finding to keep

**Three reviewers, one hypothesis each. All three found real defects; two found the same critical from different
briefs.** Fixed forward on the operator's call. `npm test` **2m19s → 14.9s**.

**ADR-0033's central mechanism was not implementable, and implementing it faithfully produced a privilege path.**
The decision said *"the gate asks once, upfront, for the union"* and illustrated a dialog reading *"this chain needs
`tool:bash` for build, review, debug, git-ops"*. **That dialog cannot exist**: an approval is keyed
`capability@subject`, so one dialog means one subject. Measured consequences — `shaper` running on a yes given for
`digger`; a 30-day entry keyed to `digger` satisfying `shaper` in later sessions with **no dialog at all**; a
model-chosen `tools:` list being offered *Always allow in this project*, which a plain `delegate` is denied.

**The lesson is about the ADR process, not the code.** That decision had options weighed, a worked example, and the
operator's recorded choice — and its mechanism was still impossible, found by reviewers in under an hour and missed by
the author while implementing it faithfully. **A decision that names a mechanism must be checked against the layer
that would enforce it before it is Accepted.** One grep for where approvals are keyed would have caught it at writing
time. That sentence is now in the ADR.

**The root cause was one line in the planner, not in the chain**, and that is the more useful half. `planDelegation`
matched `approved` by bare capability name — safe only because every existing caller pre-filtered by subject
upstream. That made `approved` a footgun for any *new* caller, and this feature was the new caller. Enforcing subject
matching in the planner makes the property hold by construction; it is a no-op on the old paths. **Ask "is this safe
because of the code, or because of who happens to call it?"**

**Two defects were yesterday's, reintroduced on a new path.** The executor-refusal check ran after the gate again,
because a chain hoists its gate above `runOneDelegation` — so the ordering fixed the previous day was simply bypassed.
And a refused chain wrote no ledger line at all. **A fix applied at one call site is not a fix; ask where else the
shape appears.**

**The handoff was never verbatim.** `String.replaceAll` interprets `$` in a *replacement*, so a `build` step
summarising a shell script had `$$` and `$'…'` silently rewritten, and `$&` reinserted a literal `{previous}` — the
exact outcome `replaceAll` was chosen to prevent. No adversary needed.

**Three of my tests could not fail, and one was worse than useless:**
- Deleting the handoff entirely left all 489 green; the test that claimed to cover it only pinned `taskFrom`.
- All 11 fence tests passed with the body moved OUTSIDE the fence, because `indexOf(">>>")` latched onto a *forged*
  delimiter in the hostile text.
- My replacement for the gate test used `composeStepTask` without importing it, so it failed **unconditionally** and
  proved nothing. **Mutation-checking caught that one before it was kept** — a test that always fails looks like
  coverage in a red run and like a flake in a green one.

**And I broke the two-tier test design.** Five chain tests spawned real `pi` children calling a real model, so the
unit suite needed network and credentials and ran 66s/127s/346s while `CLAUDE.md` advertised it as *"fast, pure, no
pi, no network"*. Moved to the opt-in tier; verified the moved file really runs by executing one for real.

**Three sessions running, mutation testing has found what careful tests missed every single time.** It is no longer a
technique to remember — write the test, break the code, check the test notices, and do it before believing the test.

---

## 2026-08-17 (chain) — 0.17.0: `delegate_chain`, and a herdr suite that would have caught the blockers

**Built the integration test FIRST, deliberately.** Three of 0.16.0's defects hid behind an injected `exec` fake, so
`test-integration/herdr.it.ts` now checks herdr's own contracts against a live server: 12 tests, no model tokens,
~20s, in a workspace it creates and closes so an operator's layout is untouched. Verified it can fail — re-allowing
dots in the agent-name charset fails five of them, including the one written for that blocker.

**One thing to carry forward about `node:test`:** it evaluates a test's `{ skip }` option when the test is
**defined**, before any `before()` hook. The first version probed in `before`, so all twelve skipped and the suite
reported `pass 0` while looking perfectly healthy. Module-level `await` runs first.

**Then ADR-0033 (`delegate_chain`), accepted and shipped in five commits.** `src/chain.ts` is the handoff, pure;
`extensions/delegate-chain.ts` is the tool. Every step goes through `runOneDelegation`, so no governance rule is
re-implemented — what a chain adds is composition, one gate instead of N, a budget unit per step, and abort.

**Three defects in my own work, all caught by a test or the compiler rather than by reading:**

1. **I reused `takeBytes` for the handoff, which keeps the HEAD.** A handoff needs the tail — a summary's conclusion
   is at its end, which is why `readPane` keeps the tail too. The head-keeping version silently discarded exactly
   the part of a step's answer the next step needed. `tailBytes` now walks code points backwards.
2. **Adding `preApproved` as a seventh positional parameter put it in front of `onProgress`**, and two call sites
   silently passed a progress sink where approvals were expected. TypeScript caught it only because the types
   happen to differ — luck, not a control, and **R-28 was exactly a defect in an argument list**. The optional tail
   is now one options object, which makes the mistake unspellable.
3. **A framing sentence wrapped across two lines** put a newline in the middle of a phrase a test asserts verbatim.

**And one test of mine could not fail — found by mutation, which is the only way it could have been.** "A chain asks
ONCE for the union" declines at the gate, so the chain aborts and **no step ever runs**: dropping `preApproved`
entirely left it green, because the count was 1 from aborting rather than from the steps being satisfied. That is
precisely the shape a reviewer found on the previous branch — **a fixture that never spawns cannot test what happens
after spawning.** There is now a second test where the operator allows, all three steps run, and the count must
still be one.

**Mutation testing has earned a permanent place.** It caught the one thing six careful tests did not, twice in two
days. Write the test, then break the code and check the test notices.

---

## 2026-08-17 (review) — six reviewers, eighteen defects, two shipping blockers

**The single most valuable hour of this project so far, and the case for never merging a self-reviewed branch.**
0.16.0 was implemented, verified four ways (461 tests, typecheck, integration, smoke), manually checked against the
real herdr daemon, and had a PR written for it. Then six independent agents each got **one written hypothesis** and
no permission to fix anything. **Every one found something. None found what its hypothesis predicted.**

**Two were shipping blockers, and both came from the same root cause: an unverified line in a probe.**

`docs/probes/g16-herdr/README.md` said, in its *How to rerun* block, *"`herdr agent stop` ends the agent but leaves
the pane."* **That command does not exist.** It prints the usage banner and exits 0, which any wrapper reading only
the exit code records as success. Three call sites were built on it, and ADR-0032 built a *governance claim* on it
— "the agent is still stopped… what survives is a terminal, not a running descendant."

**The lesson is where the false line was, not that it existed.** A rerun recipe is the one place in a probe where
"measure before asserting" is easy to forget, because everything around it *was* measured. There is even a dated
correction immediately below it about a different usage mistake in the same block — which should have been the
warning. **Rule 5 needs to cover rerun instructions explicitly**, and the probe now carries a falsification note
saying so.

What it cost: a child that timed out or aborted **kept working with its grant** after its result was reported; and
because herdr frees an agent name only when its tab closes, the **second `delegate` of every turn** died with
`agent_name_taken` — on the executor ADR-0031 had just made the default. Neither was reachable by any test in the
suite, because the unit tests inject a fake `exec` that answered `agent stop` cheerfully and the integration suite
never reaches a real herdr spawn.

**Four defects were found by MUTATING production code and watching the tests stay green.** That technique earned
its place permanently:
- The `delegate_all` "one status block" test passed with a reporter per child — its fixture never spawned, so no
  sink ever fired and `frames.length === 1`. The during-run painting ADR-0032 is *about* was untested.
- The tripwire's "says which is which" test passed on the fully **inverted** message.
- Its sibling executed **zero assertions** (a conditional guard on a message containing no digits).
- Hardcoding both ledger call sites to `executor: "process"` left all 442 tests green.

**Three findings were about my own fixes creating the next defect**, which is the shape to watch:
- The R-60 guard hardcoded `grants.ts`; splitting the file under the ceiling moved ten of its thirteen controls out
  of scope, and it passed vacuously — R-60's shape inside the guard *for* R-60, in the commit whose message says
  the guard was obeyed.
- The executor disclosure was gated on `governed` rather than `mayDelegate`, so an ungoverned session would have
  relocated its children into panes in silence: ADR-0031's own rejected objection, inside its fix.
- The streaming fix bounded the *unit* count when the budget was in *bytes* — the same defect as the 1924-byte one
  it replaced, one layer down.

**And the design error worth remembering: I treated a snapshot source as a stream.** `agent read` returns the whole
terminal; diffing it as append-only broke permanently the moment a pane scrolled or passed the output cap —
measured **51 MiB streamed for 600 bytes of real output**. Four separate findings (amplification, fabricated text,
unbounded line growth, repeated real output) were all that one mistake. The fix was not a better diff; it was
admitting the substrate is a snapshot and having the consumer *replace*.

**Also found: the README was never updated.** Two reviewers independently. SPEC was corrected for every claim;
`packages/pi-daddy/README.md` — the file **npm publishes** — still said "Opt-in, never auto-detected", the exact
sentence ADR-0031 reverses and that R-62's own re-rating note on this branch calls false. **When a decision changes
behaviour, grep for the claim, not for the file you happened to be editing.**

**And then verifying the fix found a third blocker the reviewers had not reached.** Two real spawns against the
live daemon — the cheapest possible check — showed that herdr enforces an agent-name grammar
(`[a-z][a-z0-9_-]{0,31}`) that this package has always violated: names are `<definition>-<childId>` and a child id
is hierarchical (`d0.1`), so **`agent start review-d0.1` has been rejected since the executor was written**. The
herdr path had never once started a definition spawn. Both suites were green throughout, because the unit fake
accepts any name and the integration suite never reaches a real herdr spawn.

**Two probe facts falsified in one run, and both for the same reason: the probe only ever used well-formed inputs
and never executed its own cleanup advice.** Where a substrate *validates* something, a probe has to try to violate
it; where a probe gives a rerun recipe, that recipe has to have been run.

Verified fixed against real herdr: two spawns from base `review-d0.1` produce `review-d0-1-1` and `review-d0-1-2`,
and both start with real interactive pi argv.

ADR-0032 carries a five-point amendment; ADR-0031 is unaffected. R-62's re-rating stands.

---

## 2026-08-17 (later still) — 0.16.0 shipped: probed executor, visible children

**ADR-0031 and ADR-0032 accepted and implemented in twelve tasks on `feat/observable-governed-children`.**
442 unit + 32 integration tests, typecheck clean. `docs/plans/2026-08-17-observable-governed-children.md` is the
plan; ADR-0033 (chain) is deliberately still **Proposed** and un-planned — it wanted `progress.ts` and the
executor choice to exist first.

**Three guards refused something and each was obeyed rather than raised.** This is the part worth copying.

1. **`test/session-start-guard.test.ts`** refused the first version of Task 1: the new
   `await reportSessionStart` had no `try` of its own. R-60 enforced structurally, working exactly as intended.
2. **`test/file-size.test.ts`** refused `run-herdr.ts` at **404** after the output polling landed. Split to
   `src/herdr-poll.ts` along the seam the plan had named in advance — *observing* an agent versus *starting and
   cleaning up after* one. `extensions/grants.ts` was at **398** before any of this began, which is why Tasks 1
   and 2 are extractions rather than features.
3. **Two pre-existing `run-herdr` tests** asserted the pane-closes-in-`finally` contract ADR-0032 reverses. They
   were **rewritten with a note saying what changed and which property survives**, not deleted. A third failure
   was test pollution: panes now outlive each test, so the reaper tests were asserting against panes their
   predecessors left behind — fixed with an `afterEach` that drains the registry.

**Two defects were caught by review before they shipped, and both are worth remembering:**

- **The executor disclosure was gated on `session.governed`.** An ungoverned session still registers `delegate`
  and still spawns, so that version would have relocated its children into herdr panes **in silence** — which
  is ADR-0031's own rejected objection reappearing inside the fix for it. It is `session.mayDelegate` now, and
  reintroducing the old guard fails two tests (verified by doing it).
- **`PI_GRANTS_HERDR_WORKSPACE` defaulted to "let herdr choose".** herdr sets `HERDR_WORKSPACE_ID` in every pane
  it creates — measured, documented nowhere — so children were landing in a different workspace from the session
  that spawned them, making "switch between them" a workspace hop. It inherits the parent's workspace now.

**One defect the tests caught that reading did not.** `runChild`'s streaming first emitted the raw chunk, which
pushed **1924 bytes through a 1024-byte cap** on the truncating write: the cap bounded memory and not the screen
it had just been extended to protect. The fix is to derive what is streamed from `text`, so it is *by
construction* a prefix of what is returned.

**And one hazard that turned out to be false, checked before it cost anything.** `--no-extensions` does not stop
a governed child appearing as a herdr agent — `docs/probes/g16-herdr/README.md:40-47` already recorded it.

**The wiring harness now pins `PI_GRANTS_HERDR=0`, and that line is load-bearing**: unset means probe, and
`session_start` runs the probe, so without it the suite would shell out to whatever herdr is running on the
developer's machine and choose a different executor here than in CI. Two tests deliberately empty `PATH` instead
of mocking, so `defaultExec` is exercised end to end.

**Verified against the real daemon**, not only fakes: the probe answers `{ok: true}` here, unset selects herdr
panes, and `resolveWorkspace` returns `w7` — the workspace this session runs in.

**`turn_end` is not the turn-end hook.** It fires per provider round-trip, no later than the `finally` it would
have replaced. `agent_settled` is the one that means "the operator has their prompt back". Do not re-derive this.

---

## 2026-08-17 (later) — the operator ran it for real, and could not see anything

**No code changed. Three ADRs proposed (0031, 0032, 0033), all from one observation: the operator ran a real
governed fan-out and asked why nothing appeared in herdr.** Nothing was broken. `PI_GRANTS_HERDR` was unset,
which is the documented default, and they had never been told the variable existed.

**Two facts established by execution, both worth not re-deriving.**

**ADR-0030's init loop works end to end against a real project.** `~/.pi/agent/grants/bookie-pi-skills-675c4e2b56973e2f.json`
was written by `/grants init` at 10:06Z today, granting seven `agent:` ids plus six tools for
`/home/alavanja/repos/bookie-pi-skills`, and the seven scaffolded `SKILL.md` files sit in that project's
`.pi/skills/`. `/grants` in that session listed all seven as `allow` with their effective tool sets. **The
NEXT SESSION list above still implies this is unproven; it is not.**

**`principal-pi-skills@2.3.1` still declares no `allowed-tools` anywhere** — grepped the whole installed
package. **Handoff item A1 has NOT landed**, and the note above ("until A1 lands, `init` correctly reports
`0 declaring allowed-tools` and the operator writes seven ceilings by hand") remains exactly true. The seven
working definitions above are the *scaffolded* ones, not the package's.

**One thing I got wrong, and the correction is the useful part.** I identified the refused `subagent` tool as
`@tintinweb/pi-subagents`, the package ADR-0013/0016 discuss. It is not, and no such npm package is installed.
It is a **hand-installed directory drop-in** at `~/.pi/agent/extensions/subagent/` (`index.ts` 1015 lines,
`agents.ts` 126, dated 2026-08-03) which pi auto-loads in **every session on this machine** regardless of
`settings.json`. It registers a tool named `subagent` (`index.ts:462`), spawns a `pi` process per invocation,
and supports single / parallel / **chain** modes reading definitions from `~/.pi/agent/agents/`. The lesson is
the ordinary one: **a familiar name in a tripwire's allowlist is not evidence about what is installed.** The
tripwire fired correctly either way — it matches on tool *name*, which is all it ever claimed to do.

The second drop-in in that directory, `herdr-agent-state.ts`, **is** third-party and legitimate: installed and
managed by herdr (`HERDR_INTEGRATION_ID=pi`, version 6), registers **no tools** — four hooks only — so the
tripwire never sees it.

**A hypothesis checked before it was brought to the operator, and false.** `--no-extensions` (`src/spawn.ts:76`)
does **not** stop a governed child appearing as a herdr agent. `docs/probes/g16-herdr/README.md:40-47` already
records a child launched as `pi --no-session --no-extensions --tools read` with herdr emitting `agent_started`
and a live `state_change_seq`. Herdr registers the agent because `herdr agent start --kind pi` was called, not
because an extension reported in from inside the child. **The probe answered it; no new measurement was
needed.**

**`turn_end` is not the hook it sounds like.** It fires per provider round-trip
(`pi-coding-agent/dist/core/extensions/types.d.ts:557`), i.e. no later than the `finally` that already closes a
pane. `agent_settled` (`:547`) is the one that means "the operator has their prompt back" — and herdr's own pi
integration drives its busy/idle display from `agent_start`/`agent_settled`, which is independent
corroboration. Designing pane lifetime against `turn_end` would have shipped a no-op.

**R-62 has a dated note**: its L×L rating is justified by *"the herdr executor is opt-in"*, which ADR-0031
removes. Re-rate it in the change that ships 0031, not before.

**Still open, and they are decisions rather than code:** all three ADRs are **Proposed**. ADR-0031 reverses
part of ADR-0016 point 6 (which now carries a dated note pointing at it) and makes `docs/SPEC.md:398` false as
written; ADR-0032 makes `docs/SPEC.md:394-395,438` false as written. **Neither SPEC nor the risk register was
edited to match, deliberately** — the code does not do this yet, and a spec that describes unbuilt behaviour is
worse than one that lags.

---

## 2026-08-17 — five reviewers, nine defects, and the trigger I wrote and did not apply

**The independent pass on PR #2: five agents, one written hypothesis each, none of them allowed to fix
anything. Every one found something.** Nine defects, all reproduced here by execution before being acted on,
all fixed; one new decision (ADR-0029); ADR-0028 amended in four places and one of its sentences struck as
false.

**R-78 is the one to remember, and it is humbling.** R-77 — written the previous day — closed a capability
injection through a definition's **name**, and its trigger reads *"any new file this package generates whose
content includes a string taken from a third party, in a format where a separator or a quote means
something."* The `allowed-tools` **value** travels to the identical interpolation site, one line away, and
was unchecked. A package declaring `allowed-tools: Read,ext:x";touch …` produced a `.pi/grants.env` that
executed the payload when sourced — silently, exit 0, variable left plausible. **I wrote the trigger and
applied it to one of the two channels it names.** The fix is a whitelist plus a charset backstop that does
not depend on my enumeration, because the enumeration has now been incomplete twice.

**R-79 is B-I6 reintroduced.** `approval-store.ts` fixed "never write through a symlink" under ADR-0014 and
says so in a comment. A new writer in the same package, three days later, used `writeFile` after a `readFile`
presence probe — so a dangling symlink wrote outside the project, and an *unreadable* file counted as
*absent* and had its ceiling silently widened. One `open(path, "wx")` closes both.

**R-81 is R-28's shape inside the module whose header claims to have made R-28's shape inexpressible.** The
summariser deferred to the real planner and then **re-derived a category from two fields of its result** —
and `planDelegation` has six refusals that set neither. So a malformed `PI_GRANTS_MAX_DEPTH` printed "their
files are written wrong" two lines above `/grants` printing "delegation is disabled". The classification was
the second reading of the rules. It now prints the planner's own words.

**The pattern across all nine: every defect was in the half of the change nothing had attacked.** A
generated file, a CLI with no tests, a classifier written after the planner it defers to. The unit suite was
in good shape — a reviewer ran **38 mutations and 27 were killed**, and none of the 17 new tests was
decoration — which is exactly why the review had to attack somewhere else to find anything.

**ADR-0029 came from the design critic, and it is the deepest finding.** ADR-0028 said `init` "never chooses
a ceiling", which is true and beside the point: `init` chooses the **grant**, and the handoff's whole reason
a third party may safely author `allowed-tools` is that *the operator's grant independently bounds it*. A
generated union collapses those two authors into one. The generated grant is now read-only by default, with
`bash`/`write`/`edit` commented and named. The operator chose that option from three.

**Two process notes worth keeping.** A reviewer switched the working tree off the branch mid-session, and
uncommitted work by another session was sitting on `main` — the fix pass moved to a `git worktree` rather
than stashing someone else's changes. And one of the reviewers' own findings ("the summary vanished under
`PI_GRANTS_GATED=agent:x`") was **the branch switch, not a bug**; they caught it and retracted it, which is
the behaviour to want.

**353 unit + 28 integration, typecheck clean, smoke clean.** Still 0.14.0 — nothing shipped between the two
passes.

---

## 2026-08-16 — `pi-daddy init`, and a startup line that names what it will not spawn

**The pi-daddy half of the `principal-pi-skills` handoff: B1, B2 and B4, decided in ADR-0028.** Section A
belongs to the other repository and was not touched. B3 was already answered.

**`npx pi-daddy init` exists, and what makes it governance rather than convenience is what it refuses to
do.** It reads `node_modules` for packages declaring `pi.skills`, copies each declared `SKILL.md` into
`.pi/skills/`, and writes an annotated `.pi/grants.env`. A declared `allowed-tools` is copied **byte for
byte**; an undeclared one gets a **commented** placeholder and stays unspawnable; an existing file is
**kept**, because that edit is the capability decision and a second `init` run is exactly when it would be
destroyed. The generated grant authorises only what can actually be spawned.

**The tempting version was to ship the handoff's ceiling table**, and it was rejected for two reasons worth
keeping: the constraint forbids it, and *that table contradicts itself* — it gives `plan` a `Write` while
the prose beneath calls `plan` structurally incapable of modifying anything. Shipping it would have been
pi-daddy settling an open question that belongs to the skill package.

**Session start now says `1 of 7 definitions spawnable — review` and names the six it is withholding**,
grouped by reason, because a gate and an escalation have different fixes. It speaks even when **nothing** is
spawnable — the handoff proposed printing only when at least one was, which is silent for exactly the
operator in P2's state. Classified by the real planner, never by a second reading of the rules: this package
has shipped a diagnostic that disagreed with the enforcer twice (R-28, R-38).

**R-73 shipped and the smoke test caught it, which is the finding worth carrying.** `npx pi-daddy init`
printed **nothing** and exited **0** for every installed copy: npm makes a bin a symlink, so
`process.argv[1]` is the link while `import.meta.url` is the file it points at, and the "only run when
invoked directly" guard was false every time. Every in-repo test passed — they import `main` and call it,
which is the path the guard exists to exclude. **A scaffolding command that does nothing is
indistinguishable from one that found nothing to do**, which is why an `×H` sits on an otherwise trivial
defect. Same class as B-I12 (the `exports` map that worked in the tree and threw for every consumer), caught
by the same script, now twice.

**And the review question found one more, in code written the same hour.** *What does the generated file
interpolate?* — a definition's identity is its **directory name**, and `init` writes it into a
comma-separated `PI_GRANTS_GRANT`, a file the operator `source`s, and a path, all at once. A package
shipping a directory called `a,tool:bash` made `init` write
`PI_GRANTS_GRANT="agent:a,tool:bash,tool:delegate,tool:read"`: **`tool:bash` in an operator's grant,
declared by no definition and chosen by nobody**, in the one file this feature exists to make reviewable.
Reproduced against the real CLI, fixed with a name whitelist at discovery, R-77. That is the session log's
second habit — *ask where else this shape appears* — pointed at generated output instead of at parsing.

**Mutation checks found a decoration.** Thirteen production changes were named and reverted one at a time; twelve
failed exactly the test written for them, and the one that did not — deleting the containment check on a `pi.skills`
entry — failed **nothing**, because the fixture pointed at `../../../etc`, which is unreadable with or
without the guard. Rewritten to point at a real, readable definition outside the package. That is rule 7
catching the author for the third time in three sessions, and it is the cheapest check in this repository.

**Everything asserted about pi and about `principal-pi-skills@2.3.1` was re-measured** —
`docs/probes/b2-init-principal-pi-skills` runs the whole loop (`npm i` → `init` → one human edit → a real pi
session → `/grants`) and costs no model tokens. P2 is unchanged at 2.3.1: **zero of seven skills declare
`allowed-tools`**, so the README's worked example shows the honest state rather than the after-A1 one.

**332 unit + 27 integration, typecheck clean, smoke clean.** 0.14.0.

---

## 2026-08-14 (last) — the package is `pi-daddy`, and the rename went through the record

**Renamed on the way to a first publish**, which is what forced the question: `pi-agent-grants` matched
neither the repository, the workspace root, nor anything anyone calls this. `git mv` to
`packages/pi-daddy/`, `"name": "pi-daddy"`, and the workspace root became `pi-daddy-workspace` because npm
requires the root and its members to differ — given a forced choice the *published* artifact keeps the good
name.

**The operator chose to replace the old name in dated documents too, over the assistant's recommendation,
and ADR-0027 records both the decision and the disagreement.** 126 occurrences across 29 files, including
ADRs, the risk register, this log, `docs/probes/` and `docs/archive/` — the last of which is documented as
*"never edited to match today"* and has now been edited to match today.

**What that made untrue is listed in the ADR rather than glossed**: ADR-0016 now says "pi-daddy 0.7.0" and
no such version existed; probe READMEs cite a path that did not exist when the probe ran. The reasons it was
accepted: **nothing was ever published under the old name**, so no reader outside this repository holds an
artifact it refers to; git preserves every original wording and `--follow` traverses the move; and R-59 and
R-72 are both entries about the cost of two names for one thing in an orienting document.

**`.claude/rules/phase-gates.md` §2 and `CLAUDE.md` are amended rather than quietly violated.** The test that
permits this and forbids the DTCM rewrite: *does the name denote something abandoned?* "DTCM" does — those
sentences are the evidence of a retired thesis. "pi-agent-grants" did not. **Rule 4 is untouched.** A rule
that forbids what the repository already contains protects nothing; it teaches the next session to distrust
the file, which is the exact failure the retired phase-gate rule at the top of that file was rewritten to
escape.

**Verified after the move: 315 unit, 26 integration, typecheck clean, smoke clean.**

---

## 2026-08-14 (twelfth) — four agents, one hypothesis each, and the lock was letting two writers in

**The independent pass the top of this file kept asking for. Every one of the four found something, and the
worst of them broke an invariant rather than a claim.**

**R-67 — `withFileLock` admitted two holders at once.** Root cause in one sentence: `rm(lockPath)` deletes
whatever is at the path *now*, not the lock this process created. Two breaks followed — the stale-break
`stat`/`rm` gap could destroy a **live** lock, and the unconditional `finally` freed the **new** owner's,
which cascaded to processes that raced nothing and observed nothing wrong. Reproduced across **real OS
processes with no clock manipulation**: 2 of 120 trials × 16 processes under deliberate load, and the
overlap persisted for the rest of each trial. The docstring asserted the opposite in so many words, which
is what made it convincing. Fixed with a per-hold token and `removeIfOurs`.

**The fix had no failing test until the mutation check said so.** Reverting `removeIfOurs` to the
unconditional `rm` passed everything. That is rule 7 catching the author, and it is the second time in two
days — worth more than the fix.

**R-66 — eight ledger lines claimed a human was prompted; one was.** R-29 shares a non-`once` outcome across
concurrent callers, correctly; the *record* then stamped `"prompt"` on every rider. `ledger.ts` calls that
exact direction "the worst available failure", and **R-46 is the same defect one level down** — fixed across
the capability set while the concurrency case survived it untouched.

**R-64 — `source in bySource` walks the prototype.** A ledger line with `"toString"` as a source wrote a
string into a counter, made the renderer's sum a string, and **deleted the entire ADR-0020 measurement from
the report** while marking an intact ledger corrupt. Two smaller siblings beside it. All in code written the
day before.

**R-65 — the pane reaper was disabled by the one failure it exists for.** `defaultExec` *resolves* `{code:1}`
on failure, so the `.catch` was dead code and a refused close looked exactly like a successful one. Also 80
seconds of silent hang at exit, and `timeout` is not a bound: `spawnSync` SIGTERMs then waits (measured, 3s
timeout → 59.8s).

**Two agents also cleared hypotheses, and that is worth as much.** No realistic `work()` comes within two
orders of magnitude of `STALE_LOCK_MS` (measured on both filesystems); tab ids are not recycled; concurrent
tracking does not tear. Each cleared claim is now a sentence in the code stating what the threshold does and
does not guard.

**One finding went to the operator rather than being fixed:** `PI_GRANTS_FANOUT` is not a session total,
though `SPEC.md` and the README both said so — three successive `delegate_all(8)` calls in one session are
all accepted. Their call: correct the documents, because making the code match changes what a bound *means*
and would break working setups. Recorded against ADR-0008.

**ADR-0026 survived on its decision and lost most of its argument.** The critic confirmed all four
hypotheses against the reasoning: it cited ADR-0008 for an invariant ADR-0008 never states, claimed an
immunity the 120s dialog timeout already breaks, and offered a remedy (`always`) that is **structurally
unreachable for `delegate({tools})`**. Every one is now corrected in place with the correction marked, and
its revisit trigger was rewritten because the first one could not fire — ADR-0020's defect in mirror image.

**Then, and this is the part worth keeping: re-auditing the four reports against what had actually
SHIPPED found seven items reported and not fixed.** Reading a report is not acting on it, and the gap is
invisible unless you go back and tick the list off line by line. Three more risks came out of that pass —
R-69 (four causes of an unsatisfied gate, one indistinguishable record, which is the vocabulary ADR-0026
rests on), R-70 (a ledger of nothing but declines reported no declines — the quietest output for the
loudest file), R-71 (two paths orphaning a herdr pane).

**`src/ledger.ts` hit the 400-line guard during that fix and was split, not exempted** (habit 3). The seam
is the one every reporting defect has lived on: writing fails closed on one record, reading must never fail
at all on a whole damaged file.

**Verified: 315 unit, 26 integration, typecheck clean, smoke clean.** Every fix mutation-checked; every
agent finding re-verified here by execution before being acted on, and two were worse than reported. **Two
of the new controls had no failing test until the mutation check said so** — the declines block and the
lock's ownership check — which is the third and fourth time in three days that rule 7 has caught the author
rather than a contributor. It is the single highest-yield habit in this repository.

---

## 2026-08-14 (eleventh) — the operator reviewed the four unreviewed changes; three produced a finding

**The review worked, and the way it worked is the reusable part.** Four hypotheses had been written down —
one per unreviewed change — and each was *checked by execution or by grep before being put to the operator*,
so what they were asked was a concrete finding with an example rather than "please look at this". Two of the
four were cleared in minutes. Two produced defects, and one of those is the most consequential thing in this
session.

**R-63 — the ADR-0020 tally overstated the persistence layer twentyfold.** It counted `persisted` RECORDS
and reported each as a prompt avoided. Precedence is `inherited → session → persisted → prompt`, and
**`session` approvals live in memory and owe the store nothing** — so a session spawning `deploy` twenty
times under one persisted entry writes twenty records, while deleting the store would raise **one** prompt
and satisfy nineteen from the session cache. The number that decides ADR-0020's fate was wrong by 20×, in
favour of keeping the thing under evaluation.

The lesson is sharper than the bug. **That report already excluded pre-0.11.1 records specifically to avoid
inflating `prompt`** — the bias was thought about, named in a comment, and defended against in one direction
while walking into it from the other. *Excluding one known bias is not being unbiased.* It now prints
records as a stated upper bound **and** distinct `capability@subject` pairs as the closer estimate.

**R-61 gained a fourth state, because the R-61 fix contained a smaller copy of R-61.** A lock timeout
happens *before* the load, so `failed` — whose message asserts *"It is still in effect"* — was returned for
a key nobody had looked for. Third time a fix here has contained a smaller version of its own bug (R-38's
preview, ADR-0022's republish path), and the **first time it was caught while still being reviewed** rather
than by a later pass. `busy` now claims nothing about the entry.

**R-60 gained a guard test, which immediately found two more.** `test/session-start-guard.test.ts` fails on
any `await` in `session_start` without its own `catch` — the exact way R-60 was born, by *adding* a line
rather than editing one. It flagged `loadDefinitions` and `buildCatalog` on its first run. Neither throws
today; that is the point, because `verifyLedger` did not either until the day it did.

**Cleared, and worth recording as cleared** (rule 6 — say what the evidence covers): the per-call lock does
cover `planWithApprovals`, whose long window is the human dialog, where a fresh yes *should* beat an older
revoke; and no other boolean in the package is rendered as a sentence that could be false — `report.ok`,
`plan.ok`, `revokeAll` and `saveApproval` all have two values for two facts.

One documentation change came out of it: *"a revoke takes effect immediately"* claimed two things, one false
and now fixed (R-49), one **impossible** — a spawn past its gate check is not retracted by a revoke arriving
microseconds later, and no lock closes that. It now says *"at the next gate check"* and explains why.

**Verified: 305 unit, 25 integration, typecheck clean, smoke clean.** All three fixes mutation-checked.

---

## 2026-08-14 (tenth) — the known-open list, emptied of code — 0.13.0

**Four items, and the interesting part is that two of them were "parked deliberately" and the park did not
survive contact with the fix.**

**Item 1 — the ADR-0020 measurement.** That ADR names the evidence that would settle whether the persistence
layer earns its keep (`persisted` against `prompt`) and says it *"needs no new machinery"*. True of the data
and false of the answer: nothing read `approvalSources`, so the measurement needed hand-written `jq` and
therefore never happened — **R-51's shape exactly**, one layer up. `/grants ledger` now prints the tally.
The number is stated as what it measures — prompts the operator did not see — not as a verdict, because how
many prompts a person will tolerate is not something a ledger can hold. Pre-0.11.1 records are reported as
**not counted** rather than folded in: that older scalar over-claimed `prompt` (R-46), so including it would
bias the one direction this measurement must not be biased in. **Only usage produces the number.**

**Item 2 — R-49, parked as "do not harden a layer whose fate item 1 decides".** The park was right about
hardening and wrong about this fix, because it was **reuse**: the ledger's lock moved to `src/file-lock.ts`
and both writers share it, so there is no new mechanism and nothing extra to delete if Option 3 is ever
taken. Two decisions inside it, both the ledger's *opposite* and both following from what the file is —
writes lock and reads do not, and a lock this cannot take never fails your work. The test is the property:
two concurrent writes, and the expected `{b, c}` is **satisfiable only under a lock**, since unlocked leaves
either the revoked entry resurrected or the concurrent save lost.

**R-61 fell out of it, and it is the worse defect.** `revokeApproval` returned a boolean for three facts, so
a **failed write printed "no persisted approval named X"** — telling an operator performing a security
action that the approval they were revoking did not exist, while it was still in effect and still satisfying
gates. Reassuring and wrong. Now `"revoked" | "absent" | "failed"`, breaking, and `failed` says the approval
**is still in effect**.

**Item 4 — pane cleanup.** Open panes are now closed on `exit`; SIGKILL and an unlistened SIGTERM are not
covered and say so. **The obvious completion is refused**: a SIGINT/SIGTERM listener would close those cases
and *suppress Node's default termination*, taking over an application decision this package has no standing
to make — pi uses SIGINT to interrupt a turn, and a handler that re-raised would turn that into "exit pi",
on **every** session rather than the opt-in ones. A governance package quietly changing its host's interrupt
semantics is worse than the leak. Also found there: `tab create` replying without a pane id returned *before*
`cleanup` was defined, so the one path where herdr half-succeeded was the one that leaked a tab.

**Items 6 and 7 are not work.** `subagents:rpc:spawn` is unfixable from here (ADR-0013) and `bash` is out of
scope (ADR-0012). Re-deriving either wastes a session; both are in the table so nobody tries.

**Item 3 went to the operator and came back decided — ADR-0026.**
The blocking question was *what happens to an approval resolved after its tool call returned*. The answer:
**refuse the spawn**, recorded as `gatedBlocked` with no source. A late approval starts nothing, so the
effective set never depends on when a human got to the dialog. Consequence: background mode is only useful
for **ungated** capability sets, and the remedy is operator pre-approval. **Not implemented** — what was
missing was a decision, not code, and ADR-0015 had declined to decide it once already.

**Verified: 301 unit, 25 integration, typecheck clean, smoke clean.** Every fix mutation-checked — removing
the lock fails the race test alone; leaving a pane tracked fails the reaper test alone; restoring
`verifyLedger`'s rethrow fails the R-60 test alone.

**None of this is independently reviewed.** See the four hypotheses at the top of this file.

---

## 2026-08-14 (ninth) — R-60: the ledger check was silent on the worst damage there is

**Pulled the "fourth thing": grep for call sites rather than trusting a reading, then ask where else this
shape appears.** It found one, in the control shipped the session before.

`verifyLedger` **rethrows** every read error that is not `ENOENT` — right for `/grants ledger`, where an
operator asked. At session start that call sat inside `session_start`'s blanket `try/catch`, and the catch
was **empty**. So an unreadable ledger threw and cancelled every remaining control in silence.

**Confirmed by execution before writing anything down** (habit 1). A governed session with
`PI_GRANTS_LEDGER` naming a directory emitted **zero** notifications — no alarm, and not even
`grants: depth 0/2, holding [...]`, the one line that says governance is on. The same harness with an
ordinary path emitted it, so the probe was not simply broken.

This is **R-34's own shape one level down**: R-34 was *"a check an operator has to know to run is not a
control"*; R-60 is a control that does not run on the one input class it exists for. A trail nothing can
read is more damaged than a trail with a torn line, and it was the case that said nothing. The tell was an
asymmetry already in the tree: `appendRecord` is called with `strict: true`, so the first *spawn* against
that same ledger refuses loudly. Only the startup check was quiet.

Fixed in two places. The `verifyLedger` call has its own `catch` that names the path, the errno and the
remedy; the outer catch is **loud** instead of empty, and says which checks did not run rather than implying
they passed. One integration test against real pi asserts both halves — the new alarm fires **and** the
`holding [...]` line still arrives, which is what pins the discarded-controls defect rather than the message
alone. Mutation-checked: restoring the rethrow fails that test and nothing else.

**Stated rather than hidden** (rule 6): the loud outer catch has **no direct test**. Every loader inside the
hook already swallows its own filesystem errors, so after this fix nothing reachable throws past it. R-60's
trigger is written for that — any new `await` in `session_start` whose callee rethrows belongs in its own
`catch`, not the blanket one.

**Verified: 295 unit, 24 integration, typecheck clean, smoke clean.**

**Not yet reviewed independently.** The log's own loudest sentence says get the review before shipping the
next three things. This is thing one.

---

## 2026-08-14 (eighth) — the fixture directories clean up after themselves

**Known-open item 5, closed.** Every suite created a `mkdtemp` directory per test and none removed it —
4,896 under `/tmp` in one day. `test/tmp.ts` now hands them out (`tempDir`) and remembers them
(`cleanupTempDirs`), and each of the nine suites that makes fixtures registers one top-level
`after(cleanupTempDirs)`. Measured: `ls /tmp | wc -l` is **identical** before and after a full `npm test`
and a full `npm run test:integration`, where it previously grew by hundreds.

**The half that is not bookkeeping.** A helper nobody is *required* to use decays back one suite at a time,
which is exactly how the count reached 4,896 — the old `after()` in `governance.it.ts` was an empty block
whose comment said *"the OS reaps them"*. So `test/temp-hygiene.test.ts` scans `test/` and
`test-integration/` and fails on any file that calls `mkdtemp` directly or that calls `tempDir` without the
teardown hook. Same shape as `file-size.test.ts`: a constraint nobody can run is a preference.

The one property the old comment was protecting — fixtures left on disk after a failure — survives as
`PI_GRANTS_KEEP_TMP=1`, an opt-in rather than the default that leaked.

**Mutation-checked both ways** (rule 7): restoring one bare `mkdtemp(join(tmpdir(), …))` fails the scan,
and stubbing `cleanupTempDirs` to remove nothing fails the removal test. Nothing else fails in either case.

Also corrected: the `CLAUDE.md` verification block still said **250 unit / 9 integration / 3 model** — stale
by roughly forty-five tests, and the second stale-counts finding in two sessions (R-59 was the first).

**Verified: 295 unit, 23 integration, typecheck clean, smoke clean.** The four model-driven tests were not
re-run — they cost money and the change to `delegation.it.ts` is one import line, typechecked.

---

## 2026-08-14 (seventh) — session close: the untested warning, and 4,896 temp directories

**Two pieces of cleanup, one of which was a real gap.**

**The `agent:*` + ungated-`bash` warning shipped without a test.** It was added from a review finding —
*a hazard a document declares and no code detects is R-47's shape* — and then immediately became the same
thing one level down: a detector nothing verified, which by rule 7 is decoration. Two tests now: the alarm
fires for `agent:*,tool:bash` with `PI_GRANTS_GATED=""`, and — the half that keeps it worth reading — it
stays **silent** for the default configuration where `bash` is gated. Warning about a correct setup is
R-25's shape inside the warning added to prevent R-25's shape.

**The suites left 4,896 `mkdtemp` directories under `/tmp` in one day.** Every suite creates one per test
and none clean up; the harness comment says "the OS reaps them", which is true and slow. Removed at close
and recorded as item 5 — hygiene, not correctness, and an `after()` hook per suite would fix it.

Also removed: `~/.pi/agent/grants-approvals.json`, which held nothing but this project's own test fixture
(`tool:write@x`, `cwd=/tmp/grants-approvals-…`, a zeroed digest, `version: 2` — a version the loader
rejects). It was written by `npm test` before R-40 was fixed, verified inert before deletion, and the live
per-project store had never been created, so nothing real was ever stored there.

**Final state verified: 292 unit, 23 integration, 27 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke
clean, working tree clean.**

---

## 2026-08-14 (sixth) — the ledger check runs itself — 0.12.1

**R-34, closed on the distinction it was opened on.** That entry exists because ADR-0008 leans on the ledger
as its compensating control and nothing had ever read one back; the fix added `verifyLedger` and
`/grants ledger`, *"because a check an operator cannot run is not a control"*. What went unnoticed is that
the same sentence applies one level up: a check an operator has to **know to run** is a feature, not a
control. Nothing ran it.

`verifyLedger` now runs at session start whenever `PI_GRANTS_LEDGER` is set, and a damaged trail announces
itself as an error naming the first bad line. **Corruption only** — the escalation count stays a query.
Reporting historical attempts at every start is the fatigue shape R-25 names, and it ends with the operator
skipping the line that matters. Two tests: one that the alarm fires unasked (driving `/grants`, not
`/grants ledger`), and one that an intact ledger — *including one holding a recorded escalation attempt* —
says nothing at all.

Awaited rather than fired and forgotten: it is one read on a path that already awaits two directory scans,
and awaiting is what guarantees the warning reaches a live `ctx.ui`.

**Verified: 292 unit, 21 integration, typecheck clean, smoke clean.** Mutation-checked — stubbing the
corruption branch fails the alarm test and nothing else.

---

## 2026-08-14 (fifth) — the two decisions, and one package fewer — 0.12.0

**ADR-0024: a gated `agent:` id now asks before the definition runs.** R-47 was a gate that did nothing on
the path an operator writing it means, because `gatedBlocked` filters `requested` and a definition spawn's
`requested` is its *ceiling* — the authorising id was never a candidate. It half-worked when some other
definition passed the id down in its own `allowed-tools`, which is worse than not working.

The load-bearing implementation detail: the id is evaluated against the gate **without joining `requested`**.
A capability in `requested` flows to `effective`, which becomes the **child's** grant — so the child would
hold `agent:deploy` and could spawn `deploy` itself with nobody asked. This is the parent's authority to run
it *now*, not something the child receives. Pinned by a test that asserts the id never reaches
`PI_GRANTS_GRANT`.

This closes the gap ADR-0023 recorded against itself: `agent:*` now has its "except", so
*"any of our definitions, narrow tools, and a human in the loop for the one that ships things"* is
expressible in two variables.

**`test/file-size.test.ts` caught its author for the second time.** ADR-0024 pushed `src/delegate.ts` to 413
lines and the guard refused it, naming the remedy. The cap was not raised: the capability-id helpers moved to
`src/capabilities.ts`, and the seam was not chosen for convenience — three modules outside `delegate.ts`
already imported them, which is the evidence they were a separate concern in the wrong file. `delegate.ts`
re-exports them so the split stays internal and no caller pays for a line count it did not cause.

**ADR-0025: `pi-token-audit` is deleted**, and the reasoning matters more than the deletion. **Not because it
lied.** G10 falsified its headline on 2026-08-10 and `5c593fb` fixed it hours later — the report has said
*"% of request CHARACTERS … not a token measurement"* ever since. Both red-team reviewers said otherwise, and
so did I, three times, from a stale line in `CLAUDE.md` (R-59). Deciding on that premise would have been
right by accident.

The real argument is the one R-59 demonstrated: **a second package in a single-product repository is a second
thing every orienting document must keep true**, and the cost showed up as a fixed defect being described as
live for four days in the file every reader and every reviewer starts from. What is kept is the *finding* —
G10 stays in `docs/probes/`, where a headline that survived review, reached the session log as a verified
fact and fed ADR-0006 before anyone noticed `promptTokens` cancels is one of this project's better pieces of
evidence. The code that produced it does not have to stay installed for the lesson to stay learned.

**Verified: 292 unit, 19 integration, 23 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.**

---

## 2026-08-14 (fourth) — the second red-team pass, over the four ADRs written that morning — 0.11.2

**Six more entries (R-53…R-58), all fixed the same session, and one of them shipped.** `architecture-critic`
and `product-strategist` reviewed ADR-0020–0023 and the R-38/R-46/R-51 work. Everything acted on was
reproduced by execution first.

**Found before dispatching, by re-reading my own change: the republish laundering hole.** `verifyInherited`
stopped a session *using* a stale-pinned approval, but `republishable` mapped over the RAW inherited keys and
re-stamped each with THIS session's digest — so a middle session that could not use an approval handed its
child a valid-looking one. ADR-0022's hole, inside ADR-0022's fix. That is the **second** time in two days a
fix has contained a smaller copy of the bug it fixed, and both were caught by asking *"where else does this
shape appear?"* rather than by tests.

**R-53, the one that shipped, and the pass ranked it first.** `planWithApprovals` re-plans with the
just-approved capabilities, and that literal carried **no digest** and **one scope for the whole set**:

- Unpinned: `verifyInherited` honours an entry with no pin *by decision* (`<delegate>` names no file; a
  pre-0.11 parent sends none), so every freshly-approved capability crossed to the child **exempt from
  ADR-0022** — false on exactly the approvals the ADR was written for. What hid it was **sort order**: both
  spellings were published and `parseInherited`'s last-write-wins let the pinned one survive. A security pin
  defended by lexicographic collation is not defended.
- One scope: `outcome.scope` was a single variable overwritten by the last capability answered, so approving
  A *once* and B *session* re-stamped A as `session` — ADR-0014's A-S1 reopened by a mixed answer.

The fix worth keeping is the third part. Attaching a digest at both call sites would have worked and would
have been the same bet that just lost, so **`inheritApprovals` now refuses to publish an unpinned entry for
any subject but `<delegate>`**. A caller that cannot produce a digest publishes nothing. Eight existing tests
failed on that change — their fixtures predated the pin — and each was updated rather than the rule relaxed.

**R-54 broke the one rule this package must never break by accident: governance is opt-in.** `resolve()` had
no `tool:*` coverage rule. `docs/SPEC.md` has always claimed the wildcard "satisfies any capability" and
`maySpawnDefinition` has always honoured it for definition ids — `resolve` disagreed with both. So with **no
`PI_GRANTS_GRANT` at all**, spawning a definition whose `allowed-tools` names `agent:worker` or
`skill:review` was refused as *"capability escalation blocked"* and recorded as an escalation attempt.
R-28's shape again: two spellings of one rule, and the enforcing one was wrong. ADR-0023 edited that exact
function and restated the false claim rather than noticing it.

**R-55: `agent:*` could not be handed down at all.** `unknownCapabilities` runs before `resolve` and the
catalog holds no wildcards, so ADR-0023's Decision was live only at the root. Wildcards are grammar, not
entries.

**R-56: `/grants ledger` manufactured an incident.** The R-51 listing shipped that morning compared digests
by **name only**, while `verifyLedger` had carried `source` all along — so two projects' same-named `deploy`
definitions read as one definition that had CHANGED, complete with the NOTE the code calls "the finding".
A diagnostic inventing an instruction change, in the one command ADR-0018 points an investigator at.

**R-57: the per-project filename was 24 bits** — and ADR-0020 deleted the `foreign-cwd` carry-through on the
premise that one file means one directory, so inside a collision R-41 returns with its mitigation gone.
Widened to 64.

**R-58: four documents described behaviour the code no longer had**, all introduced by the preceding two
days. The one this project's rules single out: `src/approval-store.ts` still said *"One file for all
projects"*, contradicted eight lines later in the same comment block. A register entry may describe what was
believed on its date; **a source comment describing present behaviour may not.** The README's opening
paragraph had also quietly re-acquired the unqualified claim a reviewer forced out of SPEC the day before.

**Two amendments to decisions, both from the strategist and both fair.** ADR-0020's revisit trigger said
*"any further defect traced to this layer"* — unfalsifiable, since every defect since would have tripped it
and none did. It is now two concrete conditions, either sufficient: **one** case of `entryVerdict` honouring
an approval it should have voided, or **two** M×M defects in that layer reaching a *released* version rather
than being caught in the session that introduced them. And ADR-0023 now records that it **shipped without
its exception**: `agent:*` makes `PI_GRANTS_GATED=agent:<name>` the only route back to per-definition
control, and R-47 is that gate being a silent no-op — so R-47's enforcement decision is no longer an
independent item.

**Cleared as sound**, which is worth as much: the republish fix, `parseInherited`/`verifyInherited`,
ADR-0021's deletion (and `sanitise`, which now has the test rule 7 requires), R-46's derived scalar, the
per-project layout, and — checked against pi's own plumbing — `cwd` canonicality, so trailing slashes and
symlinks are not reachable through the CLI.

**Verified: 287 unit, 19 integration, 23 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.**
Mutation-checked: stubbing the digest comparison fails the R-51 test alone; replacing `sanitise` with a
plain rewrite fails the ADR-0021 test alone.

---

## 2026-08-14 (later) — the queued work: the digest becomes readable, and the ledger stops over-claiming — 0.11.1

**Three fixes from the red-team pass that needed no decision.** None changes what the product claims; each
makes an existing claim true.

**R-51 — `definitionDigest` had no reader, so ADR-0018's promise was unkeepable.** That ADR advertises that
a record answers *"did these four children run the same instructions?"* and *"has this definition changed
since?"*, and `verifyLedger` never touched the field — both questions needed hand-written `jq`, and the
second was not even reproducible with `sha256sum`, because the digest covers the body and not the
frontmatter. `verifyLedger` now groups by `name`+`sha256`, and `/grants ledger` prints each version with its
spawn count and compares it against disk:

```
  instructions 2 distinct version(s) across the recorded spawns
    docs-writer  4f2a91c8b0d3  2 spawn(s)  — current
    docs-writer  000000000000  1 spawn(s)  — CHANGED since
    NOTE docs-writer ran under more than one version of its instructions in this ledger
```

The comparison uses **the same `snapshotOf` that voids an approval**, so this listing cannot disagree with
the enforcer about whether a definition changed — the R-28 discipline applied to a new diagnostic rather
than rediscovered by it later. Two rows under one name are called out explicitly, because that is the
finding, not a formatting quirk.

**R-46 — the ledger claimed a human was asked about capabilities they never saw.** `obtainApprovals`
returned one scalar `source` for a whole set, chosen as `scope ? "prompt" : sources[approved[0]]`. Gate
`tool:bash` and `tool:write`, let a persisted entry cover `bash` while a human clicks *Allow once* for
`write`, and the record read `approvalSource: "prompt"` for both. `resolveApprovals` had always computed the
per-capability map; the defect was that it was thrown away.

The fix keeps both fields and makes one a **derived summary of the other**: `approvalSources` always, and the
scalar only when every capability shares one source — omitted rather than guessed when they differ.
`buildRecord` derives it instead of accepting it, so no call site can supply a summary that disagrees with
the map beside it. Old lines stay readable; new ones cannot lie.

**R-47 — `PI_GRANTS_GATED=agent:deploy` is a gate that gates nothing**, because `gatedBlocked` filters
`requested` and a definition spawn's `requested` is its *ceiling*, which never contains `agent:<name>` —
ADR-0017's authorisation check is a separate, ungated branch. It *does* bite when a definition passes the id
down in its own `allowed-tools`, so the flag **half-works, which is worse than not working**. A startup
warning now names it, says a human is never asked, and points at what does work (withhold the capability
from `PI_GRANTS_GRANT`). **Making it enforce is deliberately left as a decision** — that is a behaviour
change. The silence was indefensible either way.

**Verified: 283 unit, 19 integration, 23 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.** The
R-51 test was confirmed to fail when the digest comparison is stubbed to `true`, and nothing else fails with
it.

---

## 2026-08-14 — four decisions from the red-team pass, implemented — 0.11.0

**The three open decisions and one config cliff from yesterday, answered by the user and shipped.** Four
ADRs (0020–0023), each recording the option that lost and what it would have bought. **Two are breaking.**

**ADR-0020 — one approval file per project.** The shared store could not express two checkouts holding an
approval for a same-named definition (`review`, `deploy` — the case that arises the moment an operator
reuses their own conventions), and every write touched every project's data, which is where R-41, R-42, R-43
and R-49 all came from. The obvious fix — nest by `cwd` inside one document — **lost**: it closes the
collision while leaving that shared read-modify-write intact, which is the bet that had already lost four
times. Per-project files make the collision *inexpressible*. Option 3, deleting persistence entirely, was
steelmanned properly: this file has produced **nine** recorded defects and ADR-0019 rejected deletion twelve
hours before most of that evidence existed. It lost because the cost lands on ADR-0012's default `bash`
gate, which is the one gate an operator never opted into and therefore the one most exposed to R-25 fatigue.
The old file is **ignored, not migrated**, and reported once — migration would be code that runs on exactly
one input per machine, inside the layer with nine defects.

**ADR-0021 — the task is never stored.** `taskAtApproval` is deleted rather than exempted, so
`ledger.ts`'s unqualified *"the task is not recorded, anywhere, ever"* is now true. The write path projects
every entry through a **whitelist of declared fields**, which closes the class instead of the instance: no
future field can reach disk by riding on a parsed object. Option 2 — show the pinned body digest instead —
lost on ordering: R-51 says nothing reads digests yet, so the line would have invited an operator to act on
a value no tool can help them with.

**ADR-0022 — an inherited approval names its instructions.** `PI_GRANTS_APPROVED` now publishes
`capability@subject#sha256` and the child verifies it against the definition **it** loaded. A republished key
carries *this* session's digest rather than the one it received, so a stale pin cannot travel another hop —
the hole this closes rather than moves. An unpinned entry is still honoured (`<delegate>` has no file to
hash; a pre-0.11 parent sends none), and that asymmetry with `entryVerdict` is deliberate and argued: a live
parent in the same tree is a much shorter chain to trust than a 30-day-old file. `key#` with nothing after it
is dropped rather than guessed at.

**ADR-0023 — `agent:*`.** The configuration *"may spawn any of our definitions, but never hand over
`write`"* was unexpressible, and the only workaround was `tool:*` — **the ergonomic option was the least
safe one on the menu**, which is R-25's shape. `agent:*` confers no tool authority. It is the **only**
wildcard rule in `resolve()` and is deliberately not generalised to `<ns>:*`, so a namespace added later
cannot silently acquire one. Prefix globs (`agent:review-*`) were rejected on ADR-0016's reasoning about
`Bash(git:*)`: a security control implemented by string-matching is wrong at the edges.

**Three implementation notes worth keeping.**

1. **`AGENT_WILDCARD` lives in `resolve.ts`, not beside `WILDCARD` in `pi-tools.ts`** — because `resolve.ts`
   has *no imports at all* and `pi-tools.ts` imports `Capability` from it, so the obvious placement would
   have made the dependency circular. Worth preserving: the one module where an escalation could be
   introduced is the one whose behaviour is fully determined by its arguments.
2. **Two unit tests written yesterday had to be re-targeted**, not deleted. They pinned the `foreign-cwd`
   carry-through that 0.10.2 needed and ADR-0020 removes; the property they were really about — one
   project's approvals cannot affect another's — is now asserted against the layout instead of the logic.
3. **A regex ate its own helper.** A bulk edit rewriting `writeFile(approvalsPath(cwd), …)` into
   `stage(cwd, …)` also rewrote the body of `stage` itself, giving it an infinite recursion that hung
   `npm test` with no output. Read what a bulk edit matched before running the suite on it.

**Verified: 282 unit, 17 integration, 21 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.** The
model-tier lifecycle — dialog, write, reload in a different process with no prompt, void by body edit — was
re-run against the new per-project store and passes unchanged.

---

## 2026-08-13 (last) — the red-team pass, and what one pair of eyes had missed — 0.10.2

**The caution at the top of this file said a review of ADR-0017/0018/0019 was probably worth more than the
next feature. It was.** `architecture-critic` and `product-strategist` ran against the three ADRs and the
R-38 fix. Thirteen risk entries (R-39…R-51), six fixed the same session, and **both reviewers independently
found the same one** (R-44), which is usually the sign a finding is real.

**Every finding acted on was reproduced by execution before it was written down** — and two turned out
*worse* than reported, which is the argument for that rule rather than a restatement of it.

**The one that shipped: R-39.** `delegate`'s `agent` parameter description was computed at registration
time, which is synchronous in the extension factory — before the `session_start` hook that loads the
definitions. So the map was always empty and **every model in every governed session read
`Available: none.`** It then did the reasonable thing and used `delegate({tools})`: no operator-authored
instructions, no `agent:` prerequisite, no body digest on the record, and permanently denied `always`.
**ADR-0017 and ADR-0019 were both dead machinery in exactly the way ADR-0019 was written to prevent** —
every dialog was a `<delegate>` dialog again, which is the prompt fatigue that argument turned on. The
comment on the line reasoned carefully about grant staleness and never noticed the map was empty.

Fixing it needed a fact nobody here had: **pi serialises a tool's schema at request time, not at
registration.** Measured with a throwaway probe that rewrote a parameter description in `session_start` and
read it back out of `before_provider_request`'s payload — `AFTER_SESSION_START` arrives at the provider. So
`refreshSpawnable()` is called from both hooks, writing through the *constructed* schema because
`Type.Optional` shallow-copies its input.

**The one that was destroying data: R-40.** `approvalsPath(_cwd?)` ignored its argument — a vestige of the
pre-ADR-0014 in-workspace store — so the unit suite passed a `mkdtemp` directory, believed it was hermetic,
and **rewrote and cleared the developer's real `~/.pi/agent/grants-approvals.json` on every `npm test`.**
Confirmed by looking: the file contained this suite's fixture, `cwd: /tmp/grants-approvals-oFhqs6`, with a
body digest of sixty-four zeroes. Latent while nothing could write the store; destructive from the moment
ADR-0019 made it reachable — and this very log had applied that reasoning to the *integration* suite the
same morning without carrying it back to the unit suite. The parameter is now gone entirely, so the mistake
is unspellable rather than merely fixed.

**Two findings that were worse than the report.** R-41: approving in project B does not merely ignore
project A's approval, it **deletes it from the file** — and, not in the report at all, the storage key is
`capability@subject` with no project component, so two checkouts with a same-named definition (`review`,
`deploy` — the common case) **cannot both hold an approval**. The pruning half is fixed; the keyspace needs a
format decision. R-42: the atomic-write temp file was named per *process*, so two concurrent
`saveApproval` calls unlinked each other's temp and **both returned failure having written nothing** —
measured with two *different* keys, so never limited to the shared-dialog case the finding described. That is
`delegate_all`, i.e. `always` failing precisely in the case ADR-0019 says drives adoption.

**Also fixed:** R-43 (`/grants revoke --all` revoked every project on the machine) and R-48 (`/grants`
truncated its verdict list at 12 in silence, dropping the *global* definitions first).

**Open, and needing decisions rather than patches:** R-41's keyspace, R-44 (the model-authored task is
written to disk and printed back, which `src/ledger.ts` forbids in unqualified terms — *"not recorded,
anywhere, ever"*), R-45 (the body pin is enforced on the persisted path and on neither the session nor the
inherited one), R-46 (one `approvalSource` for a mixed set, so the ledger can claim a human was asked when
they were not), R-47 (`PI_GRANTS_GATED=agent:x` is a silent no-op), R-49, R-50, R-51.

**Two things the reviewers cleared, which is worth as much.** The `ctx: null` preview added this morning has
no side effects — it returns before the gate is built, so it never touches the single-flight queue, session
approvals, `publishChildEnv` or `process.env`, and its only I/O is one read. And R-29's `once` fix still
holds now that the approval subject varies per definition.

**A process note worth keeping.** A model-tier run failed mid-pass and it was not a defect: source was
edited *while* the run was live, and a two-step edit left `grants-command.ts` briefly referencing a constant
declared later. Every `/grants` spawned in that window produced no verdict lines. **Do not edit the tree
while an integration run is in flight** — the failure looks exactly like a real regression.

**Verified: 276 unit, 17 integration, 21 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.** The
mutation checks are recorded with each fix: removing `refreshSpawnable()` fails the R-39 test and nothing
else; the store's real file is byte-identical across a full `npm test`.

---

## 2026-08-13 (sixth) — the README caught up with four versions of the product

**The largest purely-mechanical job left, and it was not entirely mechanical.** `packages/pi-daddy/README.md`
still described the deleted pi-subagents interceptor as a provisioning path, and its own 0.7.0 banner said so
— which is a reasonable thing to write once and a bad thing to leave standing for three more releases.
Rewritten against the code, 626 → ~656 lines.

**Four generations of staleness, and two of them were actively dangerous to a reader:**

1. **§"What an agent type's ceiling actually is"** documented the pi-subagents frontmatter rules, whose
   central case is **inverted** in this product: there an absent `tools:` key meant pi's full default
   toolset, here an absent `allowed-tools` means *undeclared, therefore not spawnable*. An operator
   following the old table would have believed a declaration-free definition was the powerful one. Replaced
   by a `SKILL.md` ceiling table, with the inversion and the pattern refusal (`Bash(git:*)`) called out as
   the two load-bearing rows.
2. **§Approving a gated capability** said *"`always` is offered only on the interceptor path"* — the exact
   sentence ADR-0019 falsified — and, three paragraphs below its own 0.6.0 banner saying the store had moved
   out of the workspace, still said persisted approvals live in `.pi/grants-approvals.json`. A document that
   contradicts itself within one section is worse than one that is merely out of date.
3. **§"Enforce, not provision — the interceptor's limit"** and **§"Verified live against real agent types"**
   described code that no longer exists. Deleted rather than annotated; the probes hold that history, and
   `docs/probes/approval-ux` is now explicitly labelled in the README as a record of an interceptor run
   rather than a description of this version.
4. **Two test sections disagreed with each other** (149 vs 222 unit tests, both wrong) and the status header
   said 0.6.0. Collapsed into one, now 272 / 17 / +4.

**Two gaps found while writing, which is the usual return on doing this properly.**
`PI_GRANTS_APPROVAL_TIMEOUT` was **undocumented everywhere** — not in the README, not in `docs/SPEC.md` —
despite deciding how long a governance dialog waits and having a deliberate `0` ⇒ *no timeout* reading. And
`PI_CODING_AGENT_DIR` decides where persisted approvals live, which the new integration suite depends on and
neither document mentioned. Both are now in both tables.

**The one claim that needed a test rather than a proofread.** The README shows a `/grants` line reading
`allow  deploy  tool:bash, tool:read  (tool:bash approved: persisted)`. Documented output drifts, so the
preview test now asserts that annotation and says in its message that it pins the README example. Everything
else quoted from the code was checked against the source it came from — the undeclared-definition refusal,
the planned argv (which gained `--no-skills`, `--no-context-files` and `--no-prompt-templates` since the old
sample was written), `MAX_CHILDREN_PER_CALL`, `STALE_LOCK_MS`, `skillDirs`, and `allowUniversal` still
existing.

The root `README.md` had the same class of drift in three numbers and one ADR count; fixed in the same pass.

**Verified: 272 unit, 17 integration, typecheck clean.** No behaviour changed except the one new assertion.

---

## 2026-08-13 (fifth) — the approval store, watched working — and R-38 found doing it — 0.10.1

**The one job in the last session's table that needed no decision, only a real run.** ADR-0019 had made the
persisted-approval store reachable for the first time since 0.7.0, with every branch of `entryVerdict`
unit-tested and **nobody having watched the thing work**. It now works, observed:
`test-integration/approval.it.ts`, 7 model-free tests plus one model-driven lifecycle.

**What the model tier actually observed**, in one test and in this order: a real model called
`delegate({agent: "bash-user"})`; the dialog was raised with the **definition** as its subject and *Always
allow in this project (30 days)* on offer — the option no version between 0.7.0 and 0.9.0 could display;
the entry landed in `$PI_CODING_AGENT_DIR/grants-approvals.json` pinning both the ceiling and the body
digest; the ledger recorded `approvalScope: "always"`, `approvalSource: "prompt"`; a **different pi process**
then ran the same delegation with **zero dialogs** and a ledger line reading `approvalSource: "persisted"`;
and after rewriting the body — frontmatter byte-identical, so only ADR-0018's digest can catch it — the
dialog was raised again and the dismissed delegation failed. First run, no flakes.

**`PI_CODING_AGENT_DIR` is set on every test in the file, and that is not hygiene.** `approvalsPath`
defaults to `~/.pi/agent/grants-approvals.json` (ADR-0014 moved it out of the governed workspace), so
without the override this suite would read *and write the developer's own approvals*. The harness sanitises
`PI_GRANTS_*` and nothing else, which is exactly right and exactly why this needed saying out loud.

**R-38, found by writing the free tier.** One test seeded a valid entry and asked the same session two
questions. `/grants approvals` said `1 persisted approval`; `/grants` said
`BLOCK  bash-user — tool:bash requires explicit approval`. A real spawn would have proceeded. The cause is
**R-28's shape one layer up**: `/grants` ran the real `planDelegation` — which is why the file claims a
diagnostic cannot disagree with the enforcer — but enforcement is *plan → gate → approvals → re-plan*, and
`planDelegation` knows nothing about approvals by design. **Sharing the function while not sharing the
sequence** left the two free to disagree again.

Fixed by making the sequence the shared thing: `planWithApprovals` in `extensions/run-delegation.ts`, used
by the enforcer and by `/grants`, differing in one argument. `ctx: null` means *preview* — stored approvals
count exactly as they would for a spawn, and no human is asked.

**The rejected way of expressing that is the interesting part.** `hasUI: false` was the obvious lever and it
is a *different fact*: it means "there is nobody here to ask", which is true in every governed child, and it
replaces the plan's reason with advice about pre-approving in an interactive session. Using it would have
turned every gated definition's `BLOCK` line into a message about interactive sessions — and an existing
integration test asserting `tool:write requires explicit approval` would have caught it. Two different
absences of a human, kept distinguishable.

The listing also now says **why** it allows: `allow  bash-user  tool:bash, tool:read  (tool:bash approved:
persisted)`. An `allow` that silently depends on a 30-day entry in a file in the home directory is the thing
an operator ran `/grants` to discover.

**Three mutations were run to prove the new tests can fail** (rule 7, applied rather than asserted). Making
an unpinned entry fail *open* — `entry.bodyAtApproval && entry.bodyAtApproval !== current` — fails exactly
the fail-closed test and nothing else. Deleting the body comparison outright fails three. The preview test
had already failed against the shipped code before the fix, which is how R-38 was found.

Also folded in: `DelegationToolContext` now extends `ApprovalUIContext` instead of being passed through an
`as never`, and three dead imports left over from the `grants.ts` split are gone. `CLAUDE.md`'s state line
had been stale since 0.7.0 (three versions and three ADRs) and is current again.

**Verified: 272 unit, 17 integration, 21 with `PI_GRANTS_IT_MODEL=1`, typecheck clean, smoke clean.** The
model tier was re-run over the *whole* suite after the refactor, deliberately: the enforcement path changed,
and the model tests are the only thing that watches it end to end.

---

## 2026-08-13 (fourth) — ADR-0019: the persisted-approval store was unreachable — 0.10.0

**Found by grepping for call sites instead of trusting a reading.** R-37 was filed saying `always`
approvals *downgrade* on the delegate path. Wrong, and the correction is the useful part: `always` was
**never offered**. `offeredScopes` gated it on the path literal `"interceptor"`, and ADR-0016 deleted the
only caller that passed it. **No version since 0.7.0 could create a persisted approval at all** — so
`approval-store.ts` (220 lines), `entryVerdict`'s confused-deputy check, ADR-0014's atomic-write /
symlink-refusal / foreign-`cwd` work, and `/grants approvals|revoke` were all guarding a file nothing could
write. `docs/SPEC.md` said `always` was available *"on paths with a human-authored subject"*: true, and
misleading, in one sentence.

The user chose to make it reachable over deleting it (the steelmanned option — this project's best moves
have been deletions, and 220 lines of mutable on-disk state is its largest surface). The argument that
carried: `agent:` was three lines of decoration when R-35 faced the same choice, whereas this is working,
well-tested code implementing a property that was hard to get right, and what it buys is specifically the
survival of ADR-0012's default `bash` gate. A gate switched off by prompt fatigue is worse than one never
claimed.

**What shipped.** `delegate({agent: X})` approves against **X** on a new `"definition"` path that offers
`always`; `delegate({tools})` keeps `<delegate>` and keeps being denied it, because there the original
reasoning is untouched. A persisted entry pins the ceiling **and** ADR-0018's body digest, so rewriting a
definition's instructions voids it (`instructions-changed`) — strictly stronger than ADR-0010 designed,
since `ceilingForDefinition` reads only `allowed-tools` and could never have seen a body change. An entry
with no body pin fails closed: unverifiable is not unchanged. `CeilingLookup` became one `SubjectLookup`
returning `{ceiling, bodySha256}`, because two parallel callbacks is R-28's shape waiting to happen.

**The line-cap test caught its own author.** Adding this pushed `extensions/delegation.ts` to 403 lines and
`test/file-size.test.ts` — added this morning — failed. Raising the cap the day after writing it would have
neutered the guard, so the file was split as the failure message instructed: `run-delegation.ts` (what a
delegation *does*, 223 lines) and `delegation.ts` (how pi is *told* about it, 198). That is the guard
working exactly as designed, on the person who installed it.

**Verification was interrupted and is worth recording.** The Bash tool was unavailable for a stretch mid-task
(an unrelated outage), so the code sat fully edited and completely unverified. Nothing was committed and no
"fixed" note was written during that window — a claim of green with no run behind it is exactly what rule 5
exists to prevent. Everything below was run afterwards: **272 unit + 10 integration**, typecheck clean,
smoke clean.

---

## 2026-08-13 (third) — ADR-0018: the ledger records *which* instructions ran — 0.9.0

**R-35's audit half, closed as far as it can honestly be closed.** Every spawn naming a definition now
records `definitionDigest: {name, source, sha256}` over the body — the exact text passed as
`--append-system-prompt`.

**The binding constraint was already written down, at the top of `src/ledger.ts`:** *capability ids, counts
and identifiers only — never prompts, tool arguments or results.* That rule sorted the options by itself.
Two texts direct a governed child and they fall on opposite sides of it: the **body** is operator-authored,
already committed to a repository, and a hash of it is an *identifier*; the **task** is assembled by the
model from the parent's context and could carry anything the parent could see. So the body is digested and
**the task is never recorded, in any field, by decision** — the privacy rule now says so outright instead of
leaving it to be inferred.

The user declined the body **snapshot** (Option 2). The argument that carried: the ledger write path is a
fail-closed governance dependency, and doubling what can break it would mean either a full disk stops
governance or a record claims a snapshot that may not exist. The digest is the addressing scheme a snapshot
store would need anyway, so nothing is foreclosed.

**Three implementation details worth keeping.**

1. **The digest is over the body alone**, not the frontmatter — otherwise rewording `description` would
   report an instruction change that never happened. Pinned by a test that does exactly that.
2. **It is assigned into `empty`**, the object every refusal spreads, so it appears on every outcome from
   the point the file is read. That is the R-28 discipline applied to a record field: one spelling instead
   of eight that a ninth return could forget. The success return does not spread `empty`, so it names it.
3. **An ADR-0017 authorisation refusal carries NO digest** — deliberate, and the ordering is the reason. A
   caller who was never allowed to spawn the definition learns nothing about it, not even its hash.

**The test that matters is the ledger-file one**, not the plan one: the recurring defect here is a correct
value on the plan that the call site never passes to `buildRecord` (R-28, B-I3). It stages a `SKILL.md`
declaring a sub-tool pattern, so the plan is refused *after* the file is read and nothing spawns — then
reads the real JSONL line back. **Verified it can fail** by deleting `definitionDigest: plan.definitionDigest`
from `delegation.ts`; it does, and nothing else does. It also asserts a task sentinel is absent from the
line.

**R-37, found while scoping and recorded rather than fixed.** ADR-0017 falsified the premise behind the
fixed `<delegate>` approval subject — *"the only things naming a child are the task and the tool list, both
model-chosen"* — because a definition is now an operator-authored, capability-authorised subject. The
consequence is fail-closed (`ceilingOf("<delegate>")` is `null`, so `always` silently downgrades to
`session`) but it leaves ADR-0010's persisted-approval machinery **dormant on the only spawn path**, and
prompt fatigue is what gets gating switched off — R-25's shape. It is now the top open item.

268 unit + 10 integration, typecheck clean, smoke clean.

---

## 2026-08-13 (second) — ADR-0017: `agent:<name>` authorises a definition — 0.8.0

**R-35 closed as far as a capability model can close it, and R-36 found on the way.** The user chose Option
A (prerequisite) over the steelmanned Option B (delete the namespace). Shipped in two steps, in that order,
because step 2 does not work without step 1.

**Step 1 — R-36, found by measurement while scoping the ADR.** `deriveOwnGrant` filtered the inherited grant
against the session's *observed tool names*, and the matcher only ever matched `tool:` and `ext:` — so every
other namespace was dropped at the first provider request:

```
inherited      : tool:read, skill:review, agent:reviewer, ext:pkg/web_search
after  observe : ext:pkg/web_search, tool:read
```

**Live for `skill:` since R-32**: the child received the skill (it arrives as `--skill`) but could not
re-grant it, and `/grants` stopped listing something it held. Fail-closed, which is why it survived —
nothing fails when a grant quietly shrinks. It also made the `agent:` prerequisite unsatisfiable below the
root. Now only tool-shaped capabilities are filtered, in both the enumerated and wildcard branches.

**Step 2 — the prerequisite.** Spawning definition `X` requires holding `agent:X`; `tool:*` satisfies any of
them, because `resolve()` has **no wildcard rule** (a wildcard session works only because `deriveOwnGrant`
*enumerates* its observed tools, and definitions are not tools) — without that special case an **ungoverned**
session would have stopped being able to spawn, breaking "governance is opt-in".

Three details worth keeping:

1. **The refusal is a `denied`, not a bare reason.** `denied` is the escalation signal ADR-0008 designates,
   and asking to run a definition this session was not granted *is* an attempt to exceed the grant. A
   refusal leaving it empty would be invisible to every audit query.
2. **Authorisation is decided before anything is said about the file** — reporting "declares no
   `allowed-tools`" to a caller who was never allowed to spawn it discloses the definition and misnames the
   problem. Pinned by a test.
3. **It attenuates for free.** `ceilingForDefinition` already parsed `agent:` entries inside `allowed-tools`,
   so an operator writes a delegator's spawn rights in the same file as its tools, and `resolve()` already
   refuses to hand down one the parent lacks. Evidence the design anticipated this.

`delegate`'s tool description now lists only the definitions the session may actually spawn — listing all of
them would tell the model it can spawn things every attempt at which is refused, which is R-28's shape (a
description disagreeing with the enforcer).

**Breaking, and the breakage was visible in the suite**: five unit tests and four *integration* tests failed
until their enumerated grants gained `agent:` ids — the integration failures being the proof the rule bites
on the real path. **262 unit + 10 integration** (the extra one asserts the refusal end-to-end through
`/grants`), typecheck clean, smoke clean. `docs/SPEC.md`, the README banner and the quick-start grant all
updated; the README's deeper sections remain stale as before.

**Found and NOT fixed:** an `allowed-tools` entry written as `tool:read` becomes `tool:tool:read` — only
`ext:`, `skill:` and `agent:` pass through as written. It fails loudly (the catalog refuses it as unknown)
but the message names the mangled id rather than the mistake. Recorded in SPEC's known gaps rather than
fixed, because no ADR covers changing definition parsing and drifting into it during an unrelated change is
how the record stops matching the code.

---

## 2026-08-13 (first) — `extensions/grants.ts` split, and the ceiling made enforceable

**Behaviour-preserving by construction, and checked that way.** Baseline recorded first (250 unit + 9
integration, typecheck clean), then the file was cut apart and the same suites rerun. Nothing in `src/`
changed, `docs/SPEC.md` needed no edit, and no ADR was required: the product claims exactly what it
claimed yesterday.

| file | lines | holds |
| :--- | ---: | :--- |
| `extensions/grants.ts` | 202 | the pi surface only — three hooks, the tripwire, four registrations |
| `extensions/delegation.ts` | 381 | `runOneDelegation` and both tool registrations |
| `extensions/session.ts` | 228 | `createGrantsSession()`: env parsing, mutable state, `delegationContext`, `publishChildEnv` |
| `extensions/approvals.ts` | 193 | `obtainApprovals`, `republishable`, `ceilingOf` |
| `extensions/grants-command.ts` | 164 | `/grants`, unchanged |

**Every module takes the session as an explicit argument.** That is the point, not the line count. All four
wiring defects this package has had — the G7 `NaN` bound, the discarded `isError`, the unconditionally
registered `delegate` (S-5), R-28's omitted argument — were defects of *scope*: a value that was whatever
happened to be in the closure at one call site. Configuration on the session is `readonly`; the six fields
that genuinely change (`ownGrant`, `observed`, `observedTools`, `definitions`, `catalog`, `catalogReady`,
plus `cwd`) are read live **through the object**, because a copy of `ownGrant` taken at load time is a copy
taken before the tool surface is observed.

**Three things fell out of the split, all small, all deliberate.**

1. **`extensionCapabilities` was dead and is deleted** — ~28 lines whose only consumer was the interceptor
   ceiling ADR-0016 removed. It was still being maintained as if live. The fact its comment recorded is in
   `CLAUDE.md`; a dated note on R-28 records where its builder lives now.
2. **`GrantsCommandContext.inheritedApprovals` was typed `Map<string, InheritableApproval>`; it is a
   `Set<string>`.** Harmless only because the handler takes `ctx: any` and reads nothing but `.size` —
   i.e. it was caught by moving the value through a typed parameter, which is the argument for doing that.
3. **`createGrantsSession` takes no `pi`** (the log's sketch said it would) — with `extensionCapabilities`
   gone nothing in the session touches `pi`. `extensionPath` is passed *in*, because it must name the file
   pi loads as the extension and only `grants.ts` can say that about itself.

**`test/file-size.test.ts` (251st test) caps `src/` and `extensions/` at 400 lines.** Rule 7 satisfied: the
production change that breaks it is folding any of these back together, and it was verified by lowering the
bound to 200 and watching it fail with the offending files named. Tests are exempt — a long test file is
many small independent cases, not the failure mode being prevented.

**What it does not establish:** that the wiring is *correct*, only that it is unchanged. The 251 unit tests
still touch `extensions/` at only one point (`delegate-all-wiring.test.ts`); `session.ts` and `approvals.ts`
have no direct unit coverage, and the argument-list class of defect is now spread over three files instead
of hidden in one. The integration suite against real pi remains the check that actually exercises them.

---

## 2026-08-12 — a shipped enforcement defect, found by red-teaming a strategy question

**What the session was for:** the user asked whether the product could drop `pi-subagents` and rely on
"our library + pi". A `/brainstorm` over five options was stress-tested by the strategist and the
architecture critic. **The critic found a live defect that outranked the question it was asked.**

**R-28 — the `tool_call` hook reached a correct pure function through a wrong argument list.** Confirmed
by execution before it was written down, then fixed: one `decisionContext()` builder, four new tests in
`test/interceptor-wiring.test.ts` (the first unit coverage `extensions/grants.ts` has had), checked by
reintroducing the defect. **226 unit + 8 integration pass; typecheck clean.**

**Two lessons worth keeping.**

1. **A pure-core / thin-wiring design moves the bugs into the wiring.** `decideSpawn` and `ceilingFor`
   were correct and well covered — `agent-types-fidelity.test.ts:93` already pinned that an omitted
   `extensionTools` yields the wildcard. 226 tests could not see this because **the defect was in the
   argument list, and nothing tested the argument list.** Three reviewers had independently flagged
   `extensions/grants.ts` as the file with no unit coverage; that flag was correct and under-acted-on.
2. **This defect had been found and fixed once before, on `/grants` only** (see the comment on
   `extensionCapabilities`). Repairing the symptom at the call site that revealed it, rather than the
   shared call, is what let it survive on the enforcement path for two releases. The fix here is
   deliberately structural — the argument is now spelled in exactly one place.

**And it contaminated the question being asked.** ADR-0013 preferred the interceptor because `Agent` was
used 25× against `delegate`'s 0. Those calls cannot have passed a governed enumerated session while this
defect stood, so the number measures the **ungoverned** case. ADR-0015 therefore **declines to decide**
and asks for the measurement instead — the same failure mode as the original token-economics thesis
(ADR-0007), caught earlier this time.

**Re-measured, because prior probes were stale:** `@tintinweb/pi-subagents` is **0.15.0** (probes used
0.14.3) and pi is **0.84.1** (probes record 0.83.0). The proposal's core claims survive — still no
`tools` on `SpawnOptions` or `Agent`, RPC still `ping`/`spawn`/`stop`, children still in-process — but
its "unknown types get all tools" argument was answered upstream by `fallbackSubagent: "none"` (#183).
Recorded as R-31, with a differential test proposed as the missing tripwire.

**New to the landscape: herdr.** Panes are separate CLI processes, so `--tools` bites — the first spawn
mechanism other than our own where it does. The third-party `@andrewjacop/pi-herdr` is *not* the way in
(R-30: model-controlled `agentArgs` and `env`); speaking herdr's own CLI so **we** build the argv is
Option G in ADR-0015, and it would make herdr the child registry, answering most of the critic's
lifecycle objections to background delegation.

**Also recorded:** R-29 (one *Allow once* → N concurrent authorisations, confirmed by probe; latent
because `delegate` blocks, and a hard precondition for fan-out).

---

## 2026-08-12 (later) — re-architected: ADR-0016, and 0.7.0

The user's direction, given twice: **drop pi-subagents and every third-party pi extension**; build on pi
core + this package + their own `principal-pi-skills`, with **herdr as a hard requirement**; and prefer a
**widely adopted standard** for definitions. ADR-0016 records it. What shipped:

**Definitions are Agent Skills (`SKILL.md`).** `allowed-tools` is the grant, the body is the child's system
prompt. **The inversion is the whole point:** in pi-subagents' format an absent `tools:` meant *pi's full
default toolset*, so an undeclared definition was the most powerful kind and any parse failure produced a
wildcard — the direction that caused R-28 and review finding F18. Here absent means **not spawnable**, and
there is **no unknown-name fallback** (pi-subagents resolved an unknown type to `general-purpose` = every
tool, which is how a typo could grant everything).

**The port is deleted.** `src/agent-types.ts` and `src/interceptor.ts` are gone with three test files.
**R-31 is retired by deletion rather than mitigation** — its proposed devDependency pin and differential
fidelity test were never built and are no longer needed. The `tool_call` hook survives as a **tripwire**
that refuses third-party spawn tools and says plainly that it is not a boundary.

**Two behaviour changes fell out of that deletion, both deliberate.** The catalog now seeds pi's built-ins
unconditionally, because `/grants` runs before any provider request and an observation-only catalog made
every capability look "unknown" — **R-28's shape through a different door**. And `/grants` now runs the real
planner through the same context builder `delegate` uses, so a diagnostic that disagrees with the enforcer
is not expressible.

**Four tests were re-targeted rather than deleted, one deleted as redundant.** The properties survived even
though the code they exercised did not. The ADR-0011 Finding 1 test was **narrowed on purpose**: it
described a defect in `decideSpawn`'s wildcard shortcut, which no longer exists.

**`runHerdrPane` — and it failed four times end to end before it worked.** Each failure was a fact the probe
had not established, all four now encoded with tests (`docs/probes/g16-herdr` addendum): `--print` is
incompatible with an interactive agent; herdr **cannot pass a multi-line argument**, so a definition body is
staged to a file; a fresh pane is not yet at a shell prompt; and `agent read` returns **raw text, not the
JSON envelope** every other command uses. **The lesson from the last one is the one worth carrying** — the
unit fake had been written to the envelope shape, so *it agreed with the bug*. A test written from an
assumption tests the assumption.

**Bounded synchronous fan-out.** `delegate_all` runs N children concurrently; verified with three reviewer
definitions in 10.8s against ~30s sequential, each holding exactly what its own `allowed-tools` declared.
**No background mode by design** — fan-out carries most of the value, background carries nearly all the
lifecycle holes. ADR-0008 gained a **cardinality companion** (a subtree budget) and real **sibling ids**;
both gaps existed because a blocking `delegate` bounded cardinality to one *by accident*.

**Ledger integrity (R-34).** Nothing in this package had ever read a ledger back, so a torn line was
indistinguishable from a spawn that never happened. `verifyLedger` + `/grants ledger` now report it; a
corrupt line is **reported, never repaired**. Concurrent appends are serialised by a lock file with a short
timeout and stale-lock breaking.

**Released 0.7.0.** The `exports` map still pointed at the two deleted modules — a failure that would have
appeared **only on a consumer's machine**, since unit tests, typecheck and integration all passed. The smoke
test now exercises every subpath.

**Docs consolidated.** `docs/SPEC.md` is the new current-state document; ~4,700 lines of superseded material
moved to `docs/archive/` with a README explaining why each stopped being current. **Writing the spec found
R-35**: stating the guarantee precisely exposed that `agent:` capabilities enforce nothing, so a definition's
*instructions* are ungoverned — the capability model governs what a child can do, never what it is told to
do.

---

## 2026-08-10 (later) — ADR-0011 implemented, live-verified, and shipped as `pi-daddy` 0.5.0

**ADR-0011 is done and merged.** All three decided changes are implemented (`e8b0fef`), **155 tests
passing**, and — new — **verified live against real pi**: `docs/probes/adr-0011-universal`. The entry below
still says "Not yet implemented"; that was true when it was written and is left standing, as this register
always does.

**This is a breaking change, so the package is `0.5.0`.** Two spawns that succeeded in 0.4.0 now fail: an
agent type declaring a universal capability is refused on **both** paths, and a wildcard-holding delegator
no longer bypasses a configured gate. The README carries a *"0.5.0 is a breaking change"* section.

### What the live run proved, and what it found

Confirmed in a real pi process with real agent-type files, the driver **armed with `Allow once`** so that
"no dialog appeared" is falsifiable rather than merely unobserved:

- Wildcard delegator + agent type declaring `fabric_exec` → refused (was allowed in 0.4.0).
- Enumerated grant holding `fabric_exec` + same type → refused (was *silently passed through* in 0.4.0).
- Wildcard delegator + gated capability, real model-driven spawn → refused, ledger correct (the gate did
  **nothing** in 0.4.0).
- No approval dialog for any doomed spawn; no `approvalSource`/`humanDenied` in any ledger line.

**One new finding, needing a decision (probe Finding 1).** A wildcard delegator is now refused with
*"requires approval for tool:write"* while **no dialog is ever offered** — the wildcard branch returns
before a `ResolveResult` exists, and `shouldSeekApproval(undefined)` is `false`. It fails closed, but it is
the very defect ADR-0011 deliberately removed from `planDelegation`, reintroduced on the other path by the
same change. Two fixes are plausible (make the path prompt; or make the message honest) and **both are
design decisions, so neither was taken.** Recorded in ADR-0011 under *Open, from live verification*.

**Scenario 2's evidence is weaker than the others and says so.** The enumerated-path universal branch was
read from `/grants` inside a real pi process, not from a completed spawn: `deriveOwnGrant` strips
`fabric_exec` from a session that never observed it, so the escalation check fires first. Reaching it
end-to-end needs `npm:pi-fabric` installed, which this machine does not have.

### A citation that looked dangling and was not

ADR-0011 cites `docs/archive/reviews/2026-08-10-aggregated-findings.md` (findings A-S2 / B-C5). From the
`adr-0011-universal-capabilities` branch that file was absent — `docs/archive/reviews/` was committed to `main`
*after* the branch was cut — so it read as a reference to a document that had never been written, and was
briefly recorded here as one. **It was not**: the file is real, and the citation resolves from `main` after
the merge. A note in the ADR records the confusion rather than erasing it.

**The lesson worth keeping is about branch-local verification.** "The file does not exist" was concluded
from searches run inside a worktree that could not have contained it. A cross-branch check
(`git log --all -- <path>`) would have settled it in one command.

### 2026-08-11 — all three ADRs decided AND implemented; `pi-daddy` 0.6.0

**ADR-0012, ADR-0013 and ADR-0014 are accepted, implemented and committed.** 222 unit + 8 integration + 3
model-driven tests passing, typecheck clean across `src` + `extensions` + `test` + `test-integration`.

| ADR | Decided | Built |
| :--- | :--- | :--- |
| **0012 `bash`** | Threat model is *cooperative but fallible, **with prompt injection in scope*** — which is why "document it" was not enough: a prompt-injected agent holding `bash` **is** the adversarial case. | Gating closed under subsumption (gating `write` gates `bash`; the **direction** is tested both ways so it cannot invert). `bash` gated by default in a **governed** session only. README guarantee rewritten: it governs the **tool surface**, not the agent. |
| **0013 `pi-subagents`** | Govern it properly — decided on **usage**: `Agent` 25 times including that day, `delegate` **zero** outside probes. | Ceiling ported rule-for-rule from 0.14.3. |
| **0014 approvals** | Relocate the trust root; thread scope + subject. | Store moved to `$PI_CODING_AGENT_DIR`; legacy file **ignored and reported**, never migrated; `capability@subject` pairs; `once` stops at the boundary; atomic no-follow writes. |

**The port dragged review finding S-5 into the open.** `delegate` was registered **unconditionally**
despite a comment claiming otherwise, so "withhold `tool:delegate` and the child is a leaf" was untrue.
Invisible until ceilings honestly included inherited extension tools — at which point *every* agent type
"required tool:delegate", a correct reading of an incorrect situation, since in-process children really do
inherit our tool registry. Now conditional.

**One test had to be re-targeted rather than updated.** "A review-level child cannot re-spawn debug" tested
wildcard re-acquisition through a type that is no longer wildcard — and `review` holds `bash`, which
subsumes every built-in including `edit-diff`, so that spawn is now **legitimately allowed**. The wildcard
property is retested against an unknown type, and *a grant containing `bash` already confers all of these*
is pinned in its own test. That is R-25 made visible instead of hidden behind a wildcard ceiling.

**ADR-0013's other half is not ours to finish.** Measured: the live registry is unreachable by import
(different module instance), the supported RPC is `ping`/`spawn`/`stop` with no config query, and
`SpawnOptions` has no `tools` field — so **refuse-or-allow is a hard ceiling on that path**.
`docs/archive/proposals/pi-subagents-tools-parameter.md` is drafted **for the user to file**.

**Finding 6, still open and not addressable locally:** `subagents:rpc:spawn` bypasses the interceptor
entirely — event bus straight to `manager.spawn()`, no `tool_call` — so any other loaded extension can
spawn an ungoverned sub-agent. Adding names to `SPAWN_TOOLS` cannot catch it.

### G11 closed — and it found a defect on its first run

**`npm run test:integration`** now drives a real pi process with the extension loaded: **8 tests, ~17s, no
model tokens**, plus **3 opt-in end-to-end tests** (`PI_GRANTS_IT_MODEL=1`) with a real model calling real
tools. `npm test` stays fast and pi-free, as decided on 2026-08-10.

The default tier drives the `/grants` command, whose handler runs the real decision function over real
agent-type files — so the whole wiring (env parsing, agent-type loading, `publishChildEnv`, `decideSpawn`)
is exercised **without a model deciding anything**. That is what makes it deterministic enough to keep.
The suite is checked against reintroduced bugs: restoring the G7 `NaN` defect makes two of its tests fail.

**It found this immediately, and it is the kind of thing only an integration test could find:**

> **`AgentToolResult` has no `isError` field.** pi sets `isError` **only when `execute` throws** — a normal
> return is hardcoded `isError: false` (`pi-agent-core/dist/agent-loop.js`). `delegate` was *returning*
> `isError: true`, which pi silently discarded. **Every refusal this package ever made — escalation, gate,
> universal capability, depth, unknown capability — was recorded by pi as a SUCCESSFUL tool call**,
> including the G6 ledger-fail-closed and G8 child-failure paths added earlier the same day. Fixed by
> throwing.

Note what this means about the earlier G8 entry below: its claim that a failed child "comes back as a tool
error" was **only half true when written**. The text reached the model; pi's own error state did not.

### G12 closed, and three decisions written up for you (ADR-0012/0013/0014)

**ADR-0011 Finding 1 is resolved**: the wildcard branch keeps refusing, but the message is now honest — it
names the gated capability, says a `tool:*` grant cannot be approved for it because no dialog is offered on
that path, and points at `PI_GRANTS_GRANT` as the remedy. Making it *prompt* was rejected on merit: it
would let a wildcard holder widen its own children past an operator's gate with one dialog. Verified live.

**G12 — the docs stopped asserting a falsified fact.** The 72% tool-definition share now carries a dated
falsification note everywhere it appears (`SESSION-LOG`, `README`, ADR-0006, ADR-0007). Annotated, never
deleted, per this project's convention. Each note states what it does and does not undermine: ADR-0007's
reframe does not depend on it; **ADR-0006's magnitude claim and `pi-token-audit`'s headline feature do**.
`CLAUDE.md` and `docs/archive/GETTING-STARTED.md` also stopped describing a project with no production code in it.

**Three ADRs now await your decision.** Each has options honestly weighed and a recommendation, and none is
decided — they all narrow what the product claims, which is yours to choose:

| ADR | The finding | Recommended |
| :--- | :--- | :--- |
| **0012** | **`bash` escapes governance entirely — measured.** A session holding *only* `tool:bash`, at depth 1 of a maxDepth-2 tree, spawned an ungoverned pi with the full default surface: no ledger entry, no depth increment, no grant (`docs/probes/g5-bash-escape`). Also, gating is not closed under `SUBSUMPTION`, so gating `write` produces no prompt when `bash` is passed. | Close the subsumption gap; **narrow the advertised guarantee** rather than refusing every `bash` grant or becoming infrastructure. |
| **0013** | **The interceptor does not build the thing it governs.** Children are in-process (so `propagation.ts`'s race-freedom argument holds on the `delegate` path only), the ceiling omits extensions and skills, the hand-rolled frontmatter parser disagrees with pi's YAML *in the permissive direction*, identity is keyed differently at each end, and scheduled `Agent` calls have no hook at all. | Downgrade the interceptor to **best-effort guard + audit**; pursue the upstream `tools` parameter in parallel. |
| **0014** | **The approval file is forgeable by the agent it gates** — self-defeating in the package's own recommended `PI_GRANTS_GATED=tool:write` example, since a session that may use `write` can write the approval. Plus `once` being inherited by a whole subtree, the subject erased in propagation, and a corrupt file destroying valid entries on the next write. | Move the store outside agent-writable space; fix scope/subject/durability regardless. **Do not over-invest while 0012 is open** — the weaker link is elsewhere. |

**`skill:` and `agent:` capabilities enforce nothing**, under every option: skills are injected into the
system prompt rather than passed as tools, and nothing anywhere reads an `agent:` capability. That needs
fixing or removing — a capability that enforces nothing reads as a control.

### Review backlog: G1, G6, G7, G8 closed (same day, after the above)

Four more groups done, TDD throughout, each failing test watched failing first. **186 tests passing,
typecheck clean over `src` + `extensions` + `test`** (it previously excluded tests, which hid four errors).

- **G1 · the argv channel** — the delegation task sat in a CLI-parsed position. A task beginning `@` made
  pi read an arbitrary file into a child holding **no tools at all**, because the read happens before any
  tool exists and `--tools` therefore never applies. **Reproduced live**: a `--no-tools` child read a file
  *and obeyed the instructions in it*; after the fix it reports no filesystem access
  (`docs/probes/g1-argv`). Fixed with an unconditional leading space — positional, not pattern-based, so
  a third special prefix in some later pi cannot silently re-open it.
- **G6 · the ledger** — it reported **allowed** wildcard spawns as escalation attempts (`resolve()` has no
  notion of `tool:*`, so the extension's recompute denied everything), and dropped every refusal decided
  before resolution. `Decision.result` and `Delegation.result` are now **required**, so a new early exit
  cannot reintroduce either. A configured ledger that cannot be written now refuses the spawn.
- **G7 · configuration** — `parseInt` accepted `"2abc"` as `2` and gave `NaN` otherwise, and every
  comparison against `NaN` is false, so a malformed `PI_GRANTS_MAX_DEPTH` **removed** the depth limit
  rather than tightening it. Malformed now disables spawning and says which variable. Ungoverned sessions
  publish nothing to children. The catalog is awaited rather than raced.
- **G8 · child processes** — output cap, wall-clock timeout with `SIGTERM`→`SIGKILL`, `signal.aborted`
  checked *before* spawning (an `AbortSignal` does not replay), and failed children returned as tool
  errors instead of answers. Extracted to `src/run-child.ts` and tested against **real** processes.

**Eight groups remain open.** G2 (the `pi-subagents` reality gap), G3 (approval integrity) and G5 (`bash`
as a governance hole) need decisions rather than patches; G9/G10/G11/G12 are packaging, measurement
honesty, coverage and docs.

### ⚠️ The next actions are NOT the ones listed in the entry below

`docs/archive/reviews/2026-08-10-aggregated-findings.md` — **two independent reviews, cross-referenced, with eight
findings reached separately by both** — is the authoritative backlog now, and it was cut on `main` while
work happened on a branch, so it is easy to miss. **Read it before planning anything.** Merging ADR-0011
completed exactly one of its twelve groups (**G4**). Its own recommended order stands, with G4 struck:

**ALL TWELVE REVIEW GROUPS are now closed, or taken as far as they can go locally**, and ADR-0012, 0013
and 0014 are decided *and* implemented. The last two finished 2026-08-11:

- **G9 — the package was not installable.** `exports` pointed at `./src/*.ts`, and Node refuses to strip
  types under `node_modules`, so **every consumer import threw** while every in-repo test passed —
  verified by packing and installing the tarball. Now built to `dist/` with declarations, thirteen modules
  exported (three had been unreachable), `pi.extensions` declared on both packages, peer/dev deps
  declared, **tsconfigs committed** (the check config had lived in a session scratchpad, which is how four
  type errors in tests went unnoticed), `LICENSE` in both packages and at the root, a root workspace
  manifest, and `npm run test:smoke` — which packs, installs into a scratch project and *uses* the result.
  **The extension half was never broken**: pi's own loader reads TypeScript from `node_modules` fine.
- **G10 — the instrument's headline was arithmetic theatre.** `promptTokens` cancels out of
  `estToolTokens / promptTokens`, so the "tool-definition token share" was always
  `toolChars / payloadChars`. It now reports a **character share** and explains why no token figure
  exists. Relabelled rather than tokenized properly, deliberately: ADR-0007 retired the thesis a
  tokenizer would serve.

### What is left, and none of it is code

1. **File the upstream proposal** (`docs/archive/proposals/pi-subagents-tools-parameter.md`) — the user's call and
   the user's name. Until it lands the interceptor can refuse but never provision, which is measured
   rather than assumed (`docs/probes/g13-subagents-coupling`).
2. **Finding 6 has no local fix.** `subagents:rpc:spawn` reaches `manager.spawn()` over the event bus with
   no `tool_call`, so any other loaded extension can spawn an ungoverned sub-agent. Adding names to
   `SPAWN_TOOLS` cannot catch it — there is no tool call to catch.
3. **`pi-token-audit` still has no tests**, and is verified against one provider. G11 closed the
   `extensions/grants.ts` half of that coverage gap, not this one.
4. **Deferred by decision:** `A-14` (are deferred tool definitions billed as prompt tokens?) matters only
   if the cost thesis is revived, which ADR-0007 retired.

**A load-bearing "verified fact" in this file is falsified.** The 72% tool-definition share recorded in the
2026-08-09 entry — under *"Verified facts, don't re-litigate"*, and feeding **ADR-0006** — was proved
algebraically to be `toolChars / payloadChars`, a **character ratio, not a token measurement**
(`promptTokens` cancels; verified across a 72× swing). It has not yet been corrected there. Two other
architectural claims also fell: children are **in-process** on the interceptor path, so `propagation.ts`'s
race-freedom argument (and the R-26 fix) assumes a process boundary that exists on only one of the two
paths; and withholding `delegate` does **not** make a session a leaf.

**Previously agreed next feature — background + streaming delegation — should be re-decided against this
backlog.** It is a capability addition on top of a layer with twelve open critical findings, several of
which mean the guarantee the package advertises does not currently hold.

Also still queued and unaffected: the rpc integration harness (now hand-driven by two probes — that is the
point at which it should become `npm run test:integration`, and it is G11), the `PI_GRANTS_GATED`
recommendation, the `pi-subagents` proposal document, and A-14 (deferred).

---

## 2026-08-10 — the project is `pi-daddy`, under version control, with eight decisions taken

**The project is renamed to `pi-daddy`** (repo and project alike). "DTCM — Dynamic Tool & Context
Management" named the token-economics thesis ADR-0007 retired. Replaced only where the name is
*operational* — `CLAUDE.md`, `README.md`, `docs/archive/GETTING-STARTED.md`, all of `.claude/`. **"DTCM" is deliberately
preserved in every ADR and register**, where it *is* the abandoned thesis; a convention note in `CLAUDE.md`
forbids a blanket find-and-replace, because a register entry describes what was believed on its date and
renaming it makes the record lie.

**This is now a git repository** — the first one this project has had. Baseline commit `d8e4c47`, branch
`main`, 75 files, authored as `mojomanyana <nemanjaalavanja@gmail.com>` set **repo-local** so the global
identity is untouched. `.gitignore` covers `node_modules/`, `.superpowers/`, and — per **R-27** —
`.pi/grants-approvals.json` and `.pi/grants.jsonl`. No remote is set; that is the user's to add.

### Decisions taken (eight, in one pass)

| # | Decision |
| :--- | :--- |
| **ADR-0011** | **Accepted — Option 3.** Universal capabilities were treated three ways across the two spawn paths (silently dropped / silently passed / loudly refused). Fix: the interceptor refuses a spawn retaining a universal capability, `shouldSeekApproval` additionally requires `universal` to be empty, and the cosmetic stripping at `interceptor.ts:85` is removed. **Not yet implemented** — will be the first change to `src/interceptor.ts` since the package shipped. `src/resolve.ts` stays untouched. |
| **ADR-0009** | **Superseded by events.** The build path was taken; re-triggers stay live, now including "a `pi-fabric` release that fixes the recursion/containment exclusivity". |
| Wiring tests | **Integration harness, not extraction.** `obtainApprovals` stays in the extension; coverage comes from an rpc-mode suite driving real pi, promoted from `docs/probes/approval-ux/drive.mjs`. Wire as a separate `npm run test:integration` so `npm test` stays fast and pi-free. |
| Upstream PR | **Write the case first, code later.** A proposal document for a `tools` parameter on `pi-subagents`' `Agent` tool, to become an issue in the user's words. Patch only if the maintainer is receptive. |
| Gating `bash` | **Document as recommended, do not default it.** `bash` subsumes read/write/edit/grep/find/ls (R-25), so gating it is the highest-value gate *and* the likeliest source of reflexive approval. The README will recommend a `PI_GRANTS_GATED` value with the fatigue caveat; the code default stays empty, preserving "governance is opt-in and never silently tightens a workflow". |
| Next feature | **Background + streaming delegation.** |

### Next actions, highest value first

1. **Implement ADR-0011** — accepted but unimplemented; keeps the register honest.
2. **Background + streaming delegation.** `delegate` blocks until the child exits, so an orchestrator cannot
   fan out and collect — the actual multi-level pattern this project exists for. Also the first real test of
   the single-flight approval queue against genuine parallel spawns.
3. **The rpc integration harness** (decision above).
4. **`PI_GRANTS_GATED` recommendation** in the README (small).
5. **The `pi-subagents` proposal document** (small).
6. **Verify `pi-token-audit` against Anthropic and Google payload shapes** — proven on one provider only.
7. **A-14** — are deferred tool definitions billed as prompt tokens? Consciously deferred; only matters if
   the cost thesis is revived, which ADR-0007 retired.

---

## 2026-08-09 — `pi-daddy` 0.4.0: human approval for gated capabilities

Gated capabilities (held but not passable without a person saying yes) could previously only ever be
refused; `0.4.0` adds the yes — once/session/always scopes, inheritable down the tree intersected with
each child's actual grant, with `always` persisted per-project and offered only on the interceptor path
(agent types are human-authored files; `delegate`'s subject is model-chosen, so it never gets `always`).
**ADR-0010** records the approval semantics and **R-27** the hazard of a committed approvals file
authorising every clone (mitigated by ignoring entries whose `cwd` doesn't match). New public exports from
`src/approval.ts`, `src/approval-store.ts`, `src/approval-prompt.ts` — see `packages/pi-daddy/README.md`'s
*Approving a gated capability* section.

State: **unit-tested, typechecked, and verified live against real pi (149 tests, clean typecheck)**. The live
run is `docs/probes/approval-ux` — eight scenarios plus a companion, driven through `pi --mode rpc` (the same
`ctx.ui.select` the TUI dialog serves, not a rendered TUI). It found two defects, **both since fixed and
re-verified**: an approval inherited down the `delegate` path was applied but never recorded in the ledger,
and `delegate`'s default child model was a bare id that could resolve to an unauthenticated provider. The
probe still describes the original run — that is what a probe is for — with a dated resolution note on top.

A whole-branch review then returned **ship after fixing**, with no Critical findings: it could construct no
path granting a capability without the required approval, and `approved ⊆ grant` holds by construction at
every level on both paths. Its five Important and five Minor findings were all fixed in one wave — the
single-flight approval queue was inert in production (a fresh gate per call), `PI_GRANTS_APPROVED` could
escape the per-child env clamp, the dialog could fire for a spawn already refused for an unrelated reason,
the interceptor path passed neither `signal` nor `task`, and three documents described code that no longer
existed. `src/resolve.ts` and `src/interceptor.ts` remain byte-identical to their pre-feature state
throughout — the design's central claim. One reported item was deliberately left undone:
`SpawnRequest.isolated` is declared and populated but never read, and removing it means editing the protected
security surface, so it is recorded for a decision rather than patched around.

## 2026-08-09 — discovery → falsification → reframe → two shipped packages

### Where the project stands

**Status: BUILDING.** The product is a **capability-governance layer for pi's multi-level agent system**: a
top orchestrator grants each sub-agent a deliberate subset of tools/skills and withholds the rest;
sub-agents may delegate further but only ever a subset of what they hold; every grant and refusal is
recorded. Enforced by pi's own `--tools` allowlist, so the guarantee is structural.

`docs/archive/ROADMAP.md`'s phase plan is **obsolete** — it was written for the token-economics thesis. The gate
discipline and probe convention survive; the phase list does not.

### What happened, in order

1. **Discovery** pinned the substrate: pi (TypeScript, MIT, v0.83.0 installed locally, 0.84.1 upstream).
2. **G0 economic test failed decisively.** 82 real sessions, $76.12 of spend: catalog ~20 tools, p90 working
   set 4 tools, four tools = 98.1% of calls, ~50k median context, cache read:write 114:1. Break-even
   `S > 11.5·c·C` needs ~110 tools; mounting lost by 5×–102×. → G0 NO-GO, initiative parked (ADR-0005).
3. **Park reversed** (ADR-0006): the loss figure was computed on the *fallback* mounting path only. On
   native deferred loading (which pi routes to) the penalty collapses. Governing ratio is `S/(H+S)`, a curve
   over session length — a *fresh* session measured **72%** of prompt tokens on tool definitions.
   > **FALSIFIED 2026-08-10 (review finding A-C4). The 72% is not a token measurement.** `promptTokens`
   > cancels out of the calculation, so the figure is `toolChars / payloadChars` — a **character ratio**,
   > verified as such across a 72× swing in token count. The sentence is left standing because this is a
   > dated record of what was believed, but **it must not be quoted as evidence**. It is load-bearing for
   > **ADR-0006**, whose unpark argument rests partly on it; that ADR carries the same note. Correcting the
   > instrument is **G10**, **done 2026-08-11**: the report now states a character share and says so.
4. **The reframe (ADR-0007) — the most important event.** The user stated the actual goal: *"a large set of
   tools and sub agents… a top level orchestrating agent… that can give them some skills and tools but some
   not… narrow control of sub-agents… multilevel agent system."* Token cost was never the objective. The
   blueprint's §1 *justification* misled discovery; its *architecture* was always about control. Risk
   **R-17** had recorded the desired feature as a hazard.
5. **ADR-0008** established the invariant: capabilities attenuate monotonically down the tree.
6. **pi-fabric evaluated empirically** (11 probes) — it implements much of the design but **recursion and
   containment are mutually exclusive by construction** there. Decision **parked** with a re-trigger.
7. **Built and shipped** `pi-daddy` (0.3.0) and `pi-token-audit` (0.1.0).

### Verified facts (measured, not assumed — don't re-litigate)

- pi's **default** tool surface is only `read`, `bash`, `edit`, `write`. `grep`/`find`/`ls` exist but are not default.
- **pi's `--tools` / `--no-tools` hard-enforce**, including against extension tools; an `-e`-loaded extension
  cannot re-add its own tool past them (A-16). **This is the enforcement point.**
- **`bash` subsumes** the file/search tools, so a grant containing it is not narrow (A-15, R-25).
- In pi-fabric, `recursive: true` overrides `tools: []` *and* `extensions: false` — `fabric_exec` is a
  universal capability. Its `maxDepth` works; nothing else contains a recursive child.
- pi persists per-message `usage` with `cacheRead`/`cacheWrite`/`cost` in session JSONL (A-12).

### Shipped code (both under scoped waivers in `gate-reports/G0-2026-08-09.md`)

| Package | State | Verification |
| :--- | :--- | :--- |
| `packages/pi-daddy` **0.3.0** | resolver · ledger · spawn planner · `tool_call` interceptor · `delegate` tool · live catalog | **73/73 tests**, both typechecks clean, **7 live scenarios** verified against real pi |
| `packages/pi-token-audit` **0.1.0** | token/cost audit incl. tool-definition share | typechecks clean; verified end-to-end on `openai-codex`/`gpt-5.6-sol` |

Run tests: `cd packages/pi-daddy && npm test`.
Typecheck: tsconfigs are in the session scratchpad (not committed) — recreate with `tsc` pointing at
`src/**` and `extensions/grants.ts`, mapping `@earendil-works/pi-coding-agent` and `typebox` to the globally
installed pi's `dist/index.d.ts` and `node_modules/typebox/build/index.d.mts`.

### Open decisions (user's call)

1. **Code mode / pi-fabric** — parked with a re-trigger (durable actors, mesh coordination, or per-branch
   cost budgets). ADR-0009 stays *Proposed*.
2. **Upstream PR to `pi-subagents`** adding `allowed_tools` to the `Agent` tool. This is the one change that
   would turn the interceptor from *enforce-only* into *provisioning* for existing agent types, and it
   benefits everyone using that package. Not started — it is the user's name on the PR.
3. ~~**Rename the project.**~~ **RESOLVED 2026-08-10 — the project is `pi-daddy`.** "DTCM — Dynamic Tool &
   Context Management" named the token-economics thesis ADR-0007 retired. Replaced wherever the name is
   *operational* (`CLAUDE.md`, `README.md`, `docs/archive/GETTING-STARTED.md`, all of `.claude/`) and **deliberately kept
   in the historical record** — every ADR and register entry, where "DTCM" *is* the abandoned thesis and
   renaming it would make the record lie. See the convention note in `CLAUDE.md`.

### Next actions, highest value first

1. **Background + streaming delegation.** `delegate` blocks until the child finishes; add background handles
   and progress so an orchestrator can fan out and collect.
2. **`A-14`** (~1h, ~$1) — are deferred tool definitions billed as prompt tokens? Only matters if the cost
   thesis is revived; consciously deferred.
3. **Verify `pi-token-audit` against Anthropic and Google payload shapes** — only proven on one provider.

### Known gaps, stated so they aren't rediscovered as surprises

- The interceptor **enforces but cannot provision** (no `tools` param on `pi-subagents`' `Agent`). `delegate`
  provisions; the interceptor guards.
- Extension tools are catalogued as `tool:<name>`, not `ext:<pkg>/<tool>` — a provider payload carries names,
  not owning packages.
- `delegate` spawns `pi` from `PATH`.
- ADRs 0001/0002/0003 remain *Proposed*; their evidence is recorded but the reframe made their original
  framing partly moot.
