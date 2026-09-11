import { readArchiveSource, retainArchiveSource } from './evidence-archive.js';

const SHA=/^[a-f0-9]{64}$/;
export interface LearningLifecycleInput {
 caseManifestId:string; hypothesisManifestId:string; comparisonManifestId:string;
 choiceManifestId:string|null; adoptionManifestId:string|null; rollbackManifestId:string|null;
 outcomeManifestIds:string[]; predecessorManifestId:string|null;
}
export type LearningLifecycleState='awaiting-human-choice'|'decision-recorded'|'adopted-awaiting-outcome'|'rolled-back'|'outcome-observed';
export interface LearningLifecycleView {
 version:'retained-learning-lifecycle-v1'; state:LearningLifecycleState; predecessorManifestId:string|null;
 links:{case:string;hypothesis:string;comparison:string;choice:string|null;adoption:string|null;rollback:string|null;outcomes:string[]};
}
const closed=(value:unknown,names:string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===names.sort().join();
function available(root:string,id:string,parser?:string){
 if(!SHA.test(id))throw Error('invalid retained learning link');
 const source=readArchiveSource(root,id);
 if(source.status!=='available'||source.reference.retention!=='exact'||parser&&source.reference.parser.id!==parser)throw Error('retained learning link unavailable');
 return source;
}
function validate(root:string,input:LearningLifecycleInput,depth=0):LearningLifecycleView {
 if(depth>64)throw Error('learning lifecycle predecessor bound exceeded');
 if(!closed(input,['caseManifestId','hypothesisManifestId','comparisonManifestId','choiceManifestId','adoptionManifestId','rollbackManifestId','outcomeManifestIds','predecessorManifestId'])||!Array.isArray(input.outcomeManifestIds)||input.outcomeManifestIds.length>64||new Set(input.outcomeManifestIds).size!==input.outcomeManifestIds.length)throw Error('invalid bounded learning lifecycle');
 for(const id of [input.caseManifestId,input.hypothesisManifestId,input.comparisonManifestId])available(root,id);
 for(const id of [input.choiceManifestId,input.adoptionManifestId,input.rollbackManifestId,...input.outcomeManifestIds])if(id!==null)available(root,id);
 if(input.adoptionManifestId&&!input.choiceManifestId)throw Error('quality choice required before adoption');
 if(input.rollbackManifestId&&!input.adoptionManifestId)throw Error('adoption required before rollback');
 if(input.outcomeManifestIds.length&&!input.adoptionManifestId)throw Error('adoption required before outcomes');
 if(input.predecessorManifestId){
  const prior=read(root,input.predecessorManifestId,depth+1);
  if(prior.links.case!==input.caseManifestId||prior.links.hypothesis!==input.hypothesisManifestId||prior.links.comparison!==input.comparisonManifestId)throw Error('learning lifecycle identity changed');
 }
 const state:LearningLifecycleState=input.outcomeManifestIds.length?'outcome-observed':input.rollbackManifestId?'rolled-back':input.adoptionManifestId?'adopted-awaiting-outcome':input.choiceManifestId?'decision-recorded':'awaiting-human-choice';
 return {version:'retained-learning-lifecycle-v1',state,predecessorManifestId:input.predecessorManifestId,links:{case:input.caseManifestId,hypothesis:input.hypothesisManifestId,comparison:input.comparisonManifestId,choice:input.choiceManifestId,adoption:input.adoptionManifestId,rollback:input.rollbackManifestId,outcomes:[...input.outcomeManifestIds]}};
}
/** Retains navigation only. Linked artifacts retain their own semantics and authority. */
export function retainLearningLifecycle(root:string,input:LearningLifecycleInput):string {
 const view=validate(root,input);
 return retainArchiveSource(root,{sourceId:`learning-${view.links.comparison.slice(0,24)}`,parser:{id:'learning-lifecycle',version:'1'},retention:'exact',bytes:Buffer.from(JSON.stringify(view))}).manifestId;
}
function read(root:string,manifestId:string,depth:number):LearningLifecycleView {
 if(depth>64)throw Error('learning lifecycle predecessor bound exceeded');
 const source=available(root,manifestId,'learning-lifecycle');let value:unknown;
 try{value=JSON.parse(source.bytes.toString('utf8'));}catch{throw Error('invalid retained learning lifecycle');}
 if(!closed(value,['version','state','predecessorManifestId','links'])||value.version!=='retained-learning-lifecycle-v1'||!closed(value.links,['case','hypothesis','comparison','choice','adoption','rollback','outcomes']))throw Error('invalid retained learning lifecycle');
 const links=value.links as unknown as LearningLifecycleView['links'];
 const rebuilt=validate(root,{caseManifestId:links.case,hypothesisManifestId:links.hypothesis,comparisonManifestId:links.comparison,choiceManifestId:links.choice,adoptionManifestId:links.adoption,rollbackManifestId:links.rollback,outcomeManifestIds:links.outcomes,predecessorManifestId:value.predecessorManifestId as string|null},depth);
 if(rebuilt.state!==value.state||JSON.stringify(rebuilt)!==source.bytes.toString('utf8'))throw Error('retained learning lifecycle changed');
 return Object.freeze({...rebuilt,links:Object.freeze({...rebuilt.links,outcomes:Object.freeze(rebuilt.links.outcomes) as unknown as string[]})});
}
export function readLearningLifecycle(root:string,manifestId:string):LearningLifecycleView{return read(root,manifestId,0);}
