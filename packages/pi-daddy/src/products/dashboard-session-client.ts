import {
  validChoiceDetail,
  type DashboardChoiceAction,
  type DashboardChoiceDetail,
  type DashboardChoiceTarget,
} from "../kernel/dashboard-choice.ts";
import type { DashboardOwnerObservation } from "../kernel/dashboard-observation.ts";
import type { DashboardSettingsSnapshot, JevEditAction } from "./dashboard-settings.ts";
import type { EcosystemVersions } from "./ecosystem-versions.ts";
import { createConnection } from "node:net";

export interface DashboardSessionSnapshot {
  rows: Array<{ definition: string; model: string; thinking: string; source: string }>;
  cost: number | null;
  choiceControls?: { sourceGeneration: string };
  observation?: DashboardOwnerObservation;
  activity?: { rootId: string; path: string; taskId: string };
  versions?: EcosystemVersions;
  settings?: DashboardSettingsSnapshot;
  auto: { enabled: boolean; source: "default" | "environment" | "session" };
  pendingApprovals: Array<{ id: string; subject: string; capability: string }>;
}

interface DashboardSessionReply extends DashboardSessionSnapshot {
  choiceDetail?: DashboardChoiceDetail;
  choiceSaved?: true;
  choiceRefreshRequested?: true;
}
class ChoiceDeclined extends Error {
  readonly stale: boolean;
  constructor(stale: boolean) {
    super(
      stale
        ? "Choice is no longer available. Refresh and reopen it."
        : "Bookie declined the answer. Refresh and check the choice and answer.",
    );
    this.stale = stale;
  }
}
export type DashboardSessionAction = (
  | DashboardChoiceAction
  | { action: "get"; refreshChoices?: true }
  | { action: "set"; edits: string }
  | { action: "set-auto"; enabled: boolean }
  | { action: "set-jev"; enabled: boolean }
  | { action: "edit-jev"; option: JevEditAction }
  | { action: "set-limit"; key: "wall" | "idle"; seconds: number }
) & { expectedOwner?: { sessionId: string; cwd: string; generation: string } };

export async function dashboardSessionRequest(
  socketPath: string,
  token: string,
  request: DashboardSessionAction,
): Promise<DashboardSessionReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    const choiceAction = request.action === "inspect-choice" || request.action === "answer-choice";
    socket.setTimeout(choiceAction ? 30_000 : 2_000, () =>
      socket.destroy(new Error("dashboard session request timed out")),
    );
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      output += chunk;
      if (output.length > 64 * 1024) socket.destroy(new Error("dashboard session response too large"));
    });
    socket.once("end", () => {
      try {
        const parsed = JSON.parse(output) as DashboardSessionReply & {
          ok?: boolean;
          error?: string;
          choiceOutcome?: string;
        };
        if (!parsed.ok) {
          if (choiceAction) {
            if (parsed.choiceOutcome === "stale" || parsed.choiceOutcome === "refused")
              throw new ChoiceDeclined(parsed.choiceOutcome === "stale");
            throw Error("The owner could not confirm the choice request.");
          }
          throw new Error(parsed.error ?? "dashboard session request failed");
        }
        if (
          request.action === "inspect-choice" &&
          (!validChoiceDetail(parsed.choiceDetail) || parsed.choiceDetail.id !== request.choiceId)
        )
          throw Error("The owner returned an unavailable choice.");
        if (request.action === "answer-choice" && parsed.choiceSaved !== true)
          throw Error("Bookie did not confirm the answer.");
        if (
          !parsed.auto ||
          typeof parsed.auto.enabled !== "boolean" ||
          !["default", "environment", "session"].includes(parsed.auto.source) ||
          !Array.isArray(parsed.pendingApprovals) ||
          !Array.isArray(parsed.rows)
        )
          throw new Error("dashboard owner does not provide compatible permission controls");
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...request, token })}\n`));
  });
}

export type DashboardAcknowledgment = {
  action: string;
  state: "opened" | "pending" | "applied" | "refused" | "unconfirmed";
  effect: string;
};

/** Controls use only a connected owner; last observations remain explicitly disconnected evidence. */
export function createDashboardConnection(
  request?: (action: DashboardSessionAction) => Promise<DashboardSessionReply>,
) {
  const state: {
    snapshot?: DashboardSessionSnapshot;
    lastObserved?: DashboardSessionSnapshot;
    pending: boolean;
    error?: string;
    acknowledgment?: DashboardAcknowledgment;
  } = { pending: false };
  let generation = 0,
    poll = 0,
    requestedJev: boolean | undefined;
  let choiceInterest = 0,
    consumedInterest = 0;
  const retired = new Set<string>();
  const accept = (snapshot: DashboardSessionSnapshot) => {
    const previous = state.lastObserved?.observation,
      next = snapshot.observation;
    if (previous && !next) return false;
    if (next && retired.has(next.generation)) return false;
    if (previous && next && previous.generation === next.generation && next.sequence <= previous.sequence) return false;
    if (previous && next && previous.generation !== next.generation) {
      if (retired.size >= 16) throw Error("Dashboard owner changed repeatedly; reopen the panel");
      retired.add(previous.generation);
    }
    state.snapshot = snapshot;
    state.lastObserved = snapshot;
    state.error = undefined;
    if (
      state.acknowledgment?.state === "pending" &&
      requestedJev !== undefined &&
      snapshot.settings?.jev &&
      !snapshot.settings.jev.pending
    )
      state.acknowledgment.state = snapshot.settings.jev.enabled === requestedJev ? "applied" : "refused";
    return true;
  };
  const matchesOwner = (snapshot: DashboardSessionSnapshot | undefined, target: DashboardChoiceTarget) => {
    const owner = snapshot?.observation,
      expected = target.expectedOwner;
    return (
      !!owner &&
      owner.sessionId === expected.sessionId &&
      owner.cwd === expected.cwd &&
      owner.generation === expected.generation
    );
  };
  const matches = (snapshot: DashboardSessionSnapshot | undefined, target: DashboardChoiceTarget) => {
    const source = snapshot?.observation?.sources.find(
      (s) => s.producer === "bookie-memory" && s.generation === target.sourceGeneration,
    );
    return (
      matchesOwner(snapshot, target) &&
      snapshot?.choiceControls?.sourceGeneration === target.sourceGeneration &&
      source?.availability === "observed" &&
      source.items.some((i) => i.id === target.choiceId && i.kind === "work" && i.state === "observed")
    );
  };
  return {
    state,
    async inspectChoice(target: DashboardChoiceTarget): Promise<DashboardChoiceDetail> {
      if (!request || state.pending || !matches(state.snapshot, target)) throw new ChoiceDeclined(true);
      const result = await request({ ...target, action: "inspect-choice" });
      if (
        !matches(state.snapshot, target) ||
        !matches(result, target) ||
        !validChoiceDetail(result.choiceDetail) ||
        result.choiceDetail.id !== target.choiceId
      )
        throw new ChoiceDeclined(true);
      return result.choiceDetail;
    },
    requestChoiceRefresh() {
      choiceInterest++;
    },
    async refresh(visibleChoices?: "picker" | "list") {
      if (!request || state.pending) return;
      const observed = generation,
        order = ++poll;
      try {
        const interest = choiceInterest;
        const wanted = visibleChoices === "picker" || (visibleChoices === "list" && interest !== consumedInterest);
        const { choiceRefreshRequested, ...snapshot } = await request(
          wanted ? { action: "get", refreshChoices: true } : { action: "get" },
        );
        if (choiceRefreshRequested) consumedInterest = Math.max(consumedInterest, interest);
        if (generation === observed && order === poll && !accept(snapshot)) {
          state.snapshot = undefined;
          state.error = "Owner observation is stale or unavailable; controls disabled until a fresh reply.";
        }
      } catch (error) {
        if (generation === observed && order === poll) {
          state.snapshot = undefined;
          state.error = `Controls unavailable; showing last observation: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    },
    async change(action: Exclude<DashboardSessionAction, { action: "get" | "inspect-choice" }>) {
      if (!request || !state.snapshot || state.pending) return false;
      if (action.action === "answer-choice" && !matches(state.snapshot, action)) {
        state.acknowledgment = {
          action: action.action,
          state: "refused",
          effect: "Choice changed. Refresh and reopen it.",
        };
        return false;
      }
      const observedOwner = state.snapshot.observation;
      generation++;
      state.pending = true;
      requestedJev = action.action === "set-jev" ? action.enabled : undefined;
      const effect =
        action.action === "answer-choice"
          ? "Save this answer in project memory"
          : action.action === "set-auto"
            ? "current permission handling; admitted work unchanged"
            : action.action === "edit-jev"
              ? "use the main Pi session; current values shown below"
              : action.action === "set-jev"
                ? "current JEV session; separate paid-call and storage choices"
                : "future children; running children unchanged";
      state.acknowledgment = { action: action.action, state: "pending", effect };
      try {
        const snapshot = await request({
          ...action,
          ...(observedOwner && !action.expectedOwner
            ? {
                expectedOwner: {
                  sessionId: observedOwner.sessionId,
                  cwd: observedOwner.cwd,
                  generation: observedOwner.generation,
                },
              }
            : {}),
        });
        if (action.action === "answer-choice" && (snapshot.choiceSaved !== true || !matchesOwner(snapshot, action)))
          throw Error("Bookie did not confirm the answer.");
        const { choiceDetail: _detail, choiceSaved: _saved, ...observed } = snapshot;
        if (!accept(observed)) throw Error("owner acknowledgment is stale; reconcile before another action");
        state.acknowledgment.state =
          action.action === "edit-jev"
            ? "opened"
            : action.action === "set-jev"
              ? snapshot.settings?.jev.pending
                ? "pending"
                : snapshot.settings?.jev.enabled === action.enabled
                  ? "applied"
                  : "refused"
              : "applied";
        return true;
      } catch (error) {
        if (action.action === "answer-choice" && error instanceof ChoiceDeclined) {
          if (error.stale) state.snapshot = undefined;
          state.acknowledgment.state = "refused";
          state.error = error.message;
          return false;
        }
        state.snapshot = undefined;
        state.acknowledgment.state = "unconfirmed";
        state.error =
          action.action === "answer-choice"
            ? "Save unconfirmed. Check project memory before retrying."
            : `Control change not confirmed; inspect owner before retrying: ${error instanceof Error ? error.message : String(error)}`;
        return false;
      } finally {
        state.pending = false;
      }
    },
  };
}
