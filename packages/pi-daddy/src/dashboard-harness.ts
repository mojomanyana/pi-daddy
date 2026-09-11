import { constants } from "node:fs";
import { lstat,realpath,open,mkdir,mkdtemp,writeFile,symlink } from "node:fs/promises";
import { dirname,join,isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { dataDigest,byteDigest,detached,sha } from "./debrief-contract.ts";
import { DASHBOARD_HARNESS_PIN,type DashboardHarness } from "./dashboard-host-contract.ts";
export interface DashboardHarnessArtifact {version:"dashboard-harness-artifact-v1";sourceCommit:typeof DASHBOARD_HARNESS_PIN;files:Record<string,string>;typeboxRoot:string;typeboxPackageSha256:string}
const loaded=new WeakMap<object,string>();
export const DASHBOARD_HARNESS_BRIDGE_SOURCE="73ab11883bb1c8924dc5ebbe8a61c96e913ee437";
const bridgeFunctions=["learningJournal","createTrustLifecycle","openTrustLifecycle","trustPolicyDigest","archivePolicyBinding","ingestPolicySource","readArchiveCheckpoint","readArchiveSource","retainArchiveSource","captureArchivedWorkSignals","readRetainedExecution","projectRetainedExecutions","createWorkCaseReviewer","createWorkSignalReviewer","retainBlindIntervention","openBlindIntervention"] as const;
/** Adopt the API published by the already-loaded skill-harness extension. Same-process source identity is not human authentication. */
export function adoptDashboardHarnessBridge(input:unknown):DashboardHarness{
 const value=input as {version?:unknown;sourceCommit?:unknown;api?:unknown};
 if(!value||typeof value!=="object"||Object.keys(value).sort().join()!=="api,sourceCommit,version"||value.version!=="skill-harness-dashboard-bridge-v1"||value.sourceCommit!==DASHBOARD_HARNESS_BRIDGE_SOURCE)throw Error("exact supported harness bridge required");
 const api=value.api as DashboardHarness;if(!api||typeof api!=="object"||!Object.isFrozen(api)||bridgeFunctions.some(name=>typeof (api as unknown as Record<string,unknown>)[name]!=="function"))throw Error("frozen harness API with required source jobs required");
 const digest=dataDigest({version:value.version,sourceCommit:value.sourceCommit,functions:bridgeFunctions});loaded.set(api,digest);return api;
}
export const loadedDashboardHarnessDigest=(h:unknown):string|null=>typeof h==="object"&&h!==null?loaded.get(h)??null:null;
async function privateDirectory(path:string){const stat=await lstat(path);if(!isAbsolute(path)||await realpath(path)!==path||!stat.isDirectory()||stat.mode&0o077||stat.uid!==process.getuid?.())throw Error("canonical private owned harness directory required");}
async function bytes(path:string){if(await realpath(path)!==path)throw Error("harness artifact alias");const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await fd.stat();if(!stat.isFile()||stat.nlink!==1||stat.mode&0o022||stat.size>1048576)throw Error("bounded immutable artifact required");const value=Buffer.alloc(stat.size+1),n=await fd.read(value,0,value.length,0),after=await fd.stat();if(n.bytesRead!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw Error("artifact changed during read");return value.subarray(0,n.bytesRead);}finally{await fd.close();}}
/** Load approved real compiled artifacts into an exclusive private tree, avoiding stale module-cache paths.
 * Byte identity is NOT human/module authentication or hostile-same-UID confinement. No build/install here.
 * Typebox is the explicit existing peer; its package metadata is bound, not a whole peer-source attestation. */
export async function loadDashboardHarness(artifactRoot:string,input:DashboardHarnessArtifact,parent:string){
 const manifest=detached(input);if(manifest.version!=="dashboard-harness-artifact-v1"||manifest.sourceCommit!==DASHBOARD_HARNESS_PIN||!sha(manifest.typeboxPackageSha256))throw Error("exact supported harness artifact required");
 const files=Object.entries(manifest.files);if(!files.length||files.length>128||files.some(([p,h])=>!sha(h)||!/^([a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(js|json)$/.test(p)))throw Error("bounded closed artifact inventory required");
 await privateDirectory(artifactRoot);await privateDirectory(parent);
 if(await realpath(manifest.typeboxRoot)!==manifest.typeboxRoot||byteDigest(await bytes(join(manifest.typeboxRoot,"package.json")))!==manifest.typeboxPackageSha256)throw Error("retained typebox peer changed");
 const content=new Map<string,Buffer>();let total=0;for(const[p,digest]of files){const b=await bytes(join(artifactRoot,p));total+=b.length;if(total>8*1024*1024||byteDigest(b)!==digest)throw Error("harness artifact digest mismatch");content.set(p,b);}
 if(content.get("package.json")?.toString()!=='{"type":"module"}')throw Error("explicit ESM artifact root required");
 const directory=await mkdtemp(join(parent,"loaded-harness-"));for(const[p,b]of content){await mkdir(dirname(join(directory,p)),{recursive:true,mode:0o700});await writeFile(join(directory,p),b,{flag:"wx",mode:0o400});}
 await mkdir(join(directory,"node_modules"));await symlink(manifest.typeboxRoot,join(directory,"node_modules/typebox"));
 const names=["learning-journal","trust-lifecycle","archive-policy","archive-observer","archive-checkpoint","archived-work","execution-retention-archive","work-case-review","blind-intervention","evidence-archive","work-signal-observation","work-signal-cases","work-case-archive"];
 const api=Object.assign({},...await Promise.all([...names.map(n=>"packages/adapters/src/"+n+".js"),"core.js"].map(p=>{if(!content.has(p))throw Error("missing genuine harness entry");return import(pathToFileURL(join(directory,p)).href);}))) as DashboardHarness;
 for(const[p,digest]of files)if(byteDigest(await bytes(join(directory,p)))!==digest)throw Error("loaded harness bytes changed");
 Object.freeze(api);const digest=dataDigest(manifest);loaded.set(api,digest);return Object.freeze({api,artifactDigest:digest,directory,manifest});
}
