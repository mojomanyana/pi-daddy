# ADR-0028: `pi-daddy init` scaffolds a grant it refuses to decide, and session start names what is spawnable

**Date:** 2026-08-16
**Status:** Accepted
**Driver:** `docs/HANDOFF-principal-pi-skills-integration.md`, work items **B1** (fixes P4) and **B2** (fixes
P3). Section A belongs to `principal-pi-skills` and is not decided here. B3 was answered by execution on
2026-08-14 (pi auto-loads `pi.extensions` from an installed package) and B4 is documentation.

## Context

An operator installing `pi-daddy` and a package of `SKILL.md` skills gets, today, none of the governance
either package advertises, for reasons the handoff measured rather than inferred:

- **P3** — the working setup is entirely manual. Per skill: create a directory, copy the body, hand-write
  frontmatter, choose a capability set with no guidance, and assemble a `PI_GRANTS_GRANT` string by hand.
  Seven times for `principal-pi-skills`.
- **P4** — the startup line reports the *grant* and never the definitions, so "governance is working" and
  "did the install fail?" look identical.

Re-measured for this ADR (`docs/probes/b2-init-principal-pi-skills`, 2026-08-16): `principal-pi-skills@2.3.1`
still declares `allowed-tools` on **none** of its seven skills, and declares all seven in its own
`package.json` under `"pi": {"skills": [...]}`.

The constraint that shapes everything below is stated in the handoff and is not negotiable here:

> `init` writes files an operator then *reviews and commits*. It must not silently choose ceilings at
> runtime — the whole point is that the capability decision is visible, diffable and in version control.
> Generating a file the human approves is governance; deciding on their behalf at spawn time is not.

## Decision 1 — `pi-daddy init` scaffolds from each package's own declaration, and chooses no ceiling

`npx pi-daddy init` reads `<cwd>/node_modules` for packages declaring `pi.skills`, copies each declared
`SKILL.md` into `<cwd>/.pi/skills/<name>/`, and writes `<cwd>/.pi/grants.env`.

Four rules make it a scaffolder rather than a policy:

1. **A skill that declares `allowed-tools` is copied byte for byte.** The author's declaration is the
   ceiling; re-deriving or normalising it here would put a second opinion between the file and the enforcer,
   which is R-28's shape and has already cost this project twice.
2. **A skill that declares none is copied with a *commented* placeholder** and stays undeclared, therefore
   unspawnable. The placeholder is `# allowed-tools: <list the tools this skill needs, e.g. Read, Grep>` —
   deliberately not a working example, so uncommenting it unedited produces `tool:<list`, which the catalog
   refuses as unknown. A *working* commented default would be pi-daddy choosing the ceiling with one extra
   keystroke in front of it.
3. **The generated grant is the union of what the copied files declare**, plus one `agent:<name>` per
   *spawnable* definition, plus `tool:delegate` (without which no delegation tool is registered at all and
   the file is inert — S-5). An undeclared or pattern-carrying skill contributes **nothing**: authorising a
   definition nobody can spawn is authority that means nothing today and something un-reviewed the moment
   somebody fills that file in.
4. **An existing file is kept, never overwritten.** The edit an operator makes to one of these files *is*
   the capability decision, and the second run of a scaffolding command is exactly when it would be
   destroyed. `--force` exists and says in the usage text that it discards them.

**A definition whose name cannot safely be a capability id is refused outright** (R-77, found and fixed
while building this). A name is interpolated into a comma-separated `PI_GRANTS_GRANT`, into a file the
operator `source`s, and into a path — so a package shipping a directory called `a,tool:bash` made `init`
write `tool:bash` into a grant no definition declared. The rule is a whitelist,
`[A-Za-z0-9][A-Za-z0-9._-]*`, applied at discovery, and a refusal is printed with its reason rather than
quietly shortening the list.

Every capability in `.pi/grants.env` is annotated with the definition it came from, the withheld ones are
listed with their fix, and a declared `tool:` id pi 0.84.1 has no tool for (`Glob` is the live case, and the
handoff's own proposed table contains it) is flagged as a **caution** — it will be refused as an unknown
capability, and finding that out at spawn time is worse than reading it here.

## Decision 2 — session start says how many definitions are spawnable, and names the withheld ones

After the `holding [...]` line, a governed session with at least one discovered definition prints:

```
grants: 1 of 7 definitions spawnable — review
  withheld: architect, build, debug, decide, git-ops, plan — need agent:architect, …, which this session does not hold
```

**Classified by the real planner** — `planWithApprovals` with `ctx: null`, the same path `/grants` and a
real `delegate` come through, so no human is asked and stored approvals count exactly as they would for a
spawn. The summariser only counts and phrases what the planner returns. Three withheld reasons, because they
have three different fixes: a capability the session does not hold, a gate needing a human, and a file that
cannot be spawned as written.

Two deviations from the handoff's sketch, both deliberate:

- **It speaks when *nothing* is spawnable.** The handoff proposed printing "only when at least one
  definition is spawnable", which is silent for precisely the operator in P2's state — seven skills
  installed, none declaring `allowed-tools`, every spawn refused. That is the case most in need of a line.
- **The reason is grouped and named**, rather than a bare "(3 more need capabilities you do not hold)".
  Reporting a gate as an escalation would send an operator to widen a grant when the fix is to answer a
  dialog.

## Options considered

**For `init`'s treatment of an undeclared skill:**

- *Skip it.* Cheapest, and leaves P3 in place for exactly the skills that suffer from it — every one of
  `principal-pi-skills`' seven today. Rejected.
- *Write a suggested ceiling from the handoff's table.* This is the tidy option and it is the one the
  constraint forbids. The table is also explicitly **unresolved and self-contradicting** in the handoff
  itself (it gives `plan` a `Write` while the prose beneath calls `plan` structurally incapable of
  modifying anything), so shipping it would be pi-daddy settling an open question that belongs to the skill
  package. Rejected.
- *Write a commented placeholder that cannot become a grant by accident.* **Chosen.** It removes the
  mechanical cost (directory, copy, frontmatter, grant assembly) and leaves the one decision that has to be
  a human's.

**For discovering skill packages:**

- *Scan `node_modules` for files named `SKILL.md`.* Finds more, including a package's test fixtures, its
  examples and its vendored copies of other people's skills — and would then offer them as spawnable
  sub-agents. Rejected.
- *Read each package's `pi.skills` manifest field.* **Chosen.** A package that says which of its files are
  skills has said so on purpose, and it is pi's own convention. Verified against `principal-pi-skills@2.3.1`.

**For the startup summary's classifier:**

- *`maySpawnDefinition` alone* (the authorisation check the `delegate` tool description already uses).
  Cheap and synchronous, and wrong in the case that matters: a definition declaring no `allowed-tools` is
  authorised and unspawnable, so P2's operator would be told seven were spawnable while every spawn failed.
  Rejected.
- *Run the real planner per definition.* **Chosen.** The cost is one approvals-file read per definition
  whose plan reaches the gate — `planWithApprovals` returns before touching the store when the plan
  succeeds or fails for any other reason (`shouldSeekApproval`), so an ordinary project pays for nothing.
  A diagnostic with its own copy of the rules is R-28 and R-38, twice paid for.

## Consequences

- **The five-command install in the handoff is real**, minus work item A: `npm install` ×2 →
  `npx pi-daddy init` → edit the ceilings → `source .pi/grants.env && pi`. When A1 lands upstream the edit
  step disappears and `init` grants all seven `agent:` ids for the operator to delete down.
- **`pi-daddy` now has a `bin`.** The package was library-plus-extension; it is now also a command. `dist/`
  is what ships (Node refuses to strip types under `node_modules`), and `npm run test:smoke` exercises the
  installed bin — which is how the symlink defect in the entry-point guard was found rather than reasoned
  about.
- **A copied definition does not track its package.** `npm update principal-pi-skills` changes
  `node_modules`; `.pi/skills/` is a committed artifact and stays as it is. That is the correct direction —
  ADR-0018 pins a spawn to a body digest and ADR-0022 pins an inherited approval to it, so a definition that
  silently changed under an operator would void approvals and make the ledger's "has this changed since?"
  unanswerable. `init --force` is the deliberate re-sync, and it says what it costs.
- **Deliberate non-goals.** `init` does not scan `~/.pi/agent/skills/` (those definitions are already
  discovered and governed where they are; copying them would shadow the originals). It does not run
  `principal-pi-agents install` or know that package exists — P1, the two packages installing into different
  directories, is untouched by this ADR and is work item A2. And nothing here reads a definition's *body* or
  judges it: the operator authorises a file, and what that file says remains their responsibility.
- **The startup summary is an upper bound.** It runs before the first provider request, so it classifies
  against the *inherited* grant; `deriveOwnGrant` narrows to the observed tool surface afterwards. A
  definition counted spawnable can still be refused later if its ceiling names a tool this session turns out
  not to have. `/grants` — run after a request — is the settled answer, and the summary says nothing a spawn
  would not.

## Revisit trigger

- **The placeholder gets uncommented unedited more than once.** Then "cannot become a grant by accident" is
  costing more than it prevents, and the answer is a better error at spawn time, not a working default.
- **`init` acquires a second decision.** The moment it wants to choose *anything* about capabilities — a
  tier, a default, a "safe" subset — this ADR is what it has to argue against, and the argument has to be
  made in a new ADR rather than in a commit.
- **A skill package appears that declares skills some other way.** `pi.skills` is one convention observed on
  one package; a second layout means discovery needs a second source, not a heuristic scan.
