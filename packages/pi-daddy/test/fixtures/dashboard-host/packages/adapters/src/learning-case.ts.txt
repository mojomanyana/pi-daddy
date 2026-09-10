import { createWorkCaseReviewer, createWorkSignalReviewer } from './work-case-review.js';
import { readWorkCandidate } from './work-case-archive.js';
import { readWorkSignalCase } from './work-signal-cases.js';
import { learningCopy } from './learning-journal.js';
export interface LearningCaseReference {version:2|3;batchId:string;manifestId:string;decisionId:string}
/** Reads the actual selected-batch decision writer, not a caller-authored confirmation boolean. */
export function readLearningCase(root:string,input:LearningCaseReference){
 const c=learningCopy(input);if(Object.keys(c).sort().join()!=='batchId,decisionId,manifestId,version'||(c.version!==2&&c.version!==3))throw Error('explicit selected case reference required');
 const review=c.version===3?createWorkSignalReviewer(root,c.batchId,'learning-reader'):createWorkCaseReviewer(root,c.batchId,'learning-reader');
 const current=review.history(c.manifestId).at(-1)??null;
 const candidate=c.version===3?readWorkSignalCase(root,c.manifestId).candidate:readWorkCandidate(root,c.manifestId);
 return {candidate,current,matched:current?.id===c.decisionId};
}
