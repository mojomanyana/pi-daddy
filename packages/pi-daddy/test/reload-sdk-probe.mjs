// Model-free actual Pi 0.85.1 AgentSession.reload probe; no prompt/provider request is issued.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const sdkRoot="/tmp/factory-release-0.25.2-liq3whn_/node_modules/@earendil-works/pi-coding-agent";
const sdk=await import(pathToFileURL(join(sdkRoot,"dist/index.js")).href);
const grants=(await import(pathToFileURL(join(process.cwd(),"extensions/grants.ts")).href)).default;
const root=await mkdtemp(join(tmpdir(),"pi-daddy-sdk-reload-"));
const keys=["PI_GRANTS_GRANT","PI_GRANTS_DEPTH","PI_GRANTS_MAX_DEPTH","PI_GRANTS_APPROVED","PI_GRANTS_HERDR"];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
try{
 for(const key of keys)delete process.env[key];Object.assign(process.env,{PI_GRANTS_GRANT:"tool:read,tool:delegate",PI_GRANTS_MAX_DEPTH:"2",PI_GRANTS_HERDR:"0"});
 const agentDir=join(root,"agent");await mkdir(agentDir,{mode:0o700});
 const settings=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,maxRetries:0}});
 const loader=new sdk.DefaultResourceLoader({cwd:root,agentDir,settingsManager:settings,systemPromptOverride:()=>"",agentsFilesOverride:()=>({agentsFiles:[],diagnostics:[]}),skillsOverride:()=>({skills:[],diagnostics:[]}),promptsOverride:()=>({prompts:[],diagnostics:[]}),extensionFactories:[{name:"pi-daddy-reload-probe",factory:grants}]});
 await loader.reload();
 const created=await sdk.createAgentSession({cwd:root,agentDir,resourceLoader:loader,sessionManager:sdk.SessionManager.inMemory(root),settingsManager:settings});
 assert.equal(created.extensionsResult.errors.length,0);
 assert.equal(created.session.getActiveToolNames().includes("delegate"),true,"root starts with governed delegate capability");
 await created.session.reload();await created.session.reload();
 assert.equal(created.session.getActiveToolNames().includes("delegate"),true,"two actual SDK reloads retain root delegation depth/authority");
 console.log("SDK_RELOAD_OK",JSON.stringify({sdk:(await import(pathToFileURL(join(sdkRoot,"package.json")).href,{with:{type:"json"}})).default.version,reloads:2,providerRequests:0}));
 created.session.dispose();
}finally{for(const key of keys){const value=saved[key];value===undefined?delete process.env[key]:process.env[key]=value;}await rm(root,{recursive:true,force:true});}
