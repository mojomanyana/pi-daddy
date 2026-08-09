# Independent whole-codebase review — 2026-08-10

**Scope:** everything in `packages/` — `pi-agent-grants` 0.4.0 and `pi-token-audit` 0.1.0 — plus the
project's own documentation. Not a diff review: the whole codebase as it stands at commit `a4904d2`.

**Method.** Five reviewers, dispatched in parallel, each given the domain and the package's own claims but
**told nothing about what anyone else was looking at, what earlier reviews had found, or what the
orchestrator believed.** Independence was the point: this codebase had already passed ten task-scoped
reviews and one whole-branch review during construction, all of which shared context with the work.

| Reviewer | Scope |
| :--- | :--- |
| Security & invariants | Can the attenuation guarantee be broken? Asked to *try*, and to report failed attacks. |
| `pi-token-audit` | The never-reviewed package. Is the arithmetic right? Is it honest about its uncertainty? |
| Correctness & robustness | I/O, parsing, spawning, concurrency, async. |
| API design, quality, tests | Public surface, module boundaries, and specifically: tests that cannot fail. |
| Documentation accuracy | Every documented claim checked against code; labelled STALE / HISTORICAL / AMBIGUOUS. |

**Verified independently by the orchestrator** (not merely relayed): C-1, C-2, C-4, and the export failures.
Each is marked below. Everything else is a reviewer's finding reported as received.

---

## Verdict

**`src/resolve.ts` is sound. The perimeter around it is not.**

Three reviewers independently tried to break the resolver and none could. One states it plainly: *"I could
not construct any input where `effective ⊄ expandSubsumed(parentGrant)`. This module is genuinely clean."*
The 149 tests on the pure core are real tests — transitivity across three levels, approval-cannot-conjure,
rejection reasons not masking one another.

But the package's central claim — *"`src/resolve.ts` is the entire security surface"* — is false, and the
gap is exactly where the defects are. **Three reviewers, with no knowledge of each other, converged on the
same file:** `extensions/grants.ts`, 585 lines, zero tests. Eight of the security reviewer's thirteen
findings live there.

**The single most important finding is that the enforcement boundary was never the only channel.**

---

## Critical

### C-1 · `@`-prefixed task reads any file, with zero tools granted — VERIFIED

`src/spawn.ts:55` · exploited via `extensions/grants.ts:476`

`planSpawn` appends the delegation task as a bare positional argv element. pi's parser treats any argument
beginning with `@` as a **file argument** (`cli/args.js:172`) and resolves it with
`resolve(resolveReadPath(...))` — absolute paths, `~` expansion, no sandbox (`cli/file-processor.js:17`) —
injecting the contents into the child's prompt. This happens in `main.js` **before any tool is
constructed**, so `--tools` and `--no-tools` never apply.

Verified directly against pi 0.83.0:

```
$ pi --print --no-session --no-extensions --no-tools "@…/decoy.env"
I see `decoy.env`. What would you like me to do with it?
```

A session holding only `tool:delegate` can call `delegate({ task: "@/home/user/.ssh/id_rsa", tools: [] })`.
The child is spawned with `--no-tools`, reads the file regardless, and its entire stdout returns to the
parent as the tool result (`grants.ts:493`).

**Precision on severity.** *Verified:* a child granted nothing reads an arbitrary file and has it in
context. *Not verified:* verbatim exfiltration — the model declined to echo the canary, and since the whole
task is one argv element an attacker passes a path **or** an instruction, not both. But any summary the
child returns leaks.

This falsifies the README's core argument: *"pi core hard-blocks extension tools… that is why this package
needs no runtime inside the descendant."* True of tools; not true of the prompt argument, which the package
hands the model.

**Fix.** Never let a model-controlled string occupy a position the CLI parses. A leading space defeats both
the `@` and `-` branches; stdin is better; rejecting `@`/`-` prefixes in `planDelegation` makes it a
recorded refusal rather than a silent read.

### C-2 · The agent-type parser disagrees with the parser that actually spawns the child — VERIFIED

`src/agent-types.ts:47-54`

The hand-rolled frontmatter reader skips any `key:` line whose value is empty, treating it as a block
scalar. A block-style YAML list has exactly that shape:

```yaml
tools:
  - read
  - grep
```

Verified:

```
pi-agent-grants  tools:   undefined
pi-agent-grants  ceiling: [ 'tool:*' ]          ← WILDCARD

pi's own dist/utils/frontmatter.js: import { parse } from "yaml"   → ["read","grep"]
```

So this package and `pi-subagents` — reading the **same file** — disagree about the child's ceiling. No test
covers the block-list form; all 149 use the comma-separated style.

Two consequences, and the second is worse:

- **Governed delegator:** the spawn is refused with a message that is factually false — *"agent type
  declares no `tools:` allowlist"*. Every block-list agent type becomes unspawnable under any narrowed
  session.
- **Wildcard delegator (the default, since governance is opt-in):** the spawn is **allowed**, and the ledger
  records `effective: ["tool:*"]` while the child pi-subagents actually spawns is restricted to
  `read, grep`. **The audit record is wrong in the permissive direction** — it overstates what the child
  received. Auditability is this package's entire justification.

**Fix.** Parse simple `- item` sequences, or stop conflating "empty value" with "block scalar" — they are
different YAML shapes with opposite security implications here.

### C-3 · The persisted-approval file is forgeable by the agent it gates

`src/approval-store.ts` (whole file) · consulted at `extensions/grants.ts:143`

`.pi/grants-approvals.json` lives inside the governed workspace, has no integrity control, and is trusted as
evidence *a human said yes*. Its two guards — `cwd` match (R-27) and `grantAtApproval` comparison — defend
against a file arriving from elsewhere and against the agent type changing afterwards. Neither defends
against local forgery.

The gate is self-defeating in its own documented configuration: `PI_GRANTS_GATED=tool:write` means "may use
write, may not pass it down without a human" — and a session that may use write can write the approval.
Demonstrated end to end by the reviewer, including authoring the matching agent-type file so
`grantAtApproval` compares equal. No dialog is raised; the ledger records `approvalSource: "persisted"`,
indistinguishable from a real human approval.

**Fix.** Store approvals outside the agent-writable workspace (e.g. under `~/.pi/`, keyed by project path),
or sign entries. At minimum refuse to honour a persisted approval for a capability that grants filesystem
write to the current session.

### C-4 · The tool-definition percentage is a character ratio wearing a measurement's clothes — VERIFIED

`packages/pi-token-audit/extensions/token-audit.ts:111,121,186`

```
estToolTokens = toolChars × promptTokens / payloadChars
share         = 100 × estToolTokens / promptTokens
              = 100 × toolChars / payloadChars        ← promptTokens cancels
```

Verified by running the real pipeline with the README's own numbers at three wildly different provider token
counts:

```
promptTokens=   6947  charsPerToken=  4.843  estToolTokens=  4993  share=71.87%
promptTokens=   1000  charsPerToken= 33.641  estToolTokens=   719  share=71.87%
promptTokens= 500000  charsPerToken=  0.067  estToolTokens=359368  share=71.87%
pure character ratio  toolChars/payloadChars = 71.87%
```

A **72× swing** in the provider's real token count moves the headline by nothing. The README states *"the
conversion ratio is measured per turn from this provider's own counts… No tokenizer dependency, no second
API call, no guessing"* — and the reported number is mathematically independent of those counts. The printed
"error bar" describes a quantity that cannot affect the result.

**The knock-on matters more than the bug.** `docs/SESSION-LOG.md:97` records *"a fresh session measured
**72%** of prompt tokens on tool definitions"* under **"Verified facts (measured, not assumed — don't
re-litigate)"**, and it was part of ADR-0006's reasoning to unpark the initiative. A future session is
instructed not to question it.

The defensible claim is *"tool definitions are 72% of the request payload's **characters**."* The gap is not
small and its sign is known: JSON schemas tokenize far denser than prose (~3–3.5 chars/token vs ~4.5+), so
the true token share is likely **higher** — plausibly exceeding the reported prompt total, which this method
structurally cannot express, being clamped at 100%.

Two further provider bugs, verified against pi's source: **Bedrock reports `toolCount 0`** (its `toolConfig`
is an object, not an array, so `Array.isArray` falls through — and a wrong zero is indistinguishable from
"no tools"), and **Google always reports `1`** (all tools nest inside one `functionDeclarations` element).
On OpenAI Responses/Codex, deferred tool definitions are counted as conversation rather than as tools, so
the share is understated *precisely in the regime the tool exists to evaluate*.

---

## Important — security

| # | Finding | Site |
| :--- | :--- | :--- |
| S-1 | **"Allow once" is inherited by the entire descendant subtree.** `obtainApprovals` returns `approved` regardless of chosen scope; it is written into the child's `PI_GRANTS_APPROVED` and republished onward. A human picks the most conservative option and gets the least conservative outcome. | `grants.ts:434` → `delegate.ts:151` |
| S-2 | **The wildcard branch returns `allow` before the gating check**, so an operator who sets `PI_GRANTS_GATED` without `PI_GRANTS_GRANT` gets a gate that silently does nothing. | `interceptor.ts:84-93` |
| S-3 | **The ledger records false escalation attempts for spawns it allowed.** On the wildcard path `decision.result` is undefined, so the record is recomputed from a different input; `denied` comes back non-empty and `isEscalationAttempt()` returns true for a legitimate allowed spawn. | `grants.ts:326` |
| S-4 | **A malformed `PI_GRANTS_MAX_DEPTH` disables depth limiting entirely** — `??` catches only `undefined`, so an empty or non-numeric value yields `NaN` and every comparison against it is false. The adjacent `depth` parse *does* have a `\|\| 0` guard. | `grants.ts:65` |
| S-5 | **`delegate` is registered unconditionally.** The comment two lines above claims conditional registration; `DELEGATE_CAPABILITY` is imported and never used. "Withhold it and the child is a leaf" is unenforced. | `grants.ts:371` |
| S-6 | **Approval subjects are erased at the propagation boundary.** `approval.ts:33` argues at length that a model-controlled key is not a key — and a `<delegate>`-subject approval is published to children as a bare capability matching *any* subject. | `grants.ts:88,105` |
| S-7 | **Gating is not closed under `SUBSUMPTION`.** Gating `write` produces no prompt when `bash` — which the package's own table says confers `write` — is handed down. | `resolve.ts:119-121` |
| S-8 | **`skill:` and `agent:` capabilities enforce nothing.** Skills are injected into the system prompt, not passed as tools, so `--tools` cannot gate them; `spawn.ts` passes neither `--no-skills` nor `--no-context-files`. Nothing anywhere reads an `agent:` capability. | `resolve.ts:163-171`, `spawn.ts:37-56` |
| S-9 | **The interceptor governs three hardcoded tool names.** Any other spawn-capable tool is invisible — including `fabric_exec`, which the package itself declares universal. | `grants.ts:56` |

## Important — correctness

| # | Finding | Site |
| :--- | :--- | :--- |
| R-1 | **Unbounded output buffering and no execution timeout** for spawned children. No `maxBuffer`, no cap, and the only kill path depends on an external abort signal. A child that hangs holds the orchestrator's turn open forever. | `grants.ts:475-490` |
| R-2 | **A corrupt approvals file makes the *next write* silently destroy every other entry.** Reproduced: save A, truncate, save B → the file contains only B, with no error and no warning. The existing corrupt-file test only checks the read. | `approval-store.ts:126-155` |
| R-3 | **Abort-signal race:** the listener attaches after an `await`, and `AbortSignal` does not replay past events. A cancellation issued in that window is lost and the child runs to completion outside it. | `grants.ts:475-490` |
| R-4 | **Ledger write failures are entirely silent** — both call sites pass `strict: false` and swallow with no `ctx.ui.notify`, contradicting `ledger.ts`'s own "an unrecorded grant should fail closed". | `grants.ts:325-348,445-465` |
| R-5 | **Unsynchronised catalog rebuild** can falsely refuse the first `delegate` of a session as "unknown capability", purely on timing. Fails closed, but non-deterministic. | `grants.ts:236-272` |

## Important — API and tests

| # | Finding |
| :--- | :--- |
| A-1 | **`interceptor.ts`, `propagation.ts`, `agent-types.ts` are unreachable from outside the package** — confirmed by building a real `node_modules` symlink: `ERR_PACKAGE_PATH_NOT_EXPORTED`. `decideSpawn`, the function the package is named for, cannot be imported, while the README documents it as contract. **VERIFIED.** |
| A-2 | **`catalog.ts` and `delegate.ts` have subpath exports but are missing from `index.ts`**, so `import { buildCatalog } from "pi-agent-grants"` yields `undefined` silently rather than throwing. |
| A-3 | **`grants.ts:532-539` hand-copies `isValidEntryShape`** from `approval-store.ts:46-57`, which is not exported — a maintenance liability documented in its own comment, in the one file with no tests. |
| A-4 | **`obtainApprovals` makes security-relevant policy decisions** (whether to persist, whether to downgrade scope on write failure) in the untested file, violating the package's stated house rule. |
| A-5 | **`appendRecord` has zero tests.** The README's "the ledger fails closed; an unrecorded grant is a hole" is unverified. `loadAgentTypes`' multi-directory precedence and `catalog.ts`'s multi-root skill loading are likewise untested. |

### A fourth test that cannot fail

`test/approval-store.test.ts:56` — *"the file records version 1 and is human-readable"* asserts
`.includes("\n")` to verify pretty-printing. The write path appends `\n` **outside** `JSON.stringify`, so
deleting the indentation argument entirely leaves the test green while the property it is named for is gone.
Three earlier weak tests were found and strengthened during construction; this is the fourth.

---

## Documentation

The **package** README is accurate line-for-line — env vars, argv order, file paths, error strings, the
149-test claim, approval semantics all match the code. The **summary** documents one level up are stale:

| Document | Claim | Reality |
| :--- | :--- | :--- |
| `README.md:40` | `pi-agent-grants` 0.2.0, 63 tests | 0.4.0, 149 tests |
| `CLAUDE.md:46` | 0.3.0 | 0.4.0 |
| both | "nine ADRs", "R-01..R-26" | eleven ADRs, R-27 |
| both | ADR-0009 "parked" | Superseded by events |
| `GETTING-STARTED.md:3-5` | "zero implementation code, by design" | two shipped packages |
| `GETTING-STARTED.md:35,38` | `mkdir ~/projects/dtcm`, `unzip dtcm-kit.zip` | project renamed; the name is retired |

`GETTING-STARTED.md` is ranked worst because it drives an **action**, not merely a belief. The probe
READMEs, `ROADMAP.md`, `04-landscape.md`, and the older SESSION-LOG entries were all correctly judged
**HISTORICAL** — accurate as dated records and not to be rewritten.

---

## Attacks that failed

Reported because a documented failed attack is a real result, and because it separates a hardened design
from an unexamined one.

| Attack | Why it failed |
| :--- | :--- |
| `delegate({ task: "--tools=bash" })` to override the allowlist | pi matches `--tools` by exact equality with a separate value; `--flag=value` falls to `unknownFlags`. |
| `tools: ["*"]` hoping `--tools *` globs | pi filters with exact `Set.has`. A `*` allowlist grants zero tools. |
| **Escalation through `resolve()` itself** | No input found where `effective ⊄ expandSubsumed(parentGrant)`. `approved` only subtracts from `gatedBlocked`; approval can never conjure. `tool:*` is a literal string with no special meaning inside `resolve`. |
| YAML block-sequence to smuggle a ceiling past the mini-parser | Yields the wildcard ceiling → refused for any non-wildcard delegator. Fails closed. *(But see C-2: it fails closed for governance while corrupting the audit record.)* |
| `ext:evil/fabric_exec` to dodge the exact-string universal list | Refused twice — unknown to the catalog, and denied by `resolve`. |
| Copying an approvals file into another checkout | `foreign-cwd` works (R-27 mitigation confirmed). |
| Parent `PI_GRANTS_*` surviving into a delegate child | `mergeChildEnv` strips all six keys. Correct and correctly reasoned. |
| A concurrent-spawn race on `process.env` in the interceptor | None constructible. The race analysis in `propagation.ts` is right. |

---

## What this says about the construction process

Worth recording, because it is the most transferable finding.

The feature that produced most of this code passed **ten task-scoped reviews and one whole-branch review**
during construction. Those reviews caught thirteen genuine defects. They did not catch any of C-1 through
C-4.

The reason is structural: every one of those reviewers was given a diff and a brief derived from the plan.
None was asked *"can you break this?"*, none was given the whole codebase at once, and none was pointed at
`pi-token-audit` — which had never been reviewed at all and whose output had already been promoted to a
"verified fact" that a decision rested on.

Three of five independent reviewers converged on `extensions/grants.ts` without knowing the others existed.
That file was exempted from testing by a house rule, and the exemption was reaffirmed as recently as
2026-08-10 (the decision to add an integration harness rather than extract the logic). The exemption is
where the defects went.
