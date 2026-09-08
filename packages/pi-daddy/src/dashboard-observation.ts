import { parseRetentionJson } from "./retention-json.ts";
import { createHash } from "node:crypto";
import { createDailyViewReader } from "./daily-view.ts";
import { dataDigest, detached } from "./debrief-contract.ts";
import type { DashboardHarness, DashboardHostConfig, DashboardHostAuthority, HostEvent } from "./dashboard-host-contract.ts";
export interface DashboardObservation { sourceId: string; kind: "work" | "retention" | "facts"; checkpointId: string; sourceManifestId: string | null; metadata: unknown; cases: { version: "work-signals-v1"; batchId: string; observationId: string } | null; linkageManifestId: string | null }
export function dashboardObservations(h: DashboardHarness, c: DashboardHostConfig, history: () => HostEvent[]) {
  const reader=createDailyViewReader(), root=c.archiveRoot;
  const latest=()=>{const rows=new Map<string,DashboardObservation>();for(const e of history())if(e.value.type==="observation") {const row=e.value.observation as unknown as DashboardObservation;rows.set(row.sourceId,row);}return [...rows.values()];};
  const policy=(id:string)=>{const binding=h.archivePolicyBinding(c.policyPath,id);if(binding.archiveRoot!==root||binding.policySha256!==c.policySha256)throw Error("source policy binding changed");};
  const bytes=(id:string)=>{const source=h.readArchiveSource(root,id);if(source.status!=="available"||source.reference?.retention!=="exact"||!source.bytes||createHash("sha256").update(source.bytes).digest("hex")!==source.reference.sha256)throw Error("exact retained source unavailable");return Uint8Array.from(source.bytes);};
  return { latest,
    observe(payload: unknown, authority: DashboardHostAuthority, selection: DashboardHostConfig["selection"]): DashboardObservation {
      const input=detached(payload) as {sourceId:string;previousCheckpointId:string|null;facts:unknown};
      if(Object.keys(input).sort().join()!=="facts,previousCheckpointId,sourceId")throw Error("exact observation request required");
      const source=c.sources.find(s=>s.id===input.sourceId);if(!source)throw Error("source outside host binding");policy(source.id);
      const previous=latest().find(r=>r.sourceId===source.id)?.checkpointId??null;if(input.previousCheckpointId!==previous)throw Error("stale observation checkpoint");
      const captured=h.ingestPolicySource(c.policyPath,source.id,previous??undefined,c.policySha256);policy(source.id);
      let sourceManifestId:string|null=null,cases:DashboardObservation["cases"]=null,linkageManifestId:string|null=null;
      if(source.kind==="work"||source.kind==="facts"){
        const checkpoint=h.readArchiveCheckpoint(root,captured.checkpointId).checkpoint;sourceManifestId=checkpoint.sourceManifestId;bytes(sourceManifestId);
        if(source.kind==="facts") {if(input.facts!==null)throw Error("facts sources are declarations, not replacement authority");return {sourceId:source.id,kind:source.kind,checkpointId:captured.checkpointId,sourceManifestId,metadata:captured,cases:null,linkageManifestId:null};}
        const factSource=latest().find(r=>r.kind==="facts"&&r.sourceManifestId===input.facts);if(!factSource)throw Error("exact observed fact source required, not caller replacement facts");
        const facts=parseRetentionJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes(factSource.sourceManifestId!)),256*1024);captured.factSourceManifestId=factSource.sourceManifestId;captured.factBasis="explicit-host-declarations-not-authenticated-truth";
        if(dataDigest(authority.workContext.selectedSnapshot)!==dataDigest(selection))throw Error("independent source selection changed");
        try { const signals=h.captureArchivedWorkSignals(root,sourceManifestId,authority.workContext,facts);
          cases={version:"work-signals-v1",batchId:signals.caseBatchId,observationId:signals.observationId};linkageManifestId=signals.linkageManifestId;
        } catch(error) { captured.semanticFailure=String(error); } // Retain checkpoint/gap even when nomination is unavailable.
      } else {if(input.facts!==null||captured.kind!=="execution-retention-v2")throw Error("retention source requires exact referenced-blobs policy");h.readRetainedExecution(root,captured.checkpointId);}
      return {sourceId:source.id,kind:source.kind,checkpointId:captured.checkpointId,sourceManifestId,metadata:captured,cases,linkageManifestId};
    },
    async view(authority: DashboardHostAuthority | null, selection: DashboardHostConfig["selection"]) {
      const rows=latest(), projections:unknown[]=[], manifests:Record<string,Uint8Array>={};let workBytes:Uint8Array|undefined;
      for(const row of rows){policy(row.sourceId);if(row.kind==="work")workBytes=bytes(row.sourceManifestId!);else if(row.kind==="retention"){
        const read=h.readRetainedExecution(root,row.checkpointId);projections.push(read.projection);
        const raw=JSON.parse(new TextDecoder().decode(bytes(row.checkpointId))),manifest=bytes(raw.manifestId);manifests[createHash("sha256").update(manifest).digest("hex")]=manifest;
      }}
      const context=authority?.workContext??{selectedSnapshot:selection,authority:null};
      if(dataDigest(context.selectedSnapshot)!==dataDigest(selection))throw Error("dashboard selection drift");
      const daily=await reader({workBytes,archiveBytes:Buffer.from(JSON.stringify(h.projectRetainedExecutions(projections))),sourceManifestBytes:manifests,workContext:context});
      return {daily,observations:rows,coverage:"partial",unobservedSources:c.sources.filter(s=>!rows.some(r=>r.sourceId===s.id)).map(s=>s.id),sourceJobGaps:history().filter(e=>e.value.type==="claim"&&!history().some(r=>r.value.type==="result"&&r.value.requestId===e.value.requestId)).map(e=>String(e.value.requestId)),workerInteractions:0,continuity:"retained-checkpoints-not-live-continuity"};
    }
  };
}
