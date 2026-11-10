/** The live Bookie extension explicitly installs these controls for its current display publisher. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DashboardSourceSnapshot } from "../src/kernel/dashboard-observation.ts";
import {
  DASHBOARD_CHOICE_EVENT,
  validChoiceAnswer,
  validChoiceDetail,
  validChoiceId,
  validChoiceRevision,
  type DashboardChoiceRegistration,
  type DashboardChoiceDetail,
  type DashboardChoiceOutcome,
} from "../src/kernel/dashboard-choice.ts";

type Source = { sessionId: string; cwd: string; source: DashboardSourceSnapshot };
type Binding = {
  source: DashboardSourceSnapshot;
  provider: DashboardChoiceRegistration;
  lastRenewal: number;
  renewing: boolean;
};
export function registerDashboardChoiceOwner(pi: ExtensionAPI, lookup: () => Source | undefined, now: () => number) {
  let binding: Binding | undefined;
  const installed = new WeakSet<DashboardSourceSnapshot>();
  const off = pi.events?.on?.(DASHBOARD_CHOICE_EVENT, (input: unknown) => {
    const r = input as DashboardChoiceRegistration | undefined;
    if (r?.version !== 1 || typeof r.reply !== "function") return;
    const current = lookup();
    if (
      !current ||
      current.source.availability !== "observed" ||
      r.sessionId !== current.sessionId ||
      r.cwd !== current.cwd ||
      r.sourceGeneration !== current.source.generation ||
      installed.has(current.source) ||
      typeof r.inspect !== "function" ||
      typeof r.answer !== "function"
    ) {
      r.reply({ version: 1, ok: false });
      return;
    }
    installed.add(current.source);
    const entry: Binding = { source: current.source, provider: r, lastRenewal: -Infinity, renewing: false };
    binding = entry;
    r.reply({
      version: 1,
      ok: true,
      close() {
        if (binding === entry) binding = undefined;
      },
    });
  });
  const current = () => {
    const source = lookup()?.source;
    return source && source === binding?.source && source.availability === "observed" ? binding : undefined;
  };
  const active = () => {
    const entry = current();
    if (!entry) return;
    const age = now() - Date.parse(entry.source.observedAt);
    return Number.isFinite(age) && age >= 0 && age <= entry.source.staleAfterMs ? entry : undefined;
  };
  const row = (entry: Binding, id: unknown) =>
    entry.source.items.find((item) => item.id === id && item.kind === "work" && item.state === "observed");
  const ready = (sourceGeneration: unknown, choiceId: unknown) => {
    const entry = active();
    if (entry && entry.source.generation === sourceGeneration && validChoiceId(choiceId) && row(entry, choiceId))
      return entry;
    return undefined;
  };
  const fence = (entry: Binding, id: string, label: string, checkClient: () => void) => () => {
    checkClient();
    if (active() !== entry || row(entry, id)?.label !== label) throw Error("Choice is no longer current");
  };
  let saving: Binding | undefined;
  return {
    requestRenewal() {
      const entry = current();
      if (!entry?.provider.renew || !entry.source.items.some((item) => validChoiceId(item.id) && row(entry, item.id)))
        return false;
      const time = now(),
        age = time - Date.parse(entry.source.observedAt);
      if (!Number.isFinite(age) || age < entry.source.staleAfterMs - 15_000) return false;
      if (entry.renewing || time - entry.lastRenewal < 30_000) return true;
      // Demand is explicit. The old publication keeps its original age until Bookie actually republishes.
      entry.lastRenewal = time;
      entry.renewing = true;
      void Promise.resolve()
        .then(() => {
          if (current() === entry) return entry.provider.renew?.();
        })
        .catch(() => undefined)
        .finally(() => {
          entry.renewing = false;
        });
      return true;
    },
    controls() {
      const entry = active();
      return entry ? { sourceGeneration: entry.source.generation } : undefined;
    },
    currentDetail(sourceGeneration: unknown, detail: DashboardChoiceDetail) {
      const entry = ready(sourceGeneration, detail.id);
      return !!entry && row(entry, detail.id)?.label === detail.label;
    },
    async inspect(
      sourceGeneration: unknown,
      id: unknown,
      checkClient: () => void,
    ): Promise<DashboardChoiceDetail | undefined> {
      const entry = ready(sourceGeneration, id);
      if (!entry || typeof id !== "string") return;
      const label = row(entry, id)!.label;
      const assertCurrent = fence(entry, id, label, checkClient);
      try {
        assertCurrent();
        const detail = await entry.provider.inspect(id, assertCurrent);
        assertCurrent();
        if (validChoiceDetail(detail) && detail.id === id && detail.label === label) return structuredClone(detail);
      } catch {
        // Provider errors can carry private project text or paths.
      }
      return undefined;
    },
    async answer(
      sourceGeneration: unknown,
      id: unknown,
      revision: unknown,
      answer: unknown,
      checkClient: () => void,
    ): Promise<DashboardChoiceOutcome> {
      const entry = ready(sourceGeneration, id);
      if (!entry || typeof id !== "string" || !validChoiceRevision(revision) || !validChoiceAnswer(answer) || saving)
        return "refused";
      const assertCurrent = fence(entry, id, row(entry, id)!.label, checkClient);
      saving = entry;
      try {
        assertCurrent();
        const result = await entry.provider.answer(id, revision, answer, assertCurrent);
        return result === "saved" || result === "refused" ? result : "unconfirmed";
      } catch {
        return "unconfirmed";
      } finally {
        saving = undefined;
      }
    },
    close() {
      binding = undefined;
      off?.();
    },
  };
}
