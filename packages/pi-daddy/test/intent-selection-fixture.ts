import { buildWorkRevisionEvent,buildWorkSnapshotEvent } from "../src/work-ledger.ts";
import { fixtureRevisionRef as ref,fixtureEventRef as er } from "./work-ledger-fixtures.ts";
import { intentWorld } from "./intent-control-fixture.ts";
export function selectionProposal(options:{effect?:string;owner?:string}={}){
 const w=intentWorld(),[scope,policy,goal,...rest]=w.initial,obligations=rest.filter(e=>e.event==="work_revision"),now=new Date("2026-09-08T00:00:00Z");
 if(scope.event!=="work_revision"||policy.event!=="work_revision"||goal.event!=="work_revision")throw Error("fixture shape");
 const successor=(e:typeof goal,parent:ReturnType<typeof ref>)=>{const{digest:_,...r}=e.payload.revision;return buildWorkRevisionEvent({eventId:e.eventId+":successor",now,revision:{...JSON.parse(JSON.stringify(r)),revision:2,predecessor:ref(e),parent,contentDigest:"9".repeat(64),...(options.effect?{permittedEffects:["read",options.effect]}:{}),...(options.owner?{ownerId:options.owner}:{})}});};
 const g=successor(goal,ref(scope)),os=obligations.map(o=>successor(o,ref(g))),snapshot=buildWorkSnapshotEvent({eventId:"selection:successor",now,snapshot:{snapshotId:"nonscope-successor",scope:ref(scope),revisions:[policy,g,...os].map(ref),bindings:os.map(o=>({intent:ref(g),obligation:ref(o),artifact:null,policy:ref(policy)}))}});
 return {w,events:[g,...os,snapshot],selection:{snapshot:{id:snapshot.payload.snapshot.snapshotId,digest:snapshot.payload.snapshot.digest},event:er(snapshot)},priorities:os.map((o,rank)=>({obligation:ref(o),rank}))};
}
