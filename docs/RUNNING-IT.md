# Running it — governed sub-agents, start to finish

Setup, then a feature built end to end with seven sub-agents, sequential where it must be and parallel
where it pays.

The end-to-end workflow was verified against `pi-daddy@0.14.0`, `principal-pi-skills@2.4.0`, pi 0.84.1 on
2026-08-17. ADR-0037's init-ledger setup delta was re-verified against the 0.21.0 candidate and real pi/Herdr
on 2026-09-01. Every number below is read from source or execution, not remembered.

---

## Part 1 — setup

### 1. Install

```bash
pi install npm:pi-daddy
pi install npm:principal-pi-skills
```

**`pi install`, not `npm install`.** It fetches the package *and registers it in pi's settings*, which is
what makes pi auto-load the extension — presence in `node_modules` alone does nothing. It installs into
`$PI_CODING_AGENT_DIR/npm/node_modules`, so your project may have no `node_modules` at all, and that is
normal. `npm install` into the project also works and pins the version for a team, but then the extension
needs `-e ./node_modules/pi-daddy/extensions/grants.ts`. `pi-daddy init` searches **both** locations.

### 2. Start pi and scaffold — from inside

```
pi
/grants init
```

`init` copies each skill **byte for byte** into `.pi/skills/` and chooses no ceiling. Then it asks about the
capabilities it will **not** grant on its own — the ones that can change your machine:

```
grants: grant tool:bash to sub-agents?
  needed by: build, review, debug, git-ops
  this can change your machine — and bash also confers write and edit
  [No] [Yes]
```

Three or four questions, not a dozen. The read-only capabilities each skill declares are already bounded
twice — by the ceiling its author wrote and by pi's `--tools` — so they are not the decision. These are.

Answering **No** is a real answer: those definitions stay unspawnable and `/grants` says so.

The result is stored **outside your project** (`$PI_CODING_AGENT_DIR/grants/…`) and applied to the session
you are already in — **no restart, no `source`** (ADR-0030). Outside, because a grant is a *ceiling*, and a
ceiling a child holding `tool:write` could rewrite is not a ceiling.

The same explicit init enables `.pi/grants.jsonl` now and on future plain `pi` starts (ADR-0037). Every spawn
and refusal is therefore recorded, and `/grants dashboard` is ready without exporting a second variable.
Existing pre-0.21 stored grants keep their no-ledger behavior until you rerun `/grants init` once.

### 3. Confirm before trusting it

`/grants` costs nothing, calls no model, and runs the **real planner** — so it cannot disagree with what a
spawn would actually do:

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

That is the whole setup. To change your mind later, run `/grants init` again — or delete the stored file,
whose path `/grants` prints, and the directory is ungoverned again.

### The alternative: an environment variable

`PI_GRANTS_GRANT` **always wins over the store**, because it is how a *child* is governed and how CI is
configured. `init` also writes `.pi/grants.env` — commit it: it is the reviewable record of the decision,
diffable in a PR, even though it is no longer what the enforcer reads.

```bash
source .pi/grants.env && pi     # explicit, and what CI does
```

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
| Child timeout | `1200s` | per child; SIGTERM then SIGKILL |
| Output cap | 1 MiB | per child; beyond it the child is killed and the result flagged truncated |
| Gated | `tool:bash` | a human is asked before any child receives it |

After ADR-0037's `/grants init` (or with `PI_GRANTS_LEDGER` set explicitly), every spawn **and every refusal**
is recorded, and a spawn that cannot be recorded is refused. Read it back with `/grants ledger` — record
count, escalation attempts, integrity, and which instructions ran.

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
