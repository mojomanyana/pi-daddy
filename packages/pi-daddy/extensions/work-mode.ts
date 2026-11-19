/** Session-owned optional guidance. Selection is operator input, never a model tool or memory inference. */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GrantsSession } from "./session.ts";
import {
  ENV_WORK_MODE,
  parseWorkMode,
  standardWorkMode,
  workModeGuidance,
  type WorkModeSelection,
  type WorkModeSnapshot,
} from "../src/kernel/work-mode.ts";
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
  return clone(selection);
}
export function finishWorkModeRequest(session: GrantsSession): void {
  const state = current(session);
  if (state) delete state.active;
}
/** Child dispatch uses only the active capture, never a later UI selection. */
export function capturedWorkMode(session: GrantsSession): WorkModeSelection | undefined {
  const state = current(session);
  const selected = state?.active ?? (state?.inherited ? state.selection : undefined);
  return selected?.mode === "ambitious" ? clone(selected) : undefined;
}

export function registerWorkMode(pi: ExtensionAPI, session: GrantsSession) {
  pi.on("before_agent_start", (event) => {
    // Native retry/compaction continues the same agent run without this hook. A new hook is a new request,
    // including after preparation failed before agent_settled could be emitted.
    const selected = beginWorkModeRequest(session, true);
    // Child launch already appended the role-preserving guidance; only maintain its descendant snapshot here.
    if (current(session)?.inherited) return;
    const guidance = workModeGuidance(selected, "parent");
    if (!guidance) return;
    // Keep Pi's structured prompt live: a full-prompt return would freeze out later extensions'
    // guidelines and native tool-loadout updates. Respect an explicit earlier override if present.
    if (event.systemPromptOptions.forceSystemPrompt !== undefined)
      event.systemPromptOptions.forceSystemPrompt += `\n\n${guidance}`;
    else event.systemPromptOptions.promptGuidelines.push(guidance);
  });
  // agent_end may precede a retry/compaction. Only a settled run consumes the active capture.
  pi.on("agent_settled", () => finishWorkModeRequest(session));
  pi.on("session_tree", (_event, ctx) => initializeWorkMode(pi, session, ctx, "tree"));
  registerWorkModeCommand(pi, session);
  return (ctx: ModeContext, reason: string, environment: NodeJS.ProcessEnv) =>
    initializeWorkMode(pi, session, ctx, reason, environment);
}
