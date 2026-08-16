# Probe — `pi-daddy init` against the real `principal-pi-skills`, end to end

**Re-run 2026-08-17** against `principal-pi-skills@2.3.1`, `pi-daddy` 0.14.0 (working tree), pi 0.84.1,
node 22. Transcript: `transcript-2026-08-17.txt`. (The 2026-08-16 transcript was **replaced, not kept**:
five independent reviewers found nine defects in the code that produced it, so it recorded behaviour that
no longer exists rather than a decision anyone made. What the reviewers found is in R-73 through R-82.) Rerun: `bash docs/probes/b2-init-principal-pi-skills/probe.sh`
(needs network for one `npm install` and `pi` on PATH; **costs no model tokens**).

## What it measures

The whole B2 loop, with nothing stubbed:

```
npm i principal-pi-skills  →  pi-daddy init  →  a human edits ONE ceiling  →  pi  →  /grants
```

Five findings, in the order the transcript produces them.

**1. P2 still holds at 2.3.1, the published version.** `grep -rl allowed-tools node_modules/principal-pi-skills/`
matches nothing. Seven skills, six agent files, zero declarations — the handoff measured this on 2026-08-14
and it is unchanged in what npm serves.

**A1 has since been done upstream but not released** (`principal-pi-skills` PR #30, open as of 2026-08-16;
`npm view principal-pi-skills version` still returns 2.3.1). So everything below is the *installed-today*
case, and it is the one worth measuring: it is what an operator running these two commands actually gets.
Re-run this probe with `PPS_VERSION=<next>` once that ships — step 4 should disappear entirely.

**2. Discovery reads the package's own manifest.** `principal-pi-skills@2.3.1` declares

```json
"pi": { "skills": ["./decide", "./architect", "./plan", "./build", "./review", "./debug", "./git-ops"] }
```

and `init` found all seven from that field. It does **not** scan for files named `SKILL.md`: a scan would
also offer a package's fixtures and vendored copies of other people's skills as spawnable sub-agents.

**3. `init` writes seven files and chooses no ceiling.** Each copy is the package's file verbatim plus a
**commented** `allowed-tools:` placeholder, so the copy parses as *undeclared* and is not spawnable. The
generated `.pi/grants.env` therefore grants exactly one capability — `tool:delegate` — and names all seven
skills under `NOT AUTHORISED`, each with the fix.

The placeholder is `# allowed-tools: <list the tools this skill needs, e.g. Read, Grep>`. Uncommenting it
unedited yields capability ids like `tool:<list`, which the catalog refuses as unknown. That is deliberate:
a *working* commented default would be pi-daddy choosing the ceiling with an extra step in front of it.

**4. One edit is the whole remaining cost.** Filling in `allowed-tools: Read, Grep` for `review` and adding
`agent:review,tool:read,tool:grep` to the grant is all a human does. Nothing else was copied, edited or
assembled by hand — P3's seven-times-per-project cost.

**5. The startup line and `/grants` agree, in a real pi process.** With that grant:

```
[info] grants: depth 0/2, holding [agent:review, tool:read, tool:grep, tool:delegate]
[info] grants: 1 of 7 definitions spawnable — review
  withheld: architect (needs agent:architect); build (needs agent:build); debug (needs agent:debug);
  decide (needs agent:decide); git-ops (needs agent:git-ops); plan (needs agent:plan)
```

Each definition names **its own** missing capability. The first version printed the union across the whole
group, so a definition missing only `agent:architect` was reported as needing five other ids too (R-82) —
in the line whose stated purpose is naming the fix.

and `/grants` prints `allow review` plus six `BLOCK` lines naming the same six ids. That is B1 and P4: the
grant alone never said which definitions existed, and the six-line listing needed a command the operator
had to know to run.

## What this does NOT establish

- **No child was spawned.** The probe stops at `/grants`, which previews through the same planner but
  starts no process. Enforcement itself — `--tools` in a real child — is measured elsewhere
  (`test-integration/delegation.it.ts`, `docs/probes/g5-bash-escape`), not here.
- **No model was involved.** `/grants` is a slash command; nothing here shows a model *choosing* to
  delegate, or a definition's instructions producing sensible work.
- **It says nothing about whether any particular ceiling is right.** The ceilings belong to
  `principal-pi-skills` (work item A1, settled there by PR #30 after this probe ran, and by a different
  table than the handoff proposed). This probe measures the **mechanism**, not the policy — and once that
  release ships, the transcript's step 4 disappears, which is the point of the split.
- **The `agent:` ids in the generated grant are the union of what CAN be spawned, not a recommendation.**
  Here that is one id because six files declare nothing. With all seven declaring, `init` would grant all
  seven `agent:` ids and the operator would delete the ones they do not want — the file is written to be
  edited, and this probe does not show anyone editing it down.
- **Nothing was installed into `~/.pi/agent/skills/`.** `principal-pi-agents install` (work item A2) was
  not run; `init` reads `node_modules` only, and P1 — the two packages installing into different
  directories — is untouched by anything measured here.
