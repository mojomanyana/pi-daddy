/** Synthetic service cleanup inside the native helper's private process session; no network or model. */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCapturedExecution } from "../src/executors/captured-execution.ts";
import { piFixtureScript } from "./pi-fixture.ts";

export async function ownedCleanupFixture(
  root: string,
  mode: "pattern" | "pid" | "interrupt",
  executionId = "fixture:" + randomUUID(),
) {
  const selector = "forma-owned-selector-" + randomUUID();
  const eventsPath = join(root, "events.jsonl");
  const sessionPath = join(root, "session.jsonl");
  const script = join(root, "worker.cjs");
  const servicePath = join(root, "service.cjs");
  await writeFile(
    servicePath,
    `const fs=require('node:fs');
const record=event=>fs.appendFileSync(process.env.FORMA_EVENTS,JSON.stringify({...event,pid:process.pid})+'\\n');
process.on('SIGTERM',()=>{record({event:'service-signal',signal:'SIGTERM'});process.exit(0);});
record({event:'service-ready'});process.send('ready');process.disconnect();setInterval(()=>{},1000);
`,
  );
  await writeFile(
    script,
    piFixtureScript(`
const fs=require('node:fs'),cp=require('node:child_process'),{once}=require('node:events');
const selector=process.argv.at(-1),helperPid=process.ppid;
const record=event=>fs.appendFileSync(process.env.FORMA_EVENTS,JSON.stringify({...event,pid:process.pid})+'\\n');
const stat=pid=>fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ');
const helperStart=stat(helperPid)[19];
// Pi's real CLI also sets process.title before performing tool work.
process.title='pi-fixture';
process.on('SIGTERM',()=>{record({event:'worker-signal',signal:'SIGTERM'});process.removeAllListeners('exit');process.exit(0);});
(async()=>{
 const service=cp.spawn(process.execPath,[${JSON.stringify(servicePath)},selector],{stdio:['ignore','ignore','inherit','ipc'],env:process.env});
 await once(service,'message');
 const session=Number(stat(helperPid)[3]);
 if(session!==helperPid||Number(stat(process.pid)[3])!==session||Number(stat(service.pid)[3])!==session)
   throw Error('Fixture is not confined to its freshly owned process session');
 const selected=cp.spawnSync('pgrep',['--session',String(session),'--full',selector],{encoding:'utf8',timeout:1000});
 if(selected.status!==0)throw Error('Fixture selector did not identify its service');
 const matched=selected.stdout.trim().split(/\\s+/).map(Number);
 if(!matched.includes(service.pid)||matched.some(pid=>![helperPid,service.pid].includes(pid)))
   throw Error('Refusing cleanup outside the fixture helper/service identities');
 record({event:'cleanup-selection',helperPid,servicePid:service.pid,session,matched,
   helperArgvContainsSelector:fs.readFileSync('/proc/'+helperPid+'/cmdline').includes(selector),
   workerArgvContainsSelector:fs.readFileSync('/proc/self/cmdline').includes(selector)});
 const pending={role:'assistant',content:[{type:'toolCall',id:'cleanup',name:'bash',arguments:{command:'synthetic service cleanup'}}],stopReason:'toolUse',timestamp:2};
 fs.writeFileSync(${JSON.stringify(sessionPath)},[__fixtureHeader,
   {type:'message',id:'user',parentId:null,message:__fixtureUser},
   {type:'message',id:'cleanup',parentId:'user',message:pending}].map(JSON.stringify).join('\\n')+'\\n');
 __fixtureEmit({type:'message_end',message:pending});__fixtureEmit({type:'tool_execution_start',toolCallId:'cleanup'});
 if(process.env.FORMA_CLEANUP_MODE==='interrupt'){
   record({event:'exact-helper-interruption',target:helperPid,signal:'SIGTERM'});
   process.kill(helperPid,'SIGTERM');setInterval(()=>{},1000);return;
 }else if(process.env.FORMA_CLEANUP_MODE==='pattern'){
   // The session restriction is mandatory: never enumerate or signal user processes.
   const killed=cp.spawnSync('pkill',['--echo','--signal','TERM','--session',String(session),'--full',selector],{encoding:'utf8',timeout:1000});
   record({event:'pattern-cleanup',status:killed.status,signal:killed.signal,echo:killed.stdout});
   if(matched.includes(helperPid)){setInterval(()=>{},1000);return;}
   if(killed.status!==0)throw Error('Fixture cleanup did not deliver its signal');
 }else{service.kill('SIGTERM');record({event:'exact-pid-cleanup',target:service.pid,signal:'SIGTERM'});}
 await once(service,'close');
 record({event:'worker-continued',helperAlive:stat(helperPid)[19]===helperStart});
 __fixtureEmit({type:'tool_execution_end',toolCallId:'cleanup'});
 process.stdout.write('Fixture service stopped; worker continued.');
})().catch(error=>{record({event:'fixture-error',message:error.message});process.exit(1);});
`),
  );
  const result = await runCapturedExecution({
    command: process.execPath,
    args: [script, "--session", sessionPath, selector],
    sessionPath,
    executionId,
    cwd: root,
    env: { ...process.env, FORMA_EVENTS: eventsPath, FORMA_CLEANUP_MODE: mode },
    timeoutMs: 5000,
    killGraceMs: 500,
  });
  const events = (await readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { mode, selector, result, events, sessionPath };
}
