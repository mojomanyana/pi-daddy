/** Optional trusted producers publish display observations; no automatic work, tools, or persistent store. */
import { registerDashboardChoiceOwner } from "./dashboard-choice-controls.ts";
import { dashboardSourceRefresh } from "./dashboard-source-refresh.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
      snapshot.sequence = value.sequence;
      snapshot.items = structuredClone(value.items);
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
      capabilities: { inventory: 1, refresh: 1 },
      publish(value: DashboardSourceUpdate) {
        const previousInventory = snapshot.inventory;
        if (!publish(value)) return false;
        refreshers
          .get(producer)
          ?.observed(
            value.inventory !== undefined && JSON.stringify(previousInventory) !== JSON.stringify(value.inventory),
          );
        return true;
      },
      close() {
        if (active()) {
          refreshers.get(producer)?.close();
          refreshers.delete(producer);
          delete snapshot.inventory;
          snapshot.items = snapshot.items.filter((item) => !isBookieChoice(producer, item));
          snapshot.availability = "closed";
          snapshot.observedAt = new Date(now()).toISOString();
        }
      },
    });
  });
  return {
    choices,
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
