import { calibratePredictions, recommendExposure, type CalibrationComponent, type CalibrationPrediction, type CalibrationOutcome, type ExposurePolicy } from '@skill-harness/core';
import { isAbsolute } from 'node:path';
import { readArchiveSource } from './evidence-archive.js';
import { learningCopy, learningHash, learningJournal, registerLearningStore, verifyLearningStore } from './learning-journal.js';
import { readLearningCase, type LearningCaseReference } from './learning-case.js';
export interface TrustLifecycleInput {archiveRoot:string;component:CalibrationComponent;seed:string;maxUnflagged:number;cohort:{incidentId:string;manifestId:string;flagged:boolean;split:'calibration'|'heldout'|'tuning'}[];exposure:ExposurePolicy|null}
export interface TrustReferenceOutcome {kind:'prediction'|'unflagged';targetId:string;value:boolean;evidenceManifestId:string;referenceId:string}
export const trustPolicyDigest=(input:TrustLifecycleInput)=>learningHash({version:'trust-lifecycle-v1',input});
export const trustOutcomeDigest=(outcome:TrustReferenceOutcome)=>learningHash({version:'trust-reference-v1',outcome});
function evidence(root:string,id:string){const result=readArchiveSource(root,id);if(result.status!=='available'||!['exact','redacted'].includes(result.reference.retention))throw Error('independent retained evidence unavailable');return result;}
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\u0000-\u001f\u007f]/.test(v);
function validate(input:TrustLifecycleInput){
 if(!isAbsolute(input.archiveRoot)||Object.keys(input).sort().join()!=='archiveRoot,cohort,component,exposure,maxUnflagged,seed'||!/^([a-f0-9]{64})$/.test(input.seed)||!Number.isSafeInteger(input.maxUnflagged)||input.maxUnflagged<0||input.maxUnflagged>32||!Array.isArray(input.cohort)||!input.cohort.length||input.cohort.length>1024||new Set(input.cohort.map(c=>c.incidentId)).size!==input.cohort.length)throw Error('invalid frozen trust cohort');
 for(const c of input.cohort){if(Object.keys(c).sort().join()!=='flagged,incidentId,manifestId,split'||!text(c.incidentId)||typeof c.flagged!=='boolean'||!['calibration','heldout','tuning'].includes(c.split))throw Error('invalid cohort row');evidence(input.archiveRoot,c.manifestId);}
 const dummy:CalibrationPrediction={id:'validation',incidentId:'validation',component:input.component,kind:input.component.kind==='detector'?'positive':'approval',split:'calibration'};calibratePredictions([dummy]);
 if(input.exposure){if(learningHash(input.exposure.component)!==learningHash(input.component))throw Error('policy component scope mismatch');const report=calibratePredictions([{...dummy,kind:input.exposure.kind,split:input.exposure.split}]).reports[0];recommendExposure(report,input.exposure,0);}
}
export function createTrustLifecycle(directory:string,input:TrustLifecycleInput,authorizedPolicyDigests:readonly string[]){
 const safe=learningCopy(input);validate(safe);const policyId=trustPolicyDigest(safe);if(!authorizedPolicyDigests.includes(policyId))throw Error('independent predeclared policy authority required');
 const sampledIncidentIds=safe.cohort.filter(c=>!c.flagged&&c.split!=='tuning').sort((a,b)=>learningHash([safe.seed,a.incidentId]).localeCompare(learningHash([safe.seed,b.incidentId]))).slice(0,safe.maxUnflagged).map(c=>c.incidentId);
 const initial={type:'initial',kind:'trust-lifecycle-v1',input:safe,policyId,sampledIncidentIds};
 registerLearningStore(safe.archiveRoot,'trust',policyId,directory,learningHash(initial));
 try{learningJournal(directory,initial);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const old=learningJournal(directory).read()[0].value;if(learningHash(old)!==learningHash(initial))throw Error('trust policy already predeclared');}
 return openTrustLifecycle(directory);
}
/** Existing calibration is recomputed from durable scoped predictions and independently permitted
 * retained labels. Applied exposure is an attention reservation, not proof a human saw a question. */
export function openTrustLifecycle(directory:string){
 const journal=learningJournal(directory),initial=journal.read()[0].value;if(initial.kind!=='trust-lifecycle-v1'||initial.type!=='initial')throw Error('wrong trust journal');
 const input=initial.input as unknown as TrustLifecycleInput,sampledIncidentIds=initial.sampledIncidentIds as string[];validate(input);
 const replay=()=>{verifyLearningStore(input.archiveRoot,'trust',String(initial.policyId),directory,learningHash(initial));const history=journal.read(),predictions=new Map<string,CalibrationPrediction>(),allIds=new Set<string>(),outcomes=new Map<string,TrustReferenceOutcome>(),caseLinks=new Map<string,LearningCaseReference>(),exposures=new Map<string,{mode:'ask'|'silent'|'retire';reason:string}>();let retired=false,lastExposureAt=0;
  for(const {value:v} of history.slice(1)){
   if(v.type==='prediction'||v.type==='correction'){
    const p=v.prediction as CalibrationPrediction;calibratePredictions([p]);if(allIds.has(p.id))throw Error('duplicate prediction identity');
    const c=input.cohort.find(c=>c.incidentId===p.incidentId);if(!c?.flagged||c.split!==p.split||learningHash(p.component)!==learningHash(input.component))throw Error('prediction scope mismatch');
    if(v.type==='correction'){const old=predictions.get(String(v.prior));if(!old||old.incidentId!==p.incidentId)throw Error('stale prediction correction');predictions.delete(String(v.prior));}
    predictions.set(p.id,p);allIds.add(p.id);
   }else if(v.type==='outcome'){const r=v.outcome as TrustReferenceOutcome;if(outcomes.has(r.referenceId))throw Error('duplicate reference identity');outcomes.set(r.referenceId,r);if(v.caseReference)caseLinks.set(r.referenceId,v.caseReference as unknown as LearningCaseReference);}
   else if(v.type==='exposure'){const id=String(v.id),result=v.result as {mode:'ask'|'silent'|'retire';reason:string};if(typeof v.now!=='number'||!Number.isFinite(v.now)||v.now<lastExposureAt||exposures.has(id)||!['ask','silent','retire'].includes(result.mode))throw Error('invalid exposure history');lastExposureAt=v.now;exposures.set(id,result);retired ||= result.mode==='retire';}
   else throw Error('unknown trust history event');
  }
  return {history,predictions,allIds,outcomes,caseLinks,exposures,retired,lastExposureAt,tip:history.at(-1)!.id};
 };
 replay();
 const inspect=(now:number)=>{if(!Number.isFinite(now)||now<0)throw Error('valid policy clock required');const s=replay(),labels:CalibrationOutcome[]=[];
  for(const r of s.outcomes.values()){evidence(input.archiveRoot,r.evidenceManifestId);const p=s.predictions.get(r.targetId),link=s.caseLinks.get(r.referenceId);if(link&&!readLearningCase(input.archiveRoot,link).matched)continue;if(r.kind==='prediction'&&p)labels.push({...p,id:r.referenceId,correct:r.value});}
  for(const p of s.predictions.values())evidence(input.archiveRoot,input.cohort.find(c=>c.incidentId===p.incidentId)!.manifestId);
  const calibration=calibratePredictions([...s.predictions.values()],{outcomes:labels});let misses=0,resolved=0,conflicted=0;
  for(const id of sampledIncidentIds){evidence(input.archiveRoot,input.cohort.find(c=>c.incidentId===id)!.manifestId);const values=new Set([...s.outcomes.values()].filter(r=>r.kind==='unflagged'&&r.targetId===id).map(r=>r.value));if(values.size===1){resolved++;if(values.has(true))misses++;}else if(values.size>1)conflicted++;}
  return {policyId:String(initial.policyId),component:learningCopy(input.component),calibration,sampledIncidentIds:[...sampledIncidentIds],unflagged:{sampled:sampledIncidentIds.length,resolved,misses,unresolved:sampledIncidentIds.length-resolved,conflicted},attentionUsed:[...s.exposures.values()].filter(e=>e.mode==='ask').length,retired:s.retired,exposures:[...s.exposures].map(([id,result])=>({id,...result})),tip:s.tip,grantExpansion:false as const};
 };
 const prediction=(p:CalibrationPrediction)=>{const copy=learningCopy(p);calibratePredictions([copy]);const row=input.cohort.find(c=>c.incidentId===copy.incidentId);if(!row?.flagged||row.split!==copy.split||learningHash(copy.component)!==learningHash(input.component))throw Error('prediction scope mismatch');evidence(input.archiveRoot,row.manifestId);return copy;};
 const previewCaseOutcome=(predictionId:string,reference:LearningCaseReference)=>{const ref=learningCopy(reference),s=replay(),p=s.predictions.get(predictionId),row=p&&input.cohort.find(c=>c.incidentId===p.incidentId),resolved=readLearningCase(input.archiveRoot,ref);
  if(!p||p.kind!=='positive'||row?.manifestId!==ref.manifestId||!resolved.matched||!['confirmed_defect','expected_behavior'].includes(resolved.current!.disposition)||learningHash(resolved.candidate.detector)!==learningHash({id:p.component.id,version:p.component.version,population:p.component.population}))throw Error('current independent case outcome scope required');
  const outcome:TrustReferenceOutcome={kind:'prediction',targetId:p.id,value:resolved.current!.disposition==='confirmed_defect',evidenceManifestId:ref.manifestId,referenceId:ref.decisionId};return {outcome,caseReference:ref,digest:learningHash({outcome,caseReference:ref}),tip:s.tip};
 };
 return {inspect,history:()=>journal.read(),previewCaseOutcome,
  linkCaseOutcome(predictionId:string,reference:LearningCaseReference,authorizedDigests:readonly string[]){const preview=previewCaseOutcome(predictionId,reference);if(!authorizedDigests.includes(preview.digest))throw Error('independent exact reference authority required');const s=replay();if(s.tip!==preview.tip)throw Error('stale case outcome snapshot');const old=s.outcomes.get(preview.outcome.referenceId);if(old){if(trustOutcomeDigest(old)!==trustOutcomeDigest(preview.outcome)||learningHash(s.caseLinks.get(old.referenceId)??null)!==learningHash(reference))throw Error('reference identity conflict');return;}
   journal.append(s.tip,{type:'outcome',outcome:preview.outcome,caseReference:preview.caseReference,authorityDigest:preview.digest});},
  predict(p:CalibrationPrediction){const safe=prediction(p),s=replay();if(s.allIds.has(safe.id)){if(learningHash(s.predictions.get(safe.id)??null)!==learningHash(safe))throw Error('prediction identity conflict');return;}journal.append(s.tip,{type:'prediction',prediction:safe});},
  correct(prior:string,p:CalibrationPrediction,reason:string){const safe=prediction(p),s=replay(),old=s.predictions.get(prior);if(!old||old.incidentId!==safe.incidentId||s.allIds.has(safe.id)||!text(reason))throw Error('stale or invalid prediction correction');journal.append(s.tip,{type:'correction',prior,prediction:safe,reason});},
  outcome(value:TrustReferenceOutcome,authorizedReferenceDigests:readonly string[]){const r=learningCopy(value);if(Object.keys(r).sort().join()!=='evidenceManifestId,kind,referenceId,targetId,value'||!['prediction','unflagged'].includes(r.kind)||!text(r.targetId)||!text(r.referenceId)||typeof r.value!=='boolean')throw Error('invalid reference outcome');const digest=trustOutcomeDigest(r);if(!authorizedReferenceDigests.includes(digest))throw Error('independent exact reference authority required');evidence(input.archiveRoot,r.evidenceManifestId);
   const s=replay();if(r.kind==='prediction'?!s.predictions.has(r.targetId):!sampledIncidentIds.includes(r.targetId))throw Error('outcome outside current prediction or frozen sample');
   const old=s.outcomes.get(r.referenceId);if(old){if(trustOutcomeDigest(old)!==digest)throw Error('reference identity conflict');return;}journal.append(s.tip,{type:'outcome',outcome:r,authorityDigest:digest});},
  expose(id:string,now:number){if(!text(id))throw Error('exposure identity required');const s=replay(),existing=s.exposures.get(id);if(existing)return {...learningCopy(existing),replayed:true};if(now<s.lastExposureAt)throw Error('policy clock moved backwards');const view=inspect(now);if(view.tip!==s.tip)throw Error('stale exposure snapshot');
   const policy=input.exposure?{...input.exposure,attentionRemaining:Math.max(0,input.exposure.attentionRemaining-view.attentionUsed)}:null;
   const report=view.calibration.reports.find(r=>policy&&r.kind===policy.kind&&r.split===policy.split);
   const result=s.retired?{mode:'retire' as const,reason:'previously-retired'}:report?recommendExposure(report,policy,now):{mode:'silent' as const,reason:policy?'insufficient-independent-evidence':'policy-unavailable'};
   journal.append(s.tip,{type:'exposure',id,now,result,policyId:initial.policyId,evidenceTip:s.tip});return {...learningCopy(result),replayed:false};
  }
 };
}
