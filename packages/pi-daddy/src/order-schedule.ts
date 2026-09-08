import { closed, cloneExperiment, experimentHash } from "./experiment-contract.ts";
import type { VariantRecord } from "./experiment-state.ts";
export interface OrderNode { nodeId: string; dependencies: readonly string[]; executions: readonly string[]; expectedDigest: string; decision: { decisionId: string; authorityId: string } | null }
export interface OrderSchedule { version: "order-schedule-v1"; policyDigest: string; nodes: readonly OrderNode[] }
export interface FactoryDecision { version: "factory-decision-v1"; requestId: string; bindingDigest: string; nodeId: string; evidenceDigest: string; authorityId: string; choice: "approve" | "reject" }
export const factoryDecisionDigest = (d: FactoryDecision) => experimentHash(factoryDecision(d));
export function factoryDecision(value: FactoryDecision): FactoryDecision {
  const d = cloneExperiment(value); closed(d,["version","requestId","bindingDigest","nodeId","evidenceDigest","authorityId","choice"]);
  if(d.version!=="factory-decision-v1" || ![d.requestId,d.nodeId,d.authorityId].every(x=>typeof x==="string"&&/^[a-zA-Z0-9:_-]{1,128}$/.test(x)) || ![d.bindingDigest,d.evidenceDigest].every(x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x)) || !["approve","reject"].includes(d.choice))throw new Error("invalid reserved decision");return d;
}
export function orderSchedule(input: OrderSchedule, executions: readonly string[]): OrderSchedule {
  const s=cloneExperiment(input);closed(s,["version","policyDigest","nodes"]);
  if(s.version!=="order-schedule-v1"|| !/^[a-f0-9]{64}$/.test(s.policyDigest)||!Array.isArray(s.nodes)||!s.nodes.length||s.nodes.length>16)throw new Error("bounded order schedule required");
  const ids=new Set<string>(),all:string[]=[];
  for(const n of s.nodes as readonly OrderNode[]){closed(n,["nodeId","dependencies","executions","expectedDigest","decision"]);
    if(!/^[a-zA-Z0-9:_-]{1,128}$/.test(n.nodeId)||ids.has(n.nodeId)||!Array.isArray(n.dependencies)||n.dependencies.length>16||new Set(n.dependencies).size!==n.dependencies.length||!Array.isArray(n.executions)||n.executions.length<1||n.executions.length>3||!/^[a-f0-9]{64}$/.test(n.expectedDigest))throw new Error("invalid node/dependency/recovery policy");
    if(n.decision!==null){closed(n.decision,["decisionId","authorityId"]);if(![n.decision.decisionId,n.decision.authorityId].every(x=>/^[a-zA-Z0-9:_-]{1,128}$/.test(x)))throw new Error("invalid decision owner");}
    ids.add(n.nodeId);all.push(...n.executions);
  }
  if(new Set(all).size!==all.length||all.length!==executions.length||all.some(x=>!executions.includes(x)))throw new Error("schedule must own every reserved execution exactly once");
  const visiting=new Set<string>(),done=new Set<string>();
  const visit=(id:string)=>{if(done.has(id))return;if(visiting.has(id))throw new Error("dependency cycle");const n=s.nodes.find(n=>n.nodeId===id);if(!n)throw new Error("missing dependency");visiting.add(id);n.dependencies.forEach(visit);visiting.delete(id);done.add(id);};s.nodes.forEach(n=>visit(n.nodeId));return s;
}
export interface OrderNodeView {nodeId:string;state:"eligible"|"running"|"unknown"|"exhausted"|"decision-required"|"decision-rejected"|"dependency-blocked"|"satisfied";action:"dispatch"|"decide"|"wait"|"stakeholder"|"none";executionId:string|null;evidenceDigest:string|null}
export function evaluateOrder(s:OrderSchedule,variants:readonly VariantRecord[],digests:ReadonlyMap<string,string|null>,decisions:readonly FactoryDecision[]):OrderNodeView[]{
  const rows=new Map<string,OrderNodeView>();
  function evaluate(n:OrderNode):OrderNodeView{
    if(rows.has(n.nodeId))return rows.get(n.nodeId)!;
    const row:OrderNodeView={nodeId:n.nodeId,state:"exhausted",action:"stakeholder",executionId:null,evidenceDigest:null};
    if(n.dependencies.some(id=>evaluate(s.nodes.find(n=>n.nodeId===id)!).state!=="satisfied")){row.state="dependency-blocked";row.action="wait";rows.set(n.nodeId,row);return row;}
    for(const id of n.executions){const v=variants.find(v=>v.executionId===id)!;row.executionId=id;
      if(v.state==="unknown"){row.state="unknown";row.action="stakeholder";break;}
      if(v.state==="completed"&&digests.get(id)===n.expectedDigest){row.evidenceDigest=experimentHash({nodeId:n.nodeId,policyDigest:s.policyDigest,executionId:id,artifactDigest:v.artifactDigest,expectedDigest:n.expectedDigest});
        const d=decisions.find(d=>d.nodeId===n.nodeId&&d.evidenceDigest===row.evidenceDigest);
        row.state=n.decision?d?d.choice==="approve"?"satisfied":"decision-rejected":"decision-required":"satisfied";row.action=row.state==="decision-required"?"decide":row.state==="decision-rejected"?"stakeholder":"none";break;}
      if(["unstarted","queued"].includes(v.state)){row.state="eligible";row.action="dispatch";break;}
      if(["dispatching","running"].includes(v.state)){row.state="running";row.action="wait";break;}
    }
    rows.set(n.nodeId,row);return row;
  }
  return s.nodes.map(evaluate);
}
