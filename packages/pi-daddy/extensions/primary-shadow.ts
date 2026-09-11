import type { DelegationOutcome } from "./execute-child.ts";
import type { ExecutionOccurrenceIds } from "./execution-occurrence.ts";
import type { GrantsSession, VariantRunAccounting } from "./session.ts";

/** Return one primary while the original session retains and settles every shadow outcome. */
export async function completePrimary(input:{session:GrantsSession;primaryIndex:number;occurrences:ExecutionOccurrenceIds[];pending:Promise<DelegationOutcome>[];settle:(outcomes:{ok:boolean}[])=>void}){
 const runId=input.occurrences[input.primaryIndex].executionId,record:VariantRunAccounting={runId,primaryExecutionId:runId,shadowExecutionIds:input.occurrences.filter((_,i)=>i!==input.primaryIndex).map(x=>x.executionId),state:"running",outcomes:null};
 input.session.variantRuns.set(runId,record);
 void Promise.all(input.pending).then(outcomes=>{record.outcomes=outcomes.map((outcome,index)=>({executionId:input.occurrences[index].executionId,role:index===input.primaryIndex?"primary":"shadow",ok:outcome.ok,reason:outcome.ok?null:outcome.reason??"failed"}));record.state="settled";input.settle(outcomes);});
 return {runId,primary:await input.pending[input.primaryIndex]};
}
