import { buildWorkRevisionEvent, buildWorkSnapshotEvent, type WorkRevision } from "../src/work-ledger.ts";
import { fixtureRevisionRef as ref, fixtureEventRef as er, fixtureText } from "./work-ledger-fixtures.ts";
import { resourceBindingDigest, type GovernedBudgetBinding } from "../src/resource-budget.ts";
import { intentRequestDigest, type IntentRequest } from "../src/intent-control.ts";
export const hostDigest = "a".repeat(64);
export function intentWorld(expand = false) {
  const now = new Date("2026-09-08T00:00:00Z");
  const revision = (kind: WorkRevision["kind"], id: string, n: number, patch: Partial<WorkRevision> = {}) => buildWorkRevisionEvent({ eventId: `intent:${id}:${n}`, now,
    revision: { kind, id, revision: n, scopeId: "intent-scope", contentDigest: String(n).repeat(64), predecessor: null, parent: null, dependencies: [], ownerId: "fixed-host", permittedEffects: kind === "policy" ? [] : ["read"], policy: null, ...patch } });
  const policy = revision("policy", "policy", 1), scope = revision("scope", "intent-scope", 1);
  const goal = revision("goal", "goal", 1, { parent: ref(scope) });
  const obligations = [1, 2].map(i => revision("obligation", `obligation-${i}`, 1, { parent: ref(goal), policy: ref(policy) }));
  const scope2 = revision("scope", "intent-scope", 2, { predecessor: ref(scope), ...(expand ? { permittedEffects: ["network", "read"] } : {}) });
  const goal2 = revision("goal", "goal", 2, { predecessor: ref(goal), parent: ref(scope2) });
  const obligations2 = obligations.map(o => revision("obligation", o.payload.revision.id, 2, { predecessor: ref(o), parent: ref(goal2), policy: ref(policy) }));
  const goal3 = revision("goal", "goal", 3, { predecessor: ref(goal2), parent: ref(scope2) });
  const obligations3 = obligations2.map(o => revision("obligation", o.payload.revision.id, 3, { predecessor: ref(o), parent: ref(goal3), policy: ref(policy) }));
  const snapshot = (name: string, s: typeof scope, g: typeof goal, os: typeof obligations) => buildWorkSnapshotEvent({ eventId: `snapshot:${name}`, now,
    snapshot: { snapshotId: name, scope: ref(s), revisions: [policy, g, ...os].map(ref), bindings: os.map(o => ({ intent: ref(g), obligation: ref(o), artifact: null, policy: ref(policy) })) } });
  const base = snapshot("base", scope, goal, obligations), next = snapshot("next", scope2, goal2, obligations2), alternative = snapshot("alternative", scope2, goal3, obligations3);
  const selection = (s: typeof base) => ({ snapshot: { id: s.payload.snapshot.snapshotId, digest: s.payload.snapshot.digest }, event: er(s) });
  const priorities = (os: typeof obligations, reverse = false) => os.map((o, i) => ({ obligation: ref(o), rank: reverse ? 1 - i : i }));
  return { base, next, alternative, selection, priorities, obligations, obligations2, obligations3,
    initial: [scope, policy, goal, ...obligations, base], text: fixtureText([scope, policy, goal, ...obligations, base]),
    changes: [scope2, goal2, ...obligations2, next], recorded: [goal3, ...obligations3, alternative] };
}
/** Fixed host declarations are independently rebuilt, never extracted from the incoming request. */
export function fixedIntentRequests(b: GovernedBudgetBinding) {
  const w = intentWorld(), more = (requestId: string, action: IntentRequest["action"], expectedRevision: number): IntentRequest => ({ version: "intent-request-v1", requestId,
    action, expectedRevision, bindingDigest: resourceBindingDigest(b), expectedSelection: w.selection(w.base), selection: w.selection(w.next), events: [], priorities: w.priorities(w.obligations2, true) });
  const revise = { ...more("revise", "revise-scope", 0), events: JSON.parse(JSON.stringify(w.changes)) };
  const priority = { ...more("priority", "reprioritize", 1), expectedSelection: w.selection(w.next), priorities: w.priorities(w.obligations2) };
  const alternative = { ...more("alternative", "select-alternative", 2), expectedSelection: w.selection(w.next), selection: w.selection(w.alternative), priorities: w.priorities(w.obligations3) };
  const stale = { ...more("stale", "reprioritize", 0), selection: w.selection(w.base), priorities: w.priorities(w.obligations) };
  const expanded = intentWorld(true), expand = { ...more("expand", "revise-scope", 0), events: JSON.parse(JSON.stringify(expanded.changes)), selection: expanded.selection(expanded.next), priorities: expanded.priorities(expanded.obligations2) };
  return { revise, priority, alternative, stale, expand };
}
export const fixedIntentAuthority = (b: GovernedBudgetBinding) => ({ authorityDigest: hostDigest, requestDigests: Object.values(fixedIntentRequests(b)).map(intentRequestDigest) });
