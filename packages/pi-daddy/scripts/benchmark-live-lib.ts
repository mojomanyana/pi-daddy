/**
 * Pure, unit-testable acceptance evaluators and reporting helpers for `benchmark-live-comparison.mjs`.
 */
import { existsSync, readFileSync } from "node:fs";

const SHA256_RE = /^[a-f0-9]{64}$/;

export interface BriefReference {
  readonly version: 1;
  readonly producer: "pi-scout-research";
  readonly kind: "research-brief";
  readonly session: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface BenchmarkToolCall {
  readonly tool: string;
  readonly toolCallId?: string;
  readonly args?: Record<string, unknown>;
}

export interface BenchmarkToolResult {
  readonly tool: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly text?: string;
  readonly details?: Record<string, any>;
}

export interface AcceptanceAssertion {
  readonly id: string;
  readonly required: boolean;
  readonly status: "passed" | "failed" | "skipped";
  readonly passed: boolean | null;
  readonly detail: string;
}

/** Validate a structured Scout `research-brief` reference object. */
export function isValidBriefReference(obj: unknown): obj is BriefReference {
  const o = obj as Record<string, unknown> | null | undefined;
  return Boolean(
    o &&
    typeof o === "object" &&
    !Array.isArray(o) &&
    o.version === 1 &&
    o.producer === "pi-scout-research" &&
    o.kind === "research-brief" &&
    typeof o.session === "string" &&
    SHA256_RE.test(o.session) &&
    typeof o.sha256 === "string" &&
    SHA256_RE.test(o.sha256) &&
    Number.isInteger(o.bytes) &&
    (o.bytes as number) >= 1 &&
    (o.bytes as number) <= 96001,
  );
}

/**
 * Evaluate Scout acceptance strictly from structured evidence on the matching `scout_research`
 * invocation paired with a `delegate({ agent: "scout-public" })` call.
 *
 * Generic Daddy `delegate` cleanup (`cleanup.state === "settled"`) and model prose CANNOT
 * satisfy either Docker or Direct HTTPS cleanup requirements.
 */
export function evaluateScoutAcceptance(input: {
  mode: "direct-https" | "docker";
  processOk: boolean;
  toolCalls?: readonly BenchmarkToolCall[];
  toolResults?: readonly BenchmarkToolResult[];
}) {
  const { mode, processOk, toolCalls = [], toolResults = [] } = input;
  const failureReasons: string[] = [];
  if (!processOk) failureReasons.push("Pi process exited non-zero or timed out");

  // 1. Require a real `delegate({ agent: "scout-public" })` call whose paired tool result succeeded.
  const scoutDelegateCall = toolCalls.find((c) => c?.tool === "delegate" && c?.args?.agent === "scout-public");
  const scoutDelegateResult = scoutDelegateCall
    ? toolResults.find(
        (r) =>
          r?.tool === "delegate" &&
          (scoutDelegateCall.toolCallId ? r.toolCallId === scoutDelegateCall.toolCallId : true),
      )
    : undefined;
  const delegatedScoutPublic = Boolean(
    scoutDelegateCall && scoutDelegateResult && scoutDelegateResult.isError !== true,
  );
  if (!delegatedScoutPublic) {
    failureReasons.push('Missing successful delegate({ agent: "scout-public" }) invocation');
  }

  // 2. Require a matching `scout_research` tool invocation (paired start + non-error end) with structured details.
  const scoutStarts = toolCalls.filter((c) => c?.tool === "scout_research");
  const matchingScoutResult = toolResults.find(
    (r) =>
      r?.tool === "scout_research" &&
      r.isError !== true &&
      (scoutStarts.length === 0 || scoutStarts.some((s) => !s.toolCallId || s.toolCallId === r.toolCallId)),
  );
  const matchingScoutInvocation = Boolean(matchingScoutResult && matchingScoutResult.details);
  if (!matchingScoutInvocation) {
    failureReasons.push("Missing matching non-error scout_research invocation with structured details");
  }

  const details = matchingScoutResult?.details ?? null;

  // 3. Require valid structured `briefReference` directly from the matching Scout invocation (never prose).
  const briefRef = details?.briefReference ?? null;
  const shaConsistent = !details?.briefSha256 || details.briefSha256 === briefRef?.sha256;
  const validBriefReference = Boolean(matchingScoutInvocation && isValidBriefReference(briefRef) && shaConsistent);
  if (!validBriefReference) {
    failureReasons.push("Matching scout_research invocation did not return a valid structured briefReference");
  }

  // 4. Require mode-specific structured execution-mode & cleanup evidence strictly from Scout's result details.
  let cleanupEvidenceValid = false;
  let scoutExecutionMode: string | null = null;
  let scoutCleanupDetails: unknown = null;
  if (details) {
    if (mode === "docker") {
      const notDirectFallback = details.mode !== "direct-urls";
      const cleanupConfirmed = details.runtime?.cleanup?.confirmed === true;
      const callbacksSettled =
        details.runtime?.modelCallbackSettled !== false && details.runtime?.discoveryCallbackSettled !== false;
      cleanupEvidenceValid = Boolean(notDirectFallback && cleanupConfirmed && callbacksSettled);
      scoutExecutionMode = notDirectFallback ? (details.mode ?? "docker") : "direct-urls";
      scoutCleanupDetails = details.runtime?.cleanup ?? null;
      if (!cleanupEvidenceValid) {
        failureReasons.push(
          "Docker mode requires structured runtime.cleanup.confirmed === true from matching scout_research invocation",
        );
      }
    } else if (mode === "direct-https") {
      const ranDirectPath = details.mode === "direct-urls";
      const workerNotStarted = details.cleanup?.state === "not-started" && details.cleanup?.workerStarted === false;
      cleanupEvidenceValid = Boolean(ranDirectPath && workerNotStarted);
      scoutExecutionMode = details.mode ?? null;
      scoutCleanupDetails = details.cleanup ?? null;
      if (!cleanupEvidenceValid) {
        failureReasons.push(
          'Direct HTTPS mode requires structured mode === "direct-urls" and cleanup { state: "not-started", workerStarted: false }',
        );
      }
    } else {
      failureReasons.push(`Unsupported Scout execution mode: ${String(mode)}`);
    }
  }

  const daddyDelegationSettled = scoutDelegateResult?.details?.cleanup?.state === "settled";
  const ok = Boolean(
    processOk && delegatedScoutPublic && matchingScoutInvocation && validBriefReference && cleanupEvidenceValid,
  );

  return {
    ok,
    delegatedScoutPublic,
    matchingScoutInvocation,
    scoutToolCallId: matchingScoutResult?.toolCallId ?? null,
    validBriefReference,
    briefReference: validBriefReference ? briefRef : null,
    cleanupEvidenceValid,
    scoutExecutionMode,
    scoutCleanupDetails,
    daddyDelegationSettled,
    failureReasons,
  };
}

/**
 * Compute observed peak concurrent active children directly from Daddy's `child_lifecycle` ledger events.
 * Returns `observedPeakActiveChildren: null` when no lifecycle events were recorded (never substitutes requested counts).
 */
export function computeObservedPeakActiveFromLedger(ledgerPath: string | undefined) {
  if (!ledgerPath || !existsSync(ledgerPath)) {
    return { observedPeakActiveChildren: null as number | null, lifecycleEventCount: 0, executionIds: [] as string[] };
  }
  const active = new Set<string>();
  const seen = new Set<string>();
  let peak = 0;
  let lifecycleEventCount = 0;
  for (const line of readFileSync(ledgerPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as {
        event?: string;
        executionId?: string;
        state?: string;
        body?: { event?: string; executionId?: string; state?: string };
        record?: { event?: string; executionId?: string; state?: string };
      };
      const rec =
        raw.body && typeof raw.body === "object"
          ? raw.body
          : raw.record && typeof raw.record === "object"
            ? raw.record
            : raw;
      if (rec.event !== "child_lifecycle" || typeof rec.executionId !== "string") continue;
      lifecycleEventCount++;
      seen.add(rec.executionId);
      if (rec.state === "starting" || rec.state === "running") {
        active.add(rec.executionId);
        if (active.size > peak) peak = active.size;
      } else if (rec.state === "completed" || rec.state === "failed") {
        active.delete(rec.executionId);
      }
    } catch {
      /* Ignore malformed lines. */
    }
  }
  return {
    observedPeakActiveChildren: lifecycleEventCount > 0 ? peak : null,
    lifecycleEventCount,
    executionIds: [...seen],
  };
}

/** Explicit skipped placeholder when a task is excluded by `--only` (no invented scores or scenarios). */
export function makeSkippedTask(reason = "excluded by --only") {
  return { status: "skipped" as const, skipped: true as const, reason };
}

/** Summarize acceptance assertions distinguishing selected checks passed vs full suite passed. */
export function summarizeAcceptance(assertions: readonly AcceptanceAssertion[]) {
  const skippedCheckIds = assertions.filter((a) => a.status === "skipped").map((a) => a.id);
  const executedRequired = assertions.filter((a) => a.required && a.status !== "skipped");
  const failedRequired = executedRequired.filter((a) => a.status !== "passed");
  const allRequired = assertions.filter((a) => a.required);
  const selectedChecksPassed = executedRequired.length > 0 && failedRequired.length === 0;
  const fullSuitePassed =
    skippedCheckIds.length === 0 && allRequired.length > 0 && allRequired.every((a) => a.status === "passed");
  return {
    selectedChecksPassed,
    fullSuitePassed,
    executedRequiredCount: executedRequired.length,
    failedRequiredCount: failedRequired.length,
    skippedCheckIds,
    failedRequired,
  };
}
