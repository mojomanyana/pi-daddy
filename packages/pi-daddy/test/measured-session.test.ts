import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { join } from 'node:path';
import { cleanupTempDirs, tempDir } from './tmp.ts';
import { createResourceBudget, openResourceBudget } from '../src/resource-budget.ts';
import { MeasuredSessionFailure, MeasuredSessionUnknownError, runMeasuredAgentSession, verifyMeasuredSubscription, type MeasuredSessionHost } from '../src/measured-session.ts';
after(cleanupTempDirs);
const authorityDigest='9'.repeat(64);
async function fixture(){const root=await tempDir('measured-session-'),budget=await createResourceBudget({directory:join(root,'budget'),authorityDigest,limits:{maxAttempts:2,maxInputBytes:2048,maxConcurrent:2}});return{root,budget};}
const request=(budget:any)=>({budget,attempt:{attemptId:'measure:1',orderId:'order:measure',experimentId:'experiment:measure',kind:'primary' as const,parentAttemptId:null},model:'openai-codex/gpt-5.6-sol' as const,thinkingLevel:'high' as const,prompt:'public source only',deadlineMs:1000,terminationGraceMs:100,maxRetainedOutputBytes:1024,maxOutputTokens:512});
test('opt-in measured session retains exact provider usage under the existing attempt budget',async()=>{
 const f=await fixture(),host:MeasuredSessionHost={run:async input=>{assert.deepEqual(input.tools,[]);assert.equal(input.discovery,'factory-only');return{output:'bulletin',usage:{input:10,output:3,cacheRead:2,cacheWrite:0,reasoning:1,totalTokens:15,cost:{input:0.1,output:0.2,cacheRead:0.01,cacheWrite:0,total:0.31}},provider:'openai-codex',model:'gpt-5.6-sol',stopReason:'stop'};}};
 const result=await runMeasuredAgentSession(request(f.budget),host);assert.equal(result.state,'completed');assert.equal(result.usage.totalTokens,15);assert.equal(result.output,'bulletin');
 assert.deepEqual((await openResourceBudget(f.budget).inspect()).reservations.map(r=>r.outcome),['completed']);
});
test('pre-aborted calls launch no host and reserve no attempt',async()=>{
 const f=await fixture(),signal=AbortSignal.abort('operator'),host:MeasuredSessionHost={run:async()=>{throw Error('must not run');}};
 await assert.rejects(runMeasuredAgentSession({...request(f.budget),signal},host),MeasuredSessionFailure);assert.equal((await openResourceBudget(f.budget).inspect()).attempts,0);
});
test('identity, stop and retained-output failures preserve evidence and settle failed',async()=>{
 const usage={input:1,output:1,cacheRead:0,cacheWrite:0,reasoning:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 for(const [suffix,result,match] of [
  ['identity',{output:'evidence',usage,provider:'openai-codex',model:'gpt-5.6-terra',stopReason:'stop'},/identity/],
  ['length',{output:'partial',usage,provider:'openai-codex',model:'gpt-5.6-sol',stopReason:'length'},/stop cleanly/],
  ['overflow',{output:'x'.repeat(1025),usage,provider:'openai-codex',model:'gpt-5.6-sol',stopReason:'stop'},/retained-output bound/],
 ] as const){const f=await fixture(),host:MeasuredSessionHost={run:async()=>result};let error:any;try{await runMeasuredAgentSession({...request(f.budget),attempt:{...request(f.budget).attempt,attemptId:'measure:'+suffix}},host);}catch(e){error=e;}assert.match(String(error),match);assert.equal(error.evidence.output.sha256.length,64);assert.equal((await openResourceBudget(f.budget).inspect()).reservations[0].outcome,'failed');}
});
test('settled abort is cancelled; non-settling abort stays actively unknown',async()=>{
 const usage={input:1,output:1,cacheRead:0,cacheWrite:0,reasoning:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},f=await fixture();
 const settled:MeasuredSessionHost={run:input=>new Promise(resolve=>input.signal.addEventListener('abort',()=>resolve({output:'late',usage,provider:'openai-codex',model:'gpt-5.6-sol',stopReason:'aborted'}),{once:true}))};
 await assert.rejects(runMeasuredAgentSession(request(f.budget),settled),MeasuredSessionFailure);
 const never:MeasuredSessionHost={run:()=>new Promise(()=>{})};await assert.rejects(runMeasuredAgentSession({...request(f.budget),attempt:{...request(f.budget).attempt,attemptId:'measure:2'}},never),MeasuredSessionUnknownError);
 const rows=(await openResourceBudget(f.budget).inspect()).reservations;assert.deepEqual(rows.map(r=>r.outcome),['cancelled',null]);assert.equal(rows[1].state,'reserved');
});
test('OAuth subscription metadata is required without exposing credentials',async()=>{
 const runtime=(oauth:boolean,subscription:boolean,type:'oauth'|'api_key'='oauth')=>({isUsingOAuth:()=>oauth,isUsingSubscription:()=>subscription,checkAuth:async()=>({type})});
 await verifyMeasuredSubscription(runtime(true,true));await assert.rejects(verifyMeasuredSubscription(runtime(false,true)),/OAuth subscription/);await assert.rejects(verifyMeasuredSubscription(runtime(true,false)),/OAuth subscription/);await assert.rejects(verifyMeasuredSubscription(runtime(true,true,'api_key')),/OAuth subscription/);
});
