import { cloneExperiment, closed, experimentHash } from "./experiment-contract.ts";
import { experimentStore } from "./experiment-store.ts";
import { replayExperiment } from "./experiment-state.ts";
import { factoryAuthority, factoryCharter, factoryOrderDigest, requireFactoryAuthority, type FactoryAuthority, type FactoryOrderCharter } from "./factory-contract.ts";
import { factoryRegistryStore, replayRegistry, type FactoryRegistryBinding } from "./factory-registry.ts";
import { createFactoryOrder } from "./factory-order.ts";
export interface FactoryMigration {version:"factory-migration-v1";requestId:string;sourceOrderId:string;successor:FactoryOrderCharter}
export const factoryMigrationDigest=(request:FactoryMigration)=>experimentHash(request);
/** Only unstarted controllers can be superseded. An original claim is a refusal, never an idle/PID guess. */
export async function migrateFactoryOrder(inputRegistry:FactoryRegistryBinding,input:FactoryMigration,host:FactoryAuthority|null){
  const b=factoryRegistryStore(inputRegistry).binding;
  const r=cloneExperiment(input),a=requireFactoryAuthority(factoryAuthority(host),b.initial.authorityId);closed(r,["version","requestId","sourceOrderId","successor"]);
  if(r.version!=="factory-migration-v1"||!/^[a-zA-Z0-9:_-]{1,128}$/.test(r.requestId)||r.sourceOrderId===r.successor.orderId||!a.migrationDigests.includes(factoryMigrationDigest(r)))throw new Error("independent migration authority required");
  r.successor=factoryCharter(r.successor);if(!a.orderDigests.includes(factoryOrderDigest(r.successor)))throw new Error("successor order authority required");
  const store=factoryRegistryStore(b);let fresh=false;
  await store.transaction(async(events,append)=>{const s=replayRegistry(b,events),old=s.changes.get(r.requestId);if(old){if(old!==factoryMigrationDigest(r))throw new Error("conflicting migration ID");return;}
    const source=s.orders.get(r.sourceOrderId);if(!source?.binding||!a.orderDigests.includes(factoryOrderDigest(source.charter)))throw new Error("source order authority unavailable");
    if(r.successor.scopeDigest!==b.initial.scopeDigest||r.successor.pin.revision!==s.revision||r.successor.pin.candidateDigest!==s.candidateDigest||s.orders.has(r.successor.orderId))throw new Error("stale migration target");
    const e={type:"migration-request",requestId:r.requestId,sourceOrderId:r.sourceOrderId,targetOrderId:r.successor.orderId,requestDigest:factoryMigrationDigest(r)};replayRegistry(b,[...events,e]);await append(e);fresh=true;
  });
  if(fresh){const s=replayRegistry(b,(await store.read()).events),source=s.orders.get(r.sourceOrderId)!,binding=source.binding!,old=experimentStore(binding);
    const applied=await old.transaction(async(events,append)=>{const state=replayExperiment(binding.charter,events);if(state.claim||state.superseded)return false;
      const e={type:"order-migrated",requestId:r.requestId,successorDigest:factoryOrderDigest(r.successor)};replayExperiment(binding.charter,[...events,e]);await append(e);return true;});
    if(applied)await createFactoryOrder(b,r.successor,a);
    await store.transaction(async(events,append)=>{const e={type:"migration-receipt",requestId:r.requestId,application:applied?"applied":"refused-active",renewedObligations:applied?source.charter.nodes.map(n=>n.obligation):[]};replayRegistry(b,[...events,e]);await append(e);});
  }
  const m=replayRegistry(b,(await store.read()).events).migrations.get(r.requestId)!;
  return {...m,requestId:r.requestId,grantExpansion:false,acceptanceTransfer:"none" as const};
}
