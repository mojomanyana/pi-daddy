# Gated Capability Approval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Give a human a way to say *yes* to a gated capability — with a scope, an audit trail, and a
defined answer when no human is present — without modifying `resolve.ts`.

**Architecture:** `resolve()` already computes `gatedBlocked` and already accepts `approved`; nothing ever
fills it. Every task below adds machinery *around* that pure function: the wiring detects `gatedBlocked`,
obtains approvals (inherited → session → persisted → prompt), and calls the **same unmodified `resolve()`**
a second time with `approved` filled. All decision logic lives in `src/` as pure, testable functions;
`extensions/grants.ts` stays wiring only, per the package's existing house rule.

**Tech Stack:** TypeScript run directly by Node ≥ 22.19 (native type stripping — there is no build step),
`node:test` + `node:assert/strict`, pi ≥ 0.83.0 `ExtensionAPI`.

**Spec:** `docs/specs/2026-08-09-gated-capability-approval.md` · **Decision:** `ADR-0010` · **Risk:** `R-27`

## Global Constraints

- **This project is not a git repository.** `git rev-parse` fails at the root. The skill's per-task
  *Commit* step is therefore impossible; each task ends with **run the full suite** instead. Do not run
  `git init` — that is a workspace decision belonging to the user, not to this plan.
- **Do not modify `src/resolve.ts`.** It is the entire security surface, and leaving it untouched is the
  design's central claim. `ResolveInput.approved` already exists and already works.
- **Do not modify `src/interceptor.ts`.** `DecisionContext.approved` already exists and already flows into
  `resolve()` at `interceptor.ts:107-112`.
- Test command: `cd packages/pi-agent-grants && npm test` (`node --test test/*.test.ts`). Baseline before
  any change: **73 passing**. Every task states the expected new total.
- Imports inside `src/` use explicit `.ts` extensions (e.g. `from "./resolve.ts"`) — match the existing files.
- Node ≥ 22.19.0, `"type": "module"`. No new runtime dependencies; `node:*` builtins only.
- **Typecheck is not wired into the repo.** Per `docs/SESSION-LOG.md`, tsconfigs live in a session
  scratchpad and are not committed. To typecheck, point `tsc` at `src/**` and `extensions/grants.ts`,
  mapping `@earendil-works/pi-coding-agent` → the globally installed pi's `dist/index.d.ts` and `typebox` →
  `node_modules/typebox/build/index.d.mts` under
  `/home/alavanja/.nvm/versions/node/v24.14.0/lib/node_modules/@earendil-works/pi-coding-agent/`.
- Capability ids are strings like `tool:write`, `ext:pkg/tool`, `skill:x`, `agent:y`. `WILDCARD` is
  `"tool:*"` (`src/agent-types.ts:17`).
- **Privacy rule inherited from `ledger.ts`:** capability ids, counts, and identifiers only. `taskAtApproval`
  is the single deliberate exception and is provenance-only, never part of a key.

## File Structure

| File | Responsibility |
| :--- | :--- |
| `src/approval.ts` **(create)** | Pure model: keys, scopes, inheritance, entry validity, precedence. No I/O. |
| `src/approval-store.ts` **(create)** | The only I/O: `.pi/grants-approvals.json` load / save / revoke. |
| `src/approval-prompt.ts` **(create)** | The dialog gate: `hasUI` check, scope labels, timeout, single-flight. |
| `src/propagation.ts` (modify) | `ENV_APPROVED`; `childEnv` carries inherited approvals. |
| `src/ledger.ts` (modify) | Four optional record fields. |
| `src/delegate.ts` (modify) | Emit `ENV_APPROVED` in the per-child env. |
| `src/index.ts` (modify) | Re-export the new public surface. |
| `extensions/grants.ts` (modify) | Wiring: session set, both call sites, `/grants` subcommands. |
| `package.json` (modify) | `exports` entries for the new modules. |
| `test/approval.test.ts` **(create)** | Tasks 1–2. |
| `test/approval-store.test.ts` **(create)** | Task 3. |
| `test/approval-prompt.test.ts` **(create)** | Task 6. |
| `test/propagation.test.ts` (modify) | Task 4. |

---

### Task 1: Approval model — keys, scopes, inheritance

**Files:**
- Create: `packages/pi-agent-grants/src/approval.ts`
- Test: `packages/pi-agent-grants/test/approval.test.ts`

**Interfaces:**
- Consumes: `Capability` from `./resolve.ts`; `WILDCARD` from `./agent-types.ts`
- Produces: `ApprovalScope`, `ApprovalSource`, `ApprovalPath`, `DELEGATE_SUBJECT`, `APPROVAL_TTL_DAYS`,
  `approvalKey(capability, subject): string`, `offeredScopes(path): ApprovalScope[]`,
  `inheritApprovals(approved, grant): Capability[]`, `expiryFor(approvedAt: Date): string`

- [ ] **Step 1: Write the failing test**

Create `packages/pi-agent-grants/test/approval.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVAL_TTL_DAYS,
  DELEGATE_SUBJECT,
  approvalKey,
  expiryFor,
  inheritApprovals,
  offeredScopes,
} from "../src/approval.ts";

test("a key names the capability and the subject that was approved", () => {
  assert.equal(approvalKey("tool:write", "docs-writer"), "tool:write@docs-writer");
});

test("an approval for one agent type does not satisfy another", () => {
  assert.notEqual(approvalKey("tool:write", "typeA"), approvalKey("tool:write", "typeB"));
});

test("the delegate subject cannot collide with a real agent type", () => {
  // '<' and '>' are not legal in an agent-type name parsed from frontmatter.
  assert.match(DELEGATE_SUBJECT, /^<.+>$/);
});

test("always is offered on the interceptor path, where the subject is a file a human wrote", () => {
  assert.deepEqual(offeredScopes("interceptor"), ["once", "session", "always"]);
});

test("always is NEVER offered on the delegate path — the model controls the subject there", () => {
  assert.deepEqual(offeredScopes("delegate"), ["once", "session"]);
  assert.ok(!offeredScopes("delegate").includes("always"));
});

test("an inherited approval is intersected with the child's grant", () => {
  assert.deepEqual(inheritApprovals(["tool:write", "tool:bash"], ["tool:read", "tool:write"]), [
    "tool:write",
  ]);
});

test("THE invariant for approvals: approved can never exceed the grant", () => {
  assert.deepEqual(inheritApprovals(["tool:write"], []), []);
  assert.deepEqual(inheritApprovals([], ["tool:write"]), []);
});

test("the wildcard is never inherited as an approval (mirrors R-26 for grants)", () => {
  assert.deepEqual(inheritApprovals(["tool:*", "tool:read"], ["tool:*", "tool:read"]), ["tool:read"]);
});

test("expiry is TTL days after approval, as an ISO instant", () => {
  const at = new Date("2026-08-09T14:02:11.331Z");
  const expected = new Date(at.getTime() + APPROVAL_TTL_DAYS * 86_400_000).toISOString();
  assert.equal(expiryFor(at), expected);
  assert.equal(expiryFor(at), "2026-09-08T14:02:11.331Z");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pi-agent-grants && npm test`
Expected: FAIL — `Cannot find module '../src/approval.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/pi-agent-grants/src/approval.ts`:

```ts
/**
 * Approval model for gated capabilities — pure, so it is exhaustively testable without pi.
 *
 * `resolve()` computes `gatedBlocked`: capabilities a session legitimately holds but which may not enter
 * a child's grant without a human saying so. This module decides WHAT a yes means — how far it reaches,
 * how long it lasts, and what it is keyed to. It never performs I/O and never prompts; see
 * `approval-store.ts` and `approval-prompt.ts` for those.
 *
 * ADR-0010 records the four decisions encoded here.
 */

import { WILDCARD } from "./agent-types.ts";
import type { Capability } from "./resolve.ts";

/** How far a single yes reaches in time. */
export type ApprovalScope = "once" | "session" | "always";

/** Where a yes came from, for the ledger. These call for different follow-ups, so they stay distinct. */
export type ApprovalSource = "prompt" | "session" | "persisted" | "inherited";

/** Which call site is asking. Determines the scopes offered — see `offeredScopes`. */
export type ApprovalPath = "interceptor" | "delegate";

/**
 * Subject used for delegate-path approvals.
 *
 * The delegate tool has no human-authored subject: the only things naming a child are the task string and
 * the tool list, both chosen by the model. A key the model controls is not a key, so delegate approvals
 * use this fixed literal — "allow write for delegations this session" — and are never persisted.
 * Angle brackets cannot appear in an agent-type name (`parseAgentType` reads an identifier), so this can
 * never collide with a real type.
 */
export const DELEGATE_SUBJECT = "<delegate>";

/**
 * Lifetime of a persisted approval.
 *
 * Deliberately a constant rather than an environment variable: a knob that silently extends every gate is
 * the first thing an impatient operator would reach for.
 */
export const APPROVAL_TTL_DAYS = 30;

const DAY_MS = 86_400_000;

/** `tool:write` + `docs-writer` -> `tool:write@docs-writer`. */
export function approvalKey(capability: Capability, subject: string): string {
  return `${capability}@${subject}`;
}

/** Scopes a given call site may offer. `always` requires a human-authored subject, so delegate is denied it. */
export function offeredScopes(path: ApprovalPath): ApprovalScope[] {
  return path === "interceptor" ? ["once", "session", "always"] : ["once", "session"];
}

/**
 * The approval an inheriting child may hold.
 *
 * Intersecting with the child's grant is what keeps ADR-0008 intact once approvals became inheritable:
 * `approved ⊆ grant` at every level, by construction. An approval can therefore never name a capability
 * the session does not hold — it only ever unblocks part of a grant, never widens one.
 *
 * The wildcard is filtered for the same reason `childEnv` filters it out of grants (R-26): inheriting it
 * would let a descendant treat every future gate as pre-approved.
 */
export function inheritApprovals(approved: Capability[], grant: Capability[]): Capability[] {
  const held = new Set(grant);
  return [...new Set(approved.filter((c) => c !== WILDCARD && held.has(c)))].sort();
}

/** When an approval granted now stops being valid. Computed once at write time and stored, so an entry's
 *  lifetime is visible in the file rather than implied by whichever version of the code reads it. */
export function expiryFor(approvedAt: Date): string {
  return new Date(approvedAt.getTime() + APPROVAL_TTL_DAYS * DAY_MS).toISOString();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/pi-agent-grants && npm test`
Expected: PASS — **82 tests** (73 baseline + 9 new)

- [ ] **Step 5: Checkpoint (no commit — see Global Constraints)**

Confirm `npm test` reports 82 passing and 0 failing before starting Task 2.

---

### Task 2: Entry validity and approval precedence

**Files:**
- Modify: `packages/pi-agent-grants/src/approval.ts` (append)
- Test: `packages/pi-agent-grants/test/approval.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `ApprovalScope`, `ApprovalSource`, `approvalKey`
- Produces: `ApprovalEntry`, `EntryVerdict`, `entryVerdict(input): EntryVerdict`,
  `resolveApprovals(input): { approved, needsPrompt, sources }`

- [ ] **Step 1: Write the failing test**

Append to `packages/pi-agent-grants/test/approval.test.ts`:

```ts
import { entryVerdict, resolveApprovals, type ApprovalEntry } from "../src/approval.ts";

const CWD = "/repo/a";
const NOW = new Date("2026-08-20T00:00:00.000Z");

const entry = (over: Partial<ApprovalEntry> = {}): ApprovalEntry => ({
  approvedAt: "2026-08-09T00:00:00.000Z",
  expiresAt: "2026-09-08T00:00:00.000Z",
  cwd: CWD,
  grantAtApproval: ["tool:read", "tool:write"],
  ...over,
});

test("a live entry whose agent type is unchanged is valid", () => {
  const v = entryVerdict({ entry: entry(), cwd: CWD, now: NOW, currentCeiling: ["tool:read", "tool:write"] });
  assert.equal(v, "valid");
});

test("R-27: an entry approved in another directory authorises nothing here", () => {
  const v = entryVerdict({ entry: entry(), cwd: "/repo/b", now: NOW, currentCeiling: ["tool:read", "tool:write"] });
  assert.equal(v, "foreign-cwd");
});

test("an expired entry is not valid", () => {
  const v = entryVerdict({
    entry: entry(),
    cwd: CWD,
    now: new Date("2026-09-09T00:00:00.000Z"),
    currentCeiling: ["tool:read", "tool:write"],
  });
  assert.equal(v, "expired");
});

test("the confused deputy: a rewritten agent type voids the approval", () => {
  const v = entryVerdict({
    entry: entry(),
    cwd: CWD,
    now: NOW,
    currentCeiling: ["tool:bash", "tool:read", "tool:write"],
  });
  assert.equal(v, "type-changed");
});

test("a deleted agent type voids the approval", () => {
  const v = entryVerdict({ entry: entry(), cwd: CWD, now: NOW, currentCeiling: null });
  assert.equal(v, "type-missing");
});

test("reordering the tools: line is not a change", () => {
  const v = entryVerdict({ entry: entry(), cwd: CWD, now: NOW, currentCeiling: ["tool:write", "tool:read"] });
  assert.equal(v, "valid");
});

const RA = (over: Partial<Parameters<typeof resolveApprovals>[0]> = {}) =>
  resolveApprovals({
    gated: [],
    subject: "docs-writer",
    sessionApprovals: new Set<string>(),
    persisted: new Map<string, ApprovalEntry>(),
    ...over,
  });

test("nothing gated means nothing to approve and nothing to ask", () => {
  const r = RA();
  assert.deepEqual(r.approved, []);
  assert.deepEqual(r.needsPrompt, []);
});

test("an unsatisfied gated capability needs a prompt", () => {
  const r = RA({ gated: ["tool:write"] });
  assert.deepEqual(r.approved, []);
  assert.deepEqual(r.needsPrompt, ["tool:write"]);
});

test("a session approval satisfies without prompting", () => {
  const r = RA({ gated: ["tool:write"], sessionApprovals: new Set(["tool:write@docs-writer"]) });
  assert.deepEqual(r.approved, ["tool:write"]);
  assert.deepEqual(r.needsPrompt, []);
  assert.equal(r.sources["tool:write"], "session");
});

test("a persisted approval satisfies without prompting", () => {
  const r = RA({ gated: ["tool:write"], persisted: new Map([["tool:write@docs-writer", entry()]]) });
  assert.deepEqual(r.approved, ["tool:write"]);
  assert.equal(r.sources["tool:write"], "persisted");
});

test("an inherited approval satisfies, and outranks session and persisted in reporting", () => {
  const r = RA({
    gated: ["tool:write"],
    inherited: ["tool:write"],
    sessionApprovals: new Set(["tool:write@docs-writer"]),
  });
  assert.deepEqual(r.approved, ["tool:write"]);
  assert.equal(r.sources["tool:write"], "inherited");
});

test("a persisted approval for a DIFFERENT subject does not satisfy", () => {
  const r = RA({ gated: ["tool:write"], persisted: new Map([["tool:write@other", entry()]]) });
  assert.deepEqual(r.approved, []);
  assert.deepEqual(r.needsPrompt, ["tool:write"]);
});

test("mixed: one satisfied, one still needing a human", () => {
  const r = RA({
    gated: ["tool:write", "tool:bash"],
    sessionApprovals: new Set(["tool:write@docs-writer"]),
  });
  assert.deepEqual(r.approved, ["tool:write"]);
  assert.deepEqual(r.needsPrompt, ["tool:bash"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pi-agent-grants && npm test`
Expected: FAIL — `entryVerdict` / `resolveApprovals` are not exported

- [ ] **Step 3: Write minimal implementation**

Append to `packages/pi-agent-grants/src/approval.ts`:

```ts
/** A persisted approval. Only the interceptor path writes these, so `subject` is always an agent type. */
export interface ApprovalEntry {
  approvedAt: string;
  expiresAt: string;
  /** The directory the human was sitting in. See `entryVerdict` and R-27. */
  cwd: string;
  /** The agent type's ceiling AT APPROVAL TIME. Load-bearing, not decorative — see `entryVerdict`. */
  grantAtApproval: Capability[];
  /** Provenance only, NEVER part of a key: what was being done when the yes was given. */
  taskAtApproval?: string;
}

export type EntryVerdict = "valid" | "expired" | "foreign-cwd" | "type-changed" | "type-missing";

export interface EntryValidityInput {
  entry: ApprovalEntry;
  /** The directory this session is running in. */
  cwd: string;
  now: Date;
  /** The named agent type's CURRENT ceiling, or null when the type no longer exists. */
  currentCeiling: Capability[] | null;
}

/**
 * Decide whether a persisted approval still means what the human meant.
 *
 * Four ways it can stop meaning that, and each is reported distinctly so `/grants approvals` can explain
 * itself rather than silently showing fewer rows:
 *
 *  - `foreign-cwd`  — the file was copied or committed and opened somewhere else. Nobody in THIS checkout
 *                     was asked, so it authorises nothing here (R-27).
 *  - `expired`      — a gate opened during one project must not still be open next quarter.
 *  - `type-changed` — the confused deputy. The key names a file whose contents can change after approval:
 *                     approve `tool:write@docs-writer` when it declares `read, write`, and later that file
 *                     gains `bash`. The entry would still match the key while describing something the
 *                     human never saw.
 *  - `type-missing` — the type was deleted or renamed; a new file could later claim the same name.
 */
export function entryVerdict(input: EntryValidityInput): EntryVerdict {
  if (input.entry.cwd !== input.cwd) return "foreign-cwd";
  if (new Date(input.entry.expiresAt).getTime() <= input.now.getTime()) return "expired";
  if (input.currentCeiling === null) return "type-missing";
  // Compare as sorted lists: reformatting or reordering a `tools:` line is not a change; adding,
  // removing, or renaming a capability is.
  const approved = [...input.entry.grantAtApproval].sort().join(",");
  const current = [...input.currentCeiling].sort().join(",");
  return approved === current ? "valid" : "type-changed";
}

export interface ResolveApprovalsInput {
  /** `ResolveResult.gatedBlocked` — held and within ceiling, but awaiting a human. */
  gated: Capability[];
  subject: string;
  /** Approval KEYS approved for this session, in memory only. */
  sessionApprovals: ReadonlySet<string>;
  /** Persisted entries by key, ALREADY validity-filtered by the store. */
  persisted: ReadonlyMap<string, ApprovalEntry>;
  /** Capabilities approved further up the tree and inherited with the grant. */
  inherited?: Capability[];
}

export interface ResolveApprovalsResult {
  approved: Capability[];
  /** Gated capabilities still requiring a live human. */
  needsPrompt: Capability[];
  sources: Record<Capability, ApprovalSource>;
}

/**
 * Satisfy as much of `gated` as possible without asking anyone.
 *
 * Precedence is inherited -> session -> persisted -> prompt. Order matters only for what gets REPORTED
 * (the ledger's `approvalSource`); any hit satisfies equally. Checking all three before prompting is what
 * stops an orchestrator's tenth delegation from raising a tenth identical dialog.
 */
export function resolveApprovals(input: ResolveApprovalsInput): ResolveApprovalsResult {
  const inherited = new Set(input.inherited ?? []);
  const approved: Capability[] = [];
  const needsPrompt: Capability[] = [];
  const sources: Record<Capability, ApprovalSource> = {};

  for (const capability of [...new Set(input.gated)].sort()) {
    const key = approvalKey(capability, input.subject);
    if (inherited.has(capability)) {
      approved.push(capability);
      sources[capability] = "inherited";
    } else if (input.sessionApprovals.has(key)) {
      approved.push(capability);
      sources[capability] = "session";
    } else if (input.persisted.has(key)) {
      approved.push(capability);
      sources[capability] = "persisted";
    } else {
      needsPrompt.push(capability);
    }
  }

  return { approved, needsPrompt, sources };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/pi-agent-grants && npm test`
Expected: PASS — **95 tests** (82 + 13 new)

- [ ] **Step 5: Checkpoint**

Confirm 95 passing, 0 failing.

---

### Task 3: The approval store

**Files:**
- Create: `packages/pi-agent-grants/src/approval-store.ts`
- Test: `packages/pi-agent-grants/test/approval-store.test.ts`

**Interfaces:**
- Consumes: `ApprovalEntry`, `EntryVerdict`, `entryVerdict` from `./approval.ts`
- Produces: `approvalsPath(cwd): string`,
  `loadApprovals(input): Promise<{ valid: Map<string, ApprovalEntry>; dropped: DroppedApproval[] }>`,
  `saveApproval(cwd, key, entry, ceilingOf, now): Promise<boolean>`,
  `revokeApproval(cwd, key): Promise<boolean>`, `revokeAll(cwd): Promise<void>`,
  `DroppedApproval { key, entry, verdict }`

- [ ] **Step 1: Write the failing test**

Create `packages/pi-agent-grants/test/approval-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalsPath,
  loadApprovals,
  revokeAll,
  revokeApproval,
  saveApproval,
} from "../src/approval-store.ts";
import type { ApprovalEntry } from "../src/approval.ts";

const NOW = new Date("2026-08-20T00:00:00.000Z");
const temp = () => mkdtemp(join(tmpdir(), "grants-approvals-"));
const ceiling = (caps: string[] | null) => () => caps;

const entryFor = (cwd: string, over: Partial<ApprovalEntry> = {}): ApprovalEntry => ({
  approvedAt: "2026-08-09T00:00:00.000Z",
  expiresAt: "2026-09-08T00:00:00.000Z",
  cwd,
  grantAtApproval: ["tool:read", "tool:write"],
  ...over,
});

test("a missing file is empty, not an error", async () => {
  const cwd = await temp();
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read"]) });
  assert.equal(r.valid.size, 0);
  assert.deepEqual(r.dropped, []);
});

test("a corrupt file grants nothing and does not throw", async () => {
  const cwd = await temp();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(approvalsPath(cwd), "{ this is not json", "utf8");
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read"]) });
  assert.equal(r.valid.size, 0, "a broken cache grants nothing");
});

test("round trip: a saved approval loads back", async () => {
  const cwd = await temp();
  const ok = await saveApproval(cwd, "tool:write@docs-writer", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  assert.equal(ok, true);
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read", "tool:write"]) });
  assert.deepEqual([...r.valid.keys()], ["tool:write@docs-writer"]);
});

test("the file records version 1 and is human-readable", async () => {
  const cwd = await temp();
  await saveApproval(cwd, "tool:write@docs-writer", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  const parsed = JSON.parse(await readFile(approvalsPath(cwd), "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.approvals["tool:write@docs-writer"].cwd, cwd);
  assert.ok(await readFile(approvalsPath(cwd), "utf8").then((t) => t.includes("\n")), "pretty-printed");
});

test("R-27: an entry from another checkout is dropped with a reason", async () => {
  const cwd = await temp();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    approvalsPath(cwd),
    JSON.stringify({ version: 1, approvals: { "tool:write@docs-writer": entryFor("/somewhere/else") } }),
    "utf8",
  );
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 0);
  assert.equal(r.dropped[0].verdict, "foreign-cwd");
});

test("a changed agent type drops the entry with a reason", async () => {
  const cwd = await temp();
  await saveApproval(cwd, "tool:write@docs-writer", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:bash", "tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 0);
  assert.equal(r.dropped[0].verdict, "type-changed");
});

test("revoke removes one entry and leaves the others", async () => {
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);
  await saveApproval(cwd, "tool:write@a", entryFor(cwd), c, NOW);
  await saveApproval(cwd, "tool:write@b", entryFor(cwd), c, NOW);
  assert.equal(await revokeApproval(cwd, "tool:write@a"), true);
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: c });
  assert.deepEqual([...r.valid.keys()], ["tool:write@b"]);
});

test("revoking something that was never approved reports false", async () => {
  const cwd = await temp();
  assert.equal(await revokeApproval(cwd, "tool:write@nope"), false);
});

test("revokeAll clears the file", async () => {
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);
  await saveApproval(cwd, "tool:write@a", entryFor(cwd), c, NOW);
  await revokeAll(cwd);
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: c });
  assert.equal(r.valid.size, 0);
});

test("saving prunes entries that have become invalid", async () => {
  const cwd = await temp();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    approvalsPath(cwd),
    JSON.stringify({ version: 1, approvals: { "tool:write@stale": entryFor("/elsewhere") } }),
    "utf8",
  );
  await saveApproval(cwd, "tool:write@fresh", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  const parsed = JSON.parse(await readFile(approvalsPath(cwd), "utf8"));
  assert.deepEqual(Object.keys(parsed.approvals), ["tool:write@fresh"], "the stale entry was pruned on write");
});

test("an unwritable location reports failure rather than throwing", async () => {
  const ok = await saveApproval(
    "/proc/nonexistent-and-unwritable",
    "tool:write@x",
    entryFor("/proc/nonexistent-and-unwritable"),
    ceiling(["tool:read", "tool:write"]),
    NOW,
  );
  assert.equal(ok, false, "the caller downgrades to session scope rather than failing the work");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pi-agent-grants && npm test`
Expected: FAIL — `Cannot find module '../src/approval-store.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/pi-agent-grants/src/approval-store.ts`:

```ts
/**
 * Persistence for `always`-scoped approvals — the package's only mutable state outside the ledger.
 *
 * DESIGN NOTE, because it is easy to get backwards: this file is a CONVENIENCE CACHE, not a security
 * control. The security decision was already made by a human at the moment of approval. So a failure here
 * must never fail the work — an unwritable file downgrades the approval to session scope (see the boolean
 * return of `saveApproval`), and an unreadable one simply grants nothing.
 *
 * Read on demand, never cached at session start, so a revoke takes effect immediately — including one
 * performed from another session while this one is running.
 *
 * Pruning is deliberately lazy: `loadApprovals` never writes, so a read is a read. Invalid entries are
 * dropped from the file on the next `saveApproval` or `revokeApproval`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { entryVerdict, type ApprovalEntry, type EntryVerdict } from "./approval.ts";
import type { Capability } from "./resolve.ts";

interface ApprovalFile {
  version: 1;
  approvals: Record<string, ApprovalEntry>;
}

export interface DroppedApproval {
  key: string;
  entry: ApprovalEntry;
  verdict: EntryVerdict;
}

/** Look up an agent type's current ceiling by subject; null when the type no longer exists. */
export type CeilingLookup = (subject: string) => Capability[] | null;

export function approvalsPath(cwd: string): string {
  return join(cwd, ".pi", "grants-approvals.json");
}

/** The subject half of `capability@subject`. Capability ids contain `:` but never `@`. */
function subjectOf(key: string): string {
  return key.slice(key.indexOf("@") + 1);
}

async function readFileSafely(cwd: string): Promise<ApprovalFile> {
  try {
    const parsed = JSON.parse(await readFile(approvalsPath(cwd), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { version: 1, approvals: {} };
    const file = parsed as Partial<ApprovalFile>;
    if (file.version !== 1 || !file.approvals || typeof file.approvals !== "object") {
      return { version: 1, approvals: {} };
    }
    return { version: 1, approvals: file.approvals };
  } catch {
    // Missing is normal; corrupt grants nothing. Either way the caller re-prompts, which is safe.
    return { version: 1, approvals: {} };
  }
}

export interface LoadApprovalsInput {
  cwd: string;
  now: Date;
  ceilingOf: CeilingLookup;
}

/** Load the approvals valid HERE and NOW, plus the ones that were dropped and why. */
export async function loadApprovals(
  input: LoadApprovalsInput,
): Promise<{ valid: Map<string, ApprovalEntry>; dropped: DroppedApproval[] }> {
  const file = await readFileSafely(input.cwd);
  const valid = new Map<string, ApprovalEntry>();
  const dropped: DroppedApproval[] = [];

  for (const [key, entry] of Object.entries(file.approvals)) {
    const verdict = entryVerdict({
      entry,
      cwd: input.cwd,
      now: input.now,
      currentCeiling: input.ceilingOf(subjectOf(key)),
    });
    if (verdict === "valid") valid.set(key, entry);
    else dropped.push({ key, entry, verdict });
  }

  return { valid, dropped };
}

async function writeFileSafely(cwd: string, file: ApprovalFile): Promise<boolean> {
  try {
    await mkdir(dirname(approvalsPath(cwd)), { recursive: true });
    await writeFile(approvalsPath(cwd), `${JSON.stringify(file, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist one approval, pruning anything that has since become invalid.
 *
 * Returns false when the write failed. The caller must then downgrade to session scope and warn — NOT
 * refuse the delegation. The human already said yes; refusing work because a cache could not be written
 * would be failing closed on the wrong thing.
 */
export async function saveApproval(
  cwd: string,
  key: string,
  entry: ApprovalEntry,
  ceilingOf: CeilingLookup,
  now: Date,
): Promise<boolean> {
  const { valid } = await loadApprovals({ cwd, now, ceilingOf });
  valid.set(key, entry);
  return writeFileSafely(cwd, { version: 1, approvals: Object.fromEntries(valid) });
}

/** Remove one approval. Returns false when there was nothing to remove. */
export async function revokeApproval(cwd: string, key: string): Promise<boolean> {
  const file = await readFileSafely(cwd);
  if (!(key in file.approvals)) return false;
  delete file.approvals[key];
  return writeFileSafely(cwd, file);
}

export async function revokeAll(cwd: string): Promise<void> {
  await writeFileSafely(cwd, { version: 1, approvals: {} });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/pi-agent-grants && npm test`
Expected: PASS — **106 tests** (95 + 11 new)

- [ ] **Step 5: Checkpoint**

Confirm 106 passing, 0 failing.

---

### Task 4: Propagate approvals to children

**Files:**
- Modify: `packages/pi-agent-grants/src/propagation.ts:32` (add `ENV_APPROVED`), `:69-101` (`ChildEnvInput`, `childEnv`)
- Modify: `packages/pi-agent-grants/src/delegate.ts:20` (import), `:140-147` (child env)
- Test: `packages/pi-agent-grants/test/propagation.test.ts` (append)

**Interfaces:**
- Consumes: `inheritApprovals` from `./approval.ts`
- Produces: `ENV_APPROVED = "PI_GRANTS_APPROVED"`; `ChildEnvInput.approved?: Capability[]`;
  `DelegationContext.approved` now reaches the child env

- [ ] **Step 1: Write the failing test**

Append to `packages/pi-agent-grants/test/propagation.test.ts`:

```ts
import { ENV_APPROVED, childEnv } from "../src/propagation.ts";
import { planDelegation } from "../src/delegate.ts";

test("an inherited approval is intersected with what the child actually gets", () => {
  const env = childEnv({
    ownGrant: ["tool:read", "tool:write"],
    depth: 0,
    maxDepth: 2,
    gated: ["tool:write"],
    approved: ["tool:write", "tool:bash"],
  });
  assert.equal(env[ENV_APPROVED], "tool:write", "bash was approved upstream but is not held here");
});

test("no approvals means the variable is absent, not empty", () => {
  const env = childEnv({ ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [] });
  assert.equal(ENV_APPROVED in env, false);
});

test("the wildcard is never inherited as an approval", () => {
  const env = childEnv({
    ownGrant: ["tool:*", "tool:read"],
    depth: 0,
    maxDepth: 2,
    gated: [],
    approved: ["tool:*", "tool:read"],
  });
  assert.equal(env[ENV_APPROVED], "tool:read");
});

test("delegate hands the child only approvals for capabilities it was actually granted", () => {
  const plan = planDelegation(
    { task: "edit the docs", tools: ["read", "write"] },
    {
      ownGrant: ["tool:read", "tool:write", "tool:bash"],
      depth: 0,
      maxDepth: 2,
      gated: ["tool:write", "tool:bash"],
      approved: ["tool:write", "tool:bash"],
    },
  );
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.env[ENV_APPROVED], "tool:write", "bash was approved but not granted to this child");
});

test("an approved capability the child was NOT granted never reaches it", () => {
  const plan = planDelegation(
    { task: "read the docs", tools: ["read"] },
    {
      ownGrant: ["tool:read", "tool:write"],
      depth: 0,
      maxDepth: 2,
      gated: ["tool:write"],
      approved: ["tool:write"],
    },
  );
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(ENV_APPROVED in plan.env, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pi-agent-grants && npm test`
Expected: FAIL — `ENV_APPROVED` is not exported from `../src/propagation.ts`

- [ ] **Step 3: Write minimal implementation**

In `packages/pi-agent-grants/src/propagation.ts`, add the import at the top (after the existing
`import { WILDCARD } from "./agent-types.ts";`):

```ts
import { inheritApprovals } from "./approval.ts";
```

Add the constant after `ENV_LEDGER` (line 32):

```ts
export const ENV_APPROVED = "PI_GRANTS_APPROVED";
```

Add the field to `ChildEnvInput` (after `gated: Capability[];`):

```ts
  /**
   * Gated capabilities a human approved at or above this level.
   *
   * Safe to push on the GLOBAL channel because it is intersected with THIS session's own grant, which is
   * a parent-level fact — identical for every sibling, so there is nothing to race on. Each child then
   * re-intersects with its own grant on arrival, exactly as it does for the grant itself.
   */
  approved?: Capability[];
```

Extend `childEnv`'s body — after the `gated` line, before `ledgerPath`:

```ts
  const approved = inheritApprovals(input.approved ?? [], inheritable);
  if (approved.length > 0) env[ENV_APPROVED] = approved.join(",");
```

In `packages/pi-agent-grants/src/delegate.ts`, extend the propagation import (line 20):

```ts
import { ENV_APPROVED, ENV_DEPTH, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH } from "./propagation.ts";
```

and add the import for the pure helper:

```ts
import { inheritApprovals } from "./approval.ts";
```

Then, in `planDelegation`, after the `if (ctx.gated.length > 0)` line:

```ts
  // Approvals ride down with the grant, but only ever for what this child actually received — so
  // `approved ⊆ grant` holds at every level (ADR-0010).
  const inheritedApprovals = inheritApprovals(ctx.approved ?? [], result.effective);
  if (inheritedApprovals.length > 0) env[ENV_APPROVED] = inheritedApprovals.join(",");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/pi-agent-grants && npm test`
Expected: PASS — **111 tests** (106 + 5 new)

- [ ] **Step 5: Checkpoint**

Confirm 111 passing. Sanity-check that the pre-existing propagation tests still pass — `childEnv`'s
signature gained an optional field only, so none should have changed.

---

### Task 5: Ledger records the approval

**Files:**
- Modify: `packages/pi-agent-grants/src/ledger.ts:19-35` (`GrantRecord`), `:49-76` (`buildRecord`)
- Test: `packages/pi-agent-grants/test/resolve.test.ts` (append — `buildRecord` is already tested there)

**Interfaces:**
- Consumes: `ApprovalScope`, `ApprovalSource` from `./approval.ts`
- Produces: `GrantRecord.approved?`, `.approvalSource?`, `.approvalScope?`, `.humanDenied?`; the same four
  as optional args to `buildRecord`

- [ ] **Step 1: Write the failing test**

Append to `packages/pi-agent-grants/test/resolve.test.ts`:

```ts
test("the ledger records what was approved and where the yes came from", () => {
  const result = resolve({
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    gated: ["tool:write"],
    approved: ["tool:write"],
  });
  const record = buildRecord({
    parentId: "d0",
    childId: "docs-writer@d1",
    depth: 1,
    agentType: "docs-writer",
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    result,
    blocked: false,
    approved: ["tool:write"],
    approvalSource: "prompt",
    approvalScope: "once",
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.deepEqual(record.approved, ["tool:write"]);
  assert.equal(record.approvalSource, "prompt");
  assert.equal(record.approvalScope, "once");
  assert.equal(record.humanDenied, undefined);
});

test("a human saying no is recorded distinctly from an escalation attempt", () => {
  const result = resolve({
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    gated: ["tool:write"],
  });
  const record = buildRecord({
    parentId: "d0",
    childId: "docs-writer@d1",
    depth: 1,
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    result,
    blocked: true,
    humanDenied: true,
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(record.humanDenied, true);
  assert.deepEqual(record.gatedBlocked, ["tool:write"]);
  assert.deepEqual(record.denied, [], "a human declining is NOT an escalation attempt");
  assert.equal(isEscalationAttempt(record), false);
});

test("a gate hit with nobody present is neither an escalation nor a human refusal", () => {
  const result = resolve({
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    gated: ["tool:write"],
  });
  const record = buildRecord({
    parentId: "d0",
    childId: "docs-writer@d1",
    depth: 1,
    requested: ["tool:write"],
    parentGrant: ["tool:write"],
    result,
    blocked: true,
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(record.humanDenied, undefined);
  assert.equal(record.approvalSource, undefined);
  assert.deepEqual(record.gatedBlocked, ["tool:write"]);
  assert.equal(isEscalationAttempt(record), false);
});

test("existing records are unaffected — the new fields are absent, not null", () => {
  const result = resolve({ requested: ["tool:read"], parentGrant: ["tool:read"] });
  const record = buildRecord({
    parentId: "d0",
    childId: "x@d1",
    depth: 1,
    requested: ["tool:read"],
    parentGrant: ["tool:read"],
    result,
    blocked: false,
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  const round = JSON.parse(JSON.stringify(record));
  assert.equal("approved" in round, false);
  assert.equal("humanDenied" in round, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pi-agent-grants && npm test`
Expected: FAIL — `buildRecord` does not accept `approvalSource`

- [ ] **Step 3: Write minimal implementation**

In `packages/pi-agent-grants/src/ledger.ts`, add the import below the existing `resolve.ts` import:

```ts
import type { ApprovalScope, ApprovalSource } from "./approval.ts";
```

Add to `GrantRecord`, after `gatedBlocked`:

```ts
  /**
   * Gated capabilities satisfied for this spawn.
   *
   * The ledger used to have ONE flavour of no. It now has three, and they call for different responses:
   *  - `denied` non-empty            -> an agent asked for more than it holds. ESCALATION ATTEMPT.
   *  - `humanDenied`                 -> a person was asked and said no. WORKING AS DESIGNED.
   *  - `gatedBlocked` with no source -> nobody was there to ask. A background run hit a gate; the fix is
   *                                     an operator pre-approving it, not an incident.
   */
  approved?: Capability[];
  approvalSource?: ApprovalSource;
  /** Present only when the source was a live prompt. */
  approvalScope?: ApprovalScope;
  /** A human was asked and declined. Distinct from `denied`, which is an escalation attempt. */
  humanDenied?: boolean;
```

Add the same four as optional parameters to `buildRecord`'s argument object (after `reason?: string;`):

```ts
  approved?: Capability[];
  approvalSource?: ApprovalSource;
  approvalScope?: ApprovalScope;
  humanDenied?: boolean;
```

And in the returned object, after `reason: args.reason,` — assigning conditionally so absent stays absent
through `JSON.stringify`, keeping every existing record byte-identical:

```ts
    ...(args.approved && args.approved.length > 0 ? { approved: args.approved } : {}),
    ...(args.approvalSource ? { approvalSource: args.approvalSource } : {}),
    ...(args.approvalScope ? { approvalScope: args.approvalScope } : {}),
    ...(args.humanDenied ? { humanDenied: true } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/pi-agent-grants && npm test`
Expected: PASS — **115 tests** (111 + 4 new)

- [ ] **Step 5: Checkpoint**

Confirm 115 passing.

---

### Task 6: The prompt gate — `hasUI`, timeout, single-flight

**Files:**
- Create: `packages/pi-agent-grants/src/approval-prompt.ts`
- Test: `packages/pi-agent-grants/test/approval-prompt.test.ts`

**Interfaces:**
- Consumes: `ApprovalScope`, `ApprovalPath`, `approvalKey`, `offeredScopes` from `./approval.ts`
- Produces: `ApprovalUI`, `PromptRequest`, `PromptOutcome`, `SCOPE_LABELS`, `DENY_LABEL`,
  `timeoutMsFromEnv(raw): number | undefined`, `createApprovalGate(options): ApprovalGate` with
  `request(req: PromptRequest): Promise<PromptOutcome>`

- [ ] **Step 1: Write the failing test**

Create `packages/pi-agent-grants/test/approval-prompt.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApprovalGate, timeoutMsFromEnv, type ApprovalUI } from "../src/approval-prompt.ts";

const recordingUI = (answer: string | undefined) => {
  const calls: Array<{ title: string; options: string[] }> = [];
  const ui: ApprovalUI = {
    select: async (title, options) => {
      calls.push({ title, options });
      return answer;
    },
    notify: () => {},
  };
  return { ui, calls };
};

const req = (over = {}) => ({
  capability: "tool:write",
  subject: "docs-writer",
  path: "interceptor" as const,
  task: "fix the docs typos",
  ...over,
});

test("with no interactive user the gate denies without asking", async () => {
  const { ui, calls } = recordingUI("Allow once");
  const gate = createApprovalGate({ ui, hasUI: false, mode: "print" });
  const outcome = await gate.request(req());
  assert.equal(outcome.scope, null);
  assert.equal(calls.length, 0, "no dialog is attempted when there is nobody to see it");
});

test("the no-human refusal names the cause AND the fix", async () => {
  const { ui } = recordingUI(undefined);
  const gate = createApprovalGate({ ui, hasUI: false, mode: "print" });
  const outcome = await gate.request(req());
  assert.match(outcome.reason ?? "", /tool:write/);
  assert.match(outcome.reason ?? "", /print/, "says which mode it was in");
  assert.match(outcome.reason ?? "", /pre-approve/i, "says what to do about it");
});

test("dismissing the dialog denies", async () => {
  const { ui } = recordingUI(undefined);
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  assert.equal((await gate.request(req())).scope, null);
});

test("choosing deny denies", async () => {
  const { ui, calls } = recordingUI("Deny");
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  assert.equal((await gate.request(req())).scope, null);
  assert.equal(calls[0].options[0], "Deny", "deny is first, so the safe answer is the default");
});

test("allow once yields the once scope", async () => {
  const { ui } = recordingUI("Allow once");
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  assert.equal((await gate.request(req())).scope, "once");
});

test("the interceptor path offers always; the delegate path does not", async () => {
  const a = recordingUI("Deny");
  await createApprovalGate({ ui: a.ui, hasUI: true, mode: "tui" }).request(req());
  assert.equal(a.calls[0].options.length, 4);

  const b = recordingUI("Deny");
  await createApprovalGate({ ui: b.ui, hasUI: true, mode: "tui" }).request(req({ path: "delegate" }));
  assert.equal(b.calls[0].options.length, 3);
  assert.ok(!b.calls[0].options.some((o) => /always/i.test(o)));
});

test("the prompt shows the task, so the human sees what they are approving", async () => {
  const { ui, calls } = recordingUI("Deny");
  await createApprovalGate({ ui, hasUI: true, mode: "tui" }).request(req());
  const shown = `${calls[0].title}`;
  assert.match(shown, /tool:write/);
  assert.match(shown, /docs-writer/);
});

test("single-flight: two concurrent requests for the same key raise ONE dialog", async () => {
  let calls = 0;
  let release: (v: string) => void = () => {};
  const pending = new Promise<string>((r) => (release = r));
  const ui: ApprovalUI = {
    select: async () => {
      calls += 1;
      return pending;
    },
    notify: () => {},
  };
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  const both = Promise.all([gate.request(req()), gate.request(req())]);
  release("Allow once");
  const [a, b] = await both;
  assert.equal(calls, 1, "the second request awaited the first dialog");
  assert.equal(a.scope, "once");
  assert.equal(b.scope, "once");
});

test("different keys prompt separately", async () => {
  let calls = 0;
  const ui: ApprovalUI = {
    select: async () => {
      calls += 1;
      return "Allow once";
    },
    notify: () => {},
  };
  const gate = createApprovalGate({ ui, hasUI: true, mode: "tui" });
  await Promise.all([gate.request(req()), gate.request(req({ capability: "tool:bash" }))]);
  assert.equal(calls, 2);
});

test("the timeout env var is read in seconds and converted to milliseconds", () => {
  assert.equal(timeoutMsFromEnv("30"), 30_000);
  assert.equal(timeoutMsFromEnv(undefined), 120_000, "default is two minutes");
  assert.equal(timeoutMsFromEnv("0"), undefined, "zero means wait indefinitely");
  assert.equal(timeoutMsFromEnv("banana"), undefined, "unparseable means wait rather than guess");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/pi-agent-grants && npm test`
Expected: FAIL — `Cannot find module '../src/approval-prompt.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/pi-agent-grants/src/approval-prompt.ts`:

```ts
/**
 * The approval dialog — the only place a human enters the capability-governance path.
 *
 * Kept out of `extensions/grants.ts` deliberately: that file is wiring only, and this holds decisions
 * (what to offer, what a dismissal means, what happens with nobody watching) that must be testable
 * without pi. `ApprovalUI` is the minimal slice of pi's `ExtensionUIContext` needed here, so a test can
 * supply a plain object.
 *
 * Everything here denies on uncertainty. pi already agrees: in non-interactive modes it installs a
 * no-op UI context whose `select` resolves undefined, so even a missed `hasUI` check would deny.
 */

import { approvalKey, offeredScopes, type ApprovalPath, type ApprovalScope } from "./approval.ts";
import type { Capability } from "./resolve.ts";

/** The slice of pi's `ExtensionUIContext` this module needs. */
export interface ApprovalUI {
  select(
    title: string,
    options: string[],
    opts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export const DENY_LABEL = "Deny";

export const SCOPE_LABELS: Record<ApprovalScope, string> = {
  once: "Allow once",
  session: "Allow for this session",
  always: "Always allow in this project (30 days)",
};

export interface PromptRequest {
  capability: Capability;
  /** Agent type name, or `DELEGATE_SUBJECT` on the delegate path. */
  subject: string;
  path: ApprovalPath;
  /** Shown to the human for context. Never part of a key. */
  task?: string;
  signal?: AbortSignal;
}

export interface PromptOutcome {
  /** The scope the human chose, or null for any form of no. */
  scope: ApprovalScope | null;
  /** Why, when the answer was no. */
  reason?: string;
}

export interface ApprovalGateOptions {
  ui: ApprovalUI;
  /** pi's `ctx.hasUI` — false in print/json mode, and therefore in every governed child. */
  hasUI: boolean;
  /** pi's `ctx.mode`, quoted back in the refusal so an operator can see why. */
  mode: string;
  timeoutMs?: number;
}

export interface ApprovalGate {
  request(request: PromptRequest): Promise<PromptOutcome>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Read `PI_GRANTS_APPROVAL_TIMEOUT`, in SECONDS, into the milliseconds pi expects.
 *
 * `0` or an unparseable value means no timeout: waiting forever denies nothing, so it is the safe
 * interpretation of a value we do not understand.
 */
export function timeoutMsFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

function labelToScope(label: string, scopes: ApprovalScope[]): ApprovalScope | null {
  return scopes.find((s) => SCOPE_LABELS[s] === label) ?? null;
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  /**
   * One dialog per approval key at a time.
   *
   * `delegate` sets no `executionMode`, so an orchestrator can fan out several children at once and two
   * can hit the same gate simultaneously — otherwise two stacked dialogs asking the identical question.
   */
  const inFlight = new Map<string, Promise<PromptOutcome>>();

  const ask = async (request: PromptRequest): Promise<PromptOutcome> => {
    const scopes = offeredScopes(request.path);
    const title =
      `grants: approve ${request.capability} for ${request.subject}?` +
      (request.task ? `\n  task: ${request.task}` : "");

    let chosen: string | undefined;
    try {
      chosen = await options.ui.select(title, [DENY_LABEL, ...scopes.map((s) => SCOPE_LABELS[s])], {
        timeout: options.timeoutMs,
        signal: request.signal,
      });
    } catch (error) {
      // A governance layer that errors must deny, not permit.
      return { scope: null, reason: `approval dialog failed, denying (${String(error)})` };
    }

    // undefined covers dismissal, timeout, and abort. All are a no.
    if (chosen === undefined) return { scope: null, reason: `approval for ${request.capability} was dismissed` };
    if (chosen === DENY_LABEL) return { scope: null, reason: `${request.capability} was denied by a human` };

    const scope = labelToScope(chosen, scopes);
    return scope === null
      ? { scope: null, reason: `unrecognised approval choice ${JSON.stringify(chosen)}, denying` }
      : { scope };
  };

  return {
    async request(request: PromptRequest): Promise<PromptOutcome> {
      if (!options.hasUI) {
        return {
          scope: null,
          reason:
            `${request.capability} requires approval and this session has no interactive user ` +
            `(mode: ${options.mode}). Pre-approve it in an interactive session, or drop it from the request.`,
        };
      }

      const key = approvalKey(request.capability, request.subject);
      const existing = inFlight.get(key);
      if (existing) return existing;

      const pending = ask(request).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/pi-agent-grants && npm test`
Expected: PASS — **126 tests** (115 + 11 new)

- [ ] **Step 5: Checkpoint**

Confirm 126 passing.

---

### Task 7: Wire approval into both call sites

**Files:**
- Modify: `packages/pi-agent-grants/extensions/grants.ts` — imports, session state, `tool_call` handler
  (`:107-149`), `delegate.execute` (`:177-233`)

**Interfaces:**
- Consumes: everything from Tasks 1–6
- Produces: no new exports; behaviour only

**Note:** `src/interceptor.ts` and `planDelegation`'s resolution logic are **not** modified —
`DecisionContext.approved` and `DelegationContext.approved` already flow into `resolve()`.

- [ ] **Step 1: Add imports and session state**

In `packages/pi-agent-grants/extensions/grants.ts`, extend the imports:

```ts
import {
  DELEGATE_SUBJECT,
  approvalKey,
  expiryFor,
  resolveApprovals,
  type ApprovalPath,
  type ApprovalSource,
  type ApprovalScope,
} from "../src/approval.ts";
import { loadApprovals, revokeAll, revokeApproval, saveApproval } from "../src/approval-store.ts";
import { createApprovalGate, timeoutMsFromEnv } from "../src/approval-prompt.ts";
import { ceilingFor } from "../src/agent-types.ts";
```

Add `ENV_APPROVED` to the existing `../src/propagation.ts` import list.

Inside the default export, after `let catalog: Catalog = makeCatalog([]);`:

```ts
  /** Approval keys approved for this session. In memory only — this dies with the process. */
  const sessionApprovals = new Set<string>();
  /** Approvals inherited from the delegator, already clamped to this session's grant upstream. */
  const inheritedApprovals = parseList(process.env[ENV_APPROVED]);

  /** Current ceiling for an agent type, for the confused-deputy check in the store. */
  const ceilingOf = (subject: string) => {
    const type = types.get(subject);
    return type ? ceilingFor(type) : null;
  };
```

Extend `publishChildEnv` to carry approvals — the value is a parent-level fact (this session's own
approvals ∩ its own grant), identical for every sibling:

```ts
  const publishChildEnv = () => {
    const env = childEnv({
      ownGrant,
      depth,
      maxDepth,
      gated,
      ledgerPath,
      approved: [...inheritedApprovals, ...sessionApprovalCapabilities()],
    });
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
  };
```

and add the helper just above it:

```ts
  /** Capabilities (not keys) approved this session, for propagation. */
  const sessionApprovalCapabilities = (): Capability[] =>
    [...sessionApprovals].map((key) => key.slice(0, key.indexOf("@")));
```

- [ ] **Step 2: Add the shared approval routine**

Still inside the default export, after `publishChildEnv`:

```ts
  /**
   * Satisfy as many gated capabilities as possible, asking a human only for what is left.
   *
   * Returns what was approved and how, so the caller can re-resolve and the ledger can record which of
   * the three flavours of "no" applies.
   */
  const obtainApprovals = async (
    gatedBlocked: Capability[],
    subject: string,
    path: ApprovalPath,
    ctx: { ui: Parameters<typeof createApprovalGate>[0]["ui"]; hasUI: boolean; mode: string },
    task?: string,
    signal?: AbortSignal,
  ): Promise<{
    approved: Capability[];
    source?: ApprovalSource;
    scope?: ApprovalScope;
    humanDenied: boolean;
    reason?: string;
  }> => {
    const { valid } = await loadApprovals({ cwd, now: new Date(), ceilingOf });
    const pre = resolveApprovals({
      gated: gatedBlocked,
      subject,
      sessionApprovals,
      persisted: valid,
      inherited: inheritedApprovals,
    });
    if (pre.needsPrompt.length === 0) {
      return {
        approved: pre.approved,
        source: pre.approved.length > 0 ? pre.sources[pre.approved[0]] : undefined,
        humanDenied: false,
      };
    }

    const gate = createApprovalGate({
      ui: ctx.ui,
      hasUI: ctx.hasUI,
      mode: ctx.mode,
      timeoutMs: timeoutMsFromEnv(process.env.PI_GRANTS_APPROVAL_TIMEOUT),
    });

    const approved = [...pre.approved];
    let scope: ApprovalScope | undefined;
    let humanDenied = false;
    let reason: string | undefined;

    for (const capability of pre.needsPrompt) {
      const outcome = await gate.request({ capability, subject, path, task, signal });
      if (outcome.scope === null) {
        humanDenied = ctx.hasUI; // with no UI nobody was asked, so nobody declined
        reason = outcome.reason;
        break;
      }
      approved.push(capability);
      scope = outcome.scope;

      if (outcome.scope === "session" || outcome.scope === "always") {
        sessionApprovals.add(approvalKey(capability, subject));
      }
      if (outcome.scope === "always") {
        const now = new Date();
        const currentCeiling = ceilingOf(subject);
        const written = await saveApproval(
          cwd,
          approvalKey(capability, subject),
          {
            approvedAt: now.toISOString(),
            expiresAt: expiryFor(now),
            cwd,
            grantAtApproval: currentCeiling ?? [],
            taskAtApproval: task,
          },
          ceilingOf,
          now,
        );
        if (!written) {
          // The human already said yes; the security decision stands. Only the convenience cache failed.
          ctx.ui.notify(
            `grants: could not persist the approval for ${capability} — it applies for this session only`,
            "warning",
          );
          scope = "session";
        }
      }
      publishChildEnv(); // a new session approval widens what children may inherit
    }

    return { approved, source: approved.length > 0 ? (scope ? "prompt" : pre.sources[approved[0]]) : undefined, scope, humanDenied, reason };
  };
```

- [ ] **Step 3: Wire the `tool_call` handler**

In the `tool_call` handler, replace the block between the `decideSpawn` try/catch and the ledger write
with a re-resolution pass. Insert immediately after the `catch` closing brace:

```ts
    let approvalOutcome: Awaited<ReturnType<typeof obtainApprovals>> | undefined;
    if (!decision.allow && (decision.result?.gatedBlocked.length ?? 0) > 0) {
      approvalOutcome = await obtainApprovals(
        decision.result?.gatedBlocked ?? [],
        decision.typeName,
        "interceptor",
        ctx,
      );
      if (approvalOutcome.approved.length > 0) {
        // Same pure function, second call — the ONLY difference is that `approved` is now filled.
        decision = decideSpawn(
          { subagentType: decision.typeName },
          { parentGrant: ownGrant, depth, maxDepth, types, gated, approved: approvalOutcome.approved },
        );
      }
      if (!decision.allow && approvalOutcome.reason) decision.reason = approvalOutcome.reason;
    }
```

Change `let decision;` to `let decision: ReturnType<typeof decideSpawn>;` so it can be reassigned.

Then extend the `buildRecord` call in the ledger block with the four new fields:

```ts
          approved: approvalOutcome?.approved,
          approvalSource: approvalOutcome?.source,
          approvalScope: approvalOutcome?.scope,
          humanDenied: approvalOutcome?.humanDenied,
```

- [ ] **Step 4: Wire `delegate.execute`**

In `delegate.execute`, replace the single `planDelegation` call with a prompt-and-retry:

```ts
      let plan = planDelegation(
        { task: params.task, tools: params.tools, model: params.model ?? ctx.model?.id },
        { ownGrant, depth, maxDepth, gated, ledgerPath, extensionPath, catalog, approved: inheritedApprovals },
      );

      let approvalOutcome: Awaited<ReturnType<typeof obtainApprovals>> | undefined;
      if (!plan.ok && (plan.result?.gatedBlocked.length ?? 0) > 0) {
        approvalOutcome = await obtainApprovals(
          plan.result?.gatedBlocked ?? [],
          DELEGATE_SUBJECT,
          "delegate",
          ctx,
          params.task,
          signal,
        );
        if (approvalOutcome.approved.length > 0) {
          plan = planDelegation(
            { task: params.task, tools: params.tools, model: params.model ?? ctx.model?.id },
            {
              ownGrant, depth, maxDepth, gated, ledgerPath, extensionPath, catalog,
              approved: [...inheritedApprovals, ...approvalOutcome.approved],
            },
          );
        }
        if (!plan.ok && approvalOutcome.reason) plan = { ...plan, reason: approvalOutcome.reason };
      }
```

and add the same four fields to this call site's `buildRecord`.

- [ ] **Step 5: Run the suite and verify nothing regressed**

Run: `cd packages/pi-agent-grants && npm test`
Expected: PASS — **126 tests**, unchanged. This task adds wiring, which Task 10 verifies live.

Then typecheck per Global Constraints. Expected: clean.

---

### Task 8: `/grants approvals` and `/grants revoke`

**Files:**
- Modify: `packages/pi-agent-grants/extensions/grants.ts:236-254` (the `grants` command handler)

**Interfaces:**
- Consumes: `loadApprovals`, `revokeApproval`, `revokeAll` from Task 3
- Produces: no new exports

- [ ] **Step 1: Replace the command handler**

Replace the `pi.registerCommand("grants", …)` handler body with a small subcommand dispatch:

```ts
    handler: async (args, ctx) => {
      const [sub, target] = (args ?? "").trim().split(/\s+/).filter(Boolean);

      if (sub === "approvals") {
        const { valid, dropped } = await loadApprovals({ cwd, now: new Date(), ceilingOf });
        const lines = [`grants: ${valid.size} persisted approval${valid.size === 1 ? "" : "s"}`];
        for (const [key, entry] of valid) {
          lines.push(`  ${key}`);
          lines.push(`    approved ${entry.approvedAt}, expires ${entry.expiresAt}`);
          if (entry.taskAtApproval) lines.push(`    for: ${entry.taskAtApproval}`);
        }
        // Dropped entries are SHOWN, not silently omitted — otherwise a revoked-by-expiry approval looks
        // like one that was never given.
        for (const d of dropped) lines.push(`  (ignored) ${d.key} — ${d.verdict}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "revoke") {
        if (target === "--all") {
          await revokeAll(cwd);
          ctx.ui.notify("grants: all persisted approvals revoked", "info");
        } else if (!target) {
          ctx.ui.notify("grants: usage — /grants revoke <capability>@<agent-type> | --all", "warning");
        } else {
          const removed = await revokeApproval(cwd, target);
          ctx.ui.notify(
            removed ? `grants: revoked ${target}` : `grants: no persisted approval named ${target}`,
            removed ? "info" : "warning",
          );
        }
        return;
      }

      const { valid } = await loadApprovals({ cwd, now: new Date(), ceilingOf });
      const lines = [
        governed ? "grants: ACTIVE" : "grants: inactive (set PI_GRANTS_GRANT to govern this session)",
        `  holding    ${ownGrant.join(", ") || "(nothing)"}${observed ? " (observed)" : " (inherited, not yet observed)"}`,
        `  depth      ${depth} of max ${maxDepth}${maxDepth <= 0 ? " (spawning disabled)" : ""}`,
        `  ledger     ${ledgerPath ?? "(not recording — set PI_GRANTS_LEDGER)"}`,
        `  gated      ${gated.join(", ") || "(nothing gated)"}`,
        `  approvals  ${sessionApprovals.size} this session, ${valid.size} persisted` +
          `${inheritedApprovals.length > 0 ? `, ${inheritedApprovals.length} inherited` : ""}` +
          ` — /grants approvals`,
        `  catalog    ${catalog.all.length} capabilities — ` +
          `${catalog.byKind("builtin").length} builtin, ${catalog.byKind("extension").length} extension, ` +
          `${catalog.byKind("skill").length} skill, ${catalog.byKind("agentType").length} agent-type`,
      ];
      for (const [name] of [...types].slice(0, 12)) {
        const d = decideSpawn({ subagentType: name }, { parentGrant: ownGrant, depth, maxDepth, types, gated });
        lines.push(`    ${d.allow ? "allow" : "BLOCK"}  ${name}${d.allow ? "" : ` — ${d.reason}`}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
```

Also update the command's `description` to mention the subcommands:

```ts
    description: "Show this session's grant, depth, gated capabilities and approvals; /grants approvals | /grants revoke <key>|--all",
```

- [ ] **Step 2: Run the suite**

Run: `cd packages/pi-agent-grants && npm test`
Expected: PASS — **126 tests**, unchanged.

- [ ] **Step 3: Typecheck**

Per Global Constraints. Expected: clean.

- [ ] **Step 4: Checkpoint**

Verified live in Task 10, scenarios 4–5.

---

### Task 9: Public surface and documentation

**Files:**
- Modify: `packages/pi-agent-grants/src/index.ts`, `packages/pi-agent-grants/package.json`,
  `packages/pi-agent-grants/README.md`, `docs/SESSION-LOG.md`

- [ ] **Step 1: Extend the exports**

Append to `packages/pi-agent-grants/src/index.ts`:

```ts
export {
  APPROVAL_TTL_DAYS,
  DELEGATE_SUBJECT,
  approvalKey,
  entryVerdict,
  expiryFor,
  inheritApprovals,
  offeredScopes,
  resolveApprovals,
  type ApprovalEntry,
  type ApprovalPath,
  type ApprovalScope,
  type ApprovalSource,
  type EntryVerdict,
} from "./approval.ts";

export {
  approvalsPath,
  loadApprovals,
  revokeAll,
  revokeApproval,
  saveApproval,
  type DroppedApproval,
} from "./approval-store.ts";

export {
  createApprovalGate,
  timeoutMsFromEnv,
  type ApprovalGate,
  type ApprovalUI,
  type PromptOutcome,
  type PromptRequest,
} from "./approval-prompt.ts";
```

Add to `package.json`'s `exports`:

```json
    "./approval": "./src/approval.ts",
    "./approval-store": "./src/approval-store.ts",
    "./approval-prompt": "./src/approval-prompt.ts"
```

and bump `"version"` to `"0.4.0"` — this adds a feature without breaking the existing API.

- [ ] **Step 2: Update the README**

Replace the *"What does not exist yet"* clause in the **Status** section, which currently reads
"a human-approval UX for gated capabilities (they currently just refuse)". The status becomes **0.4.0**
and lists only background/streaming delegation as missing.

Add a new section after *"Governed delegation — the `delegate` tool"*:

````markdown
## Approving a gated capability

`gated` capabilities are ones a session holds but may not pass on without a human saying so. They used to
just refuse. Now they ask:

```
grants: approve tool:write for docs-writer?
  task: fix the docs typos

> Deny
  Allow once
  Allow for this session
  Always allow in this project (30 days)
```

- **`always` is offered only for agent types**, never for `delegate`. An agent type is a `.md` file you
  wrote, so `docs-writer` is a key you control. `delegate`'s only subject would be a task string and a
  tool list, both chosen by the model — and a key the model controls is not a key.
- **An approval rides down with the grant**, intersected with what each child actually receives. So
  `approved ⊆ grant` holds at every level: an approval unblocks part of a grant, it can never widen one.
- **`--print` and background runs have no interactive user**, so they refuse with a reason naming the
  fix. This is pi's own behaviour, not ours — non-interactive modes install a no-op UI context whose
  `select` resolves `undefined`.
- **Persisted approvals expire after 30 days**, are void once their agent type's `tools:` line changes,
  and are ignored entirely in any directory other than the one they were approved in — so a committed
  `.pi/grants-approvals.json` authorises nobody who clones the repo (R-27).

```
/grants approvals                       list them, with why any are being ignored
/grants revoke tool:write@docs-writer   take one back
/grants revoke --all
```
````

- [ ] **Step 3: Update the session log**

In `docs/SESSION-LOG.md`, move item 1 out of **Next actions** and add a dated entry recording: the feature
shipped at 0.4.0, ADR-0010 and R-27 created, and the pi-fabric divergence on inheritance/persistence
accepted deliberately.

- [ ] **Step 4: Run the suite**

Run: `cd packages/pi-agent-grants && npm test`
Expected: PASS — **126 tests**.

---

### Task 10: Live verification against real pi

**Files:**
- Create: `docs/probes/approval-ux/README.md` (per the probe convention in `.claude/rules/phase-gates.md`)

This package's claims are verified against real pi, not only unit tests — the README documents live
scenarios beside every claim, and this feature must meet the same bar. Nothing outside `docs/probes/` may
import from the probe.

- [ ] **Step 1: Prepare a gated fixture**

Create a scratch agent type at `.pi/agents/docs-writer.md` in a temporary directory:

```markdown
---
name: docs-writer
tools: read, write
---
Fix documentation typos.
```

- [ ] **Step 2: Run the eight scenarios**

Record the outcome and the resulting ledger line for each:

| # | Scenario | Expected |
| :--- | :--- | :--- |
| 1 | TUI, `PI_GRANTS_GATED=tool:write`, spawn `docs-writer`, **Allow once** | spawn proceeds; ledger `approvalSource: "prompt"`, `approvalScope: "once"` |
| 2 | Same, **Deny** | refused; ledger `humanDenied: true`, `denied: []` |
| 3 | `pi --print` with the same config | refused, reason names `mode: print` and says pre-approve; nothing written to `.pi/grants-approvals.json` |
| 4 | **Always allow**, quit pi, restart, spawn again | no prompt; ledger `approvalSource: "persisted"` |
| 5 | `/grants revoke tool:write@docs-writer`, spawn again | prompts again |
| 6 | Approve `write` for a child holding `tool:delegate`; child sub-delegates `write` to a grandchild | allowed; grandchild ledger line at depth 2 shows `approvalSource: "inherited"` |
| 7 | Copy `.pi/grants-approvals.json` to another directory and run there | ignored; `/grants approvals` shows `(ignored) … — foreign-cwd` |
| 8 | Approve always, then edit `docs-writer.md` to add `bash` to `tools:` | prompts again; `/grants approvals` shows `(ignored) … — type-changed` |

- [ ] **Step 3: Write the probe README**

Document what was measured, the exact commands to rerun, and the observed output for each scenario —
matching the format of `docs/probes/pi-fabric-eval/`.

- [ ] **Step 4: Record results in the package README**

Add a *"Verified live"* table for approvals, mirroring the existing ones. Any scenario that does not
behave as predicted is a plan failure, not a documentation problem — fix the code and rerun.

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
| :--- | :--- |
| §2 prompt-then-re-resolve; `resolve.ts` untouched | 7 (and the Global Constraint forbidding edits) |
| §3.1 delegate subject `<delegate>` | 1 |
| §3.2 propagation, `approved ⊆ grant` | 1, 4 |
| §4.1 `approval.ts`, precedence, `hasUI` | 1, 2, 6 |
| §4.2 store, file format, read-on-demand | 3 |
| §4.3 `ENV_APPROVED` | 4 |
| §4.4 wiring | 7 |
| §4.5 ledger fields | 5 |
| §5 lifecycle: revoke, ceiling check, expiry, cwd | 2, 3, 8 |
| §6 error handling incl. write-failure downgrade | 3, 6, 7 |
| §6.1 single-flight | 6 |
| §7.1–7.3 unit tests | 1, 2, 3, 6 |
| §7.4 live verification | 10 |
| §8 non-goals | not built — correct |
| §9 `bash` gating open item | not built — correct, carried on R-25 |

**Type consistency** — checked across tasks: `ApprovalScope`/`ApprovalSource`/`ApprovalPath` are defined
once in Task 1 and imported everywhere after; `approvalKey(capability, subject)` keeps that argument order
at all five call sites; `saveApproval(cwd, key, entry, ceilingOf, now)` matches its use in Task 7;
`loadApprovals` returns `{ valid, dropped }` in Tasks 3, 7, and 8 alike; `PromptOutcome.scope` is
`ApprovalScope | null` in both Task 6 and its Task 7 consumer.

**One gap found and closed during review:** Task 7's `publishChildEnv` originally propagated only
`inheritedApprovals`, which would have meant a *session* approval granted at the root never reached
children on the interceptor path — silently breaking the inheritance ADR-0010 chose. It now propagates
inherited **plus** session approvals, and is re-called after each new session approval.
