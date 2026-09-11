import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { openResourceBudget, type AttemptDemand, type GovernedBudgetBinding } from './resource-budget.ts';
import { freezeWork } from './work-ledger-json.ts';

const MODELS=['openai-codex/gpt-5.6-sol','openai-codex/gpt-5.6-terra'] as const;
const THINKING=['off','minimal','low','medium','high','xhigh','max'] as const;
export interface ProviderUsage {input:number;output:number;cacheRead:number;cacheWrite:number;reasoning:number;totalTokens:number;cost:{input:number;output:number;cacheRead:number;cacheWrite:number;total:number}}
export interface MeasuredSessionHostInput {model:typeof MODELS[number];thinkingLevel:typeof THINKING[number];prompt:string;deadlineMs:number;maxOutputTokens:number;tools:readonly [];discovery:'factory-only';signal:AbortSignal}
export interface MeasuredSessionHostResult {output:string;usage:ProviderUsage;provider:'openai-codex';model:'gpt-5.6-sol'|'gpt-5.6-terra';stopReason:string}
export interface MeasuredSessionHost {run(input:MeasuredSessionHostInput):Promise<MeasuredSessionHostResult>}
export interface MeasuredSessionInput {budget:GovernedBudgetBinding;attempt:Omit<AttemptDemand,'inputBytes'|'inputDigest'>;model:typeof MODELS[number];thinkingLevel:typeof THINKING[number];prompt:string;deadlineMs:number;maxOutputBytes:number;maxOutputTokens:number;signal?:AbortSignal}
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function checkedUsage(value:ProviderUsage):ProviderUsage {
 if(!value||typeof value!=='object'||Object.keys(value).sort().join()!=='cacheRead,cacheWrite,cost,input,output,reasoning,totalTokens'||![value.input,value.output,value.cacheRead,value.cacheWrite,value.reasoning,value.totalTokens].every(finite)||!Number.isSafeInteger(value.totalTokens)||!value.cost||Object.keys(value.cost).sort().join()!=='cacheRead,cacheWrite,input,output,total'||!Object.values(value.cost).every(finite))throw Error('provider usage unavailable or malformed');
 return JSON.parse(JSON.stringify(value));
}
function checked(input:MeasuredSessionInput):MeasuredSessionInput {
 if(!input||typeof input!=='object'||!MODELS.includes(input.model)||!THINKING.includes(input.thinkingLevel))throw Error('measured sessions require exact Codex Sol or Terra');
 if(typeof input.prompt!=='string'||!input.prompt.length||Buffer.byteLength(input.prompt)>65536||!Number.isSafeInteger(input.deadlineMs)||input.deadlineMs<1000||input.deadlineMs>300000||!Number.isSafeInteger(input.maxOutputBytes)||input.maxOutputBytes<1||input.maxOutputBytes>1024*1024||!Number.isSafeInteger(input.maxOutputTokens)||input.maxOutputTokens<1||input.maxOutputTokens>16384)throw Error('invalid measured session bounds');
 return input;
}
/** Opt-in one-prompt route. Existing resource budgets own attempts; the host must disable discovery/tools and settle abort before returning. */
export async function runMeasuredAgentSession(raw:MeasuredSessionInput,host:MeasuredSessionHost){
 const input=checked(raw),bytes=Buffer.from(input.prompt),budget=openResourceBudget(input.budget),permit=await budget.reserve({...input.attempt,inputBytes:bytes.length,inputDigest:createHash('sha256').update(bytes).digest('hex')});
 const controller=new AbortController(),abort=()=>controller.abort(input.signal?.reason??'operator-cancellation');input.signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort('deadline'),input.deadlineMs);let outcome:'completed'|'failed'|'cancelled'='failed';
 try{
  const result=await host.run({model:input.model,thinkingLevel:input.thinkingLevel,prompt:input.prompt,deadlineMs:input.deadlineMs,maxOutputTokens:input.maxOutputTokens,tools:[],discovery:'factory-only',signal:controller.signal});
  if(result.provider!=='openai-codex'||`${result.provider}/${result.model}`!==input.model)throw Error('measured model identity mismatch');
  if(Buffer.byteLength(result.output)>input.maxOutputBytes)throw Error('measured output bound exceeded');
  const usage=checkedUsage(result.usage);if(controller.signal.aborted)throw Error('measured session settled after cancellation');
  outcome='completed';return freezeWork({version:'measured-session-result-v1',state:'completed',model:input.model,thinkingLevel:input.thinkingLevel,output:result.output,usage,stopReason:result.stopReason,acceptance:'not-assessed',grantExpansion:false});
 }catch(error){if(controller.signal.aborted)outcome='cancelled';throw error;}
 finally{clearTimeout(timer);input.signal?.removeEventListener('abort',abort);await permit.settle(outcome);}
}
/** Concrete SDK host: in-memory session/settings, empty discovery roots, no tools, one factory-named inline extension. */
export function piSdkMeasuredSessionHost():MeasuredSessionHost{return{async run(input){
 const root=await mkdtemp(join(resolve(process.env.TMPDIR??'/tmp'),'pi-daddy-measured-'));let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
 try{
  const agentDir=join(root,'agent');await mkdir(agentDir,{mode:0o700});const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false,maxRetries:0}});
  const loader=new DefaultResourceLoader({cwd:root,agentDir,settingsManager:settings,systemPromptOverride:()=> 'Follow the supplied bounded task. Do not use tools or claim acceptance.',agentsFilesOverride:()=>({agentsFiles:[],diagnostics:[]}),skillsOverride:()=>({skills:[],diagnostics:[]}),promptsOverride:()=>({prompts:[],diagnostics:[]}),extensionFactories:[{name:'pi-daddy-measured-session',factory:()=>{}}]});await loader.reload();
  const runtime=await ModelRuntime.create(),[provider,modelId]=input.model.split('/'),found=runtime.getModel(provider,modelId);if(!found)throw Error('requested measured model unavailable');
  const created=await createAgentSession({cwd:root,agentDir,model:{...found,maxTokens:input.maxOutputTokens},thinkingLevel:input.thinkingLevel,modelRuntime:runtime,resourceLoader:loader,sessionManager:SessionManager.inMemory(root),settingsManager:settings,noTools:'all'});session=created.session;if(created.extensionsResult.errors.length)throw Error('factory-only extension load failed');
  const abort=()=>void session!.abort();input.signal.addEventListener('abort',abort,{once:true});try{await session.prompt(input.prompt,{expandPromptTemplates:false});}finally{input.signal.removeEventListener('abort',abort);}
  const message=[...session.messages].reverse().find(m=>m.role==='assistant');if(!message)throw Error('measured assistant result unavailable');
  return {output:message.content.filter(c=>c.type==='text').map(c=>c.text).join(''),usage:checkedUsage(message.usage as ProviderUsage),provider:'openai-codex',model:modelId as MeasuredSessionHostResult['model'],stopReason:message.stopReason};
 }finally{session?.dispose();await rm(root,{recursive:true,force:true});}
}};}
