# Observable Governed Children — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

> **DO NOT START until ADR-0031 and ADR-0032 are Accepted.** Both are `Proposed` as of 2026-08-17. ADR-0031
> reverses part of ADR-0016 point 6; implementing a Proposed reversal is how a record stops describing the
> code.

**Goal:** a governed child runs where it can be seen — herdr panes chosen by probe rather than by an
undiscovered environment variable — and the parent shows what each child is doing while it runs.

**Architecture:** two ADRs, one shipment. `planSpawn` still owns the argv and both executors still enforce the
identical grant; what changes is *selection* (a probe, ADR-0031), *disclosure* (the executor is named at
session start, in `/grants`, and per child in the ledger), and *observability* (output streamed through pi's
`onUpdate`, panes living until `agent_settled`). Nothing in this plan touches `resolve.ts`, the gate, the
depth bound or the fan-out budget.

**Tech Stack:** TypeScript on Node ≥22.19 (type-stripping, no build step for `src/` under test), `node:test`,
`typebox` for tool schemas, `@earendil-works/pi-coding-agent` ≥0.83 as a peer, herdr 0.7.5 CLI over
`execFile`.

**Spec:** `docs/06-decisions/ADR-0031-the-executor-is-probed-not-declared.md` and
`docs/06-decisions/ADR-0032-a-delegation-is-observable-while-it-runs.md`. Read both before Task 1. ADR-0033
(chain) is a **separate plan** — it shares no files with Tasks 3–10 and must not be folded in.

## Global Constraints

- **No shipped module may exceed 400 lines.** `test/file-size.test.ts` enforces it over `src/` and
  `extensions/`. Tasks 1 and 2 exist purely because `extensions/grants.ts` is at **398** and
  `src/run-herdr.ts` at **357**. **Never raise `MAX_LINES`** — this project split `delegate.ts` at 413 rather
  than raise it, and the rule is "when a guard fails, obey it."
- **Every fixture directory comes from `test/tmp.ts`.** `test/temp-hygiene.test.ts` fails if a suite calls
  `mkdtemp` directly. Use the helper and `after(cleanupTempDirs)`.
- **A test that cannot fail is worse than no test** (working rule 7). Each task below names the production
  change that breaks its test. If you add a test, name that too.
- **Fail closed and be loud** (working rule 8). Malformed configuration disables the risky path and says so,
  naming the variable.
- **`AgentToolResult` has no `isError` field.** A refusal must `throw` from `execute`; a returned
  `isError: true` is silently discarded by pi.
- **Never throw into the agent loop from a hook.** Every hook body in `extensions/grants.ts` is wrapped; keep
  it that way, and make each new control's `try` its own (R-60: one added `await` inside a shared `catch`
  cancels every control below it, silently).
- **The streamed text is never the result.** ADR-0032 is explicit: display only. The tool's result stays what
  the child produced at settle.
- Verification gate for every task: `npm test && npm run typecheck` from `packages/pi-daddy`.

---

## File Structure

**New:**

| File | Responsibility |
| :--- | :--- |
| `extensions/session-report.ts` | Everything said at `session_start` — the notify calls and their conditions. Lifted out of `grants.ts` to make room, exactly as `grants-command.ts` and `session.ts` were. |
| `src/herdr-cli.ts` | The herdr CLI protocol: `HerdrExec`, `defaultExec`, `parseReply`, and `probeHerdr`. Shared by the executor and the session probe, which is why it is not left inside `run-herdr.ts`. |
| `src/executor.ts` | `chooseExecutor` — the three-state `PI_GRANTS_HERDR` decision as a pure function over the probe result. |
| `src/progress.ts` | The status block: per-child state, tail buffering, and rendering. Pure; no pi, no herdr. |
| `test/executor.test.ts`, `test/progress.test.ts`, `test/herdr-cli.test.ts` | Unit suites for the three new pure modules. |

**Modified:**

| File | Change |
| :--- | :--- |
| `extensions/grants.ts` | Delegates session-start reporting to `session-report.ts`; gains the `agent_settled` hook. Must end **under 400 lines**. |
| `extensions/session.ts` | `useHerdr: boolean` becomes `executor: ExecutorChoice`. |
| `extensions/run-delegation.ts` | Picks the executor from the choice, refuses when forced-and-unreachable, threads progress through. |
| `extensions/delegation.ts` | Forwards progress to `onUpdate` in both tools. |
| `extensions/grants-command.ts` | One `executor` line in the status screen. |
| `src/run-child.ts` | Optional `onOutput` called from `capture`. |
| `src/run-herdr.ts` | Imports the protocol from `herdr-cli.ts`; polls `agent read` for the tail; stops closing the tab in `cleanup`. |
| `src/pane-reaper.ts` | `MAX_OPEN_PANES`, `trimOpenPanes`, `reapOpenPanesAsync`. |
| `src/ledger.ts` | `executor` field on a record. |

---

### Task 1: Make room in `grants.ts` — extract session-start reporting

Pure refactor. No behaviour change, and the test that proves it is the existing suite.

**Files:**
- Create: `packages/pi-daddy/extensions/session-report.ts`
- Modify: `packages/pi-daddy/extensions/grants.ts:65-274` (the `session_start` handler)
- Test: `packages/pi-daddy/test/file-size.test.ts` (existing), `test/session-start-guard.test.ts` (existing)

**Interfaces:**
- Consumes: `GrantsSession` from `./session.ts`; `planWithApprovals` from `./run-delegation.ts`.
- Produces: `reportSessionStart(session: GrantsSession, ctx: SessionReportContext): Promise<void>` where
  `SessionReportContext` is `{ cwd: string; ui: { notify(message: string, level: "info" | "warning" | "error"): void } }`.

- [ ] **Step 1: Prove the ceiling is the blocker**

Run: `cd packages/pi-daddy && wc -l extensions/grants.ts`
Expected: `398`. Two lines of headroom against `MAX_LINES = 400`. This is why Task 1 exists.

- [ ] **Step 2: Create `extensions/session-report.ts`**

Move, verbatim and comments intact, everything inside the `session_start` handler's outer `try` **except**
`session.publishChildEnv()` and `delegation.refreshSpawnable()` — those are wiring, not reporting, and must
stay in `grants.ts` where the `delegation` holder lives.

```ts
/**
 * Everything this extension says at session start.
 *
 * Lifted out of `extensions/grants.ts` for the reason `grants-command.ts` and `session.ts` were: that file is
 * where every wiring bug in this package has lived, and it was at 398 of the 400-line ceiling
 * `test/file-size.test.ts` enforces. ADR-0032 adds a control here, so the file had to be split before it
 * could be added — the alternative was raising the cap, which is how a guard stops guarding.
 *
 * The seam is deliberate and it is the same one twice over: `grants.ts` keeps the HOOKS and the wiring;
 * this module decides what an operator is TOLD. Nothing here returns a value or mutates the session.
 *
 * Each control keeps its own `try`. That is R-60's lesson, not tidiness: one added `await` inside a shared
 * `catch` cancels every control below it with no trace.
 */

import { existsSync } from "node:fs";
import { legacyApprovalsPath, sharedApprovalsPath } from "../src/approval-store.ts";
import { verifyLedger } from "../src/ledger.ts";
import { AGENT_WILDCARD } from "../src/resolve.ts";
import { planWithApprovals } from "./run-delegation.ts";
import type { GrantsSession } from "./session.ts";
import { renderSpawnableSummary, summariseSpawnable } from "./spawn-summary.ts";

export interface SessionReportContext {
  cwd: string;
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
}

export async function reportSessionStart(session: GrantsSession, ctx: SessionReportContext): Promise<void> {
  // …the moved bodies, in the SAME ORDER as before: malformed bounds, shared-approvals notice,
  // legacy-approvals notice, agent:*+bash warning, inert agent: gates, ledger verification, the
  // `holding [...]` banner, then the spawnable summary in its own try/catch.
}
```

- [ ] **Step 3: Rewrite the `session_start` handler in `grants.ts` to call it**

```ts
  pi.on("session_start", async (_event, ctx) => {
    session.cwd = ctx.cwd;
    if (session.storeCwd !== ctx.cwd && process.env[ENV_GRANT] === undefined) {
      ctx.ui.notify(
        `grants: this session's stored grant was read for ${session.storeCwd}, but pi is working in ` +
          `${ctx.cwd}. A grant belongs to a directory, so run /grants init here, or set PI_GRANTS_GRANT ` +
          `explicitly — the environment always wins.`,
        "warning",
      );
    }
    try {
      try {
        await loadProjectDefinitions(session, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(
          `grants: could not read this project's definitions or capability catalog ` +
            `(${error instanceof Error ? error.message : String(error)}) — no SKILL.md definition can be ` +
            `spawned this session, and delegation by tools: is unaffected. Governance itself is unaffected: ` +
            `it is enforced by --tools when a child is spawned.`,
          "error",
        );
      }
      session.publishChildEnv();
      delegation.refreshSpawnable();
      await reportSessionStart(session, ctx);
    } catch (error) {
      try {
        ctx.ui.notify(
          `grants: session start did not complete — ${error instanceof Error ? error.message : String(error)}. ` +
            `Checks and setup after the failure did not run, so definitions may be missing and a delegation ` +
            `may refuse. The grant itself is unaffected: it is enforced by --tools when a child is spawned.`,
          "error",
        );
      } catch {
        /* a UI that cannot be notified is the one failure there is nowhere to report */
      }
    }
    return undefined;
  });
```

- [ ] **Step 4: Run the full suite and the ceiling guard**

Run: `cd packages/pi-daddy && npm test && npm run typecheck`
Expected: PASS, unchanged count (364 unit tests). **The production change that breaks `file-size.test.ts`:**
folding `session-report.ts` back into `grants.ts`.

- [ ] **Step 5: Confirm the headroom exists**

Run: `wc -l extensions/grants.ts extensions/session-report.ts`
Expected: `grants.ts` comfortably under 300; both under 400.

- [ ] **Step 6: Commit**

```bash
git add extensions/grants.ts extensions/session-report.ts
git commit -m "refactor: extract session-start reporting out of grants.ts

extensions/grants.ts was at 398 of the 400-line ceiling test/file-size.test.ts
enforces, and ADR-0032 adds a control there. Split rather than raise the cap —
the same move grants-command.ts and session.ts were extracted under.

No behaviour change: the notify calls move verbatim, in the same order, each
keeping its own try/catch (R-60)."
```

---

### Task 2: Extract the herdr CLI protocol, and add the probe

**Files:**
- Create: `packages/pi-daddy/src/herdr-cli.ts`, `packages/pi-daddy/test/herdr-cli.test.ts`
- Modify: `packages/pi-daddy/src/run-herdr.ts:24-122` (remove `HerdrExec`, `defaultExec`, `parseReply`; import them)
- Modify: `packages/pi-daddy/package.json` (add a `./herdr-cli` export beside `./run-herdr`)

**Interfaces:**
- Produces:
  - `type HerdrExec = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>`
  - `const defaultExec: HerdrExec`
  - `function parseReply(reply: { stdout: string; stderr: string }): { result?: Record<string, unknown>; error?: string }`
  - `function probeHerdr(options?: { exec?: HerdrExec; timeoutMs?: number }): Promise<HerdrProbe>` where
    `interface HerdrProbe { ok: boolean; error?: string }`
  - `const PROBE_TIMEOUT_MS = 2000`
  - `function resolveWorkspace(env: NodeJS.ProcessEnv): string | undefined`
  - `const ENV_PARENT_WORKSPACE = "HERDR_WORKSPACE_ID"`
- Consumed by: Task 3 (`chooseExecutor` takes a `HerdrProbe`), Task 4 (the session runs the probe;
  `resolveWorkspace` feeds the `runHerdrPane` call), Task 9 and Task 10 (`run-herdr.ts` and the async reaper
  both need `HerdrExec`).

- [ ] **Step 1: Write the failing test**

`test/herdr-cli.test.ts`:

```ts
/**
 * The herdr CLI protocol, and the probe ADR-0031 selects the executor with.
 *
 * The production change that breaks these: making `probeHerdr` report `ok` on anything other than a parsed
 * `result` envelope. That is the whole point of ADR-0031 rejecting option C — a binary on PATH proves
 * nothing, only a server that ANSWERS does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PROBE_TIMEOUT_MS, parseReply, probeHerdr, type HerdrExec } from "../src/herdr-cli.ts";

test("the probe asks `tab list`, because it is the cheapest command that proves a server answered", async () => {
  const calls: string[][] = [];
  const exec: HerdrExec = async (args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ id: "x", result: { type: "tab_list", tabs: [] } }), stderr: "" };
  };
  const probe = await probeHerdr({ exec });
  assert.equal(probe.ok, true);
  assert.deepEqual(calls, [["tab", "list"]]);
});

test("an empty tab list is still a reachable server", async () => {
  // A fresh herdr with no tabs must not read as "herdr is down". Zero tabs is an ANSWER.
  const exec: HerdrExec = async () => ({ code: 0, stdout: JSON.stringify({ id: "x", result: { tabs: [] } }), stderr: "" });
  assert.equal((await probeHerdr({ exec })).ok, true);
});

test("a missing binary is not reachable, and the reason survives", async () => {
  const exec: HerdrExec = async () => ({ code: 1, stdout: "", stderr: "herdr: command not found" });
  const probe = await probeHerdr({ exec });
  assert.equal(probe.ok, false);
  assert.match(probe.error ?? "", /command not found/);
});

test("a binary that answers with an error envelope is not reachable", async () => {
  // The case option C could not distinguish: herdr installed, server down.
  const exec: HerdrExec = async () => ({
    code: 1,
    stdout: JSON.stringify({ id: "x", error: { code: "no_server", message: "could not connect to herdr" } }),
    stderr: "",
  });
  const probe = await probeHerdr({ exec });
  assert.equal(probe.ok, false);
  assert.match(probe.error ?? "", /could not connect/);
});

test("a probe that never returns is bounded, and a timeout is not reachable", async () => {
  const exec: HerdrExec = () => new Promise(() => {});
  const probe = await probeHerdr({ exec, timeoutMs: 20 });
  assert.equal(probe.ok, false);
  assert.match(probe.error ?? "", /timed out/);
});

test("the default probe timeout is short enough to sit on session start", () => {
  assert.ok(PROBE_TIMEOUT_MS <= 2000, "a session-start probe must not be a visible pause");
});

test("parseReply folds stderr into the message, so a wrapper never hides the substrate's reason", () => {
  const parsed = parseReply({ stdout: "", stderr: "socket missing" });
  assert.match(parsed.error ?? "", /socket missing/);
});

test("children default to the PARENT's workspace, so switching to one is a tab keystroke", () => {
  // Measured 2026-08-17: herdr sets HERDR_WORKSPACE_ID / HERDR_TAB_ID / HERDR_PANE_ID in every pane it
  // creates, so a pi session running under herdr knows its own workspace. Letting herdr choose put children
  // in a DIFFERENT workspace from the session that spawned them, making "switch between them" a workspace
  // hop. The production change that breaks this: reading only PI_GRANTS_HERDR_WORKSPACE again.
  assert.equal(resolveWorkspace({ HERDR_WORKSPACE_ID: "w7" }), "w7");
});

test("PI_GRANTS_HERDR_WORKSPACE overrides the parent's workspace, because it is the explicit answer", () => {
  assert.equal(
    resolveWorkspace({ HERDR_WORKSPACE_ID: "w7", PI_GRANTS_HERDR_WORKSPACE: "wB" }),
    "wB",
  );
});

test("outside a herdr pane there is no workspace to inherit, and herdr chooses", () => {
  assert.equal(resolveWorkspace({}), undefined);
});

test("a blank or whitespace workspace is treated as absent rather than passed through", () => {
  // `--workspace ""` is not a workspace; passing it would make `tab create` fail on a path nobody chose.
  assert.equal(resolveWorkspace({ HERDR_WORKSPACE_ID: "   " }), undefined);
  assert.equal(resolveWorkspace({ PI_GRANTS_HERDR_WORKSPACE: "", HERDR_WORKSPACE_ID: "w7" }), "w7");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/pi-daddy && node --test test/herdr-cli.test.ts`
Expected: FAIL — `Cannot find module '../src/herdr-cli.ts'`.

- [ ] **Step 3: Create `src/herdr-cli.ts`**

Move `HerdrExec`, `defaultExec` and `parseReply` out of `run-herdr.ts` **with their comments intact** — the
`parseReply` comment records why stderr is folded in, which was found by a real failed run. Then add:

```ts
/** Bound on the session-start probe. Short: it sits in front of the operator's first prompt. */
export const PROBE_TIMEOUT_MS = 2000;

export interface HerdrProbe {
  ok: boolean;
  /** herdr's own words when it is not reachable. Carried so the disclosure line can name the reason. */
  error?: string;
}

/**
 * Is there a herdr server that will answer right now?
 *
 * **`tab list`, not `which herdr`** — ADR-0031 rejects PATH detection as option C by name. A binary on PATH
 * with no server behind it would make every delegation fail at `tab create`, on a path the operator never
 * chose. Only a parsed `result` envelope counts as reachable; an `error` envelope, a non-JSON reply and a
 * timeout are all "not reachable" with the reason preserved.
 *
 * Zero tabs is a successful answer, deliberately: a fresh herdr with nothing open is reachable.
 */
export async function probeHerdr(options: { exec?: HerdrExec; timeoutMs?: number } = {}): Promise<HerdrProbe> {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<HerdrProbe>((settle) => {
    timer = setTimeout(() => settle({ ok: false, error: `probe timed out after ${timeoutMs}ms` }), timeoutMs);
  });

  try {
    const reply = await Promise.race([
      exec(["tab", "list"]).then((r) => {
        const parsed = parseReply(r);
        return parsed.error ? { ok: false, error: parsed.error } : { ok: true };
      }),
      timeout,
    ]);
    return reply;
  } catch (error) {
    // `defaultExec` never rejects, but an injected one may. A probe that throws is a probe that failed.
    return { ok: false, error: String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 3b: Add `resolveWorkspace` to `src/herdr-cli.ts`**

```ts
/** herdr's own variable, set in every pane it creates. Measured 2026-08-17, not documented anywhere. */
export const ENV_PARENT_WORKSPACE = "HERDR_WORKSPACE_ID";

/**
 * Which herdr workspace a governed child's pane belongs in.
 *
 * **Defaults to the parent's own workspace**, because herdr tells a pane which one it is in and a child in a
 * different workspace from the session that spawned it turns "switch between them" into a workspace hop —
 * which is the entire feature. `PI_GRANTS_HERDR_WORKSPACE` still wins: it is the operator saying so
 * explicitly, and the environment beating an inference is this package's standing rule (ADR-0030).
 *
 * Blank is treated as absent rather than passed through: `--workspace ""` is not a workspace, and it would
 * fail `tab create` on a path nobody chose.
 */
export function resolveWorkspace(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.PI_GRANTS_HERDR_WORKSPACE?.trim();
  if (explicit) return explicit;
  const inherited = env[ENV_PARENT_WORKSPACE]?.trim();
  return inherited || undefined;
}
```

- [ ] **Step 4: Re-export from `run-herdr.ts` so nothing else has to move yet**

`test/run-herdr.test.ts` imports `type HerdrExec` from `../src/run-herdr.ts`. Keep that working:

```ts
export { type HerdrExec, parseReply } from "./herdr-cli.ts";
```

- [ ] **Step 5: Run the new suite and the whole suite**

Run: `node --test test/herdr-cli.test.ts && npm test && npm run typecheck`
Expected: PASS. `run-herdr.test.ts` must pass **unmodified** — that is the proof the extraction changed no
behaviour.

- [ ] **Step 6: Add the package export**

In `package.json` `exports`, beside `./run-herdr`:

```json
    "./herdr-cli": {
      "types": "./dist/herdr-cli.d.ts",
      "default": "./dist/herdr-cli.js"
    },
```

- [ ] **Step 7: Commit**

```bash
git add src/herdr-cli.ts src/run-herdr.ts test/herdr-cli.test.ts package.json
git commit -m "feat(ADR-0031): probe for a REACHABLE herdr, not a herdr on PATH

Extracts the herdr CLI protocol out of run-herdr.ts (which was at 357 of the
400-line ceiling and gains output polling later) and adds probeHerdr.

The probe runs \`tab list\` and counts only a parsed result envelope as
reachable. ADR-0031 rejects PATH detection as option C by name: a binary with
no server behind it makes every delegation fail at \`tab create\`, on a path
nobody chose."
```

---

### Task 3: `chooseExecutor` — the three-state decision, as a pure function

**Files:**
- Create: `packages/pi-daddy/src/executor.ts`, `packages/pi-daddy/test/executor.test.ts`
- Modify: `packages/pi-daddy/package.json` (add `./executor` export)

**Interfaces:**
- Consumes: `HerdrProbe` from `./herdr-cli.ts` (Task 2).
- Produces:
  ```ts
  export const ENV_HERDR = "PI_GRANTS_HERDR";
  export type ExecutorKind = "herdr" | "process";
  export interface ExecutorChoice {
    kind: ExecutorKind;
    /** The operator named it: `PI_GRANTS_HERDR` was 0 or 1. */
    forced: boolean;
    /** Whether a probe was needed at all — false only for `0`. */
    probed: boolean;
    /** Set ONLY when herdr was demanded and is unreachable. Every delegation must refuse with this. */
    refusal?: string;
    /** One line for the session banner and `/grants`. */
    disclosure: string;
  }
  export function chooseExecutor(raw: string | undefined, probe: HerdrProbe | null): ExecutorChoice;
  export function needsProbe(raw: string | undefined): boolean;
  ```
- Consumed by: Task 4 (session), Task 5 (disclosure), Task 6 (ledger).

- [ ] **Step 1: Write the failing test**

`test/executor.test.ts`:

```ts
/**
 * ADR-0031's decision table, as a pure function.
 *
 * The production change that breaks these: making an unset variable mean `runChild` again (that is the
 * reversal), or making `PI_GRANTS_HERDR=1` fall back to the process executor when herdr is down (the
 * operator chose refusal over fallback on 2026-08-17, and the audit story is the reason).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseExecutor, needsProbe } from "../src/executor.ts";

const reachable = { ok: true };
const down = { ok: false, error: "could not connect to herdr" };

test("unset + reachable herdr means panes — this is ADR-0031's reversal", () => {
  const choice = chooseExecutor(undefined, reachable);
  assert.equal(choice.kind, "herdr");
  assert.equal(choice.forced, false);
  assert.equal(choice.refusal, undefined);
});

test("unset + no herdr means the captured subprocess, silently enough to be CI", () => {
  const choice = chooseExecutor(undefined, down);
  assert.equal(choice.kind, "process");
  assert.equal(choice.refusal, undefined, "an unforced fallback must never refuse a delegation");
});

test("`0` forces the subprocess and does not probe at all", () => {
  assert.equal(needsProbe("0"), false);
  const choice = chooseExecutor("0", null);
  assert.equal(choice.kind, "process");
  assert.equal(choice.forced, true);
  assert.equal(choice.probed, false);
});

test("`1` + reachable herdr means panes, and says it was demanded", () => {
  const choice = chooseExecutor("1", reachable);
  assert.equal(choice.kind, "herdr");
  assert.equal(choice.forced, true);
  assert.equal(choice.refusal, undefined);
});

test("`1` + herdr down REFUSES rather than falling back, and names the variable and the reason", () => {
  // The operator's decision, 2026-08-17: an operator who named the executor gets it or gets an error,
  // never a substitution. The ledger can then never contain a child that ran somewhere nobody chose.
  const choice = chooseExecutor("1", down);
  assert.equal(choice.kind, "herdr");
  assert.equal(choice.forced, true);
  assert.ok(choice.refusal, "a forced-and-unreachable executor must set a refusal");
  assert.match(choice.refusal, /PI_GRANTS_HERDR/);
  assert.match(choice.refusal, /could not connect to herdr/);
});

test("`1` still probes, so the failure is reported at session start rather than at the first delegation", () => {
  assert.equal(needsProbe("1"), true);
});

test("an unrecognised value fails CLOSED to the dependency-free executor, loudly", () => {
  // Rule 8. "yes"/"true"/"on" are the plausible typos, and a typo must not silently relocate a run.
  for (const raw of ["yes", "true", "on", "2", ""]) {
    const choice = chooseExecutor(raw, reachable);
    assert.equal(choice.kind, "process", `${JSON.stringify(raw)} should not select herdr`);
    assert.match(choice.disclosure, /PI_GRANTS_HERDR/);
    assert.equal(choice.refusal, undefined, "a malformed value must not break delegation outright");
  }
});

test("every outcome carries a disclosure line, because ADR-0031 rests on not being silent", () => {
  for (const [raw, probe] of [
    [undefined, reachable], [undefined, down], ["0", null], ["1", reachable], ["1", down], ["nonsense", down],
  ] as const) {
    const choice = chooseExecutor(raw, probe);
    assert.ok(choice.disclosure.length > 0);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/executor.test.ts`
Expected: FAIL — `Cannot find module '../src/executor.ts'`.

- [ ] **Step 3: Write `src/executor.ts`**

```ts
/**
 * Which executor runs a governed child — ADR-0031.
 *
 * `PI_GRANTS_HERDR` is three-state, and absent means **probe**. That reverses ADR-0016 point 6's opt-in, and
 * the reversal is narrow: nothing is detected from `herdr` being on `PATH` (option C, rejected by name), only
 * from a server that answered. The grant, the depth bound, the gate and `--tools` are identical either way;
 * `planSpawn` produces one plan and both executors enforce it.
 *
 * Pure on purpose. The probe is I/O and lives in `herdr-cli.ts`; the DECISION is a table, and a table that
 * can be read in one screen is the only reason a reversal like this is reviewable.
 */

import type { HerdrProbe } from "./herdr-cli.ts";

export const ENV_HERDR = "PI_GRANTS_HERDR";
export type ExecutorKind = "herdr" | "process";

export interface ExecutorChoice {
  kind: ExecutorKind;
  forced: boolean;
  probed: boolean;
  refusal?: string;
  disclosure: string;
}

/** `0` is the one value that needs no probe: the operator ruled herdr out. */
export function needsProbe(raw: string | undefined): boolean {
  return raw !== "0" && (raw === undefined || raw === "1");
}

export function chooseExecutor(raw: string | undefined, probe: HerdrProbe | null): ExecutorChoice {
  if (raw === "0") {
    return {
      kind: "process",
      forced: true,
      probed: false,
      disclosure: "captured subprocess (PI_GRANTS_HERDR=0) — children have no terminal",
    };
  }

  if (raw === "1") {
    if (probe?.ok) {
      return { kind: "herdr", forced: true, probed: true, disclosure: "herdr panes (PI_GRANTS_HERDR=1)" };
    }
    // Refusal, not fallback — the operator's decision of 2026-08-17. `kind` stays `herdr` so nothing
    // downstream can mistake this for a working process-executor session.
    const why = probe?.error ?? "the herdr probe did not succeed";
    return {
      kind: "herdr",
      forced: true,
      probed: true,
      refusal:
        `PI_GRANTS_HERDR=1 demands the herdr executor and herdr is not answering (${why}). ` +
        `Delegation is refused rather than quietly relocated to a captured subprocess, so this session's ` +
        `ledger can never contain a child that ran somewhere nobody chose. Start herdr, or unset ` +
        `PI_GRANTS_HERDR to let this session probe, or set PI_GRANTS_HERDR=0 to choose subprocesses.`,
      disclosure: `herdr panes DEMANDED but unreachable (${why}) — every delegation will refuse`,
    };
  }

  if (raw !== undefined) {
    // Rule 8: fail closed and be loud. An unrecognised value must not relocate a run, and must not break
    // delegation either — the operator meant something, and the dependency-free executor is the safe read.
    return {
      kind: "process",
      forced: false,
      probed: probe !== null,
      disclosure:
        `captured subprocess — PI_GRANTS_HERDR is set to an unrecognised value and was ignored. ` +
        `Use 1 (demand herdr), 0 (demand subprocesses), or unset it to probe.`,
    };
  }

  if (probe?.ok) {
    return {
      kind: "herdr",
      forced: false,
      probed: true,
      disclosure: "herdr panes (probed — herdr is answering)",
    };
  }
  return {
    kind: "process",
    forced: false,
    probed: true,
    disclosure:
      `captured subprocess (probed — no herdr answering${probe?.error ? `: ${probe.error}` : ""}). ` +
      `Set PI_GRANTS_HERDR=1 to demand panes.`,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/executor.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Add the package export**

```json
    "./executor": {
      "types": "./dist/executor.d.ts",
      "default": "./dist/executor.js"
    },
```

- [ ] **Step 6: Commit**

```bash
git add src/executor.ts test/executor.test.ts package.json
git commit -m "feat(ADR-0031): chooseExecutor — PI_GRANTS_HERDR becomes three-state

unset means probe, 1 demands herdr and REFUSES if it is unreachable, 0 demands
the captured subprocess and skips the probe. An unrecognised value fails closed
to the subprocess, loudly (rule 8).

Refusal rather than fallback is the operator's decision of 2026-08-17: a
fallback nobody reads is R-25's shape, and refusing keeps the ledger unable to
name a child that ran somewhere nobody chose."
```

---

### Task 4: Wire the choice into the session, and refuse when herdr was demanded and is down

**Files:**
- Modify: `packages/pi-daddy/extensions/session.ts:46-57` (the `ENV_HERDR` block), `:79` (`useHerdr`), `:224`, `:270`
- Modify: `packages/pi-daddy/extensions/grants.ts` (run the probe in `session_start`)
- Modify: `packages/pi-daddy/extensions/run-delegation.ts:214-241` (executor branch)
- Test: `packages/pi-daddy/test/delegate-all-wiring.test.ts` (extend)

**Interfaces:**
- Consumes: `chooseExecutor`, `needsProbe`, `ExecutorChoice`, `ENV_HERDR` (Task 3); `probeHerdr` (Task 2).
- Produces on `GrantsSession`: `executor: ExecutorChoice` replacing `readonly useHerdr: boolean`.
  **Mutable**, because the probe is async and the session object is built synchronously in the factory —
  the same constraint that forced `governed` to be mutable for ADR-0030.
  Also `resolveExecutor(session): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `test/delegate-all-wiring.test.ts`:

```ts
test("a session that DEMANDED herdr and cannot reach it refuses every delegation, before spawning anything", async () => {
  // The refusal must land in the PLANNER's path, not at the executor: a child that reaches `tab create`
  // has already had its ledger line written, and a refused delegation must never be recorded as a spawn
  // that happened. The production change that breaks this: moving the check into runHerdrPane.
  const session = fakeSession({
    executor: {
      kind: "herdr", forced: true, probed: true,
      refusal: "PI_GRANTS_HERDR=1 demands the herdr executor and herdr is not answering (no server)",
      disclosure: "herdr panes DEMANDED but unreachable",
    },
  });
  const outcome = await runOneDelegation(
    session, { task: "review the diff", agent: "review" },
    { parentId: "d0", childId: "d0.1" }, 8, fakeCtx(), undefined,
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? "", /PI_GRANTS_HERDR/);
  assert.equal(outcome.exitCode, null, "nothing was started");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/delegate-all-wiring.test.ts`
Expected: FAIL — `session.executor` is not read; the delegation proceeds.

- [ ] **Step 3: Replace `useHerdr` on the session**

In `extensions/session.ts`, replace the `ENV_HERDR` export block and the field. Keep
`ENV_HERDR_WORKSPACE` / `ENV_HERDR_KEEP_PANE` where they are; re-export `ENV_HERDR` from `../src/executor.ts`
so existing importers keep working.

```ts
export { ENV_HERDR } from "../src/executor.ts";
```

Field, replacing `readonly useHerdr: boolean`:

```ts
  /**
   * Which executor runs this session's children — ADR-0031.
   *
   * **Mutable, and for ADR-0030's reason exactly.** The choice needs a probe, the probe is async, and this
   * object is built synchronously in the extension factory (S-5 forces that: whether `delegate` is
   * registered at all is decided there). So it starts as the un-probed reading and is replaced once
   * `session_start` has probed. Nothing may capture a copy — read it through the session, live.
   */
  executor: ExecutorChoice;
```

Initialiser, before the probe has run:

```ts
    executor: chooseExecutor(process.env[ENV_HERDR], null),
```

And `delegationContext`'s `interactive` flag:

```ts
      // The herdr executor drives the child after starting it, so its plan must NOT carry `--print`.
      interactive: session.executor.kind === "herdr",
```

Add the resolver:

```ts
/**
 * Probe for herdr and settle this session's executor — once, at session start.
 *
 * Never per spawn (ADR-0031): a fan-out whose children ran under two executors would put two different
 * things under one call in the ledger. A herdr that dies mid-session surfaces as a failed `tab create`,
 * reported as the spawn error it is.
 */
export async function resolveExecutor(session: GrantsSession): Promise<void> {
  const raw = process.env[ENV_HERDR];
  const probe = needsProbe(raw) ? await probeHerdr() : null;
  session.executor = chooseExecutor(raw, probe);
}
```

- [ ] **Step 4: Call it from `session_start`, before anything reports**

In `extensions/grants.ts`, inside the outer `try`, **before** `reportSessionStart`:

```ts
      // ADR-0031: probe once, here, so the disclosure line below can name the executor and a demanded-but-
      // unreachable herdr is reported before the operator's first prompt rather than at the first delegation.
      // Its own try: a probe failure must not cancel the controls after it (R-60).
      try {
        await resolveExecutor(session);
      } catch (error) {
        ctx.ui.notify(
          `grants: could not settle which executor to use (${error instanceof Error ? error.message : String(error)}) ` +
            `— falling back to the captured subprocess, which needs nothing installed. Set PI_GRANTS_HERDR=0 ` +
            `to make that explicit, or 1 to demand herdr panes.`,
          "warning",
        );
      }
```

- [ ] **Step 5: Refuse in the planner path, not the executor**

In `extensions/run-delegation.ts`, immediately after `planWithApprovals` returns and **before** the ledger
write, so a refused delegation is recorded as a refusal rather than as a spawn:

```ts
  // ADR-0031: herdr was DEMANDED and is not answering. Refused rather than relocated — and refused HERE,
  // in front of the ledger write, because a record written before the refusal would describe a child that
  // never existed. `plan.ok` is turned off so the existing blocked-record path handles it unchanged.
  if (session.executor.refusal) {
    plan = { ...plan, ok: false, reason: `grants: ${session.executor.refusal}` };
  }
```

Then the executor branch reads the choice:

```ts
  const output = session.executor.kind === "herdr"
    ? await runHerdrPane({ /* … unchanged … */ })
    : await runChild({ /* … unchanged … */ });
```

- [ ] **Step 5b: Put children in the parent's workspace**

In the same `runHerdrPane({ … })` call, replace the workspace argument:

```ts
        // Was `process.env[ENV_HERDR_WORKSPACE]`, i.e. "omitted lets herdr choose" — which put children in a
        // different workspace from the pi session that spawned them, so switching to one meant hopping
        // workspaces. `resolveWorkspace` prefers the operator's explicit answer and falls back to the
        // parent's own HERDR_WORKSPACE_ID.
        workspace: resolveWorkspace(process.env),
```

`ENV_HERDR_WORKSPACE` stays exported from `extensions/session.ts` for the environment table and for anything
importing it; `resolveWorkspace` is now the only reader.

- [ ] **Step 6: Run tests**

Run: `node --test test/delegate-all-wiring.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extensions/session.ts extensions/grants.ts extensions/run-delegation.ts test/delegate-all-wiring.test.ts
git commit -m "feat(ADR-0031): the session probes once and settles its executor

session.useHerdr becomes session.executor (an ExecutorChoice), probed once in
session_start and never per spawn — a fan-out whose children ran under two
executors would put two different things under one ledger call.

A demanded-but-unreachable herdr refuses in the PLANNER path, in front of the
ledger write, so the refusal is recorded as a refusal and not as a spawn."
```

---

### Task 5: Say which executor is in force

This is the sentence ADR-0031 depends on to claim its probe is not silent. It ships with it.

**Files:**
- Modify: `packages/pi-daddy/extensions/session-report.ts` (the `holding [...]` banner block)
- Modify: `packages/pi-daddy/extensions/grants-command.ts:22-55` (context type), `:300-311` (status lines)
- Modify: `packages/pi-daddy/extensions/grants.ts` (pass `executor` into the command context)
- Test: `packages/pi-daddy/test/config.test.ts` (extend)

**Interfaces:**
- Consumes: `ExecutorChoice` (Task 3).
- Produces: `GrantsCommandContext.executor: ExecutorChoice`.

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts`:

```ts
test("/grants names the executor, because a session whose children have no terminal must say so", async () => {
  // This is the exact gap that produced ADR-0031: the status screen printed holding/depth/ledger/approvals/
  // catalog and never said where children run, so "my children are invisible subprocesses" was
  // undiscoverable. The production change that breaks this: dropping the executor line.
  const notices: string[] = [];
  await grantsCommand.handler("", fakeCommandCtx(notices, {
    executor: { kind: "process", forced: false, probed: true,
      disclosure: "captured subprocess (probed — no herdr answering). Set PI_GRANTS_HERDR=1 to demand panes." },
  }));
  const screen = notices.join("\n");
  assert.match(screen, /executor {2,}captured subprocess/);
  assert.match(screen, /PI_GRANTS_HERDR=1/);
});

test("a demanded-but-unreachable herdr is on the status screen as a refusal, not as a working executor", async () => {
  const notices: string[] = [];
  await grantsCommand.handler("", fakeCommandCtx(notices, {
    executor: { kind: "herdr", forced: true, probed: true, refusal: "…",
      disclosure: "herdr panes DEMANDED but unreachable (no server) — every delegation will refuse" },
  }));
  assert.match(notices.join("\n"), /every delegation will refuse/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/config.test.ts`
Expected: FAIL — no `executor` line in the rendered screen.

- [ ] **Step 3: Add the line to `/grants`**

In `grants-command.ts`, add `executor: ExecutorChoice` to `GrantsCommandContext`, destructure it, and insert
after the `holding` line so the two facts about where work happens sit together:

```ts
      `  executor   ${executor.disclosure}`,
```

- [ ] **Step 4: Add it to the session banner — gated on `mayDelegate`, NOT on `governed`**

In `session-report.ts`, **outside** the `if (session.governed)` block, before it:

```ts
  // ADR-0031 rests on this line existing: an executor chosen by probe is only defensible if it is announced.
  //
  // **`mayDelegate`, not `governed`** — and that distinction is a defect caught in review before it shipped.
  // An UNGOVERNED session still registers `delegate` and still spawns (`mayDelegate` is true when
  // `!governed`), so gating this on `governed` would have relocated an ungoverned session's children into
  // herdr panes and said nothing about it. That is precisely the "silently" objection ADR-0031 claims to have
  // discharged, reappearing inside the fix for it — the R-28 shape, in the one configuration nobody tests.
  //
  // A session that cannot spawn at all has no executor worth naming, which is why the guard is not simply
  // dropped.
  if (session.mayDelegate) {
    // Level tracks severity: a demanded-but-unreachable herdr is an error, not an FYI.
    ctx.ui.notify(`grants: executor — ${session.executor.disclosure}`, session.executor.refusal ? "error" : "info");
  }
```

- [ ] **Step 4b: Test the ungoverned case, since it is the one the defect lived in**

Append to `test/config.test.ts`:

```ts
test("an UNGOVERNED session that can still spawn names its executor", async () => {
  // The defect this prevents: gating the disclosure on `governed` instead of `mayDelegate`. An ungoverned
  // session registers `delegate` and spawns with the wildcard, so it would have moved children into herdr
  // panes in silence. The production change that breaks this: changing the guard back to session.governed.
  const notices: string[] = [];
  await reportSessionStart(
    fakeSession({ governed: false, mayDelegate: true, executor: probedHerdr }),
    { cwd: "/repo", ui: { notify: (m: string) => notices.push(m) } },
  );
  assert.match(notices.join("\n"), /executor — herdr panes/);
});

test("a leaf session names no executor, because it has nothing to run anywhere", async () => {
  const notices: string[] = [];
  await reportSessionStart(
    fakeSession({ governed: true, mayDelegate: false, executor: probedHerdr }),
    { cwd: "/repo", ui: { notify: (m: string) => notices.push(m) } },
  );
  assert.doesNotMatch(notices.join("\n"), /executor/);
});
```

- [ ] **Step 5: Pass it through in `grants.ts`**

In the `registerCommand("grants", …)` context object, beside `ownGrant`:

```ts
          executor: session.executor,
```

- [ ] **Step 6: Run tests**

Run: `node --test test/config.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extensions/session-report.ts extensions/grants-command.ts extensions/grants.ts test/config.test.ts
git commit -m "feat(ADR-0032): name the executor at session start and in /grants

The status screen printed holding/depth/ledger/approvals/catalog and never said
where children run, so an operator on a herdr machine could not discover that
their children were invisible subprocesses. That gap is what produced ADR-0031.

This is the disclosure ADR-0031 depends on to claim its probe is not silent, so
it ships in the same change."
```

---

### Task 6: Record the executor per child in the ledger

**Files:**
- Modify: `packages/pi-daddy/src/ledger.ts` (the record shape and `buildRecord`)
- Modify: `packages/pi-daddy/extensions/run-delegation.ts` (pass it)
- Test: `packages/pi-daddy/test/ledger-integrity.test.ts` (extend)

**Interfaces:**
- Consumes: `ExecutorKind` (Task 3).
- Produces: `buildRecord({ …, executor: ExecutorKind })` and an `executor` field on each record.

- [ ] **Step 1: Write the failing test**

```ts
test("a record names the executor, because the argv differs between them", async () => {
  // ADR-0031: the herdr plan withholds `--print`, so two records with the same capabilities can describe
  // different argv. Without this field "which executor ran this?" is unanswerable from the trail, and after
  // ADR-0031 the answer is not even implied by a variable's value. The production change that breaks this:
  // dropping `executor` from buildRecord.
  const record = buildRecord({
    parentId: "d0", childId: "d0.1", depth: 1, agentType: "review",
    requested: ["tool:read"], parentGrant: ["tool:read"],
    result: { effective: ["tool:read"], denied: [], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
    blocked: false, executor: "herdr", now: new Date("2026-08-17T12:00:00Z"),
  });
  assert.equal(record.executor, "herdr");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/ledger-integrity.test.ts`
Expected: FAIL — `record.executor` is `undefined`.

- [ ] **Step 3: Add the field**

In `src/ledger.ts`, add `executor: ExecutorKind` to the record interface and to `buildRecord`'s input, and
write it through. Document why:

```ts
  /**
   * Which executor ran this child — ADR-0031.
   *
   * Required rather than optional: after ADR-0031 the executor is decided by a runtime probe, so it is not
   * recoverable from a variable's value afterwards, and the two plans differ (`--print` is withheld on the
   * herdr path). A trail that cannot answer "where did this run?" cannot be read back reliably.
   */
  executor: ExecutorKind;
```

- [ ] **Step 4: Pass it from both call sites**

`extensions/run-delegation.ts` — in `buildRecord({ … })`: `executor: session.executor.kind,`.
`extensions/grants.ts` — the tripwire's `buildRecord`: `executor: session.executor.kind,`. The tripwire never
spawns anything, and recording the executor the session *would* have used is the honest value; a refused spawn
has no executor of its own.

- [ ] **Step 5: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS. If `verifyLedger`'s parser rejects the new field, that is a real finding — fix the parser, do
not drop the field.

- [ ] **Step 6: Commit**

```bash
git add src/ledger.ts extensions/run-delegation.ts extensions/grants.ts test/ledger-integrity.test.ts
git commit -m "feat(ADR-0031): the ledger records which executor ran each child

Required, not optional. The executor is now decided by a runtime probe, so it
cannot be recovered from a variable afterwards, and the two plans differ —
--print is withheld on the herdr path. A trail that cannot answer 'where did
this run' cannot be read back."
```

---

### Task 7: `runChild` streams

**Files:**
- Modify: `packages/pi-daddy/src/run-child.ts:32-43` (`ChildRunRequest`), `:104-118` (`capture`)
- Test: `packages/pi-daddy/test/run-child.test.ts` (extend)

**Interfaces:**
- Produces: `ChildRunRequest.onOutput?: (chunk: string) => void`.
- Consumed by: Task 9.

- [ ] **Step 1: Write the failing test**

```ts
test("onOutput sees each chunk as it arrives, and the result is still whole", async () => {
  // The production change that breaks this: dropping onOutput, or calling it AFTER close — the whole point
  // is that the parent can render progress before the child finishes.
  const chunks: string[] = [];
  const result = await runChild({
    command: process.execPath,
    args: ["-e", "process.stdout.write('one\\n'); setTimeout(() => process.stdout.write('two\\n'), 30)"],
    env: process.env, cwd: process.cwd(),
    onOutput: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.code, 0);
  assert.match(chunks.join(""), /one/);
  assert.match(chunks.join(""), /two/);
  assert.match(result.text, /one\ntwo/);
});

test("onOutput throwing does not kill the child, because a renderer is not a governance control", async () => {
  const result = await runChild({
    command: process.execPath, args: ["-e", "process.stdout.write('hi')"],
    env: process.env, cwd: process.cwd(),
    onOutput: () => { throw new Error("renderer exploded"); },
  });
  assert.equal(result.code, 0);
  assert.equal(result.text, "hi");
});

test("output past the cap stops being streamed as well as stored", async () => {
  const chunks: string[] = [];
  const result = await runChild({
    command: process.execPath,
    args: ["-e", "for (let i = 0; i < 5000; i++) process.stdout.write('x'.repeat(100))"],
    env: process.env, cwd: process.cwd(), maxOutputBytes: 1024,
    onOutput: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(chunks.join("")) <= 1024 + 100, "streaming must respect the same cap as capture");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/run-child.test.ts`
Expected: FAIL — `onOutput` is not in the request type (typecheck) and never called.

- [ ] **Step 3: Implement**

Add to `ChildRunRequest`:

```ts
  /**
   * Called with each chunk as it arrives, for the progress display (ADR-0032).
   *
   * **Display only.** The result is still `text`, assembled here; a consumer must never treat what it saw
   * streamed as the child's answer. That is R-03's rule — a partial result must not be mistakable for a
   * complete one.
   *
   * Exceptions are swallowed: a renderer is not a governance control, and one that throws must not kill a
   * governed child mid-task.
   */
  onOutput?: (chunk: string) => void;
```

In `capture`, after the truncation branch and before/with the append — the cap governs both:

```ts
    const capture = (chunk: unknown) => {
      if (truncated) return;
      const s = String(chunk);
      bytes += Buffer.byteLength(s);
      if (bytes > maxOutputBytes) {
        text += s;
        text = text.slice(0, maxOutputBytes);
        truncated = true;
        emit(s);
        stop();
        return;
      }
      text += s;
      emit(s);
    };

    /** A renderer that throws must not kill a governed child. */
    const emit = (chunk: string) => {
      if (!request.onOutput) return;
      try {
        request.onOutput(chunk);
      } catch {
        /* display only */
      }
    };
```

- [ ] **Step 4: Run tests**

Run: `node --test test/run-child.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run-child.ts test/run-child.test.ts
git commit -m "feat(ADR-0032): runChild streams output through an optional onOutput

capture is already the single funnel for stdout and stderr, so one callback
covers the whole surface and the existing byte cap governs streaming too.

Display only: the result is still the assembled text, and a renderer that
throws is swallowed rather than killing a governed child."
```

---

### Task 8: The status block

**Files:**
- Create: `packages/pi-daddy/src/progress.ts`, `packages/pi-daddy/test/progress.test.ts`
- Modify: `packages/pi-daddy/package.json` (add `./progress` export)

**Interfaces:**
- Produces:
  ```ts
  export const TAIL_LINES = 3;
  export type ChildState = "starting" | "running" | "completed" | "failed";
  export interface ChildProgress {
    label: string;
    agentName?: string;
    paneId?: string;
    state: ChildState;
    startedAt: number;
    settledAt?: number;
    tail: string[];
  }
  export function appendTail(tail: string[], chunk: string): string[];
  export function renderProgress(children: ChildProgress[], executorKind: "herdr" | "process", now: number): string;
  ```
- Consumed by: Task 9.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * The status block ADR-0032 pins, chosen by the operator on 2026-08-17.
 *
 * The production change that breaks these: letting the block grow per chunk instead of holding a fixed tail,
 * or dropping the pane id — which is the entire difference between a pane you can switch to and one you find
 * out about after it closed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { appendTail, renderProgress, TAIL_LINES, type ChildProgress } from "../src/progress.ts";

test("the tail holds the LAST three lines, however many arrive", () => {
  let tail: string[] = [];
  for (const line of ["a", "b", "c", "d", "e"]) tail = appendTail(tail, `${line}\n`);
  assert.deepEqual(tail, ["c", "d", "e"]);
  assert.equal(tail.length, TAIL_LINES);
});

test("a chunk split mid-line does not produce two lines", () => {
  // A pipe delivers bytes, not lines. Rendering "Read" and "ing file.ts" as two entries would make the
  // block lie about what the child printed.
  let tail = appendTail([], "Read");
  tail = appendTail(tail, "ing file.ts\n");
  assert.deepEqual(tail, ["Reading file.ts"]);
});

test("blank lines are dropped, so a child printing newlines cannot blank the block", () => {
  let tail = appendTail([], "real output\n");
  tail = appendTail(tail, "\n\n\n");
  assert.deepEqual(tail, ["real output"]);
});

const child = (over: Partial<ChildProgress> = {}): ChildProgress => ({
  label: "review", agentName: "review-d0.1", paneId: "w7:t12",
  state: "running", startedAt: 0, tail: ["3 findings so far", "session.ts:88", "Reading test file"], ...over,
});

test("a running child's header carries its agent, pane, state and elapsed time", () => {
  const block = renderProgress([child()], "herdr", 42_000);
  assert.match(block, /review/);
  assert.match(block, /review-d0\.1/);
  assert.match(block, /w7:t12/);
  assert.match(block, /running/);
  assert.match(block, /0:42/);
});

test("the block is fixed height: four lines per child plus a header", () => {
  const children = Array.from({ length: 8 }, (_, i) => child({ label: `c${i}`, agentName: `c${i}-d0.${i + 1}` }));
  const lines = renderProgress(children, "herdr", 1000).split("\n").filter((l) => l.length > 0);
  assert.ok(lines.length <= 8 * 4 + 2, `expected a bounded block, got ${lines.length} lines`);
});

test("the process executor renders no pane column, because there is no pane", () => {
  const block = renderProgress([child({ agentName: undefined, paneId: undefined })], "process", 1000);
  assert.doesNotMatch(block, /pane/);
  assert.match(block, /review/);
});

test("a settled child freezes its elapsed time instead of counting forever", () => {
  const block = renderProgress([child({ state: "completed", settledAt: 12_000 })], "herdr", 99_000);
  assert.match(block, /0:12/);
  assert.doesNotMatch(block, /1:39/);
});

test("a failed child is visibly failed", () => {
  assert.match(renderProgress([child({ state: "failed", settledAt: 3000 })], "herdr", 3000), /failed/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/progress.test.ts`
Expected: FAIL — `Cannot find module '../src/progress.ts'`.

- [ ] **Step 3: Write `src/progress.ts`**

```ts
/**
 * The status block a running delegation renders — ADR-0032, the shape the operator chose on 2026-08-17.
 *
 * Three properties are load-bearing rather than cosmetic, and each has a test:
 *
 *  - **Fixed height.** Four lines per child, so eight children is ~34 lines and the block cannot grow with
 *    the child's output. A block that grows per chunk is the interleaved option that was rejected.
 *  - **No braiding.** Each child's text stays under its own header.
 *  - **The pane id is on screen while the child is alive**, which is the whole difference between a pane you
 *    can switch to and one you learn about after it closed.
 *
 * What it gives up is stated rather than implied (R-48): output older than the last `TAIL_LINES` lines is not
 * here. It is in the pane while the pane lives, and in the returned result afterwards.
 *
 * Pure — no pi, no herdr, no clock. `now` is a parameter so elapsed time is testable.
 */

export const TAIL_LINES = 3;

export type ChildState = "starting" | "running" | "completed" | "failed";

export interface ChildProgress {
  /** Definition name, or `delegate` for a `tools:` spawn. */
  label: string;
  agentName?: string;
  paneId?: string;
  state: ChildState;
  startedAt: number;
  /** Set once terminal, so elapsed time freezes instead of counting forever. */
  settledAt?: number;
  tail: string[];
}

/**
 * Fold a raw chunk into a line tail.
 *
 * A pipe delivers bytes, not lines, so a chunk can split mid-line — hence the continuation branch. Blank
 * lines are dropped so a child printing newlines cannot blank the block.
 */
export function appendTail(tail: string[], chunk: string): string[] {
  const endsMidLine = !chunk.endsWith("\n");
  const parts = chunk.split("\n");
  const next = [...tail];

  const continues = next.length > 0 && !next[next.length - 1].endsWith(" ");
  // The first part continues the previous line when the last chunk did not end in a newline. That state is
  // carried by a sentinel rather than a second field so the tail stays a plain string[] a test can read.
  void continues;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const isContinuation = i === 0 && next.length > 0 && next[next.length - 1].endsWith(" ");
    if (isContinuation) {
      next[next.length - 1] = next[next.length - 1].slice(0, -1) + part;
    } else if (part.trim().length > 0) {
      next.push(part);
    }
  }

  if (endsMidLine && next.length > 0 && !next[next.length - 1].endsWith(" ")) {
    next[next.length - 1] += " ";
  }

  const clean = next.map((line) => (line.endsWith(" ") ? line : line));
  return clean.slice(-TAIL_LINES);
}

/** `m:ss`, because a delegation is minutes-scale and an hour-long one has other problems. */
function elapsed(child: ChildProgress, now: number): string {
  const ms = Math.max(0, (child.settledAt ?? now) - child.startedAt);
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function renderProgress(children: ChildProgress[], executorKind: "herdr" | "process", now: number): string {
  const where = executorKind === "herdr" ? "herdr panes" : "captured subprocesses";
  const lines = [`${children.length} ${children.length === 1 ? "child" : "children"} · ${where}`, ""];

  for (const child of children) {
    const parts = [child.label.padEnd(10)];
    if (child.agentName) parts.push(`agent ${child.agentName}`);
    if (child.paneId) parts.push(`pane ${child.paneId}`);
    parts.push(child.state, elapsed(child, now));
    lines.push(parts.join("   "));
    for (const line of child.tail.slice(-TAIL_LINES)) {
      lines.push(`  ${line.replace(/ $/, "")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
```

> **Note for the implementer:** the sentinel in `appendTail` is ugly. If you can express "the last line is
> incomplete" more cleanly — a second return value, or a small class — do it, keep every test passing, and say
> so in the commit. The tests encode the *behaviour*; the representation is yours.

- [ ] **Step 4: Run tests**

Run: `node --test test/progress.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Add the package export and commit**

```json
    "./progress": {
      "types": "./dist/progress.d.ts",
      "default": "./dist/progress.js"
    },
```

```bash
git add src/progress.ts test/progress.test.ts package.json
git commit -m "feat(ADR-0032): the status block, as a pure renderer

Fixed height (four lines per child), no braiding, and the pane id on screen
while the child is alive — the three properties ADR-0032 calls load-bearing,
each with a test. Pure: no pi, no herdr, and `now` is a parameter."
```

---

### Task 9: Stream both executors into `onUpdate`

**Files:**
- Modify: `packages/pi-daddy/src/run-herdr.ts` (`HerdrRunRequest.onOutput`, poll `agent read` in `waitForSettled`)
- Modify: `packages/pi-daddy/extensions/run-delegation.ts` (accept and forward a progress sink)
- Modify: `packages/pi-daddy/extensions/delegation.ts:116,171` (use `onUpdate` instead of `_onUpdate`)
- Test: `packages/pi-daddy/test/run-herdr.test.ts`, `test/delegate-all-wiring.test.ts`

**Interfaces:**
- Consumes: `appendTail`, `renderProgress`, `ChildProgress` (Task 8); `ChildRunRequest.onOutput` (Task 7).
- Produces: `runOneDelegation(session, spec, ids, budget, ctx, signal, onProgress?)` where
  `onProgress: (update: { paneId?: string; agentName?: string; chunk?: string; state?: ChildState }) => void`.

- [ ] **Step 1: Write the failing test**

In `test/run-herdr.test.ts`:

```ts
test("the pane's output is reported while the child is still running", async () => {
  // The production change that breaks this: reading the pane only after waitForSettled returns, which is
  // what makes a herdr child a black box for its whole run.
  const seen: string[] = [];
  const fake = fakeHerdr({
    getSequence: [
      { agent_status: "working", state_change_seq: 11 },
      { agent_status: "working", state_change_seq: 12 },
      { agent_status: "idle", state_change_seq: 13 },
    ],
    output: "partial progress",
  });
  await runHerdrPane({ ...request(), exec: fake.exec, onOutput: (chunk) => seen.push(chunk) });
  assert.ok(seen.length > 0, "nothing was reported before the child settled");
  assert.ok(fake.verbs().filter((v) => v === "agent read").length >= 2, "the pane was read only once");
});

test("the pane id reaches the caller as soon as it exists, so a human can switch to it", async () => {
  const ids: Array<string | undefined> = [];
  const fake = fakeHerdr();
  await runHerdrPane({ ...request(), exec: fake.exec, onPane: (paneId) => ids.push(paneId) });
  assert.deepEqual(ids, ["w1:p9"]);
});
```

In `test/delegate-all-wiring.test.ts`:

```ts
test("delegate_all renders one status block covering every child, not one per child", async () => {
  const frames: string[] = [];
  await callDelegateAll(
    { children: [{ task: "a", agent: "review" }, { task: "b", agent: "debug" }] },
    { onUpdate: (partial) => frames.push(partial.content[0].text) },
  );
  const last = frames[frames.length - 1];
  assert.match(last, /2 children/);
  assert.match(last, /review/);
  assert.match(last, /debug/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test test/run-herdr.test.ts test/delegate-all-wiring.test.ts`
Expected: FAIL — `onOutput` / `onPane` are not in `HerdrRunRequest`; no frames are emitted.

- [ ] **Step 3: Add the hooks to `runHerdrPane`**

Add to `HerdrRunRequest`:

```ts
  /** Pane text as it appears, for the progress display (ADR-0032). Display only, exactly as in `runChild`. */
  onOutput?: (chunk: string) => void;
  /** The pane id, reported as soon as `tab create` returns it, so a human can switch to a LIVE child. */
  onPane?: (paneId: string) => void;
```

Call `onPane` immediately after the `paneId` check succeeds. In `waitForSettled`, on each poll iteration,
read the pane and report only what is new — herdr returns the whole terminal, so a diff is required or every
poll re-reports everything:

```ts
/**
 * Report only what the pane has gained since the last read.
 *
 * `agent read` returns the WHOLE terminal, so reporting its output verbatim on every poll would repeat the
 * entire buffer once per interval — the progress block would show the child's first line forever and the
 * transcript would grow quadratically. Kept as a prefix comparison rather than a line count because a
 * terminal can rewrite its own last line.
 */
function newSuffix(previous: string, current: string): string {
  if (current.startsWith(previous)) return current.slice(previous.length);
  // The terminal was rewritten (a spinner, a cleared screen). Report the whole thing rather than nothing.
  return current;
}
```

- [ ] **Step 4: Thread a progress sink through `runOneDelegation`**

Add the optional last parameter, build a `ChildProgress` per child, and pass `onOutput`/`onPane` into whichever
executor runs. On the process path pass only `onOutput` — there is no pane.

- [ ] **Step 5: Wire `onUpdate` in both tools**

In `extensions/delegation.ts`, rename `_onUpdate` to `onUpdate` in both `execute` signatures and build one
shared block. `delegate` renders a one-child block; `delegate_all` renders all of them:

```ts
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const children: ChildProgress[] = params.children.map((child) => ({
        label: child.agent ?? "delegate",
        state: "starting" as const,
        startedAt: Date.now(),
        tail: [],
      }));
      // Coalesced, not per chunk: a child printing fast would otherwise re-render the whole block hundreds
      // of times a second, and pi has to lay out every frame.
      const paint = throttle(() => onUpdate?.({
        content: [{ type: "text", text: renderProgress(children, session.executor.kind, Date.now()) }],
      }), PAINT_INTERVAL_MS);
```

Add `PAINT_INTERVAL_MS = 250` and a small local `throttle` in `src/progress.ts` (tested there, not here).

- [ ] **Step 6: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/run-herdr.ts src/progress.ts extensions/run-delegation.ts extensions/delegation.ts test/
git commit -m "feat(ADR-0032): stream both executors into the parent's transcript

delegate and delegate_all stop discarding onUpdate. The herdr path polls
agent read inside waitForSettled and reports only the new suffix — agent read
returns the whole terminal, so reporting it verbatim each poll would repeat the
buffer once per interval.

Painting is throttled to 250ms: a fast child would otherwise re-render the
block hundreds of times a second."
```

---

### Task 10: Pane lifetime — `agent_settled`, an async sweep, and a cap of 8

**Files:**
- Modify: `packages/pi-daddy/src/run-herdr.ts:204-221` (`cleanup` stops closing the tab)
- Modify: `packages/pi-daddy/src/pane-reaper.ts` (`MAX_OPEN_PANES`, `trimOpenPanes`, `reapOpenPanesAsync`)
- Modify: `packages/pi-daddy/extensions/grants.ts` (the `agent_settled` hook)
- Test: `packages/pi-daddy/test/run-herdr.test.ts`

**Interfaces:**
- Consumes: `HerdrExec` (Task 2).
- Produces: `MAX_OPEN_PANES = 8`, `trimOpenPanes(exec?): Promise<string[]>`, `reapOpenPanesAsync(exec?): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

```ts
test("a completed child's pane is left open, so a human can still read it", async () => {
  // The production change that breaks this: putting `tab close` back in cleanup's finally. That is what made
  // a 20-second child's pane vanish before anyone could switch to it.
  const fake = fakeHerdr();
  await runHerdrPane({ ...request(), exec: fake.exec });
  assert.ok(!fake.verbs().includes("tab close"), "the pane was closed at the end of the tool call");
  assert.equal(openPaneCount(), 1, "the pane must stay tracked so agent_settled can reap it");
  await reapOpenPanesAsync(fake.exec);
  assert.equal(openPaneCount(), 0);
});

test("the agent is still stopped even though the pane stays", async () => {
  const fake = fakeHerdr();
  await runHerdrPane({ ...request(), exec: fake.exec });
  assert.ok(fake.verbs().includes("agent stop"));
});

test("a ninth pane closes the oldest, and says which", async () => {
  // A plain blocking `delegate` spends nothing from the fan-out budget, so pane count is otherwise unbounded
  // within one agent run. The production change that breaks this: dropping the trim.
  for (let i = 0; i < 9; i += 1) trackPane({ tab: `w1:t${i}`, name: `child-${i}` });
  const fake = fakeHerdr();
  const closed = await trimOpenPanes(fake.exec);
  assert.deepEqual(closed, ["w1:t0"], "the OLDEST pane is the one to go");
  assert.equal(openPaneCount(), MAX_OPEN_PANES);
});

test("a pane herdr refuses to close stays tracked, so exit tries again", async () => {
  // R-62's lesson, kept: untracking a pane we did not close disables the one thing built for that failure.
  trackPane({ tab: "w1:t1", name: "child-1" });
  const fake = fakeHerdr({ failAt: "tab close" });
  await reapOpenPanesAsync(fake.exec);
  assert.equal(openPaneCount(), 1);
});
```

- [ ] **Step 2: Run and watch fail**

Run: `node --test test/run-herdr.test.ts`
Expected: FAIL — `cleanup` closes the tab, so `openPaneCount()` is 0 and `tab close` is in the verbs.

- [ ] **Step 3: Stop closing the tab in `cleanup`**

```ts
  /**
   * Stop the agent and clean up what belongs to this CALL. The pane deliberately survives.
   *
   * ADR-0032: a pane destroyed the instant its child settles is unobservable in practice — a twenty-second
   * child's pane is gone before anyone can switch to it. The pane now belongs to the AGENT RUN and is reaped
   * at `agent_settled`, with the `exit` handler as the backstop it always was.
   *
   * `keepPane` still means "not even at agent_settled": untracked here, so nothing reaps it.
   */
  const cleanup = async () => {
    await exec(["agent", "stop", request.name]).catch(() => undefined);
    if (request.keepPane) {
      if (tabId) untrackPane(tabId);
      return;
    }
    // The staged prompt is per-call, so it goes now — but only if the pane is going eventually. A human
    // reading the pane may want to see what the child was told, and the pane outlives this function.
  };
```

Note: the staged `promptDir` must now be carried on the tracked pane and removed by the reaper, since the pane
outlives the call. `OpenPane.promptDir` already exists for exactly that.

- [ ] **Step 4: Add the async sweep and the trim**

```ts
/**
 * Close every outstanding pane, asynchronously — the `agent_settled` path (ADR-0032).
 *
 * A separate function from `reapOpenPanes` rather than a shared implementation, because the sync one is
 * `execFileSync` with a six-second budget *by necessity*: an `exit` handler cannot await. Running that at
 * `agent_settled` would freeze pi for up to six seconds every time the operator gets their prompt back.
 *
 * Both drain the same `Map`, keyed by tab id, so a double close is impossible and a pane herdr refused stays
 * tracked for the other one to retry.
 */
export async function reapOpenPanesAsync(syncFree: HerdrExec = asyncExec): Promise<string[]> { /* … */ }

/** Keep at most `MAX_OPEN_PANES`; the Map's insertion order makes the oldest first. */
export async function trimOpenPanes(exec: HerdrExec = asyncExec): Promise<string[]> { /* … */ }
```

`MAX_OPEN_PANES` is imported from `./fanout.ts` as `MAX_CHILDREN_PER_CALL` and re-exported under the clearer
name, so the two cannot drift.

- [ ] **Step 5: Call `trimOpenPanes` from `trackPane`'s caller**

In `run-herdr.ts`, right after `trackPane(...)`, await the trim and report anything closed through `onOutput`
so the operator is told rather than surprised (R-48).

- [ ] **Step 6: Add the `agent_settled` hook**

In `extensions/grants.ts`:

```ts
  /**
   * Reap the panes this agent run opened — ADR-0032.
   *
   * `agent_settled`, not `turn_end`: `turn_end` fires at the end of each provider round-trip, i.e. no later
   * than the `finally` that used to close the pane, so building this on it would have shipped a no-op.
   * `agent_settled` is documented as firing once the run has fully settled with no retry, compaction or
   * queued continuation — and herdr's own pi integration drives its busy/idle display from the same pair,
   * which is independent corroboration that this is what "the operator has their prompt back" means.
   */
  pi.on("agent_settled", async () => {
    try {
      if (session.executor.kind !== "herdr" || openPaneCount() === 0) return undefined;
      await reapOpenPanesAsync();
    } catch {
      /* never throw into the agent loop; `exit` is still the backstop */
    }
    return undefined;
  });
```

- [ ] **Step 7: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS. Then check the ceiling: `wc -l src/run-herdr.ts src/pane-reaper.ts extensions/grants.ts` —
all under 400. If `run-herdr.ts` is over, extract `waitForSettled` + `readPane` + `newSuffix` into
`src/herdr-poll.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/run-herdr.ts src/pane-reaper.ts extensions/grants.ts test/run-herdr.test.ts
git commit -m "feat(ADR-0032): a pane lives until agent_settled, capped at 8

cleanup stops closing the tab; the pane belongs to the agent run and is reaped
by a new agent_settled hook, with the exit handler as the backstop it was.

agent_settled, not turn_end: turn_end fires per provider round-trip, no later
than the finally it would replace, so that version would have been a no-op.

The sweep is async and separate from reapOpenPanes, which is execFileSync with
a 6s budget by necessity — running that at agent_settled would freeze pi every
time the operator gets their prompt back.

Capped at MAX_CHILDREN_PER_CALL: a plain delegate spends nothing from the
fan-out budget, so pane count is otherwise unbounded within one agent run."
```

---

### Task 11: The tripwire names `delegate_all`

The one fix that would have changed the screenshot that started this work.

**Files:**
- Modify: `packages/pi-daddy/extensions/grants.ts:324-328`
- Test: `packages/pi-daddy/test/gated-default.test.ts` (extend) or a new `test/tripwire.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("the tripwire names delegate_all, because a refusal that names only delegate gets a serial answer", async () => {
  // Observed 2026-08-17: the operator asked for parallel work, `subagent` was refused with "Use `delegate`
  // instead", and the model then planned a single sequential delegate. The message that redirected it named
  // only the serial tool. The production change that breaks this: dropping delegate_all from the text.
  const refusal = tripwireReason("subagent", 0);
  assert.match(refusal, /delegate_all/);
  assert.match(refusal, /delegate\b/);
});
```

- [ ] **Step 2: Run and watch fail**

Run: `node --test test/tripwire.test.ts`
Expected: FAIL — the message has no `delegate_all`.

- [ ] **Step 3: Extract the message and extend it**

```ts
/**
 * Why a third-party spawn tool is refused, and what to use instead.
 *
 * **Both tools are named, deliberately.** This said only *"Use `delegate` instead"*, and on 2026-08-17 an
 * operator asked for parallel work, `subagent` was refused, and the model then planned a single sequential
 * `delegate` — because the message that redirected it named only the serial tool. A refusal that points at
 * the wrong replacement is a refusal that gets obeyed badly.
 */
export function tripwireReason(toolName: string, depth: number): string {
  return (
    `grants: "${toolName}" spawns sub-agents outside this session's governance — refused. ` +
    `This session grants capabilities by spawning them itself, so a child created by another extension ` +
    `would hold whatever that extension decided, with no grant, no depth bound and no ledger entry. ` +
    `Use \`delegate\` for one sub-agent, or \`delegate_all\` to run several CONCURRENTLY — that is the ` +
    `governed equivalent of a parallel or chained spawn. If you meant to run ungoverned, unset ` +
    `PI_GRANTS_GRANT.`
  );
}
```

- [ ] **Step 4: Run tests and commit**

```bash
git add extensions/grants.ts test/tripwire.test.ts
git commit -m "fix: the tripwire names delegate_all, not just delegate

Observed: an operator asked for parallel work, subagent was refused with 'Use
delegate instead', and the model planned a single sequential delegate. The
refusal pointed at the wrong replacement."
```

---

### Task 12: Make the record true

**Files:**
- Modify: `docs/SPEC.md:394-401,438`
- Modify: `docs/03-risks.md` (R-62 — re-rate, replacing the dated note's instruction)
- Modify: `docs/06-decisions/ADR-0031-*.md`, `ADR-0032-*.md` (Status → Accepted)
- Modify: `docs/SESSION-LOG.md`
- Test: `packages/pi-daddy/test/risk-register-status.test.ts` (existing guard)

- [ ] **Step 1: Update `docs/SPEC.md`**

Replace the *"Opt-in, never auto-detected from `herdr` being on `PATH`"* paragraph with the three-state table
and the probe, and the `PI_GRANTS_HERDR` row in the environment table. State that panes live until
`agent_settled` and that at most 8 are open.

- [ ] **Step 2: Re-rate R-62**

Its dated note says to do this *in the change that ships ADR-0031*. This is that change. Raise the likelihood
(the pane path is now the default on a herdr machine), keep the impact, and keep the note as the record of
why the rating moved. **Do not delete the note** — rule 2.

- [ ] **Step 3: Flip both ADRs to Accepted**

`**Status:** Accepted (2026-08-17, by the user — probe with refusal on a demanded-but-unreachable herdr)` and
the equivalent for 0032. Add the shipped version number.

- [ ] **Step 4: Add a SESSION-LOG entry**

What shipped, the test counts, and the one thing worth carrying forward: `turn_end` is not the turn-end hook.

- [ ] **Step 5: Full verification**

```bash
cd packages/pi-daddy
npm test && npm run typecheck && npm run test:integration && npm run test:smoke
```

Then, once, by hand — the thing no unit test covers:

```bash
cd ~/repos/bookie-pi-skills && pi
# expect: `grants: executor — herdr panes (probed — herdr is answering)`
# then ask for a parallel fan-out and watch the block fill, and `herdr tab list` for the panes
```

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs: ADR-0031 and ADR-0032 accepted, SPEC and R-62 updated

SPEC.md:398's 'never auto-detected' paragraph and the PI_GRANTS_HERDR row were
false as written once the probe shipped. R-62's L×L rating rested on 'the herdr
executor is opt-in', which is no longer true — re-rated, with its dated note
kept as the record of why."
```

---

## Self-Review

**Spec coverage.** ADR-0031: three-state variable (T3), probe (T2), once per session (T4), refusal on
demanded-and-down (T3/T4), ledger executor (T6), disclosure (T5), SPEC + R-62 (T12). ADR-0032: streaming on
both executors (T7/T9), the pinned block shape (T8), pane lifetime at `agent_settled` (T10), the async sweep
(T10), the 8-pane cap (T10), disclosure (T5), tripwire (T11). **One gap accepted deliberately:** ADR-0032's
"the streamed text is not the result" is enforced by construction (streaming goes to `onUpdate`, the result
comes from `output.text`) and by comments, not by a test — there is no production change that could conflate
them without also deleting the return statement. Named here so it is a decision rather than an omission.

**Placeholders.** Task 1's `session-report.ts` body is described as "the moved bodies, in the same order"
rather than reproduced — deliberate, because reproducing 150 lines of unchanged code invites a rewrite where a
move is wanted. Tasks 9 and 10 leave three function bodies to the implementer with their contracts and tests
fully specified. Everything else carries real code.

**Type consistency.** `ExecutorChoice` / `ExecutorKind` / `HerdrProbe` / `ChildProgress` / `ChildState` are
each defined once (T3, T2, T8) and referenced by those names throughout. `MAX_OPEN_PANES` is re-exported from
`MAX_CHILDREN_PER_CALL` rather than redeclared, so the cap cannot drift.
