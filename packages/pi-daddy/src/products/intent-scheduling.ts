import { intentKey, intentSelection, intentPriorities, type IntentState, type IntentAdmission } from "./intent-control.ts";
import { controlShape } from "./dispatch-control.ts";
interface Charged { intent?: IntentAdmission }
export function nextIntent(state: IntentState, records: readonly Charged[]) {
  return intentPriorities(state.priorities).find(p => !records.some(r => r.intent &&
    intentKey(r.intent.selection) === intentKey(state.selection) && intentKey(r.intent.obligation) === intentKey(p.obligation)))?.obligation ?? null;
}
/** Explicit once-per-selection primary dispatch policy. This is not completion/acceptance accounting. */
export function intentAdmission(state: IntentState, records: readonly Charged[], input: IntentAdmission): IntentAdmission {
  controlShape(input, ["selection", "revision", "obligation"]);
  const selection = intentSelection(input.selection), obligation = intentPriorities([{ obligation: input.obligation, rank: 0 }])[0].obligation;
  if (input.revision !== state.revision || intentKey(selection) !== intentKey(state.selection) || intentKey(obligation) !== intentKey(nextIntent(state, records))) throw new Error("stale selection/revision or out-of-priority dispatch");
  return { selection, revision: input.revision, obligation };
}
