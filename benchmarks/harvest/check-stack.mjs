// Run two actual Pi processes against the local candidates and installed peers. No model requests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const peers = resolve(process.argv[2] ?? join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "npm", "node_modules"));
const packages = [join(root,"packages/pi-daddy"),resolve(root,"../pi-harvest-scout"),
  ...["pi-bookie","principal-pi-skills","skill-harness"].map(name=>join(peers,name))];
for (const path of packages) assert(existsSync(join(path,"package.json")), "Missing package at " + path);
const temp = mkdtempSync(join(tmpdir(),"pi-ecosystem-check-"));
try {
  const profile = join(temp,"profile"), cwd = join(temp,"workspace"), session = join(temp,"session.jsonl");
  mkdirSync(profile); mkdirSync(cwd);
  writeFileSync(join(profile,"settings.json"),JSON.stringify({packages}));
  const probe = join(temp,"check.mjs"), result = join(temp,"result.json");
  const harnessOut = join(temp,"evaluations");
  const harvest = spawnSync(process.execPath,[join(peers,"skill-harness/bin.js"),"harvest","--turn-json","-","--out",harnessOut,"--unique","--json"],{
    cwd,encoding:"utf8",timeout:15000,input:JSON.stringify({scenarioId:"fixture-parse-error",skillName:"debug",prompt:"Fix the fixture parser",
      editedFiles:["parser.ts"],verifyCommands:["node --test parser.test.ts"],sawColdReviewBlocker:true,sawThrashHint:false}),
  });
  assert.equal(harvest.status,0,harvest.error?.message ?? harvest.stderr);
  const receipt = JSON.parse(harvest.stdout.trim().split(/\r?\n/).at(-1));
  assert(existsSync(receipt.specPath),"Harness did not write a regression spec");
  console.log("Skill Harness wrote a regression spec from the synthetic turn.");
  const bookieModule = join(peers,"pi-bookie/src/managed-vault.ts").replaceAll("\\","/");
  const statusPath = join(root,"benchmarks/harvest/pilot-status.mjs").replaceAll("\\","/");
  writeFileSync(probe, `import {writeFileSync} from 'node:fs';
import {ecosystemStatus} from ${JSON.stringify(statusPath)};
import {taskEnrollment,openManagedVault,attestTaskEnrollment} from ${JSON.stringify(bookieModule)};
export default function(pi) {
  pi.registerCommand('verify-ecosystem-fixture',{description:'Offline fixture',handler:async (_,ctx)=>{
    const loaded = ecosystemStatus(pi);
    let enrollment;
    if (process.platform === "linux") {
      const dir = ${JSON.stringify(profile)};
      const before = await taskEnrollment(ctx.cwd,dir);
      await openManagedVault(ctx.cwd,async()=>{},dir);
      await attestTaskEnrollment(ctx.cwd,async()=>{},dir);
      enrollment = {before,after:await taskEnrollment(ctx.cwd,dir)};
    }
    let scoutSettings = false;
    pi.events.emit('scout:model-settings:v1',{report(){scoutSettings=true}});
    const restored = ctx.sessionManager.getBranch().some(e=>e.type==='message' && e.message.content==='Fixture marker');
    writeFileSync(${JSON.stringify(result)},JSON.stringify({loaded,scoutSettings,restored,enrollment,id:ctx.sessionManager.getSessionId()}));
    ctx.shutdown();
  }});
}`);
  const cli = join(root,"node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const run = () => {
    rmSync(result,{force:true});
    const child = spawnSync(process.execPath,[cli,"--offline","--approve","--mode","rpc","--session",session,"-e",probe],{
      cwd,env:{...process.env,PI_CODING_AGENT_DIR:profile,PI_DADDY_AUTO_MODE:"1",PI_OFFLINE:"1",PI_SKIP_VERSION_CHECK:"1"},
      input:JSON.stringify({id:"inspect",type:"prompt",message:"/verify-ecosystem-fixture"})+"\n",encoding:"utf8",timeout:45000,
    });
    assert.equal(child.status,0,child.error?.message ?? child.stderr.slice(-600));
    assert(existsSync(result),"Pi did not complete the offline inspection: " + (child.error?.message ?? child.stderr.slice(-600)));
    const state = JSON.parse(readFileSync(result,"utf8"));
    console.log(JSON.stringify(state));
    assert(Object.values(state.loaded).every(Boolean) && state.scoutSettings,"Missing ecosystem registration");
    return state;
  };
  const first = run();
  const timestamp = new Date().toISOString();
  writeFileSync(session,[{type:"session",version:3,id:first.id,timestamp,cwd},{type:"message",id:"1234abcd",parentId:null,timestamp,message:{role:"user",content:"Fixture marker",timestamp:Date.now()}}].map(x=>JSON.stringify(x)).join("\n")+"\n");
  const second = run();
  assert.equal(second.id,first.id); assert(second.restored,"Original turn missing after resume");
  if (process.platform === "linux") {
    assert.deepEqual(first.enrollment,{before:"absent",after:"attached"});
    assert.equal(second.enrollment.before,"attached");
    console.log("Bookie attached the fixture workspace and recovered the same enrollment after restart.");
  } else console.log("Bookie workspace enrollment is covered by the Linux/WSL run.");
  console.log("Fresh and resumed Pi registered all five components and the Scout settings handler.");
} finally { rmSync(temp,{recursive:true,force:true}); }
