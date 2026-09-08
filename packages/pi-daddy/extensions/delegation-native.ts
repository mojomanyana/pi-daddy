import { allocateNativeSessionTarget } from "../src/native-session-target.ts";
import type { GrantsSession } from "./session.ts";
import type { ExecutionOccurrenceIds } from "./execution-occurrence.ts";
/** Shared delegate/all/chain host setup, before planning/audit; no tool-schema destination parameter. */
export async function nativeDelegationContext(session:GrantsSession,ids:ExecutionOccurrenceIds,budget:number|undefined,refused:boolean){
  let sessionFile:string|undefined,refusal:string|undefined;
  if(!refused&&session.nativeSessionRoot!==undefined){
    try{sessionFile=await allocateNativeSessionTarget(session.nativeSessionRoot,ids.executionId);}
    catch(error){refusal=`native retention target refused (${String(error)})`;}
  }
  return {extra:{fanoutBudget:budget,spawnId:ids.parentId,childSpawnId:ids.childId,childExecutionId:ids.executionId,sessionFile},refusal};
}
