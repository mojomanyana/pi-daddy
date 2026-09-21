import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { appendWorkLedgerEventOnce, buildWorkRevisionEvent, buildWorkSnapshotEvent, type RevisionRef, type WorkRevision, type WorkRevisionEvent, type WorkSnapshotEvent, type WorkFrozen } from "../governance/work-ledger.ts";
import { resolveWorkSnapshotText } from "../governance/work-ledger-snapshot.ts";
import { loadDeclaredWork, type DeclaredWorkState } from "./work-command.ts";
import { withFileLock } from "../governance/file-lock.ts";
import { intentKey, type IntentSelection } from "./intent-control.ts";
import { privateDirectory, projectProductDirectory, readProductJson, writeProductJson } from "./product-files.ts";
import type { WorkPresentation } from "./daily-panel.ts";

export const WORK_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface WorkTaskSetup { id: string; outcome: string; agent: string | null; model: string; thinking: typeof WORK_EFFORTS[number]; dependencies: string[] }
export interface WorkSetup { version: "work-setup-v1"; id: string; outcome: string; maxParallel: number; tasks: WorkTaskSetup[] }
export interface RecordedWorkSetup { version: "recorded-work-setup-v1"; setup: WorkSetup; state: DeclaredWorkState; tasks: { id: string; obligation: RevisionRef }[]; events: WorkFrozen<WorkRevisionEvent | WorkSnapshotEvent>[] }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const keys = (value: object, expected: string[]) => { if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== expected.sort().join()) throw Error("unsupported work setup fields"); };
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value);
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 8192;
const ref = (r: Pick<WorkRevision, "kind" | "id" | "revision" | "digest">): RevisionRef => ({ kind: r.kind, id: r.id, revision: r.revision, digest: r.digest });
export function workSetup(input: WorkSetup): WorkSetup {
  const s = JSON.parse(JSON.stringify(input)) as WorkSetup;
  keys(s, ["version", "id", "outcome", "maxParallel", "tasks"]);
  if (s.version !== "work-setup-v1" || !id(s.id) || !text(s.outcome) || !Number.isInteger(s.maxParallel) || s.maxParallel < 1 || s.maxParallel > 8 || !Array.isArray(s.tasks) || !s.tasks.length || s.tasks.length > 8) throw Error("work setup requires 1–8 tasks and parallel limit 1–8");
  const seen = new Set<string>();
  for (const task of s.tasks) {
    keys(task, ["id", "outcome", "agent", "model", "thinking", "dependencies"]);
    if (!id(task.id) || seen.has(task.id) || !text(task.outcome) || !(task.agent === null || typeof task.agent === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(task.agent)) || typeof task.model !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/@+-]+$/.test(task.model) || task.model.length > 128 || !WORK_EFFORTS.includes(task.thinking) || !Array.isArray(task.dependencies) || new Set(task.dependencies).size !== task.dependencies.length || task.dependencies.some(d => !id(d) || d === task.id)) throw Error("invalid task, model/effort or dependency; no profile fallback");
    seen.add(task.id);
  }
  const done = new Set<string>();
  while (done.size < s.tasks.length) {
    const eligible = s.tasks.filter(t => !done.has(t.id) && t.dependencies.every(d => done.has(d)));
    if (!eligible.length) throw Error("dependencies contain a cycle or missing task");
    eligible.forEach(t => done.add(t.id));
  }
  return s;
}
const setupPath = (state: DeclaredWorkState) => join(dirname(state.statePath), "work-setups", `${state.selectedSnapshot.snapshot.digest}.json`);

/** Author first, append through P01, then select separately at an explicit owner boundary. */
export async function recordWorkSetup(cwd: string, value: WorkSetup, mode: "new" | "revise" | "alternative" = "new", expected: DeclaredWorkState | null = null): Promise<RecordedWorkSetup> {
  const setup = workSetup(value), root = join(resolve(cwd), ".pi"), statePath = join(root, "work-current.json");
  await projectProductDirectory(root); await privateDirectory(join(root, "work-setups"));
  return withFileLock(statePath, "work setup", async () => {
    const current = await loadDeclaredWork(statePath);
    if (intentKey(current?.selectedSnapshot ?? null) !== intentKey(expected?.selectedSnapshot ?? null)) throw Error("work selection changed; reopen setup");
    if (mode !== "new" && !current) throw Error("select existing work before recording a revision");
    const original = mode !== "new" ? await loadWorkSetup(current!) : null;
    if (mode !== "new" && (!original || original.setup.tasks.length !== setup.tasks.length || original.setup.tasks.some(t => !setup.tasks.some(n => n.id === t.id && intentKey([...n.dependencies].sort()) === intentKey([...t.dependencies].sort()))))) throw Error("topology changes require a new work setup; no live entity expansion");
    const revisions = current && mode !== "new" ? resolveWorkSnapshotText(await readFile(current.ledgerPath, "utf8"), current.selectedSnapshot) : null;
    const token = hash(intentKey({ setup, mode, from: mode === "new" ? null : current?.selectedSnapshot })).slice(0, 24), prefix = mode === "new" ? `work:${setup.id}:${token.slice(0, 8)}` : current!.scope.id.replace(/:scope$/, "");
    // Preparation is durable before the first append, so an interrupted exact retry retains timestamps/identities.
    const preparedPath = join(root, "work-setups", `pending-${token}.json`);
    const prepared = await readProductJson(preparedPath) as { now: string } | null;
    if (prepared && (Object.keys(prepared).join() !== "now" || !Number.isFinite(Date.parse(prepared.now)))) throw Error("invalid retained setup preparation");
    const now = new Date(prepared?.now ?? Date.now());
    if (!prepared) await writeProductJson(preparedPath, { now: now.toISOString() });
    const events: WorkFrozen<WorkRevisionEvent | WorkSnapshotEvent>[] = [];
    const build = (kind: WorkRevision["kind"], entityId: string, content: unknown, parent: RevisionRef | null, dependencies: RevisionRef[] = [], policy: RevisionRef | null = null): RevisionRef => {
      const prior = revisions && [revisions.scope!, ...revisions.revisions].find(r => r.kind === kind && r.id === entityId);
      const event = buildWorkRevisionEvent({ eventId: `${prefix}:${token}:${kind}:${events.length}`, now, revision: { kind, id: entityId, revision: prior ? prior.revision + 1 : 1, predecessor: prior ? ref(prior) : null, scopeId: `${prefix}:scope`, contentDigest: hash(intentKey(content)), parent, dependencies, ownerId: prior?.ownerId ?? "local-operator", permittedEffects: prior ? [...prior.permittedEffects] : [], policy } });
      events.push(event); return ref(event.payload.revision);
    };
    const scope = mode === "alternative" ? current!.scope : build("scope", `${prefix}:scope`, setup, null);
    const policy = mode === "new" ? build("policy", `${prefix}:policy`, { acceptance: "independent-review-required" }, null) : current!.policy;
    const intent = build("goal", mode === "new" ? `${prefix}:goal` : current!.intent.id, setup, scope);
    const tasks: RecordedWorkSetup["tasks"] = [];
    while (tasks.length < setup.tasks.length) {
      for (const task of setup.tasks) {
        if (tasks.some(t => t.id === task.id) || !task.dependencies.every(d => tasks.some(t => t.id === d))) continue;
        const entityId = original?.tasks.find(t => t.id === task.id)?.obligation.id ?? `${prefix}:${task.id}`;
        const obligation = build("obligation", entityId, task, intent, task.dependencies.map(d => tasks.find(t => t.id === d)!.obligation), policy);
        tasks.push({ id: task.id, obligation });
      }
    }
    const ordered = setup.tasks.map(t => tasks.find(x => x.id === t.id)!);
    const snapshot = buildWorkSnapshotEvent({ eventId: `${prefix}:${token}:snapshot`, now, snapshot: { snapshotId: `${prefix}:${token}:selected`, scope, revisions: [policy, intent, ...ordered.map(t => t.obligation)], bindings: ordered.map(t => ({ intent, obligation: t.obligation, artifact: null, policy })) } });
    events.push(snapshot);
    const state: DeclaredWorkState = { version: "pi-daddy-declared-work-v1", id: setup.id, outcomeDigest: hash(setup.outcome.trim()), ledgerPath: join(root, "work.jsonl"), statePath, grantLedgerPath: null, selectedSnapshot: { snapshot: { id: snapshot.payload.snapshot.snapshotId, digest: snapshot.payload.snapshot.digest }, event: { eventId: snapshot.eventId, digest: snapshot.digest } }, scope, intent, obligation: ordered[0].obligation, policy };
    const result: RecordedWorkSetup = { version: "recorded-work-setup-v1", setup, state, tasks: ordered, events };
    const path = setupPath(state), previous = await readProductJson(path);
    if (previous && intentKey(previous) !== intentKey(result)) throw Error("recorded setup identity conflict");
    if (!previous) await writeProductJson(path, result);
    for (const event of events) await appendWorkLedgerEventOnce({ path: state.ledgerPath, grantLedgerPath: null }, event);
    await loadWorkSetup(state); return result;
  });
}

export async function loadWorkSetup(state: DeclaredWorkState): Promise<RecordedWorkSetup | null> {
  const value = await readProductJson(setupPath(state)) as RecordedWorkSetup | null;
  if (!value) return null;
  keys(value, ["version", "setup", "state", "tasks", "events"]);
  const setup = workSetup(value.setup);
  if (value.version !== "recorded-work-setup-v1" || intentKey(value.state.selectedSnapshot) !== intentKey(state.selectedSnapshot) || value.state.ledgerPath !== state.ledgerPath || value.state.statePath !== state.statePath || hash(setup.outcome.trim()) !== value.state.outcomeDigest || !Array.isArray(value.tasks) || value.tasks.length !== setup.tasks.length) throw Error("work setup selection mismatch");
  const resolved = resolveWorkSnapshotText(await readFile(state.ledgerPath, "utf8"), state.selectedSnapshot);
  if (resolved.scopeState !== "valid" || !resolved.snapshot || hash(intentKey(setup)) !== resolved.revisions.find(r => r.digest === value.state.intent.digest)?.contentDigest) throw Error("recorded work labels are stale or mismatched");
  if (intentKey(resolved.snapshot.scope) !== intentKey(value.state.scope) || !resolved.snapshot.bindings.some(b => intentKey(b.intent) === intentKey(value.state.intent) && intentKey(b.policy) === intentKey(value.state.policy) && intentKey(b.obligation) === intentKey(state.obligation))) throw Error("work state is not an exact selected binding");
  for (const task of setup.tasks) {
    const binding = value.tasks.find(t => t.id === task.id), revision = resolved.revisions.find(r => r.digest === binding?.obligation.digest);
    if (!binding || !revision || revision.contentDigest !== hash(intentKey(task)) || !resolved.snapshot.bindings.some(b => intentKey(b.obligation) === intentKey(binding.obligation))) throw Error("task configuration is not bound to selected work");
  }
  return value;
}
/** Caller must own a quiescent session, with no running daily host. No active order is rebound. */
export async function selectRecordedWork(recorded: RecordedWorkSetup, expected: IntentSelection | null): Promise<DeclaredWorkState> {
  const state = recorded.state;
  return withFileLock(state.statePath, "select work", async () => {
    const current = await loadDeclaredWork(state.statePath);
    if (intentKey(current?.selectedSnapshot ?? null) !== intentKey(expected)) throw Error("selection changed; no work selected");
    if (!await loadWorkSetup(state)) throw Error("recorded setup missing");
    const { statePath: _path, ...stored } = state;
    await writeProductJson(state.statePath, stored, true); return state;
  });
}
export async function listWorkSetups(cwd: string): Promise<RecordedWorkSetup[]> {
  const root = join(resolve(cwd), ".pi", "work-setups");
  let files: string[]; try { files = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (files.length > 256) throw Error("work setup history bound exceeded");
  const results: RecordedWorkSetup[] = [];
  for (const file of files.filter(f => /^[a-f0-9]{64}\.json$/.test(f)).sort()) {
    const value = await readProductJson(join(root, file)) as RecordedWorkSetup;
    if (value?.state?.statePath !== join(resolve(cwd), ".pi", "work-current.json") || file !== `${value.state.selectedSnapshot.snapshot.digest}.json`) throw Error("invalid work setup history");
    results.push((await loadWorkSetup(value.state))!);
  }
  return results;
}
export async function workSetupForSelection(cwd: string, selection: IntentSelection): Promise<RecordedWorkSetup | null> {
  const path=join(resolve(cwd),".pi","work-setups",`${selection.snapshot.digest}.json`),value=await readProductJson(path) as RecordedWorkSetup|null;
  if(!value)return null;
  if(value.state?.statePath!==join(resolve(cwd),".pi","work-current.json")||intentKey(value.state.selectedSnapshot)!==intentKey(selection))throw Error("recorded selection labels mismatch");
  return loadWorkSetup(value.state);
}
export async function workPresentation(state: DeclaredWorkState): Promise<WorkPresentation | null> {
  const setup = await loadWorkSetup(state);
  if (setup) return { outcome: setup.setup.outcome, obligations: setup.tasks.map(t => { const spec = setup.setup.tasks.find(s => s.id === t.id)!; return { digest: t.obligation.digest, outcome: spec.outcome, agent: spec.agent ?? "No-tool agent", dependencies: spec.dependencies }; }) };
  const value = await readProductJson(join(dirname(state.statePath), "work-outcomes", `${state.outcomeDigest}.json`)) as { outcome: string } | null;
  if (!value) return null;
  if (Object.keys(value).join() !== "outcome" || typeof value.outcome !== "string" || hash(value.outcome.trim()) !== state.outcomeDigest) throw Error("declared outcome digest mismatch");
  return { outcome: value.outcome, obligations: [{ digest: state.obligation.digest, outcome: value.outcome }] };
}
