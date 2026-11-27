/** Session-owned optional guidance. Selection is operator input, never a model tool or memory inference. */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
import type { GrantsSession } from "./session.ts";
import {
  ENV_WORK_MODE,
  parseWorkMode,
  standardWorkMode,
  workModeGuidance,
  type WorkModeSelection,
  type WorkModeSnapshot,
} from "../src/kernel/work-mode.ts";
import { isUnderPiProjectDir } from "../src/kernel/project-paths.ts";
import { AMBITIOUS_FANOUT_BUDGET, STANDARD_FANOUT_BUDGET } from "../src/kernel/fanout.ts";
import { ENV_FANOUT } from "../src/kernel/env-names.ts";
import {
  loadEcosystemConfig,
  resolveEcosystemModelCandidates,
  selectRegistryModel,
} from "../src/kernel/ecosystem-config.ts";
import { registerWorkModeCommand } from "./work-mode-command.ts";

export const WORK_MODE_ENTRY = "pi-daddy:work-mode:v1";
interface PendingMode {
  id: string;
  selection: WorkModeSelection;
}
interface StoredMode {
  version: 1;
  selection: WorkModeSelection;
  pending?: PendingMode;
  consumed?: string;
}
export interface WorkModeLifecycle {
  nativeSessionId: string;
  selection: WorkModeSelection;
  pending?: PendingMode;
  active?: WorkModeSelection;
  inherited: boolean;
  note?: string;
  isIdle?: () => boolean;
  write: (value: StoredMode) => void;
}
type ModeContext = Pick<ExtensionContext, "sessionManager" | "ui"> & Partial<Pick<ExtensionContext, "isIdle">>;
const clone = (value: WorkModeSelection) => parseWorkMode(value)!;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

function storedMode(value: unknown): StoredMode | undefined {
  if (!value || typeof value !== "object") return;
  const input = value as Record<string, unknown>;
  if (input.version !== 1) return;
  const selection = parseWorkMode(input.selection);
  if (!selection) return;
  const pending = input.pending as Partial<PendingMode> | undefined;
  if (pending && (!validId(pending.id) || !parseWorkMode(pending.selection))) return;
  if (input.consumed !== undefined && !validId(input.consumed)) return;
  return {
    version: 1,
    selection,
    ...(pending ? { pending: { id: pending.id!, selection: clone(pending.selection!) } } : {}),
    ...(typeof input.consumed === "string" ? { consumed: input.consumed } : {}),
  };
}
function modeEntry(entry: unknown): StoredMode | undefined {
  if (!entry || typeof entry !== "object") return;
  const item = entry as { type?: string; customType?: string; data?: unknown };
  return item.type === "custom" && item.customType === WORK_MODE_ENTRY ? storedMode(item.data) : undefined;
}
function current(session: GrantsSession): WorkModeLifecycle | undefined {
  const state = session.reloadLifecycle?.workMode;
  const owner = session.reloadLifecycle?.autoMode;
  return session.ownerBound &&
    state &&
    owner?.nativeSessionId === state.nativeSessionId &&
    session.autoMode === owner.reader
    ? state
    : undefined;
}

/** Called after the normal owner binding, before startup publishes child environment. */
export function initializeWorkMode(
  pi: Pick<ExtensionAPI, "appendEntry">,
  session: GrantsSession,
  ctx: ModeContext,
  reason: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const id = ctx.sessionManager?.getSessionId?.() ?? session.episodeId;
  const existing = session.reloadLifecycle.workMode;
  const write = (value: StoredMode) => {
    if (typeof pi.appendEntry !== "function") throw new Error("Work-mode session recording is unavailable");
    pi.appendEntry(WORK_MODE_ENTRY, value);
  };
  if (reason === "reload" && existing?.nativeSessionId === id) {
    existing.write = write;
    existing.isIdle = ctx.isIdle ? () => ctx.isIdle!() : undefined;
    return;
  }
  const state: WorkModeLifecycle = {
    nativeSessionId: id,
    selection: standardWorkMode(),
    inherited: false,
    write,
    ...(ctx.isIdle ? { isIdle: () => ctx.isIdle!() } : {}),
  };
  session.reloadLifecycle.workMode = state;
  if (session.depth > 0 || session.ownExecutionId) {
    state.inherited = true;
    const raw = environment[ENV_WORK_MODE];
    if (raw !== undefined) {
      try {
        const parsed = raw.length <= 512 ? parseWorkMode(JSON.parse(raw)) : undefined;
        if (!parsed) throw Error();
        state.selection = parsed;
      } catch {
        state.note =
          "Inherited work-mode guidance is unavailable; Standard applies. Execution permissions are unchanged.";
      }
    }
    return;
  }
  if (reason === "new") return;
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const consumed = new Set(entries.map(modeEntry).flatMap((item) => (item?.consumed ? [item.consumed] : [])));
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== WORK_MODE_ENTRY) continue;
      const record = modeEntry(entry);
      if (!record) {
        state.note = "Saved work-mode settings could not be read; Standard applies. Select a mode again if wanted.";
        break;
      }
      state.selection = record.selection;
      // A fork is a new conversation; a historical one-shot request must never become its next request.
      if (reason !== "fork" && record.pending && !consumed.has(record.pending.id)) state.pending = record.pending;
      break;
    }
  } catch {
    state.note = "Saved work-mode settings are unavailable; Standard applies.";
  }
}

export function workModeSnapshot(session: GrantsSession): WorkModeSnapshot {
  const state = current(session);
  return state
    ? {
        available: true,
        selection: clone(state.selection),
        inherited: state.inherited,
        ...(state.pending ? { nextRequest: clone(state.pending.selection) } : {}),
        // Preparation can fail without agent_settled. Display the owner's live idle state rather
        // than treating a captured prompt as proof that a run is still active.
        ...(state.active && !state.isIdle?.() ? { active: clone(state.active) } : {}),
        ...(state.note ? { note: state.note } : {}),
      }
    : { available: false, selection: standardWorkMode(), inherited: false };
}

/** Sync session-wide active descendant fanout across Standard (8) and Ambitious (24) unless PI_DADDY_FANOUT is explicitly pinned. */
export function syncModeFanout(session: GrantsSession, selection: WorkModeSelection | undefined): void {
  if (session.depth !== 0 || session.ownExecutionId) return;
  if (session.fanoutFromEnvironment || process.env[ENV_FANOUT] !== undefined) return;
  const target = selection?.mode === "ambitious" ? AMBITIOUS_FANOUT_BUDGET : STANDARD_FANOUT_BUDGET;
  if (typeof session.capacity?.setTotal === "function" && session.capacity.total !== target) {
    session.capacity.setTotal(target);
    session.fanoutBudget = target;
  }
}

/** Explicit operator edit. A session edit clears a queued one-shot override but keeps active work frozen. */
export function setWorkMode(session: GrantsSession, value: unknown, scope: unknown): void {
  const state = current(session);
  if (!state || state.inherited || !session.reloadLifecycle.autoMode?.authority)
    throw new Error("Work mode can only be changed in the connected owning parent");
  const selection = parseWorkMode(value);
  if (!selection || (scope !== "session" && scope !== "next-request"))
    throw new Error("Choose Standard or Ambitious, valid emphases, and a session or next-request scope");
  const next: StoredMode =
    scope === "session"
      ? { version: 1, selection }
      : { version: 1, selection: state.selection, pending: { id: randomUUID(), selection } };
  try {
    state.write(next);
  } catch {
    throw new Error("Work-mode selection was not saved; the previous setting still applies");
  }
  state.selection = clone(next.selection);
  state.pending = next.pending;
  delete state.note;
  if (scope === "session") syncModeFanout(session, state.selection);
}

/** Capture before any asynchronous discovery/gating; one override belongs to one complete Pi run. */
export function beginWorkModeRequest(session: GrantsSession, freshRequest = false): WorkModeSelection | undefined {
  const state = current(session);
  if (!state) return;
  if (state.active && !freshRequest) return clone(state.active);
  let selection = state.pending?.selection ?? state.selection;
  if (state.pending) {
    try {
      state.write({ version: 1, selection: state.selection, consumed: state.pending.id });
      delete state.pending;
    } catch {
      // Do not run an override whose consumption cannot be recorded; ordinary delivery remains available.
      state.note = "Next-request mode could not be recorded and was not used; the session mode applies.";
      selection = state.selection;
    }
  }
  state.active = clone(selection);
  syncModeFanout(session, state.active);
  return clone(selection);
}
export function finishWorkModeRequest(session: GrantsSession): void {
  const state = current(session);
  if (state) {
    delete state.active;
    syncModeFanout(session, state.selection);
  }
}
/** Child dispatch uses only the active capture, never a later UI selection. */
export function capturedWorkMode(session: GrantsSession): WorkModeSelection | undefined {
  const state = current(session);
  const selected = state?.active ?? (state?.inherited ? state.selection : undefined);
  return selected?.mode === "ambitious" ? clone(selected) : undefined;
}

const WHOLE_REPO_REQUEST_RE =
  /\b(whole\s+repo|entire\s+repo|full\s+repo|all\s+repos|multi-repo|across\s+all\s+repos)\b/i;

export interface ReviewScope {
  readonly mode: "workspace" | "whole-repo";
  readonly cwd: string;
  readonly label: string;
}

/** Scope automatic review to the directory where Pi started unless the prompt explicitly widens to whole/multi-repo. */
export function resolveReviewScope(cwd: string, prompt: string): ReviewScope {
  if (WHOLE_REPO_REQUEST_RE.test(prompt)) {
    return { mode: "whole-repo", cwd, label: `whole-repo (widened by request from ${cwd})` };
  }
  return { mode: "workspace", cwd, label: `workspace (${cwd})` };
}

export async function collectReviewDiff(
  cwd: string,
  scopeMode: "workspace" | "whole-repo" = "workspace",
): Promise<string> {
  const parts: string[] = [];
  let diff = "";
  const pathspec = scopeMode === "workspace" ? ["--", "."] : [];
  try {
    const out = await execFileAsync("git", ["diff", "--no-color", "HEAD", ...pathspec], {
      cwd,
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    diff = out.stdout.trim();
  } catch {
    // Unborn HEAD (fresh git init with 0 commits): fall back to staged diff.
    try {
      const out = await execFileAsync("git", ["diff", "--no-color", "--cached", ...pathspec], {
        cwd,
        timeout: 5000,
        maxBuffer: 256 * 1024,
      });
      diff = out.stdout.trim();
    } catch {
      diff = "";
    }
  }
  if (diff) parts.push(diff);

  // Include untracked non-ignored files strictly under the effective scope (never sibling/parent folders).
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", ...pathspec], {
      cwd,
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const untracked = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith(".") && !s.startsWith("../") && !s.endsWith(".log") && !isUnderPiProjectDir(s))
      .slice(0, 12);
    let extraBytes = 0;
    for (const rel of untracked) {
      if (extraBytes >= 12_000) break;
      try {
        const full = join(cwd, rel);
        const info = await stat(full);
        if (!info.isFile() || info.size === 0 || info.size > 32 * 1024) continue;
        const raw = await readFile(full, "utf8");
        if (raw.includes("\0")) continue;
        const snippet = raw.slice(0, Math.min(raw.length, 12_000 - extraBytes));
        extraBytes += snippet.length;
        parts.push(`--- /dev/null\n+++ b/${rel}\n${snippet}`);
      } catch {
        /* Skip unreadable untracked file. */
      }
    }
  } catch {
    /* Non-git workspace or git unavailable. */
  }
  return parts.join("\n\n").trim();
}

async function runColdDiffReview(
  ctx: ExtensionContext,
  originalPrompt: string,
  model: unknown,
  signal?: AbortSignal,
  pi?: ExtensionAPI,
): Promise<{ pass: boolean; feedback?: string; scope: ReviewScope }> {
  const scope = resolveReviewScope(ctx.cwd, originalPrompt);
  try {
    const trimmed = await collectReviewDiff(ctx.cwd, scope.mode);
    if (!trimmed) return { pass: true, scope };
    if (ctx.hasUI) ctx.ui?.notify?.(`Review scope: ${scope.label}`, "info");
    pi?.events?.emit?.("pi-daddy:ecosystem-activity:v1", {
      producer: "principal",
      kind: "review-started",
      detail: `Principal · cold review started (${scope.label})`,
    });
    const registry = (ctx as any).modelRegistry;
    if (!model || typeof registry?.streamSimple !== "function") throw Error("Review model unavailable");
    const clippedDiff = trimmed.length > 24_000 ? `${trimmed.slice(0, 24_000)}\n...[truncated]` : trimmed;
    const reviewPrompt = [
      "You are an independent, cold senior engineer reviewing ONLY this git diff against",
      "the user's original requirements. Check EVERY explicit requirement: correctness,",
      "concurrency/race conditions, boundary/edge cases, memory/resource cleanup, and API",
      "compatibility. If EVERY requirement is solidly satisfied, reply EXACTLY:",
      "VERDICT: PASS",
      "Otherwise reply: VERDICT: FAIL followed by a concise bullet list of ONLY concrete,",
      "verified [BLOCKER] defects (file, exact flaw, minimal fix). No style nitpicks.",
      "",
      "=== ORIGINAL REQUEST ===",
      originalPrompt.slice(0, 4000),
      "",
      "=== GIT DIFF & NEW FILES ===",
      clippedDiff,
    ].join("\n");
    const timeoutSignal = AbortSignal.timeout(15_000);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const stream = registry.streamSimple(
      model,
      {
        messages: [{ role: "user", content: [{ type: "text", text: reviewPrompt }], timestamp: Date.now() }],
      },
      { signal: effectiveSignal, reasoning: "low" },
    );
    const message = await stream.result();
    const text = (message?.content ?? [])
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    if (!text || message?.stopReason === "error" || message?.stopReason === "aborted")
      throw Error("Review model unavailable");
    if (/^VERDICT:\s*PASS\b/im.test(text)) {
      pi?.events?.emit?.("pi-daddy:ecosystem-activity:v1", {
        producer: "principal",
        kind: "review-completed",
        detail: `Principal · review passed (${scope.label})`,
      });
      return { pass: true, scope };
    }
    pi?.events?.emit?.("pi-daddy:ecosystem-activity:v1", {
      producer: "principal",
      kind: "review-failed",
      detail: `Principal · review found blocker(s) (${scope.label})`,
    });
    return { pass: false, feedback: text.slice(0, 2500), scope };
  } catch {
    if (!signal?.aborted && ctx.hasUI)
      ctx.ui?.notify?.(
        "Independent review could not finish. Choose a connected STRONG model in /dashboard settings, then use Escalate to retry.",
        "warning",
      );
    return { pass: false, scope };
  }
}

export function registerWorkMode(pi: ExtensionAPI, session: GrantsSession) {
  let savedThinking: string | undefined;
  let savedTools: string[] | undefined;
  let lastPrompt = "";
  let lastCtx: ExtensionContext | undefined;
  let coldReviewRanForTurn = false;
  let escalatedForTurn = false;
  let harnessHoldsForTurn = 0;
  const failedSkillEvals = new Map<
    string,
    { skill: string; coverageLabel: string; failed: Array<{ id: string; expected?: string[]; observed?: string }> }
  >();

  pi.events?.on?.("skill-harness:eval-result:v1", (payload: unknown) => {
    const ev = payload as {
      skill?: string;
      keepTaskOpen?: boolean;
      coverage?: { label?: string };
      scenarios?: Array<{ id: string; verdict: string; expected?: string[]; observed?: string }>;
    };
    if (!ev || typeof ev.skill !== "string") return;
    if (ev.keepTaskOpen) {
      const failed = (ev.scenarios ?? []).filter((s) => s.verdict !== "PASS");
      failedSkillEvals.set(ev.skill, {
        skill: ev.skill,
        coverageLabel: ev.coverage?.label ?? "focused",
        failed,
      });
    } else {
      failedSkillEvals.delete(ev.skill);
    }
  });

  const runRescueEscalation = async (reason: string) => {
    if (escalatedForTurn || !lastCtx) return;
    const { model, label: strongSpec } = selectRegistryModel(
      lastCtx.modelRegistry,
      resolveEcosystemModelCandidates("strong"),
      lastCtx.model,
    );
    if (!model) {
      if (lastCtx.hasUI)
        lastCtx.ui.notify("Select a connected model with /model and request escalation again.", "warning");
      return;
    }
    escalatedForTurn = true;
    const verdict = await runColdDiffReview(
      lastCtx,
      `${lastPrompt}\n\n[Escalation trigger: ${reason}. Identify the exact root cause and concrete fix.]`,
      model,
      (lastCtx as any)?.signal,
      pi,
    );
    const send = (pi as any).sendUserMessage;
    if (!verdict.pass && verdict.feedback && typeof send === "function") {
      pi.events?.emit?.("pi-daddy:review-blocker:v1", { feedback: verdict.feedback.slice(0, 400) });
      send(
        `[Strong-model escalation (${strongSpec}) — ${reason}]:\n\n${verdict.feedback}\n\nApply this fix directly and re-verify.`,
        { deliverAs: "steer", expandPromptTemplates: false },
      );
    }
  };

  pi.events?.on?.("principal:thrash-detected:v1", (payload: any) => {
    const cfg = loadEcosystemConfig();
    if (process.env.PI_ECO_AUTO_ESCALATE === "0" || cfg.escalation?.auto === false) return;
    const detail = `repeated failing check (${payload?.command ?? "test"}): ${payload?.signature ?? "thrash"}`;
    void runRescueEscalation(detail).catch(() => {});
  });
  pi.events?.on?.("pi-daddy:escalate-request:v1", (payload: any) => {
    void runRescueEscalation(String(payload?.reason ?? "operator panel")).catch(() => {});
  });

  const restoreThinking = () => {
    if (savedThinking !== undefined && typeof (pi as any).setThinkingLevel === "function") {
      try {
        (pi as any).setThinkingLevel(savedThinking);
      } catch {
        /* best-effort */
      }
    }
    savedThinking = undefined;
  };

  const restoreTools = () => {
    if (savedTools !== undefined && typeof (pi as any).setActiveTools === "function") {
      try {
        (pi as any).setActiveTools(savedTools);
      } catch {
        /* best-effort */
      }
    }
    savedTools = undefined;
  };

  const resetLifecycle = () => {
    restoreThinking();
    restoreTools();
    lastPrompt = "";
    coldReviewRanForTurn = false;
    escalatedForTurn = false;
    harnessHoldsForTurn = 0;
    failedSkillEvals.clear();
  };

  for (const ev of ["session_start", "session_switch", "session_fork", "session_shutdown"]) {
    (pi as any).on(ev, resetLifecycle);
  }

  pi.on("before_agent_start", (event, ctx) => {
    lastCtx = ctx;
    coldReviewRanForTurn = false;
    escalatedForTurn = false;
    harnessHoldsForTurn = 0;
    lastPrompt = typeof (event as any).prompt === "string" ? (event as any).prompt : "";
    const selected = beginWorkModeRequest(session, true);
    if (current(session)?.inherited) return;
    const guidance = workModeGuidance(selected, "parent");
    if (!guidance) return;

    // Mechanical lever 1: for explicit `speed` (without depth/altitude), lower thinking to "low".
    // Never force-bump parent thinking upward; spend deeper reasoning on the 1-shot cold review.
    const getThinking = (pi as any).getThinkingLevel;
    const setThinking = (pi as any).setThinkingLevel;
    if (selected?.mode === "ambitious" && typeof getThinking === "function" && typeof setThinking === "function") {
      const cur = getThinking();
      const hasDepthOrAlt = selected.emphases.includes("depth") || selected.emphases.includes("altitude");
      const hasSpeedOnly = selected.emphases.includes("speed") && !hasDepthOrAlt;
      if (hasSpeedOnly && ["medium", "high", "xhigh", "max"].includes(cur)) {
        savedThinking = cur;
        try {
          setThinking("low");
        } catch {
          savedThinking = undefined;
        }
      }
    }

    // Mechanical lever 1b: auto-activate Phase-2 tools for balanced Ambitious or matching emphases.
    const getTools = (pi as any).getActiveTools;
    const setTools = (pi as any).setActiveTools;
    if (selected?.mode === "ambitious" && typeof getTools === "function" && typeof setTools === "function") {
      const balanced = selected.emphases.length === 0;
      const extras: string[] = [];
      if ((balanced || selected.emphases.includes("range")) && session.mayDelegate) {
        extras.push("delegate_tournament");
      }
      if (balanced || selected.emphases.includes("altitude") || selected.emphases.includes("depth")) {
        extras.push("quick_review");
      }
      if (extras.length > 0) {
        const currentTools: string[] = getTools();
        const missing = extras.filter((t) => !currentTools.includes(t));
        if (missing.length > 0) {
          savedTools = [...currentTools];
          try {
            setTools([...currentTools, ...missing]);
          } catch {
            savedTools = undefined;
          }
        }
      }
    }

    // Inject into structured XML section (preserves Pi 1.6 prompt-diff prefix caching).
    const opts = event.systemPromptOptions as any;
    if (opts.forceSystemPrompt !== undefined) {
      opts.forceSystemPrompt += `\n\n<pi-daddy-work-mode>\n${guidance}\n</pi-daddy-work-mode>`;
    } else {
      opts.sections = { ...(opts.sections ?? {}), "pi-daddy-work-mode": guidance };
    }
  });

  // Mechanical lever 2: Skill Harness failure gate (keeps task open in both Standard and Ambitious
  // modes until failed scenarios are fixed and rerun to PASS) + automatic scoped cold diff review.
  (pi as any).on("agent_before_settle", async (event: any, ctx: ExtensionContext) => {
    if (failedSkillEvals.size > 0 && harnessHoldsForTurn < 3) {
      harnessHoldsForTurn++;
      const details = [...failedSkillEvals.values()].map((item) => {
        const rows = item.failed.map(
          (f) => `  - ${f.id}: expected [${(f.expected ?? []).join(" | ")}], observed [${f.observed ?? "FAIL"}]`,
        );
        return `Skill "${item.skill}" (${item.coverageLabel}) has failing scenario(s):\n${rows.join("\n")}`;
      });
      const content = [
        "Skill Harness reported failed evaluation scenario(s); this task remains open:",
        "",
        ...details,
        "",
        "Fix the in-scope skill regression and rerun the affected scenario(s) with skill_check_run, " +
          "or explain why the evaluation needs updating before changing it if behavior intentionally changed.",
      ].join("\n");
      return {
        entries: [
          ...(Array.isArray(event?.entries) ? event.entries : []),
          { type: "custom_message", customType: "pi-daddy-skill-harness-gate", content, display: false },
        ],
        continue: true,
      };
    }
    if (coldReviewRanForTurn || !lastPrompt) return;
    const active = capturedWorkMode(session);
    const wantsAmbitiousDepth =
      active?.mode === "ambitious" && (active.emphases.length === 0 || active.emphases.includes("depth"));
    if (!wantsAmbitiousDepth && process.env.PI_DADDY_AUTO_REVIEW === "0") return;
    const { model } = selectRegistryModel(ctx.modelRegistry, resolveEcosystemModelCandidates("strong"), ctx.model);
    if (!wantsAmbitiousDepth) {
      const strong = model as typeof ctx.model;
      if (!strong || (strong.provider === ctx.model?.provider && strong.id === ctx.model?.id)) return;
      const scope = resolveReviewScope(ctx.cwd, lastPrompt);
      const preview = await collectReviewDiff(ctx.cwd, scope.mode);
      const fileCount = (preview.match(/^\+\+\+ b\//gm) ?? []).length;
      const lineCount = preview.split("\n").length;
      if (fileCount < 2 && lineCount < 60) return;
    }
    coldReviewRanForTurn = true;
    const verdict = await runColdDiffReview(ctx, lastPrompt, model, (ctx as any)?.signal, pi);
    if (verdict.pass || !verdict.feedback) return;
    const content = [
      `Independent cold diff review (${verdict.scope.label}) found concrete blocker(s) against the user's requirements:`,
      "",
      verdict.feedback,
      "",
      "Fix these verified issues, re-run tests to prove they pass, then provide your final reply.",
    ].join("\n");
    return {
      entries: [
        ...(Array.isArray(event?.entries) ? event.entries : []),
        { type: "custom_message", customType: "pi-daddy-cold-review", content, display: false },
      ],
      continue: true,
    };
  });

  pi.on("agent_settled", () => {
    restoreThinking();
    restoreTools();
    finishWorkModeRequest(session);
  });
  pi.on("session_tree", (_event, ctx) => initializeWorkMode(pi, session, ctx, "tree"));
  registerWorkModeCommand(pi, session);
  return (ctx: ModeContext, reason: string, environment: NodeJS.ProcessEnv) => {
    initializeWorkMode(pi, session, ctx, reason, environment);
    const state = current(session);
    if (state) syncModeFanout(session, state.selection);
  };
}
