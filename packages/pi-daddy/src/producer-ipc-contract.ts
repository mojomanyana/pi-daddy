import { createHash } from "node:crypto";
import { isExecutionId } from "./execution-id.ts";
import type { AttemptDemand } from "./resource-budget.ts";
export const PRODUCER_IPC_LIMITS = Object.freeze({ frameBytes:1024, referenceBytes:128, childMs:3000, graceMs:50, maxElapsedMs:30000 });
export interface ProducerIpcBinding { version:"producer-ipc-v1"; budgetDigest:string; orderId:string; experimentId:string; executionId:string; charterSha256:string; invocationId:string }
export interface ProducerIpcReferences { claimRef:string; responseRef:string }
const id = (v:unknown):v is string => typeof v === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const hash = (v:unknown):v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function ipcShape(value:unknown, keys:readonly string[]): asserts value is Record<string,unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length || keys.some(k=>{const d=Object.getOwnPropertyDescriptor(value,k);return !d||!d.enumerable||!Object.hasOwn(d,"value");})) throw new TypeError("closed producer IPC data required");
}
export function producerIpcBinding(value:ProducerIpcBinding):Readonly<ProducerIpcBinding> {
  ipcShape(value,["version","budgetDigest","orderId","experimentId","executionId","charterSha256","invocationId"]);
  if (value.version!=="producer-ipc-v1" || !hash(value.budgetDigest) || !hash(value.charterSha256) || !isExecutionId(value.executionId) || ![value.orderId,value.experimentId,value.invocationId].every(id)) throw new TypeError("exact producer IPC binding required");
  return Object.freeze({version:value.version,budgetDigest:value.budgetDigest,orderId:value.orderId,experimentId:value.experimentId,executionId:value.executionId,charterSha256:value.charterSha256,invocationId:value.invocationId});
}
export const producerIpcBindingDigest = (value:ProducerIpcBinding) => createHash("sha256").update(JSON.stringify(producerIpcBinding(value))).digest("hex");
export const producerIpcFrame = (value:ProducerIpcBinding):Buffer => Buffer.from(JSON.stringify({id:producerIpcBinding(value).invocationId,sequence:1})+"\n");
/** Existing v4 reservation schema, not a new model/effort/skills experiment operation. */
export function producerIpcDemand(value:ProducerIpcBinding):AttemptDemand {
  const b=producerIpcBinding(value);return {attemptId:b.executionId,orderId:b.orderId,experimentId:b.experimentId,kind:"primary",parentAttemptId:null,inputBytes:Buffer.byteLength(JSON.stringify(b)),inputDigest:producerIpcBindingDigest(b)};
}
export function ipcReferences(value:ProducerIpcReferences):Readonly<ProducerIpcReferences> {
  ipcShape(value,["claimRef","responseRef"]);if(!id(value.claimRef)||!id(value.responseRef))throw new TypeError("bounded evidence references required");
  return Object.freeze({claimRef:value.claimRef,responseRef:value.responseRef});
}
