/** Inert Node child scripts emitting Pi 1.0.4 protocol and matching persisted session.
 * Real CLI/SDK qualification lives in test-integration/pi-sdk; this fixture tests runtime wiring only.
 */
export function piFixtureScript(source: string): string {
  return `#!/usr/bin/env node
const __fixtureFs = require("node:fs");
const __fixtureId = require("node:crypto").randomUUID();
const __fixtureEmit = (event) => __fixtureFs.writeSync(1, JSON.stringify(event) + "\\n");
const __fixtureHeader = {type:"session",version:3,id:__fixtureId,timestamp:new Date().toISOString(),cwd:process.cwd()};
const __fixtureUser = {role:"user",content:[{type:"text",text:process.argv.at(-1) || "fixture task"}],timestamp:Date.now()};
let __fixtureText = "";
const __piFixture = { provider:"fixture", model:"fixture", usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, entries:[], persist:undefined };
const __fixtureMessage = (code) => ({role:"assistant",api:"fixture",provider:__piFixture.provider,model:__piFixture.model,
  content:[{type:"text",text:__fixtureText}],usage:__piFixture.usage,stopReason:code===0?"stop":"error",timestamp:1});
__piFixture.persist = (code=0) => {
  const rows = [__fixtureHeader]; let parentId=null;
  for (const entry of [{type:"message",message:__fixtureUser}, ...__piFixture.entries,{type:"message",message:__fixtureMessage(code)}]) {
    const id=require("node:crypto").randomUUID(); rows.push({...entry,id,parentId,timestamp:new Date().toISOString()});parentId=id;
  }
  const i=process.argv.indexOf("--session");
  if(i>=0) __fixtureFs.writeFileSync(process.argv[i+1], rows.map(JSON.stringify).join("\\n")+"\\n");
};
__fixtureEmit(__fixtureHeader);__fixtureEmit({type:"agent_start"});__fixtureEmit({type:"message_end",message:__fixtureUser});
process.stdout.write = (chunk, encoding, callback) => {
  const delta=Buffer.isBuffer(chunk)?chunk.toString(typeof encoding === "string"?encoding:"utf8"):String(chunk);
  __fixtureText+=delta;__fixtureEmit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta}});
  if(typeof encoding==="function") encoding(); else if(typeof callback==="function") callback(); return true;
};
process.on("exit",(code)=>{__piFixture.persist(code);__fixtureEmit({type:"message_end",message:__fixtureMessage(code)});__fixtureEmit({type:"agent_end"});__fixtureEmit({type:"agent_settled"});});
${source.replace(/^#![^\n]*\n/, "")}
`;
}
