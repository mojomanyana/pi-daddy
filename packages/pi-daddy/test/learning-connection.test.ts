import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { declareWork } from "../src/products/work-command.ts";
import { bindLearningConnection, loadLearningConnection, learningScopeDigest, bindLearningAdoption, type LearningHarness, type LearningWorkspace } from "../src/products/learning-connection.ts";
after(cleanupTempDirs);
const d=(char:string)=>char.repeat(64);

test("learning reconnect binds raw P01 snapshot plus exact archive/population/author, never inferred fixed-order scope",async()=>{
  const cwd=await tempDir("learning-connect-"),state=await declareWork({cwd,id:"page",outcome:"Read the page"});
  let configuration={archiveRoot:join(cwd,"archive"),scopeDigest:state.selectedSnapshot.snapshot.digest,population:"work:page",author:"local-operator"};
  // Boundary fixture, not evidence of real calibration or a loaded peer implementation.
  const harness={openLearningWorkspace:()=>({configuration:()=>({...configuration})})} as unknown as LearningHarness;
  assert.equal(learningScopeDigest(state),state.selectedSnapshot.snapshot.digest);
  const connection=await bindLearningConnection(cwd,state,join(cwd,"workspace"),harness,"local-operator");
  assert.equal((await loadLearningConnection(cwd,state,harness,"local-operator"))?.connection.directory,connection.directory);
  configuration={...configuration,population:"other"};await assert.rejects(loadLearningConnection(cwd,state,harness,"local-operator"),/mismatch/);
  configuration={...configuration,population:"work:page"};await assert.rejects(loadLearningConnection(cwd,{...state,selectedSnapshot:{...state.selectedSnapshot,snapshot:{...state.selectedSnapshot.snapshot,digest:d("a")}}},harness,"local-operator"),/stale/);
});

test("adoption authoring uses only selected public readback, then links the binding without producing authority",()=>{
  let linked:unknown,choice="one",decision="adopt",candidate=d("c"),caseReference:unknown={fixture:"original-case"};
  const workspace={configuration:()=>({scopeDigest:d("a")}),comparisonContext:()=>({caseReference,hypothesisManifestId:d("f"),adoptionBinding:null}),hypotheses:()=>[{name:"origin:trial",manifestId:d("f"),hypothesis:{id:d("b")}}],decisionStatus:()=>({current:{disposition:decision}}),reveal:()=>({manifestId:d("e"),choice:{kind:choice,labels:["opaque-A"]},arms:[{label:"opaque-A",configuration:{configuration:candidate}}]}),linkComparisonContext:(_name:string,context:unknown)=>{linked=context;}} as unknown as LearningWorkspace;
  const input={candidateDigest:d("c"),rollbackCandidateDigest:d("d"),assessmentPolicyDigest:d("f"),expiresAt:10000};
  const binding=bindLearningAdoption(workspace,"trial",input);
  assert.equal(binding.experimentDigest,d("e"));assert.equal(binding.hypothesisDigest,d("b"));assert.equal(binding.scopeDigest,d("a"));assert.equal(binding.activationBoundary,"next-orders");
  assert.deepEqual((linked as {adoptionBinding:unknown}).adoptionBinding,binding);assert.ok(!("authority" in binding));
  linked=null;candidate=d("d");assert.throws(()=>bindLearningAdoption(workspace,"trial",input),/exact configuration/);assert.equal(linked,null);
  candidate=d("c");choice="insufficient";assert.throws(()=>bindLearningAdoption(workspace,"trial",input),/exact configuration/);
  choice="one";decision="defer";assert.throws(()=>bindLearningAdoption(workspace,"trial",input),/explicit adopt intent/);
  decision="adopt";caseReference=null;assert.throws(()=>bindLearningAdoption(workspace,"trial",input),/original confirmed case/);
});
