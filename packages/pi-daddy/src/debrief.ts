import { reviewPage, reviewRequest, matchingHistory, validatedHistory, blindView, blindChoice, byteDigest, dataDigest, dataKey, detached, freeze,
  type ReviewPort, type ReviewItem, type ReviewRequest, type BlindPort, type BlindView, type BlindChoice } from "./debrief-contract.ts";
export interface DebriefCheckpoint {
  version: "debrief-checkpoint-v1"; scope: string; offset: number; operatorIdentity: string | null; caseIds: string[]; blindDigest: string | null;
  requests: ReviewRequest[]; choice: BlindChoice | null; revealRequested: boolean;
}
/** Host-owned attention/transport checkpoint, NOT a dashboard decision ledger. CAS must be durable/atomic. */
export interface DebriefPersistence {
  durability: "host-owned" | "fixture-memory";
  load(): unknown | Promise<unknown>;
  compareAndSwap(expectedDigest: string | null, next: DebriefCheckpoint): void | Promise<void>;
}
export interface DebriefHost {
  scope: string; offset?: number; operatorIdentity?: string; reviewer: ReviewPort; blind?: BlindPort; persistence?: DebriefPersistence;
  fixture?: boolean;
}
export interface DebriefFrame {
  version: "debrief-view-v1"; mode: "manual"; state: string; persistence: "host-checkpoint" | "session-only";
  total: number; unexposed: number; budgetSpent: number | null; remainingBudget: number | null; cards: ({ kind: "case"; slot: number; caseManifestId: string; priorDecisionId: string | null;
    summary: string; disposition: string; resolution: "unresolved" | "label-recorded"; actionEnabled: boolean } |
    { kind: "blind"; slot: number; variants: { label: string; text: string[] }[]; choice: BlindChoice | null; choiceConfirmed: boolean;
      actionEnabled: boolean; revealed: unknown | null })[];
  fixture: boolean; acceptance: "not-assessed"; automatic: "unqualified"; freshness: "snapshot-unknown";
}
const presenters = new WeakSet<object>();
export const isDebriefPresenter = (p: unknown): p is DebriefPresenter => typeof p === "object" && p !== null && presenters.has(p);
export type DebriefPresenter = ReturnType<typeof createDebriefPresenter>;
const reasons: Record<string, string> = { repeat_without_progress: "Repeated attempts without recorded progress", economical_exemplar: "Candidate economical exemplar", coverage_gap: "Missing evidence coverage" };
function checkpoint(value: unknown, scope: string, offset: number, operatorIdentity: string | null): DebriefCheckpoint | null {
  if (value === null) return null;
  const c = detached(value) as DebriefCheckpoint;
  if (!c || Object.keys(c).sort().join() !== "blindDigest,caseIds,choice,offset,operatorIdentity,requests,revealRequested,scope,version" || c.version !== "debrief-checkpoint-v1" || c.scope !== scope || c.offset !== offset || c.operatorIdentity !== operatorIdentity || !Array.isArray(c.caseIds) ||
    new Set(c.caseIds).size !== c.caseIds.length || c.caseIds.length + (c.blindDigest ? 1 : 0) > 5 || c.caseIds.some(id => !/^[a-f0-9]{64}$/.test(id)) ||
    !(c.blindDigest === null || /^[a-f0-9]{64}$/.test(c.blindDigest)) || !Array.isArray(c.requests) || c.requests.length > c.caseIds.length || typeof c.revealRequested !== "boolean" ||
    new Set(c.requests.map(r => r.caseManifestId)).size !== c.requests.length || c.requests.some(r => !c.caseIds.includes(reviewRequest(r).caseManifestId)) ||
    (!c.blindDigest && (c.choice !== null || c.revealRequested)) || (c.revealRequested && !c.choice)) throw new Error("invalid host presentation checkpoint");
  return c;
}
/** Manual host path only. Neither events nor caller-shaped idle/pause claims qualify automatic exposure. */
export function createDebriefPresenter(host: DebriefHost) {
  if (typeof host.scope !== "string" || !host.scope || host.scope.length > 256) throw new Error("explicit host presentation scope required");
  const scope = host.scope, fixture = host.fixture === true, offset = host.offset ?? 0, operatorIdentity = host.operatorIdentity ?? null;
  if (operatorIdentity !== null && (typeof operatorIdentity !== "string" || !operatorIdentity || operatorIdentity.length > 512 || /[\u0000-\u001f\u007f]/.test(operatorIdentity))) throw new Error("invalid independent operator identity");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 4096) throw new Error("invalid independently selected queue offset");
  const reviewer: ReviewPort = Object.freeze({ list: host.reviewer.list.bind(host.reviewer), history: host.reviewer.history.bind(host.reviewer),
    ...(host.reviewer.decide ? { decide: host.reviewer.decide.bind(host.reviewer) } : {}) });
  const blind: BlindPort | undefined = host.blind ? Object.freeze({ view: host.blind.view.bind(host.blind), readArtifact: host.blind.readArtifact.bind(host.blind),
    choose: host.blind.choose.bind(host.blind), reveal: host.blind.reveal.bind(host.blind) }) : undefined;
  const persistence: DebriefPersistence | undefined = host.persistence ? Object.freeze({ durability: host.persistence.durability,
    load: host.persistence.load.bind(host.persistence), compareAndSwap: host.persistence.compareAndSwap.bind(host.persistence) }) : undefined;
  let saved: DebriefCheckpoint | null = null, items: ReviewItem[] = [], publicBlind: BlindView | null = null;
  let checkpointKnown = !persistence;
  let total = 0, state = "closed", busy = false, poisoned = false, choiceConfirmed = false, revealed: unknown | null = null;
  let variants: { label: string; text: string[] }[] = [];
  const outcomes = new Map<string, { disposition: string; prior: string | null; resolution: "unresolved" | "label-recorded" }>();
  const enabled = () => Boolean(operatorIdentity && persistence && (persistence.durability === "host-owned" || fixture) && reviewer.decide && !poisoned);
  const persist = async (next: DebriefCheckpoint) => {
    if (persistence) {
      await persistence.compareAndSwap(saved ? dataDigest(saved) : null, detached(next));
      const observed = checkpoint(await persistence.load(), scope, offset, operatorIdentity);
      if (!observed || dataDigest(observed) !== dataDigest(next)) throw new Error("checkpoint acknowledgement has no exact readback");
    }
    saved = freeze(detached(next));
  };
  const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
    if (busy || poisoned) throw new Error("debrief busy or persistence unknown"); busy = true;
    try { return await run(); } finally { busy = false; }
  };
  const reconcileItem = async (item: ReviewItem, request: ReviewRequest) => {
    try {
      const id = matchingHistory(await reviewer.history(item.caseManifestId), item, request, operatorIdentity ?? "");
      outcomes.set(item.caseManifestId, { disposition: id ? request.disposition : "unresolved", prior: id ?? item.priorDecisionId,
        resolution: id && !["skip", "uncertain"].includes(request.disposition) ? "label-recorded" : "unresolved" });
      return id ? "recorded" : "stale-or-unknown";
    } catch { outcomes.set(item.caseManifestId, { disposition: "unresolved", prior: item.priorDecisionId, resolution: "unresolved" }); return "unknown"; }
  };
  const api = {
    async open(input: { mode: "manual" | "automatic"; userPresent: boolean; boundary?: string }) {
      return exclusive(async () => {
        if (input.mode !== "manual" || !input.userPresent || input.boundary === "busy") { state = "deferred: automatic/absent/busy boundary unqualified"; return api.view(); }
        try {
          if (persistence) {
            const loaded = checkpoint(await persistence.load(), scope, offset, operatorIdentity);
            if (saved && (!loaded || dataKey(saved.caseIds) !== dataKey(loaded.caseIds) || saved.blindDigest !== loaded.blindDigest ||
              saved.choice && dataKey(saved.choice) !== dataKey(loaded.choice) || saved.requests.some(r => !loaded.requests.some(n => dataKey(n) === dataKey(r))) || saved.revealRequested && !loaded.revealRequested)) throw new Error("checkpoint rollback/change; no new allowance");
            saved = loaded; checkpointKnown = true;
          }
          publicBlind = blind ? blindView(await blind.view()) : null;
          const page = reviewPage(await reviewer.list(offset, publicBlind ? 4 : 5), publicBlind ? 4 : 5, offset); total = page.total;
          if (!saved) await persist({ version: "debrief-checkpoint-v1", scope, offset, operatorIdentity, caseIds: page.items.map(i => i.caseManifestId), blindDigest: publicBlind ? dataDigest(publicBlind) : null, requests: [], choice: null, revealRequested: false });
          if (saved!.blindDigest !== (publicBlind ? dataDigest(publicBlind) : null) || saved!.caseIds.some(id => !page.items.some(i => i.caseManifestId === id))) throw new Error("changed batch/blind identity; no fresh allowance");
          items = saved!.caseIds.map(id => page.items.find(i => i.caseManifestId === id)!);
          if (saved!.choice && publicBlind) blindChoice(saved!.choice, publicBlind);
          for (const item of items) {
            const latest = validatedHistory(await reviewer.history(item.caseManifestId), item);
            const consistent = (latest?.id ?? null) === item.priorDecisionId && (latest?.disposition ?? "unresolved") === item.disposition;
            outcomes.set(item.caseManifestId, { disposition: consistent ? item.disposition : "unresolved", prior: item.priorDecisionId, resolution: !consistent || ["unresolved", "skip", "uncertain"].includes(item.disposition) ? "unresolved" : "label-recorded" });
            const request = saved!.requests.find(r => r.caseManifestId === item.caseManifestId); if (request) await reconcileItem(item, request);
          }
          variants = [];
          for (const c of publicBlind?.cards ?? []) {
            const text: string[] = [];
            for (const digest of c.artifactDigests) {
              const bytes = await blind!.readArtifact(c.label, digest);
              if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65536 || byteDigest(bytes) !== digest) throw new Error("blind artifact unavailable/mismatched");
              let preview = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              if (fixture) preview = preview.replace(/Synthetic Layout [AB]/g, "Synthetic layout (fixture caption removed)");
              text.push(preview.slice(0, 320) + (preview.length > 320 ? " [preview truncated]" : ""));
            }
            variants.push({ label: c.label, text });
          }
          state = "open"; return api.view();
        } catch { state = "unavailable: host data/persistence unknown"; poisoned = true; return api.view(); }
      });
    },
    close() { state = "closed"; return api.view(); },
    view(): Readonly<DebriefFrame> {
      const cards: DebriefFrame["cards"] = state === "open" ? items.map((item, i) => ({ kind: "case", slot: i + 1, caseManifestId: item.caseManifestId,
        priorDecisionId: outcomes.get(item.caseManifestId)?.prior ?? item.priorDecisionId, summary: reasons[item.candidate.reason] ?? "Unresolved case",
        disposition: outcomes.get(item.caseManifestId)?.disposition ?? "unresolved", resolution: outcomes.get(item.caseManifestId)?.resolution ?? "unresolved",
        actionEnabled: enabled() && !saved?.requests.some(r => r.caseManifestId === item.caseManifestId) })) : [];
      if (state === "open" && publicBlind) cards.push({ kind: "blind", slot: cards.length + 1, variants, choice: saved?.choice ?? null, choiceConfirmed,
        actionEnabled: Boolean(blind && (fixture || operatorIdentity) && persistence && (persistence.durability === "host-owned" || fixture) && !poisoned), revealed });
      return freeze(detached({ version: "debrief-view-v1", mode: "manual", state, persistence: persistence?.durability === "host-owned" ? "host-checkpoint" : "session-only", total,
        unexposed: Math.max(0, total - items.length), budgetSpent: saved ? saved.caseIds.length + (saved.blindDigest ? 1 : 0) : poisoned || !checkpointKnown ? null : 0,
        remainingBudget: !checkpointKnown || poisoned && !saved ? null : 5 - (saved ? saved.caseIds.length + (saved.blindDigest ? 1 : 0) : 0), cards, fixture, acceptance: "not-assessed", automatic: "unqualified", freshness: "snapshot-unknown" }));
    },
    async label(input: ReviewRequest) {
      const request = reviewRequest(input);
      return exclusive(async () => {
        if (state !== "open" || !enabled()) throw new Error("genuine host writer/persistence unavailable");
        const item = items.find(i => i.caseManifestId === request.caseManifestId); if (!item) throw new Error("case not exposed in this budget");
        const prior = saved!.requests.find(r => r.caseManifestId === item.caseManifestId);
        if (prior) { if (dataKey(prior) !== dataKey(request)) throw new Error("one immutable label request per card/pause"); return reconcileItem(item, request); }
        if (request.priorDecisionId !== item.priorDecisionId) throw new Error("stale displayed label request");
        try { await persist({ ...saved!, requests: [...saved!.requests, request] }); }
        catch { poisoned = true; throw new Error("label request persistence unknown; no writer call"); }
        outcomes.set(item.caseManifestId, { disposition: "unresolved", prior: item.priorDecisionId, resolution: "unresolved" });
        try { await reviewer.decide!(request); } catch { return "unknown"; }
        return reconcileItem(item, request);
      });
    },
    async reconcile(caseManifestId: string) {
      return exclusive(async () => {
        const item = items.find(i => i.caseManifestId === caseManifestId), request = saved?.requests.find(r => r.caseManifestId === caseManifestId);
        if (!item || !request) throw new Error("no exact pending request"); return reconcileItem(item, request);
      });
    },
    async choose(input: BlindChoice) {
      return exclusive(async () => {
        if (state !== "open" || !blind || !publicBlind || !persistence || !fixture && !operatorIdentity || persistence.durability !== "host-owned" && !fixture) throw new Error("quality persistence/host unavailable");
        const choice = blindChoice(input, publicBlind);
        if (saved!.choice && dataKey(saved!.choice) !== dataKey(choice)) throw new Error("quality choice is locked");
        try { if (!saved!.choice) await persist({ ...saved!, choice }); }
        catch { poisoned = true; throw new Error("quality persistence unknown; no reveal"); }
        const chosen = blindChoice(await blind.choose(choice) as BlindChoice, publicBlind);
        if (dataKey(chosen) !== dataKey(choice)) throw new Error("quality acknowledgement mismatch");
        choiceConfirmed = true; return api.view();
      });
    },
    async reveal() {
      return exclusive(async () => {
        if (state !== "open" || !blind || !saved?.choice || !choiceConfirmed || !persistence || !fixture && !operatorIdentity) throw new Error("confirmed quality choice required before reveal");
        try { if (!saved.revealRequested) await persist({ ...saved, revealRequested: true }); }
        catch { poisoned = true; throw new Error("reveal persistence unknown; no exposure"); }
        const result = detached(await blind.reveal()) as Record<string, any>;
        if (!result || Object.keys(result).sort().join() !== "arms,choice,manifestId,routingDefault" || result.routingDefault !== null || !Array.isArray(result.arms) || result.arms.length !== publicBlind!.cards.length || new Set(result.arms.map(a => a.label)).size !== result.arms.length || dataKey(blindChoice(result.choice, publicBlind!)) !== dataKey(saved.choice)) throw new Error("invalid reveal acknowledgement");
        revealed = { arms: result.arms.map(a => {
          if (Object.keys(a).sort().join() !== "armId,configuration,cost,costUnit,label" || !publicBlind!.cards.some(c => c.label === a.label) || !["wall_ms", "tool_calls", "usd"].includes(a.costUnit) || !(a.cost === null || typeof a.cost === "number" && Number.isFinite(a.cost) && a.cost >= 0) || typeof a.configuration !== "object" || a.configuration === null || Object.keys(a.configuration).sort().join() !== "configuration,effort,model,prompt,skill" || Object.values(a.configuration).some(v => typeof v !== "string")) throw new Error("invalid reveal arm");
          return { label: a.label, configuration: a.configuration, cost: a.cost, costUnit: a.costUnit };
        }), routingDefault: null, adoptionAuthorized: false };
        return api.view();
      });
    },
  };
  presenters.add(api); return Object.freeze(api);
}
