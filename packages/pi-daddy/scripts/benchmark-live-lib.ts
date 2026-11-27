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
  readonly parentCallId?: string;
  readonly parentToolCallId?: string;
  readonly executionId?: string;
  readonly parentExecutionId?: string;
  readonly args?: Record<string, unknown>;
}

export interface BenchmarkToolResult {
  readonly tool: string;
  readonly toolCallId?: string;
  readonly parentCallId?: string;
  readonly parentToolCallId?: string;
  readonly executionId?: string;
  readonly parentExecutionId?: string;
  readonly isError?: boolean;
  readonly text?: string;
  readonly details?: Record<string, any>;
}

export interface AcceptanceAssertion {
  readonly id: string;
  readonly required: boolean;
  readonly status: "passed" | "failed" | "skipped" | "blocked";
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
 * start/end pair correlated to the actual `delegate({ agent: "scout-public" })` call.
 *
 * Missing or ambiguous linkage must return insufficient evidence.
 * For Docker, requires affirmative worker execution and cleanup evidence from the producer's actual schema.
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
  const scoutDelegateCalls = toolCalls.filter((c) => c?.tool === "delegate" && c?.args?.agent === "scout-public");
  if (scoutDelegateCalls.length === 0) {
    failureReasons.push('Missing delegate({ agent: "scout-public" }) invocation');
  } else if (scoutDelegateCalls.length > 1) {
    failureReasons.push('Ambiguous scout-public delegation: multiple delegate({ agent: "scout-public" }) calls found');
  }
  const scoutDelegateCall = scoutDelegateCalls.length === 1 ? scoutDelegateCalls[0] : undefined;

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
  if (scoutDelegateCall && !delegatedScoutPublic) {
    failureReasons.push('delegate({ agent: "scout-public" }) failed or returned error');
  }

  // Delegation identities for correlation:
  const delCallId = scoutDelegateCall?.toolCallId ?? null;
  const delParentExecId =
    scoutDelegateCall?.executionId ??
    scoutDelegateCall?.parentExecutionId ??
    scoutDelegateResult?.details?.parentExecutionId ??
    null;
  const delChildExecId =
    scoutDelegateResult?.details?.childExecutionId ?? scoutDelegateResult?.details?.childId ?? null;

  // 2. Correlate successful scout_research start/end pair to the actual scout-public delegation
  const scoutResults = toolResults.filter((r) => r?.tool === "scout_research" && r.isError !== true);
  const scoutStarts = toolCalls.filter((c) => c?.tool === "scout_research");

  const correlatedPairs: Array<{ start: BenchmarkToolCall; result: BenchmarkToolResult }> = [];
  let orphanResultsCount = 0;

  for (const r of scoutResults) {
    const matchingStart = scoutStarts.find((s) => s.toolCallId && r.toolCallId && s.toolCallId === r.toolCallId);
    if (!matchingStart) {
      orphanResultsCount++;
      continue;
    }

    const scoutParentCallId =
      r.parentCallId ??
      r.parentToolCallId ??
      matchingStart.parentCallId ??
      matchingStart.parentToolCallId ??
      r.details?.parentCallId ??
      r.details?.parentToolCallId ??
      null;

    const scoutChildId = r.executionId ?? matchingStart.executionId ?? r.details?.executionId ?? null;

    const scoutParentExecId =
      r.parentExecutionId ?? matchingStart.parentExecutionId ?? r.details?.parentExecutionId ?? null;

    // Check for explicit conflicting linkage:
    const conflictingCall = Boolean(scoutParentCallId && delCallId && scoutParentCallId !== delCallId);
    const conflictingParent = Boolean(scoutParentExecId && delParentExecId && scoutParentExecId !== delParentExecId);
    const conflictingChild = Boolean(delChildExecId && scoutChildId && scoutChildId !== delChildExecId);

    if (conflictingCall || conflictingParent || conflictingChild) {
      // Explicit parent or child ID conflicts with delegation trace
      continue;
    }

    // Check for affirmative matching parent or child:
    const matchesParentCall = Boolean(delCallId && scoutParentCallId && scoutParentCallId === delCallId);
    const matchesParentExec = Boolean(delParentExecId && scoutParentExecId && scoutParentExecId === delParentExecId);
    const matchesChildExec = Boolean(delChildExecId && scoutChildId && scoutChildId === delChildExecId);

    if (matchesParentCall || matchesParentExec || matchesChildExec) {
      correlatedPairs.push({ start: matchingStart, result: r });
    }
  }

  let matchingScoutResult: BenchmarkToolResult | undefined;
  let correlationValid = false;

  if (orphanResultsCount > 0 && correlatedPairs.length === 0) {
    failureReasons.push("Found orphan scout_research result with no matching start invocation");
  } else if (correlatedPairs.length === 1) {
    matchingScoutResult = correlatedPairs[0].result;
    correlationValid = true;
  } else if (correlatedPairs.length > 1) {
    failureReasons.push("Ambiguous linkage: multiple scout_research invocations correlated to scout-public delegation");
  } else {
    failureReasons.push(
      "Missing or ambiguous linkage: scout_research invocation not correlated to the scout-public delegation by call or execution identity",
    );
  }

  const matchingScoutInvocation = Boolean(matchingScoutResult && matchingScoutResult.details && correlationValid);

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
      const hasWorkerExecution = Boolean(
        details.runtime &&
        (typeof details.runtime.container === "string" ||
          (Array.isArray(details.runtime.commands) && details.runtime.commands.length > 0) ||
          typeof details.runtime.image === "string"),
      );
      const cleanupConfirmed = details.runtime?.cleanup?.confirmed === true;
      const callbacksSettled =
        details.runtime?.modelCallbackSettled !== false && details.runtime?.discoveryCallbackSettled !== false;
      cleanupEvidenceValid = Boolean(notDirectFallback && hasWorkerExecution && cleanupConfirmed && callbacksSettled);
      scoutExecutionMode = notDirectFallback ? (details.mode ?? "docker") : "direct-urls";
      scoutCleanupDetails = details.runtime?.cleanup ?? null;
      if (!cleanupEvidenceValid) {
        failureReasons.push(
          "Docker mode requires affirmative worker execution and structured runtime.cleanup.confirmed === true from producer schema",
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
    correlationValid,
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
  const blockedCheckIds = assertions.filter((a) => a.status === "blocked").map((a) => a.id);
  const failedCheckIds = assertions.filter((a) => a.status === "failed").map((a) => a.id);

  const executedRequired = assertions.filter((a) => a.required && a.status !== "skipped");
  const failedRequired = executedRequired.filter((a) => a.status !== "passed");

  const selectedChecksPassed = executedRequired.length > 0 && failedRequired.length === 0;
  const fullSuitePassed = assertions.length > 0 && assertions.every((a) => a.status === "passed");

  return {
    selectedChecksPassed,
    fullSuitePassed,
    executedRequiredCount: executedRequired.length,
    failedRequiredCount: failedRequired.length,
    skippedCheckIds,
    blockedCheckIds,
    failedCheckIds,
    failedRequired,
  };
}

function isSkillMdMutationCall(call: BenchmarkToolCall): boolean {
  if (!call) return false;
  const tool = call.tool;
  const isMutation =
    tool === "edit" ||
    tool === "write" ||
    tool === "edit-diff" ||
    tool === "edit_diff" ||
    tool === "editFile" ||
    tool === "writeFile";
  if (!isMutation) return false;
  const rawPath = String(
    call.args?.path ??
      call.args?.file ??
      call.args?.filePath ??
      call.args?.target ??
      call.args?.filename ??
      (call as any).path ??
      "",
  );
  if (rawPath) {
    return /(?:^|[\\/])SKILL\.md$/i.test(rawPath);
  }
  return false;
}

function isSuccessfulToolCall(call: BenchmarkToolCall, results: readonly BenchmarkToolResult[]): boolean {
  if (call.toolCallId) {
    const r = results.find((res) => res.toolCallId === call.toolCallId);
    if (r) return r.isError !== true;
  }
  const byTool = results.find((res) => res.tool === call.tool);
  return byTool ? byTool.isError !== true : true;
}

function findLinkedHarnessResult(
  call: BenchmarkToolCall,
  results: readonly BenchmarkToolResult[],
): BenchmarkToolResult | undefined {
  if (!call || call.tool !== "skill_check_run") return undefined;
  if (call.toolCallId) {
    return results.find((r) => r?.tool === "skill_check_run" && r.toolCallId === call.toolCallId && r.isError !== true);
  }
  return results.find((r) => r?.tool === "skill_check_run" && !r.toolCallId && r.isError !== true);
}

/**
 * Evaluate ordinary unprompted skill-edit behavioral selection:
 * Requires the edit to succeed and requires the skill harness to execute and successfully
 * evaluate the scenario covering the changed behavior (defaulting to "tag-prefix").
 * Evaluates the latest applicable verdict for the required scenario after the final relevant edit.
 * Any additional scenarios that ran are reported separately.
 */
export function evaluateOrdinarySkillEdit(input: {
  processOk: boolean;
  beforeText: string;
  afterText: string;
  toolCalls?: readonly BenchmarkToolCall[];
  toolResults?: readonly BenchmarkToolResult[];
  requiredScenarioId?: string;
}) {
  const { processOk, beforeText, afterText, toolCalls = [], toolResults = [] } = input;
  const failureReasons: string[] = [];
  if (!processOk) failureReasons.push("Pi process exited non-zero or timed out");

  const skillEdited = afterText !== beforeText && /lowercase/i.test(afterText);
  if (!skillEdited) {
    failureReasons.push("SKILL.md was not edited to clarify lowercase tag requirement");
  }

  const harnessCalls = toolCalls.filter((c) => c?.tool === "skill_check_run");
  const harnessResults = toolResults.filter((r) => r?.tool === "skill_check_run" && r.isError !== true);
  const harnessInvoked = harnessCalls.length > 0 && harnessResults.length > 0;
  if (!harnessInvoked) {
    failureReasons.push("Skill harness was never invoked to evaluate the modified skill");
  }

  // Find all indices of successful mutations of fixture SKILL.md
  const skillMutationIndices: number[] = [];
  toolCalls.forEach((call, idx) => {
    if (isSkillMdMutationCall(call) && isSuccessfulToolCall(call, toolResults)) {
      skillMutationIndices.push(idx);
    }
  });

  const fileChanged = beforeText !== afterText;
  if (fileChanged && skillMutationIndices.length === 0) {
    failureReasons.push(
      "SKILL.md was modified but the trace cannot establish the mutation boundary (insufficient evidence)",
    );
  }

  const lastMutationIndex =
    skillMutationIndices.length > 0 ? skillMutationIndices[skillMutationIndices.length - 1] : -1;

  // Post-boundary harness calls: strictly calls occurring after the final successful SKILL.md mutation
  const postBoundaryCalls = toolCalls
    .map((call, idx) => ({ call, idx }))
    .filter(
      ({ call, idx }) => call?.tool === "skill_check_run" && (lastMutationIndex === -1 || idx > lastMutationIndex),
    );

  const requiredScenario = input.requiredScenarioId ?? "tag-prefix";
  let requiredScenarioPassed = false;
  let latestApplicableVerdict: string | null = null;
  let rerunAfterFinalEdit = false;

  if (lastMutationIndex !== -1 && postBoundaryCalls.length === 0) {
    failureReasons.push(
      `Required scenario "${requiredScenario}" was not evaluated after the final relevant edit (insufficient evidence)`,
    );
  } else if (postBoundaryCalls.length > 0) {
    rerunAfterFinalEdit = true;
    for (let j = postBoundaryCalls.length - 1; j >= 0; j--) {
      const { call } = postBoundaryCalls[j];
      const matchResult = findLinkedHarnessResult(call, toolResults);
      if (!matchResult) {
        if (j === postBoundaryCalls.length - 1) {
          failureReasons.push(
            `Harness call after final edit had no matching completed result linked to the call (${call.toolCallId ?? "unlinked"})`,
          );
        }
        continue;
      }
      const scenarios = Array.isArray(matchResult?.details?.scenarios) ? matchResult.details.scenarios : [];
      const target = scenarios.find((s: any) => String(s.id) === requiredScenario);
      if (target) {
        latestApplicableVerdict = String(target.verdict);
        break;
      }
    }
    if (latestApplicableVerdict === "PASS") {
      requiredScenarioPassed = true;
    } else {
      failureReasons.push(
        `Latest applicable verdict for required scenario "${requiredScenario}" after final edit was not PASS (${latestApplicableVerdict ?? "no-verdict"})`,
      );
    }
  }

  // Collect all scenarios run across all harness results
  const scenariosActuallyRun = [
    ...new Set(
      harnessResults.flatMap((r) =>
        Array.isArray(r.details?.coverage?.scenariosRun)
          ? r.details.coverage.scenariosRun
          : Array.isArray(r.details?.scenarios)
            ? r.details.scenarios.map((s: any) => s.id)
            : [],
      ),
    ),
  ];
  const verdicts = harnessResults.flatMap((r) =>
    Array.isArray(r.details?.scenarios)
      ? r.details.scenarios.map((s: any) => ({ id: String(s.id), verdict: String(s.verdict) }))
      : [],
  );

  const extraScenariosRun = scenariosActuallyRun.filter((id) => id !== requiredScenario);
  const ok = Boolean(
    processOk &&
    skillEdited &&
    harnessInvoked &&
    (fileChanged ? skillMutationIndices.length > 0 : true) &&
    (lastMutationIndex === -1 || rerunAfterFinalEdit) &&
    requiredScenarioPassed,
  );

  return {
    ok,
    skillEdited,
    harnessInvoked,
    rerunAfterFinalEdit,
    latestApplicableVerdict,
    requiredScenarioPassed,
    requiredScenario,
    scenariosActuallyRun,
    extraScenariosRun,
    verdicts,
    failureReasons,
  };
}
