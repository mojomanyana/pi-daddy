/**
 * Reading a ledger back — integrity, instruction versions, and the ADR-0020 approval tally.
 *
 * Split from `ledger.ts` when the file-size guard refused it at 419 lines. The seam is real rather than
 * arbitrary: `ledger.ts` **writes** one record at a time and fails closed when it cannot, while everything
 * here **reads** a whole file and must never fail at all — a report is a diagnostic, and a diagnostic that
 * throws on damaged input is useless on exactly the input it exists for. Every defect this half has had
 * (R-63's bias, R-64's three malformed shapes) was a *reporting* defect, and none of them could have
 * touched the write path.
 *
 * Re-exported from `./ledger` so the published subpath is unchanged.
 */

import { readFile } from "node:fs/promises";
import type { Capability } from "./resolve.ts";
import { DELEGATE_SUBJECT } from "./approval.ts";
import type { ApprovalSource } from "./approval.ts";
import type { GrantRecord } from "./ledger.ts";
import { isEscalationAttempt } from "./ledger.ts";
import type { WorkspaceLeaseOutcome } from "./ledger-events.ts";

export interface LedgerReport {
  /** False when the file is absent — a configuration state, not damage. */
  exists: boolean;
  /** Capability-decision records (legacy or v2). */
  records: number;
  /** Every parsed ledger event, including lifecycle and lease events. */
  events: number;
  workspaceLeases: {
    acquired: number; uncontended: number; refused: number; released: number;
    releasedUnrecorded: number; lost: number; retained: number; timeout: number; recovered: number;
  };
  lifecycle: { starting: number; completed: number; failed: number };
  /** Lines that did not, with 1-based line numbers so the report is actionable. */
  corrupt: Array<{ line: number; text: string }>;
  /** Records where an agent asked for more than it held — ADR-0008's designated signal. */
  escalationAttempts: number;
  /**
   * How many records ran under each executor, plus how many name none — ADR-0031.
   *
   * **Added because the field was written and never read, which is R-51's shape exactly.** R-51 was
   * `definitionDigest`: recorded from the start, absent from every report, so the questions ADR-0018 advertised
   * needed hand-written `jq`. `executor` arrived the same way — `src/ledger.ts` justifies making it *required*
   * with "reading it back is the only reason it exists", and nothing read it back. `docs/SPEC.md` claims the
   * executor is "announced three times… per child in the ledger"; without this the third announcement was to
   * `jq` only.
   *
   * `unknown` counts pre-0.16 lines, which have no such field. Reported rather than folded into `process`,
   * because "written before the executor was recorded" and "ran as a subprocess" are different facts.
   */
  executors: { herdr: number; process: number; unknown: number };
  /**
   * Every distinct set of instructions this ledger saw run, with how many spawns used it (R-51).
   *
   * ADR-0018 advertises that a record answers *"did these four children run the same instructions?"* and
   * *"has this definition changed since?"* — and until this existed **nothing read `definitionDigest` at
   * all**, so both questions required hand-written `jq` and the second was not even reproducible with
   * `sha256sum`, because the digest covers the body and not the frontmatter. A field no tool reads is a
   * field that quietly becomes decoration.
   *
   * Grouped by `name` + `sha256`, so two entries with one name are exactly the evidence that a definition
   * changed mid-ledger. Sorted by name then digest so two runs of the same fan-out produce a diffable
   * report, like the ids themselves.
   */
  definitions: Array<{ name: string; source: string; sha256: string; spawns: number }>;
  /**
   * Where the yes came from, per approved capability, tallied across the whole ledger.
   *
   * **This is the measurement ADR-0020 asks for.** That ADR keeps the persistence layer on R-25's fatigue
   * argument with *no number behind it*, and named the evidence that would settle it: counting `persisted`
   * against `prompt` over a few weeks of real use. It also said this "needs no new machinery" — true of the
   * data and false of the answer, which required hand-written `jq`. Same shape as R-51: a field no tool
   * reads becomes decoration, and a measurement nobody can run does not get run.
   *
   * **`bySource` counts RECORDS and is an upper bound, not an answer.** Deleting the persistence layer does
   * not turn every `persisted` record back into a prompt: precedence is `inherited → session → persisted →
   * prompt`, and `session` approvals live in memory and do not depend on the store at all. So a session that
   * spawns `deploy` twenty times under one persisted entry writes twenty `persisted` records, while without
   * the store it would raise **one** prompt and satisfy the other nineteen from the session cache. Reporting
   * twenty prompts avoided would overstate the layer's value twentyfold, on the one number that decides
   * whether to keep it — the same direction of bias `unattributed` exists to avoid, arrived at a different way.
   *
   * `distinctBySource` is the closer estimate: distinct `capability@subject` pairs, which bounds the cost of
   * deletion at one prompt per pair per session. The ledger carries no session id, so the exact figure is not
   * computable from it; both numbers are printed and labelled rather than one being presented as the truth.
   *
   * Counted from `approvalSources` **only**. `approvalSource` is deliberately not used as a fallback: before
   * 0.11.1 that scalar was written for the whole set even when the sources differed (R-46), so folding it in
   * would report humans as having been asked about capabilities they were never asked about — biasing the
   * one direction this measurement must not be biased in. Those records are counted as `unattributed`
   * instead, so the sample size is visible rather than silently smaller.
   */
  approvals: {
    /** Raw record counts. An UPPER bound on prompts avoided — see above before quoting one. */
    bySource: Record<ApprovalSource, number>;
    /** Distinct `capability@subject` pairs per source. The closer estimate. */
    distinctBySource: Record<ApprovalSource, number>;
    /** Records carrying approvals from before per-capability sources existed. Not attributable; see above. */
    unattributed: number;
    /** Records where a human was asked and said no — the fatigue argument's other half. */
    humanDenied: number;
    /**
     * Distinct `capability@subject` pairs a human declined.
     *
     * Same reason `distinctBySource` exists: R-29 shares a decline across every concurrent caller, so one
     * click of *Deny* under an eight-wide fan-out writes eight `humanDenied` records. Reporting the raw
     * count as "times a human declined" is the per-record bias R-63 removed from `persisted`, left in place
     * on the number that argues hardest FOR the layer — which is the direction that flatters this package's
     * own gating and therefore the one to be most careful with.
     */
    humanDeniedPairs: number;
  };
  ok: boolean;
}

/**
 * Read the ledger back and report what is wrong with it.
 *
 * **This is the gap that mattered most.** `appendRecord`'s strict mode catches write *errors*, never
 * corruption, and nothing in this package had ever read a ledger back — so a torn line was silently
 * indistinguishable from a spawn that never happened. An audit trail whose damage is invisible is not a
 * compensating control, and ADR-0008 leans on the ledger as exactly that.
 *
 * Deliberately reports rather than repairs. A corrupt line is evidence; rewriting the file to make it parse
 * would destroy the one artifact an investigation has.
 */
// Keyed by the UNION, not by `string`. Typed loosely, adding a `WorkspaceLeaseOutcome` member without a
// counter compiled fine and then made `verifyLedger` file the package's own valid event as CORRUPTION —
// the worst available outcome for an integrity signal, since real damage becomes noise.
const LEASE_OUTCOME_COUNTERS: Record<WorkspaceLeaseOutcome, keyof LedgerReport["workspaceLeases"]> = {
  acquired: "acquired",
  uncontended: "uncontended",
  refused: "refused",
  released: "released",
  "released-unrecorded": "releasedUnrecorded",
  lost: "lost",
  retained: "retained",
  timeout: "timeout",
  recovered: "recovered",
};

function validV2Base(event: Record<string, unknown>): boolean {
  return event.ledgerVersion === 2 && typeof event.ts === "string";
}

function requireV2(event: Record<string, unknown>, fields: string[]): void {
  if (!validV2Base(event) || fields.some((field) => typeof event[field] !== "string" || event[field] === "")) {
    throw new Error("invalid versioned ledger event");
  }
}

function requireCapabilityDecision(event: Record<string, unknown>): void {
  requireV2(event, ["parentId", "childId", "executor", "taskDigest"]);
  for (const field of ["requested", "parentGrant", "effective", "denied", "clipped", "gatedBlocked"]) {
    if (!Array.isArray(event[field]) || !(event[field] as unknown[]).every((value) => typeof value === "string")) {
      throw new Error("invalid capability decision arrays");
    }
  }
  if (!Number.isInteger(event.depth) || typeof event.blocked !== "boolean" || !/^[a-f0-9]{64}$/i.test(String(event.taskDigest))) {
    throw new Error("invalid capability decision identity");
  }
}

export async function verifyLedger(path: string): Promise<LedgerReport> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return {
        exists: false,
        records: 0,
        events: 0,
        workspaceLeases: { acquired: 0, uncontended: 0, refused: 0, released: 0, releasedUnrecorded: 0, lost: 0, retained: 0, timeout: 0, recovered: 0 },
        lifecycle: { starting: 0, completed: 0, failed: 0 },
        corrupt: [],
        escalationAttempts: 0,
        executors: { herdr: 0, process: 0, unknown: 0 },
        definitions: [],
        approvals: {
          bySource: { prompt: 0, session: 0, persisted: 0, inherited: 0 },
          distinctBySource: { prompt: 0, session: 0, persisted: 0, inherited: 0 },
          unattributed: 0,
          humanDenied: 0,
          humanDeniedPairs: 0,
        },
        ok: true,
      };
    }
    throw error;
  }

  const corrupt: Array<{ line: number; text: string }> = [];
  // Keyed by name+digest: one name with two entries is the signal that the definition changed mid-ledger.
  const digests = new Map<string, { name: string; source: string; sha256: string; spawns: number }>();
  let records = 0;
  let events = 0;
  const workspaceLeases = { acquired: 0, uncontended: 0, refused: 0, released: 0, releasedUnrecorded: 0, lost: 0, retained: 0, timeout: 0, recovered: 0 };
  const lifecycle = { starting: 0, completed: 0, failed: 0 };
  let escalationAttempts = 0;
  const executors = { herdr: 0, process: 0, unknown: 0 };
  const bySource: Record<ApprovalSource, number> = { prompt: 0, session: 0, persisted: 0, inherited: 0 };
  // `capability@subject` seen per source, so the report can state a bound as well as a raw count.
  const distinct: Record<ApprovalSource, Set<string>> = {
    prompt: new Set(),
    session: new Set(),
    persisted: new Set(),
    inherited: new Set(),
  };
  let unattributed = 0;
  let humanDenied = 0;
  const deniedPairs = new Set<string>();

  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    // A trailing newline yields one empty final element, which is normal rather than damage.
    if (raw.trim().length === 0) return;
    try {
      const event = JSON.parse(raw) as Record<string, unknown>;
      if (event.ledgerVersion !== undefined && event.event === undefined) {
        throw new Error("versioned ledger line has no event discriminator");
      }
      if (event.event === "workspace_lease") {
        requireV2(event, ["childId", "workspaceId", "root", "access"]);
        const outcome = typeof event.outcome === "string" ? event.outcome : "";
        // Explicit map, not a name match: the ledger's outcome vocabulary and these counter names are
        // allowed to differ, and a valid event must never be counted as corruption because a counter
        // happens to be spelled differently.
        const counter = Object.hasOwn(LEASE_OUTCOME_COUNTERS, outcome)
          ? LEASE_OUTCOME_COUNTERS[outcome as WorkspaceLeaseOutcome]
          : undefined;
        if (!counter) throw new Error("invalid workspace lease event");
        workspaceLeases[counter] += 1;
        events += 1;
        return;
      }
      if (event.event === "child_lifecycle") {
        requireV2(event, ["childId", "executor"]);
        const state = typeof event.state === "string" ? event.state : "";
        if (!Object.hasOwn(lifecycle, state)) throw new Error("invalid child lifecycle event");
        lifecycle[state as keyof typeof lifecycle] += 1;
        events += 1;
        return;
      }
      if (event.event === "check_receipt") {
        requireV2(event, ["childId", "receiptId", "workspaceId", "checkId", "treeSha"]);
        events += 1;
        return;
      }
      if (event.event !== undefined && event.event !== "capability_decision") throw new Error("unknown ledger event");
      const parsed = event as unknown as GrantRecord;
      if (event.event === "capability_decision") requireCapabilityDecision(event);
      if (!Array.isArray(parsed.denied)) throw new Error("not a grant record");
      records += 1;
      events += 1;
      if (isEscalationAttempt(parsed)) escalationAttempts += 1;
      const executor = (parsed as { executor?: unknown }).executor;
      if (executor === "herdr") executors.herdr += 1;
      else if (executor === "process") executors.process += 1;
      else executors.unknown += 1;
      if (parsed.humanDenied) {
        humanDenied += 1;
        const subject = parsed.agentType === undefined || parsed.agentType === "delegate" ? DELEGATE_SUBJECT : parsed.agentType;
        for (const capability of parsed.gatedBlocked ?? []) deniedPairs.add(`${capability}@${subject}`);
      }
      // A **plain, non-empty** object. Three shapes were accepted here that must not be, all of them
      // reachable from a torn, hand-edited or foreign line — which is the input class `verifyLedger` exists
      // for, so "this package never writes that" is not a defence:
      //   - `{}` beside a non-empty `approved` counted NOWHERE, silently shrinking the sample the comment
      //     below promises to keep visible;
      //   - an ARRAY passed `typeof === "object"` and was tallied with numeric indices as capability names;
      //   - `null` is an object.
      const rawSources = parsed.approvalSources;
      const sources =
        rawSources && typeof rawSources === "object" && !Array.isArray(rawSources) && Object.keys(rawSources).length > 0
          ? rawSources
          : undefined;
      if (sources) {
        // The subject half of `capability@subject`. `agentType` is the definition's name, or the literal
        // `"delegate"` for the `tools:` form — which is NOT `DELEGATE_SUBJECT`, the `<delegate>` the approval
        // layer keys on. Mapped here rather than at the write site so old ledgers read correctly too.
        // **Stated limit:** a definition genuinely named `delegate` is indistinguishable from the `tools:`
        // form in this field, and their two distinct approvals count as one pair. `DELEGATE_SUBJECT`'s own
        // angle brackets exist to make that collision impossible, and the ledger drops them.
        const subject = parsed.agentType === undefined || parsed.agentType === "delegate" ? DELEGATE_SUBJECT : parsed.agentType;
        for (const [capability, source] of Object.entries(sources)) {
          // `Object.hasOwn`, never `in`: `in` walks the prototype, so a source of `"toString"` or
          // `"valueOf"` passed the check, wrote a STRING into a counter, made `attributed` a string, and
          // deleted the entire measurement from the report while marking an intact ledger corrupt.
          // An unrecognised source is counted as unattributed rather than dropped: a tally that silently
          // ignores what it does not understand reports a smaller sample as a cleaner one.
          if (Object.hasOwn(bySource, source)) {
            bySource[source] += 1;
            distinct[source].add(`${capability}@${subject}`);
          } else unattributed += 1;
        }
      } else if (parsed.approved && parsed.approved.length > 0) {
        unattributed += parsed.approved.length;
      }
      const d = parsed.definitionDigest;
      if (d?.name && d.sha256) {
        const key = `${d.name}\u0000${d.sha256}`;
        const seen = digests.get(key);
        if (seen) seen.spawns += 1;
        else digests.set(key, { name: d.name, source: d.source, sha256: d.sha256, spawns: 1 });
      }
    } catch {
      corrupt.push({ line: index + 1, text: raw.slice(0, 120) });
    }
  });

  return {
    exists: true,
    records,
    events,
    workspaceLeases,
    lifecycle,
    corrupt,
    escalationAttempts,
    executors,
    definitions: [...digests.values()].sort((a, b) => a.name.localeCompare(b.name) || a.sha256.localeCompare(b.sha256)),
    approvals: {
      bySource,
      distinctBySource: {
        prompt: distinct.prompt.size,
        session: distinct.session.size,
        persisted: distinct.persisted.size,
        inherited: distinct.inherited.size,
      },
      unattributed,
      humanDenied,
      humanDeniedPairs: deniedPairs.size,
    },
    ok: corrupt.length === 0,
  };
}
