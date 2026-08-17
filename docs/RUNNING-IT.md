# Running it — governed sub-agents, start to finish

Setup, then a feature built end to end with seven sub-agents, sequential where it must be and parallel
where it pays.

Verified against `pi-daddy@0.14.0`, `principal-pi-skills@2.4.0`, pi 0.84.1 on 2026-08-17. Every number
below is read from the source, not remembered.

---

## Part 1 — setup

### 1. Install

```bash
npm install pi-daddy principal-pi-skills
```

No `-e` flag anywhere. `pi-daddy` declares `pi.extensions`, so pi auto-loads it for an installed package.

### 2. Scaffold

```bash
npx pi-daddy init
```

```
found principal-pi-skills@2.4.0 — 7 skill(s), 7 declaring allowed-tools
wrote .pi/skills/{decide,architect,plan,build,review,debug,git-ops}/SKILL.md
wrote .pi/grants.env

WITHHELD BY DEFAULT: tool:bash (build, review, debug, git-ops), tool:edit (build), tool:write (build).
Live grant (8 capabilities): agent:architect, agent:decide, agent:plan, tool:delegate, …
```

`init` copies each skill **byte for byte** and chooses no ceiling. It writes a file for you to read.

### 3. Read the file — this is the actual security step

```bash
$EDITOR .pi/grants.env
```

It is commented throughout and tells you what each definition declares, what is withheld, and why.
**Commit it.** From here the capability decision is in version control and reviewable like any other code.

### 4. Start

```bash
source .pi/grants.env && pi
```

### 5. Confirm before trusting it

Type `/grants` in pi. Costs nothing, calls no model, and runs the **real planner** — so it cannot disagree
with what a spawn would do:

```
grants: ACTIVE
  holding    agent:architect, agent:decide, agent:plan, tool:delegate, tool:find, tool:grep, tool:ls, tool:read
  depth      0 of max 2
    allow  architect  tool:find, tool:grep, tool:ls, tool:read
    allow  decide     tool:find, tool:grep, tool:ls, tool:read
    allow  plan       tool:find, tool:grep, tool:ls, tool:read
    BLOCK  build   — does not hold agent:build
    BLOCK  review  — does not hold agent:review
```

Three work now. Four are withheld because they need `bash`, and that is step 6.

### 6. Enable the executing tier — deliberately

`review`, `debug`, `build` and `git-ops` cannot run yet. This is the design, not a gap: `review` and
`debug` create a disposable git worktree and run your tests in it; `build` writes code. All four need
`bash`, and **`bash` subsumes `write` and `edit`** — a ceiling holding it is a full-authority ceiling.

In `.pi/grants.env`, uncomment what you want and add the matching `agent:` ids:

```bash
export PI_GRANTS_GRANT="agent:architect,agent:decide,agent:plan,\
agent:build,agent:review,agent:debug,agent:git-ops,\
tool:delegate,tool:find,tool:grep,tool:ls,tool:read,\
tool:bash,tool:edit,tool:write"

export PI_GRANTS_LEDGER=".pi/grants.jsonl"     # recommended — see Part 4
```

Then `source .pi/grants.env` and restart pi.

**`tool:bash` is gated by default**, so pi asks you before any child receives a shell — once per
capability, with *allow once / this session / always*. `tool:write` and `tool:edit` are **not** gated, so
granting those above is the whole decision for them.

---

## Part 2 — one sub-agent

```
Use the plan agent to break down adding rate limiting to our API.
```

You don't need special syntax. The `delegate` tool's description is rebuilt at request time and tells the
model verbatim:

> *"Name of a definition to spawn — its `allowed-tools` become the grant and its instructions become the
> sub-agent's system prompt. **Available: architect, decide, plan.**"*

The child is a **separate `pi` process** with `--tools find,grep,ls,read` and that skill's body as its
system prompt. It reads your repository, returns its plan as text, and has no write tool at all.

---

## Part 3 — a whole feature, seven agents

**The rule that makes this optimal: run in parallel only what does not need another child's output.**
Everything else is sequential, because a child cannot see its siblings — each is a separate process with
no shared context.

Feature: *add rate limiting to the API.*

### Phase 1 — decide (sequential, 1 agent)

```
Use the decide agent: should we rate limit at the edge (nginx/CDN) or in the
app? Weigh operational cost, per-route flexibility, and what our current
deploy setup already supports.
```

Sequential because everything downstream depends on the answer. Read-only, so it cannot touch your code.

### Phase 2 — architect and plan (still sequential)

```
Take that decision and use the architect agent to design it: where the
counter lives, what happens on a cache miss, and how we test it.
```

```
Now use the plan agent to turn that design into ordered steps with a
verification step for each.
```

Three blocking calls, because each genuinely consumes the previous answer. **Do not parallelise these** —
you would get three agents guessing at each other's conclusions.

### Phase 3 — build, then review and debug in parallel

```
Use the build agent to implement step 1 and step 2 of that plan.
```

Blocking, and the first call that asks for `bash` — you'll get the approval dialog.

Now parallelise, because these two examine the **same finished** code independently:

```
In parallel: have review check the new middleware for correctness and
simplicity, and have debug confirm the rate-limit tests actually fail when
the limiter is disabled.
```

That is one `delegate_all` call. Two processes, concurrent, neither aware of the other, both reporting
back to you.

### Phase 4 — fan out across independent work

The strongest use of parallelism is **independent subsystems**, not repeated passes:

```
In parallel, use the architect agent on three separate questions: how rate
limit state should survive a deploy, what the client should see on a 429,
and whether our metrics pipeline can carry per-route counters.
```

Three agents, no shared context, three answers back. Legitimate because none needs the others.

### Phase 5 — land it

```
Use the git-ops agent to commit this on a branch and open a PR describing
the rate limiting change.
```

### The shape, in one line

```
decide → architect → plan → build → (review ‖ debug) → git-ops
   └─────── sequential ───────┘        └ parallel ┘
```

---

## Part 4 — the bounds you are working inside

| Bound | Default | Meaning |
|---|---|---|
| Depth | `2` | a child may delegate one level further, then it is a leaf |
| Children per call | `8` | maximum in one `delegate_all` |
| Fan-out budget | `8` | per call, and the share each child inherits — **not a session total** |
| Child timeout | `600s` | per child; SIGTERM then SIGKILL |
| Output cap | 1 MiB | per child; beyond it the child is killed and the result flagged truncated |
| Gated | `tool:bash` | a human is asked before any child receives it |

With `PI_GRANTS_LEDGER` set, every spawn **and every refusal** is recorded, and a spawn that cannot be
recorded is refused. Read it back with `/grants ledger` — record count, escalation attempts, integrity, and
which instructions ran.

---

## What not to expect

**Sub-agents cannot see each other.** No shared context, no messages between them. You — or the model
driving your session — carry each result to the next step. That is why the sequential half above is
sequential.

**A child holding `bash` is not contained.** It can run `env -u PI_GRANTS_GRANT pi …` and get an
ungoverned descendant. Out of scope by decision, and the reason `bash` is gated rather than assumed: it
cannot happen *silently*.

**Nothing reads the skill body.** `agent:review` says which file may run; the ledger says which version
ran. Whether those instructions are any good is your judgement, not the governance layer's.
