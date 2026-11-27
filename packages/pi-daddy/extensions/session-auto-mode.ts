/** Session-owned Auto policy. Dashboard mutations never become banked or inherited approvals. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readEcosystemConfig } from "../src/kernel/ecosystem-config.ts";
import type { AutoModeReader, AutoModeSource } from "../src/kernel/auto-mode.ts";
import { parseAutoModeDefault, parseAutoModeRef } from "../src/kernel/auto-mode.ts";
import { ENV_AUTO_MODE, ENV_AUTO_MODE_REF } from "../src/kernel/env-names.ts";
import {
  createAutoModeAuthority,
  connectAutoMode,
  type AutoModeAuthority,
} from "../src/governance/auto-mode-policy.ts";
import { appendLedgerEvent, buildAutoModeConfigEvent } from "../src/governance/ledger.ts";
import type { GrantsSession } from "./session.ts";

export interface SessionAutoLifecycle {
  nativeSessionId: string;
  reader: AutoModeReader;
  authority?: AutoModeAuthority;
  trustedStartup?: boolean;
  updates: Promise<unknown>;
}
const stale = () => new Error("Daddy Auto controls are unavailable for this session owner");
function current(session: GrantsSession): SessionAutoLifecycle {
  const state = session.reloadLifecycle.autoMode;
  if (!session.ownerBound || !state || session.autoMode !== state.reader) throw stale();
  return state;
}
async function record(
  session: GrantsSession,
  enabled: boolean,
  source: AutoModeSource,
  revision: number,
): Promise<void> {
  if (!session.ledgerPath) return;
  await appendLedgerEvent(
    { path: session.ledgerPath, strict: true },
    buildAutoModeConfigEvent({
      episodeId: session.episodeId,
      enabled,
      source,
      revision,
      now: new Date(),
    }),
  );
}

export async function initializeSessionAutoMode(
  session: GrantsSession,
  environment: NodeJS.ProcessEnv,
  nativeSessionId: string,
  ctx?: ExtensionContext,
): Promise<void> {
  const lifecycle = session.reloadLifecycle;
  let state = lifecycle.autoMode;
  if (session.autoMode && session.autoMode !== state?.reader) await session.autoMode.close();
  if (state && state.nativeSessionId !== nativeSessionId) {
    await state.reader.close();
    delete lifecycle.autoMode;
    delete lifecycle.projectMemorySelection;
    state = undefined;
  }
  const trustedStartup = !!(
    ctx?.mode === "tui" &&
    ctx.hasUI &&
    ctx.isProjectTrusted?.() === true &&
    session.ownerBound &&
    session.depth === 0 &&
    !session.ownExecutionId &&
    session.malformedBounds?.length === 0 &&
    nativeSessionId &&
    ctx.sessionManager?.getSessionId?.() === nativeSessionId
  );
  const defaultEnabled = () => {
    if (!trustedStartup) return false;
    try {
      return readEcosystemConfig(environment)?.autoOnStartup !== false;
    } catch (error) {
      ctx?.ui?.notify?.("Daddy Auto starts off because its settings could not be read. " + String(error), "warning");
      return false;
    }
  };
  if (state) {
    // Pi can bind its interactive UI after the initial SDK session start.
    if (state.authority && state.trustedStartup !== trustedStartup && state.authority.snapshot().source === "default") {
      const before = state.authority.snapshot();
      const enabled = defaultEnabled();
      if (enabled !== before.enabled) {
        if (enabled) await record(session, true, "default", before.revision + 1);
        if (lifecycle.autoMode !== state || session.reloadLifecycle !== lifecycle) throw stale();
        if (state.authority.snapshot().revision === before.revision) {
          const after = state.authority.set(enabled, "default");
          if (!enabled) await record(session, false, "default", after.revision);
        }
      }
      state.trustedStartup = trustedStartup;
    }
    session.autoMode = state.reader;
    return;
  }
  const rawRef = environment[ENV_AUTO_MODE_REF];
  if (rawRef !== undefined) {
    // A descendant always consults its actual owner. A dead/malformed owner must not mint a new root.
    const reader = connectAutoMode(parseAutoModeRef(rawRef));
    try {
      await reader.read();
    } catch (error) {
      await reader.close();
      throw error;
    }
    state = { nativeSessionId, reader, updates: Promise.resolve() };
  } else {
    const initial = parseAutoModeDefault(environment[ENV_AUTO_MODE]);
    if (initial.source === "default") initial.enabled = defaultEnabled();
    const authority = await createAutoModeAuthority({ enabled: false, source: initial.source });
    try {
      if (initial.enabled) {
        await record(session, true, initial.source, 1);
        authority.set(true, initial.source);
      }
    } catch (error) {
      await authority.close();
      throw error;
    }
    state = { nativeSessionId, reader: authority, authority, trustedStartup, updates: Promise.resolve() };
  }
  if (session.reloadLifecycle !== lifecycle) {
    await state.reader.close();
    throw stale();
  }
  lifecycle.autoMode = state;
  session.autoMode = state.reader;
  delete session.autoModeFailure;
}

export async function getDashboardControlState(session: GrantsSession) {
  const state = current(session);
  const value = await state.reader.read();
  if (current(session) !== state) throw stale();
  return { auto: { enabled: value.enabled, source: value.source }, pendingApprovals: value.pendingApprovals };
}

export async function setAutoApproval(session: GrantsSession, enabled: boolean, source: "dashboard" | "command") {
  if (typeof enabled !== "boolean" || (source !== "dashboard" && source !== "command"))
    throw new Error("Invalid Daddy Auto mode edit");
  const state = current(session);
  if (!state.authority) throw new Error("Only the owning root session may change Daddy Auto mode");
  // Serialize operator edits. OFF remains effective even if its audit write fails; failed ON never enables.
  const update = state.updates
    .catch(() => {})
    .then(async () => {
      if (current(session) !== state) throw stale();
      const before = state.authority!.snapshot();
      if (enabled) {
        await record(session, true, "session", before.revision + 1);
        if (current(session) !== state) throw stale();
        state.authority!.set(true, "session");
        if (enabled !== before.enabled) session.reloadLifecycle.projectMemoryOwner?.setEnabled(enabled);
      } else {
        const after = state.authority!.set(false, "session");
        if (enabled !== before.enabled) session.reloadLifecycle.projectMemoryOwner?.setEnabled(enabled);
        await record(session, false, "session", after.revision);
      }
      return getDashboardControlState(session);
    });
  state.updates = update;
  return update;
}

export async function closeSessionAutoMode(session: GrantsSession): Promise<void> {
  const reader = session.autoMode;
  delete session.autoMode;
  if (reader && session.reloadLifecycle.autoMode?.reader === reader) delete session.reloadLifecycle.autoMode;
  await reader?.close();
}
