/**
 * Which executor runs a governed child — ADR-0031.
 *
 * `PI_GRANTS_HERDR` is three-state, and **absent means probe**. That reverses ADR-0016 point 6's opt-in, and
 * the reversal is narrower than it sounds: nothing is detected from `herdr` being on `PATH` (option C, rejected
 * by name), only from a server that *answered*. The grant, the depth bound, the gate and `--tools` enforcement
 * are identical either way — `planSpawn` produces one plan and both executors enforce it.
 *
 * **Pure on purpose.** The probe is I/O and lives in `herdr-cli.ts`; the DECISION is a table, and a table that
 * fits on one screen is the only reason a reversal like this is reviewable at all.
 *
 * The disclosure string is part of the return value rather than composed at the call site, because ADR-0031's
 * defence against "this relocates silently" is that every outcome says what it chose AND what to set instead.
 * Two call sites composing that separately is how one of them comes to omit it (R-28).
 */

import type { HerdrProbe } from "./herdr-cli.ts";

export const ENV_HERDR = "PI_GRANTS_HERDR";

export const EXECUTOR_KINDS = ["process", "herdr"] as const;
export type ExecutorKind = typeof EXECUTOR_KINDS[number];

export interface ExecutorChoice {
  kind: ExecutorKind;
  /** The operator named it: `PI_GRANTS_HERDR` was exactly `0` or `1`. */
  forced: boolean;
  /** Whether a probe was needed at all — false only for `0`. */
  probed: boolean;
  /**
   * Set ONLY when herdr was demanded and is unreachable. Every delegation must refuse with this.
   *
   * Note that `kind` stays `"herdr"` in that case, deliberately: nothing downstream may mistake a refusing
   * session for a working process-executor one.
   */
  refusal?: string;
  /** One line for the session banner and `/grants`. Always present. */
  disclosure: string;
}

/** `0` is the one value that needs no probe: the operator ruled herdr out, so asking is pure cost. */
export function needsProbe(raw: string | undefined): boolean {
  return raw === undefined || raw === "1";
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
    // Refusal, not fallback — the operator's decision of 2026-08-17, against the alternative of falling back
    // loudly. A fallback nobody reads is R-25's shape; refusing keeps the ledger unable to name a child that
    // ran somewhere nobody chose. A `null` probe lands here too: if the probe failed so badly it produced no
    // result, herdr was still demanded, and failing closed means refusing.
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
    // delegation either — the operator meant *something*, and the dependency-free executor is the safe read.
    // The empty string lands here rather than with `undefined`, which keeps absent-versus-empty
    // distinguishable exactly as `PI_GRANTS_GATED` does.
    return {
      kind: "process",
      forced: false,
      probed: probe !== null,
      disclosure:
        `captured subprocess — PI_GRANTS_HERDR is set to an unrecognised value and was ignored. ` +
        `Use 1 (demand herdr panes), 0 (demand subprocesses), or unset it to probe.`,
    };
  }

  if (probe?.ok) {
    return { kind: "herdr", forced: false, probed: true, disclosure: "herdr panes (probed — herdr is answering)" };
  }
  if (probe === null) {
    // **The pre-probe seed, and it must not claim a probe happened.** `createGrantsSession` builds a choice
    // synchronously with `probe: null` because S-5 forces the factory to run before any hook; `resolveExecutor`
    // replaces it during `session_start`. This branch previously fell through to the one below and reported
    // `probed: true` with the word "(probed)" in its disclosure — a fabricated observation, indistinguishable
    // from a real negative probe.
    //
    // Unreachable in practice today (pi awaits the `session_start` emit before the first prompt, verified by a
    // reviewer against real pi), which is exactly why it is worth making honest rather than leaving to be
    // discovered: if a throw ever strands a session on this reading, the disclosure should say so.
    return {
      kind: "process",
      forced: false,
      probed: false,
      disclosure: "not yet probed — settling at session start",
    };
  }
  return {
    kind: "process",
    forced: false,
    probed: true,
    // Names the remedy on the same line as the state. The gap that produced ADR-0031 was not that the
    // operator could not see which executor ran — it was that seeing it would not have told them what to do.
    disclosure:
      `captured subprocess (probed — no herdr answering${probe?.error ? `: ${probe.error}` : ""}). ` +
      `Set PI_GRANTS_HERDR=1 to demand panes.`,
  };
}
