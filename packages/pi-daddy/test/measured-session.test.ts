import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { join } from 'node:path';
import { cleanupTempDirs, tempDir } from './tmp.ts';
import { createResourceBudget, openResourceBudget } from '../src/resource-budget.ts';
import { runMeasuredAgentSession, type MeasuredSessionHost } from '../src/measured-session.ts';
after(cleanupTempDirs);
const authorityDigest='9'.repeat(64);
async function fixture(){const root=await tempDir('measured-session-'),budget=await createResourceBudget({directory:join(root,'budget'),authorityDigest,limits:{maxAttempts:2,maxInputBytes:2048,maxConcurrent:2}});return{root,budget};}
const request=(budget:any)=>({budget,attempt:{attemptId:'measure:1',orderId:'order:measure',experimentId:'experiment:measure',kind:'primary' as const,parentAttemptId:null},model:'openai-codex/gpt-5.6-sol' as const,thinkingLevel:'high' as const,prompt:'public source only',deadlineMs:1000,maxOutputBytes:1024,maxOutputTokens:512});
test('opt-in measured session retains exact provider usage under the existing attempt budget',async()=>{
 const f=await fixture(),host:MeasuredSessionHost={run:async input=>{assert.deepEqual(input.tools,[]);assert.equal(input.discovery,'factory-only');return{output:'bulletin',usage:{input:10,output:3,cacheRead:2,cacheWrite:0,reasoning:1,totalTokens:15,cost:{input:0.1,output:0.2,cacheRead:0.01,cacheWrite:0,total:0.31}},provider:'openai-codex',model:'gpt-5.6-sol',stopReason:'stop'};}};
 const result=await runMeasuredAgentSession(request(f.budget),host);assert.equal(result.state,'completed');assert.equal(result.usage.totalTokens,15);assert.equal(result.output,'bulletin');
 assert.deepEqual((await openResourceBudget(f.budget).inspect()).reservations.map(r=>r.outcome),['completed']);
});
test('unsupported models, output overflow and deadlines fail closed and settle the charged attempt',async()=>{
 const f=await fixture();await assert.rejects(runMeasuredAgentSession({...request(f.budget),model:'other/model' as any},{run:async()=>{throw Error('must not run');}}),/Sol or Terra/);
 const usage={input:1,output:1,cacheRead:0,cacheWrite:0,reasoning:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 const overflow:MeasuredSessionHost={run:async()=>({output:'x'.repeat(1025),usage,provider:'openai-codex',model:'gpt-5.6-sol',stopReason:'stop'})};
 await assert.rejects(runMeasuredAgentSession(request(f.budget),overflow),/output bound/);
 const deadline:MeasuredSessionHost={run:input=>new Promise(resolve=>input.signal.addEventListener('abort',()=>resolve({output:'late',usage,provider:'openai-codex',model:'gpt-5.6-sol',stopReason:'aborted'}),{once:true}))};
 await assert.rejects(runMeasuredAgentSession({...request(f.budget),attempt:{...request(f.budget).attempt,attemptId:'measure:2'},deadlineMs:1000},deadline),/settled after cancellation/);
 assert.deepEqual((await openResourceBudget(f.budget).inspect()).reservations.map(r=>r.outcome),['failed','cancelled']);
});
