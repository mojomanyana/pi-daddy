// Run two actual Pi processes against the local candidates and installed peers. No model requests.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { findPackageJSON } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runFile = promisify(execFile);
const peers = resolve(process.argv[2] ?? join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "npm", "node_modules"));
const packages = [join(root,"packages/pi-daddy"),resolve(root,"../pi-harvest-scout"),
  ...["pi-bookie","principal-pi-skills","skill-harness"].map(name=>join(peers,name))].map(path=>{
    assert(existsSync(join(path,"package.json")), "Missing package at " + path);
    return realpathSync(path);
  });
const version = path => JSON.parse(readFileSync(join(path,"package.json"),"utf8")).version;
const sdk = version(join(root,"node_modules/@earendil-works/pi-coding-agent"));
const release = JSON.parse(readFileSync(join(root,"packages/pi-daddy/src/products/ecosystem-release.json"),"utf8"));
assert.equal(sdk,release.piSdk,"Refresh the checkout dependencies before testing the ecosystem");
console.log("Testing Pi " + sdk + " with " + packages.map(path=>{
  const {name,version} = JSON.parse(readFileSync(join(path,"package.json"),"utf8"));
  return name + "@" + version;
}).join(", "));
const temp = mkdtempSync(join(tmpdir(),"pi-ecosystem-check-"));
try {
  const profile = join(temp,"profile"), cwd = join(temp,"workspace"), session = join(temp,"session.jsonl");
  mkdirSync(profile,{mode:0o700}); mkdirSync(cwd,{mode:0o700});
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
  const bookieModule = join(packages[2],"src/managed-vault.ts").replaceAll("\\","/");
  const coreManifest = findPackageJSON("pi-bookie-core",pathToFileURL(bookieModule));
  const coreEntry = JSON.parse(readFileSync(coreManifest,"utf8")).exports["."].import;
  const coreModule = resolve(dirname(coreManifest),coreEntry).replaceAll("\\","/");
  const statusPath = join(root,"benchmarks/harvest/pilot-status.mjs").replaceAll("\\","/");
  writeFileSync(probe, `import {writeFileSync} from 'node:fs';
import {ecosystemStatus} from ${JSON.stringify(statusPath)};
import {taskEnrollment,openManagedVault,attestTaskEnrollment} from ${JSON.stringify(bookieModule)};
import {inspectConcept,openTaskHistory} from ${JSON.stringify(coreModule)};
export default function(pi) {
  pi.registerCommand('verify-ecosystem-fixture',{description:'Offline fixture',handler:async (_,ctx)=>{
    try {
      const loaded = ecosystemStatus(pi);
      let enrollment;
      if (process.platform === "linux") {
        const dir = ${JSON.stringify(profile)};
        const before = await taskEnrollment(ctx.cwd,dir);
        const vault = await openManagedVault(ctx.cwd,async()=>{},dir);
        const project = await inspectConcept(vault.root,{path:vault.project},{maxContentBytes:1});
        if (!project.ok || project.type !== "Project") throw Error("Could not read the fixture Bookie project");
        const history = await openTaskHistory({vault:vault.root,projectId:project.uid,assertCurrent:vault.assertCurrent});
        const task = before === "absent" ? await history.ensureSelected() : await history.selected();
        if (!task?.taskId) throw Error("Missing selected Bookie task for enrollment " + before);
        await attestTaskEnrollment(ctx.cwd,vault.assertCurrent,dir);
        enrollment = {before,after:await taskEnrollment(ctx.cwd,dir),taskId:task.taskId};
      }
      let scoutSettings = false;
      pi.events.emit('scout:model-settings:v1',{report(){scoutSettings=true}});
      const restored = ctx.sessionManager.getBranch().some(e=>e.type==='message' && e.message.content==='Fixture marker');
      writeFileSync(${JSON.stringify(result)},JSON.stringify({loaded,scoutSettings,restored,enrollment,id:ctx.sessionManager.getSessionId()}));
    } catch (error) {
      writeFileSync(${JSON.stringify(result)},JSON.stringify({error:error.stack ?? String(error)}));
    } finally { ctx.shutdown(); }
  }});
}`);
  const cli = join(root,"node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const run = async () => {
    rmSync(result,{force:true});
    const done = runFile(process.execPath,[cli,"--offline","--approve","--mode","rpc","--session",session,"-e",probe],{
      cwd,env:{...process.env,PI_CODING_AGENT_DIR:profile,PI_DADDY_AUTO_MODE:"1",PI_OFFLINE:"1",PI_SKIP_VERSION_CHECK:"1"},
      encoding:"utf8",timeout:45000,
    });
    // Pi treats stdin EOF as shutdown, including while an extension command awaits disk I/O.
    // Keep the RPC channel open until the probe has saved its result and requested shutdown.
    done.child.stdin.write(JSON.stringify({id:"inspect",type:"prompt",message:"/verify-ecosystem-fixture"})+"\n");
    const {stdout,stderr} = await done;
    assert(existsSync(result),"Pi did not complete the offline inspection: " + stdout.slice(-600) + stderr.slice(-600));
    const state = JSON.parse(readFileSync(result,"utf8"));
    assert(!state.error,state.error);
    console.log(JSON.stringify(state));
    assert(Object.values(state.loaded).every(Boolean) && state.scoutSettings,"Missing ecosystem registration");
    return state;
  };
  const first = await run();
  const timestamp = new Date().toISOString();
  writeFileSync(session,[{type:"session",version:3,id:first.id,timestamp,cwd},{type:"message",id:"1234abcd",parentId:null,timestamp,message:{role:"user",content:"Fixture marker",timestamp:Date.now()}}].map(x=>JSON.stringify(x)).join("\n")+"\n");
  const second = await run();
  assert.equal(second.id,first.id); assert(second.restored,"Original turn missing after resume");
  if (process.platform === "linux") {
    assert.equal(first.enrollment.before,"absent");
    assert.equal(first.enrollment.after,"attached");
    assert.equal(second.enrollment.before,"attached");
    assert.equal(second.enrollment.taskId,first.enrollment.taskId);
    console.log("Bookie attached the fixture workspace and recovered the same enrollment after restart.");
  } else console.log("Bookie workspace enrollment is covered by the Linux/WSL run.");
  console.log("Fresh and resumed Pi registered all five components and the Scout settings handler.");
} finally { rmSync(temp,{recursive:true,force:true}); }
