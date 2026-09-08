import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { readDailySnapshot } from "./daily-view-input.ts";
import { workDestination } from "./work-ledger-destination.ts";
import { appendWorkLedgerEventOnce, buildWorkRevisionEvent, buildWorkSnapshotEvent, parseWorkLedgerText, type WorkFrozen, type WorkRevision } from "./work-ledger.ts";
import { resolveWorkSnapshotText } from "./work-ledger-snapshot.ts";
import { controlShape } from "./dispatch-control.ts";
import { freezeWork } from "./work-ledger-json.ts";
import { intentKey, intentSelection, intentPriorities, type WorkIntentBinding, type IntentRequest, type IntentState, type IntentSelection, type IntentPriority } from "./intent-control.ts";
const ref = (r: WorkFrozen<WorkRevision>) => ({ kind: r.kind, id: r.id, revision: r.revision, digest: r.digest });
const entity = (r: { kind: string; id: string } | null) => r ? `${r.kind}:${r.id}` : null;
export function workIntentBinding(input: WorkIntentBinding): WorkIntentBinding {
  controlShape(input, ["version", "path", "device", "inode", "grantLedgerPath", "selection", "priorities"]);
  if (input.version !== "1.0" || typeof input.path !== "string" || input.path.length > 1024 || !isAbsolute(input.path) || resolve(input.path) !== input.path || input.path.split("/").includes(".pi") ||
    ![input.device, input.inode].every(x => typeof x === "string" && /^\d+$/.test(x)) || !(input.grantLedgerPath === null || typeof input.grantLedgerPath === "string" && input.grantLedgerPath.length <= 1024 && isAbsolute(input.grantLedgerPath))) throw new TypeError("invalid pinned work binding");
  return JSON.parse(intentKey({ ...input, selection: intentSelection(input.selection), priorities: intentPriorities(input.priorities) }));
}
export async function readIntentWork(input: WorkFrozen<WorkIntentBinding>): Promise<string> {
  const check = async () => {
    const st = await lstat(input.path, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || st.uid !== BigInt(process.getuid!()) || (st.mode & 0o077n) || String(st.dev) !== input.device || String(st.ino) !== input.inode || await realpath(input.path) !== input.path) throw new Error("work binding changed");
  };
  await check(); const bytes = await readDailySnapshot(input.path, 16 * 1024 * 1024); await check();
  if (bytes.status !== "read") throw new Error("required work snapshot unavailable");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.bytes);
  if (!text.endsWith("\n") || !parseWorkLedgerText(text).complete) throw new Error("incomplete work ledger; no repair");
  return text;
}
export function resolveIntent(text: string, selection: WorkFrozen<IntentSelection>, priorities: WorkFrozen<IntentPriority[]>): ReturnType<typeof resolveWorkSnapshotText> {
  const result = resolveWorkSnapshotText(text, selection);
  if (result.scopeState !== "valid" || !result.scope || !result.snapshot || result.revisions.length > 64) throw new Error("unresolved authoritative work selection");
  const wanted = result.snapshot.bindings.map(b => intentKey(b.obligation)).sort();
  if (intentKey(wanted) !== intentKey(priorities.map(p => intentKey(p.obligation)).sort())) throw new Error("priority policy must name exactly the selected obligations");
  return result;
}
/** Actual owned bytes establish the physical binding; caller supplies the exact initial selection. */
export async function bindWorkIntent(input: { path: string; grantLedgerPath: string | null; selection: IntentSelection; priorities: IntentPriority[] }): Promise<WorkFrozen<WorkIntentBinding>> {
  controlShape(input, ["path", "grantLedgerPath", "selection", "priorities"]);
  const selection = intentSelection(input.selection), priorities = intentPriorities(input.priorities), path = input.path, grantLedgerPath = input.grantLedgerPath;
  if (typeof path !== "string" || !isAbsolute(path) || path.split("/").includes(".pi")) throw new TypeError("explicit work path required");
  await workDestination(path, grantLedgerPath);
  const parent = await lstat(dirname(path), { bigint: true });
  if (!parent.isDirectory() || (parent.mode & 0o077n) || parent.uid !== BigInt(process.getuid!())) throw new Error("owner-private work parent required");
  const st = await lstat(path, { bigint: true });
  const binding = workIntentBinding({ version: "1.0", path, grantLedgerPath, device: String(st.dev), inode: String(st.ino), selection, priorities });
  resolveIntent(await readIntentWork(binding), selection, priorities); return freezeWork(binding);
}
/** No authority callback: validate concrete P01 effects and prevent permission/owner/policy expansion. */
export async function validateIntentApplication(binding: WorkFrozen<WorkIntentBinding>, state: IntentState, request: WorkFrozen<IntentRequest>): Promise<void> {
  const text = await readIntentWork(binding), current = resolveIntent(text, state.selection, state.priorities);
  const existing = parseWorkLedgerText(text).events;
  const missing = request.events.filter(e => {
    const sameId = existing.filter(old => old.eventId === e.eventId);
    if (sameId.some(old => old.digest !== e.digest)) throw new Error("proposed event identity conflicts with retained work");
    return sameId.length === 0;
  });
  const candidate = text + missing.map(e => intentKey(e) + "\n").join("");
  const next = resolveIntent(candidate, request.selection, request.priorities);
  if (request.action === "reprioritize" && intentKey(request.selection) !== intentKey(state.selection)) throw new Error("priority is not scope selection");
  if (request.action !== "reprioritize" && intentKey(request.selection) === intentKey(state.selection)) throw new Error("a different exact recorded selection is required");
  const old = [current.scope!, ...current.revisions], after = [next.scope!, ...next.revisions];
  if (intentKey(old.map(entity).sort()) !== intentKey(after.map(entity).sort())) throw new Error("entity expansion/removal is outside this bounded adapter");
  for (const r of after) {
    const prior = old.find(p => entity(p) === entity(r))!;
    if (r.ownerId !== prior.ownerId || r.scopeId !== prior.scopeId || r.permittedEffects.some(e => !prior.permittedEffects.includes(e)) || intentKey(r.policy) !== intentKey(prior.policy) ||
      entity(r.parent) !== entity(prior.parent) || intentKey(r.dependencies.map(entity).sort()) !== intentKey(prior.dependencies.map(entity).sort()) ||
      r.kind === "policy" && r.digest !== prior.digest) throw new Error("owner, policy, topology or permission expansion refused");
    if (request.action === "revise-scope" && r.digest !== prior.digest && (r.revision !== prior.revision + 1 || intentKey(r.predecessor) !== intentKey(ref(prior)))) throw new Error("exact successor required");
  }
  if (request.action === "revise-scope" && (next.scope!.revision !== current.scope!.revision + 1 || intentKey(next.scope!.predecessor) !== intentKey(ref(current.scope!)))) throw new Error("scope revision is not dispatch revision");
  for (const e of request.events) {
    // Rebuild through the actual P01 builders, not an alternate event/hash encoder.
    if (e.event === "work_revision") {
      const { digest: _digest, ...revision } = e.payload.revision;
      if (!after.some(r => intentKey(ref(r)) === intentKey(ref(e.payload.revision))) || intentKey(buildWorkRevisionEvent({ eventId: e.eventId, now: new Date(e.ts), revision: JSON.parse(intentKey(revision)) })) !== intentKey(e)) throw new Error("unselected or noncanonical revision proposal");
    } else if (e.event === "work_snapshot") {
      const { digest: _digest, ...snapshot } = e.payload.snapshot;
      if (e.eventId !== request.selection.event.eventId || e.digest !== request.selection.event.digest || intentKey(buildWorkSnapshotEvent({ eventId: e.eventId, now: new Date(e.ts), snapshot: JSON.parse(intentKey(snapshot)) })) !== intentKey(e)) throw new Error("unselected snapshot proposal");
    }
  }
}
export async function applyIntentApplication(binding: WorkFrozen<WorkIntentBinding>, state: IntentState, request: WorkFrozen<IntentRequest>): Promise<void> {
  await validateIntentApplication(binding, state, request);
  for (const event of request.events) {
    await readIntentWork(binding);
    await appendWorkLedgerEventOnce({ path: binding.path, grantLedgerPath: binding.grantLedgerPath }, event);
  }
  resolveIntent(await readIntentWork(binding), request.selection, request.priorities);
}
