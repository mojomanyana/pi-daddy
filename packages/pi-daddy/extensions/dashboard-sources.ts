/** Optional trusted producers publish display observations; no automatic work, tools, or persistent store. */
import { registerDashboardChoiceOwner } from "./dashboard-choice-controls.ts";
import { dashboardSourceRefresh } from "./dashboard-source-refresh.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DASHBOARD_DELIVERY_PRODUCER } from "../src/kernel/dashboard-delivery.ts";
import {
  DASHBOARD_SOURCE_EVENT,
  DASHBOARD_SOURCE_LIMIT,
  isBookieChoice,
  validDashboardSourceUpdate,
  type DashboardSourceSnapshot,
  type DashboardSourceRefreshCallback,
  type DashboardSourceUpdate,
} from "../src/kernel/dashboard-observation.ts";
export interface DashboardSourceOwner {
  sessionId: string;
  cwd: string;
}
export function registerDashboardSources(
  pi: ExtensionAPI,
  current: () => DashboardSourceOwner | undefined,
  now: () => number = Date.now,
  currentTurnId?: () => string | undefined,
) {
  const sources = new Map<string, DashboardSourceSnapshot>();
  const refreshers = new Map<string, ReturnType<typeof dashboardSourceRefresh>>();
  let closed = false;
  let owner = current(),
    generation = randomUUID(),
    sequence = 0;
  const reconcile = () => {
    if (closed) return undefined;
    const selected = current();
    if (selected !== owner) {
      owner = selected;
      for (const refresh of refreshers.values()) refresh.close();
      refreshers.clear();
      sources.clear();
      generation = randomUUID();
      sequence = 0;
    }
    return selected;
  };
  const choices = registerDashboardChoiceOwner(
    pi,
    () => {
      const selected = reconcile();
      const source = sources.get("bookie-memory");
      return selected && source ? { sessionId: selected.sessionId, cwd: selected.cwd, source } : undefined;
    },
    now,
  );
  const off = pi.events?.on?.(DASHBOARD_SOURCE_EVENT, (input: unknown) => {
    const r = input as {
      version?: unknown;
      sessionId?: unknown;
      cwd?: unknown;
      producer?: unknown;
      producerVersion?: unknown;
      capabilities?: { taskHistory?: unknown; taskProgress?: unknown; taskDelivery?: unknown };
      refresh?: unknown;
      reply?: (value: unknown) => void;
    };
    if (r?.version !== 1 || typeof r.reply !== "function") return;
    const selected = reconcile();
    const reply = (value: unknown) => {
      try {
        r.reply!(value);
      } catch {
        /* optional consumer cannot break owner work */
      }
    };
    if (
      !selected ||
      selected.sessionId !== r.sessionId ||
      selected.cwd !== r.cwd ||
      typeof r.producer !== "string" ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(r.producer) ||
      typeof r.producerVersion !== "string" ||
      !r.producerVersion ||
      r.producerVersion.length > 80 ||
      (r.refresh !== undefined && typeof r.refresh !== "function") ||
      (!sources.has(r.producer) && sources.size >= DASHBOARD_SOURCE_LIMIT)
    ) {
      reply({ version: 1, ok: false, reason: "dashboard source registration unavailable" });
      return;
    }
    const producer = r.producer,
      token = randomUUID();
    const taskHistoryEnabled = producer === "bookie-memory" && r.capabilities?.taskHistory === 1;
    const progressEnabled = taskHistoryEnabled && r.capabilities?.taskProgress === 1;
    const deliveryEnabled = producer === DASHBOARD_DELIVERY_PRODUCER && r.capabilities?.taskDelivery === 1;
    const snapshot: DashboardSourceSnapshot = {
      producer,
      producerVersion: r.producerVersion,
      generation: token,
      sequence: -1,
      observedAt: new Date(now()).toISOString(),
      staleAfterMs: 120_000,
      availability: "observed",
      items: [],
    };
    sources.set(producer, snapshot);
    refreshers.get(producer)?.close();
    refreshers.delete(producer);
    const active = () =>
      reconcile() === selected && sources.get(producer) === snapshot && snapshot.availability !== "closed";
    const publish = (value: DashboardSourceUpdate) => {
      if (!active() || !validDashboardSourceUpdate(value) || value.sequence <= snapshot.sequence) return false;
      if (value.taskHistory !== undefined && !taskHistoryEnabled) return false;
      const delivery = value.taskDelivery;
      if (delivery && !deliveryEnabled) return false;
      if (
        delivery &&
        snapshot.taskDelivery?.deliveryId === delivery.deliveryId &&
        delivery.revision < snapshot.taskDelivery.revision
      )
        return false;
      if (
        !progressEnabled &&
        (value.taskHistory?.recentProgress !== undefined || value.taskHistory?.lastCheckpoint !== undefined)
      )
        return false;
      snapshot.sequence = value.sequence;
      snapshot.items = structuredClone(value.items);
      if (value.taskHistory) snapshot.taskHistory = structuredClone(value.taskHistory);
      else delete snapshot.taskHistory;
      if (delivery) {
        snapshot.taskDelivery = structuredClone(delivery);
        snapshot.taskDeliveryTurnId = currentTurnId?.();
      } else {
        delete snapshot.taskDelivery;
        delete snapshot.taskDeliveryTurnId;
      }
      if (value.inventory) snapshot.inventory = structuredClone(value.inventory);
      else delete snapshot.inventory;
      snapshot.observedAt = new Date(now()).toISOString();
      return true;
    };
    if (r.refresh)
      refreshers.set(
        producer,
        dashboardSourceRefresh(snapshot, r.refresh as DashboardSourceRefreshCallback, active, publish, now),
      );
    reply({
      version: 1,
      ok: true,
      generation: token,
      capabilities: {
        inventory: 1,
        refresh: 1,
        ...(taskHistoryEnabled ? { taskHistory: 1 } : {}),
        ...(progressEnabled ? { taskProgress: 1 } : {}),
        ...(deliveryEnabled ? { taskDelivery: 1 } : {}),
      },
      publish(value: DashboardSourceUpdate) {
        const previousInventory = snapshot.inventory;
        const previousHistory = snapshot.taskHistory;
        if (!publish(value)) return false;
        refreshers
          .get(producer)
          ?.observed(
            (value.inventory !== undefined && JSON.stringify(previousInventory) !== JSON.stringify(value.inventory)) ||
              JSON.stringify(previousHistory) !== JSON.stringify(value.taskHistory),
          );
        return true;
      },
      close() {
        if (active()) {
          refreshers.get(producer)?.close();
          refreshers.delete(producer);
          delete snapshot.inventory;
          delete snapshot.taskHistory;
          delete snapshot.taskDelivery;
          delete snapshot.taskDeliveryTurnId;
          snapshot.items = snapshot.items.filter((item) => !isBookieChoice(producer, item));
          snapshot.availability = "closed";
          snapshot.observedAt = new Date(now()).toISOString();
        }
      },
    });
  });
  return {
    choices,
    selectedTaskId() {
      if (!reconcile()) return;
      const source = sources.get("bookie-memory");
      if (!source || source.availability !== "observed" || source.refresh?.state === "failed") return;
      const age = now() - Date.parse(source.observedAt);
      return age >= 0 && age <= source.staleAfterMs ? source.taskHistory?.taskId : undefined;
    },
    requestRefresh() {
      if (!reconcile()) return false;
      let requested = false;
      for (const refresh of refreshers.values()) requested = refresh.request() || requested;
      return requested;
    },
    snapshot() {
      const selected = reconcile();
      return selected
        ? {
            sessionId: selected.sessionId,
            cwd: selected.cwd,
            generation,
            sequence: ++sequence,
            observedAt: new Date(now()).toISOString(),
            sources: structuredClone([...sources.values()]),
          }
        : undefined;
    },
    close() {
      closed = true;
      for (const refresh of refreshers.values()) refresh.close();
      refreshers.clear();
      choices.close();
      off?.();
      sources.clear();
      owner = undefined;
      generation = randomUUID();
    },
  };
}
