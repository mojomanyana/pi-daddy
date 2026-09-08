import { retainSessionChild } from "../src/ordinary-children.ts";
import { dataDigest } from "../src/debrief-contract.ts";
import { runWithFinalizers } from "../src/finalization.ts";
import { releaseDelegationWorkspace,type PreparedWorkspace } from "./workspace-runtime.ts";
import type { GrantsSession } from "./session.ts";
import type { DelegationOutcome } from "./execute-child.ts";
/** One wrapper around the original executor. It neither consumes nor replaces the caller's promise. */
export async function withOrdinaryChild(input:{session:GrantsSession;executionId:string;parentExecutionId:string|null;childId:string;toolCallId?:string;signal?:AbortSignal;preparedWorkspace?:PreparedWorkspace},operation:(signal?:AbortSignal)=>Promise<DelegationOutcome>){
 let retained:ReturnType<typeof retainSessionChild>;
 try{retained=retainSessionChild(input.session,{executionId:input.executionId,parentExecutionId:input.parentExecutionId,toolCallId:input.toolCallId??null},input.signal);}
 catch(error){return runWithFinalizers(async()=>{throw error;},[{label:"ordinary admission workspace release",run:async()=>{await releaseDelegationWorkspace({prepared:input.preparedWorkspace,childId:input.childId,executionId:input.executionId,parentExecutionId:input.parentExecutionId,ledgerPath:input.session.ledgerPath,reason:"refused"});}}]);}
 try{const outcome=await operation(retained?.signal??input.signal);retained?.settle({ok:outcome.ok,exitCode:outcome.exitCode,aborted:outcome.aborted??false,outputDigest:dataDigest(outcome.text)},outcome.control??"not-assessed");return outcome;}
 catch(error){retained?.settle({failure:"original executor threw; inspect original caller"},"unknown");throw error;}
}
