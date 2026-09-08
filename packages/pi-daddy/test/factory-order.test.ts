import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmod, readFile, writeFile, appendFile, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import { createExperimentBudget, openResourceBudget } from "../src/resource-budget.ts";
import { experimentCancellationDigest } from "../src/experiment-contract.ts";
import { prepareDigestProfile } from "../src/effect-profile.ts";
import { byteHash, experimentHash } from "../src/experiment-contract.ts";
import { buildWorkRevisionEvent, buildWorkSnapshotEvent } from "../src/work-ledger.ts";
import { fixtureRevisionRef as ref, fixtureEventRef as er, fixtureText } from "./work-ledger-fixtures.ts";
import { intentWorld } from "./intent-control-fixture.ts";
import { bindWorkIntent } from "../src/intent-application.ts";
import { createFactoryRegistry, createFactoryOrder, openFactoryOrder, openFactoryRegistry, factoryOrderDigest, fixedPolicyDigest, factoryDecisionDigest, activationRequestDigest,
  migrateFactoryOrder, factoryMigrationDigest, parseFactoryOrder, type FactoryOrderCharter, type FactoryAuthority } from "../src/factory-order.ts";
import { buildAdoptionBinding, authorizeAdoption, buildRollbackRequest } from "../src/vendor/adoption.ts";
const authorityId = "fixture-operator", now = Date.now();
async function fixture() {
  const root = await tempDir("p15-order-"); await chmod(root, 0o700); const w = intentWorld();
  const scope = w.initial[0] as ReturnType<typeof buildWorkRevisionEvent>, policy = w.initial[1] as typeof scope, goal = w.initial[2] as typeof scope;
  const { digest: ignored, ...baseRevision } = w.obligations[0].payload.revision;
  const obligations = [0,1,2,3].map(i => buildWorkRevisionEvent({ eventId: "order:obligation:"+i, now: new Date("2026-09-08T00:00:00Z"), revision: { ...JSON.parse(JSON.stringify(baseRevision)), id: "order-obligation-"+i } }));
  const snapshot = buildWorkSnapshotEvent({ eventId: "order:snapshot", now: new Date("2026-09-08T00:00:00Z"), snapshot: { snapshotId: "order-snapshot", scope: ref(scope), revisions: [policy,goal,...obligations].map(ref), bindings: obligations.map(o=>({intent:ref(goal),obligation:ref(o),artifact:null,policy:ref(policy)})) } });
  const text = fixtureText([scope,policy,goal,...obligations,snapshot]), path = join(root,"work.jsonl"); await writeFile(path,text,{mode:0o600});
  const work = await bindWorkIntent({ path, grantLedgerPath:null, selection:{snapshot:{id:snapshot.payload.snapshot.snapshotId,digest:snapshot.payload.snapshot.digest},event:er(snapshot)},priorities:obligations.map((o,rank)=>({obligation:ref(o),rank})) });
  const baseline = { version:"fixed-policy-v1" as const, suffixBase64:"", acceptancePolicyDigest:"b".repeat(64), grants:[], effects:["fixed-digest" as const], model:null,effort:null,skills:[] };
  const registry = await createFactoryRegistry({directory:join(root,"registry"),authorityId,scopeDigest:experimentHash(work.selection.snapshot),baseline});
  const budget = await createExperimentBudget({directory:join(root,"budget"),authorityDigest:"a".repeat(64),limits:{maxAttempts:32,maxInputBytes:65536,maxConcurrent:32}});
  const charter: FactoryOrderCharter = { version:"factory-order-v1",orderId:"order:one",directory:join(root,"order"),budget,work,workTextDigest:byteHash(text),scopeDigest:experimentHash(work.selection.snapshot),commonBase64:Buffer.from("common").toString("base64"),deadlineMs:10000,pin:{revision:0,candidateDigest:fixedPolicyDigest(baseline)},nodes:obligations.map((o,i)=>({nodeId:"node:"+i,obligation:ref(o),dependencies:i===2?["node:0"]:i===3?["node:1"]:[],attempts:Array.from({length:i===0?2:1},(_,n)=>({executionId:`order:one:${i}:${n}`,suffixBase64:Buffer.from(String(i)).toString("base64"),operation:"digest" as const})),expectedDigest:i===0?"f".repeat(64):byteHash("common"+i),decision:i===1?{decisionId:"product-choice",authorityId}:null})) };
  const authority: FactoryAuthority = {id:authorityId,orderDigests:[factoryOrderDigest(charter)],decisionDigests:[],activationDigests:[],migrationDigests:[],adoption:null,facts:[]};
  return {root,registry,budget,charter,authority,baseline};
}

test("pinned adoption source and strict factory parser keep fixture declarations distinct from authority",async()=>{
  assert.equal(byteHash(await readFile(new URL("../src/vendor/adoption.ts",import.meta.url))),"dd3adae2c8283620ffc12d52baa570ba802ca96e208b0209520295a6979e9d02");
  const f=await fixture(),text=JSON.stringify(f.charter);assert.equal(factoryOrderDigest(parseFactoryOrder(text)),factoryOrderDigest(f.charter));
  await assert.rejects(async()=>parseFactoryOrder(text.replace('"version":"factory-order-v1"','"version":"factory-order-v1","version":"factory-order-v1"')),/duplicate/i);
  const unsupported=JSON.parse(text);unsupported.nodes[0].attempts[0].operation="model";
  await assert.rejects(createFactoryOrder(f.registry,unsupported,{...f.authority,orderDigests:[factoryOrderDigest(unsupported)]}),/configuration/);
  assert.equal((await openResourceBudget(f.budget).inspect()).attempts,0);
});

test("bounded multi-node order progresses independently, exhausts recovery and returns a reserved decision",async()=>{
  const f=await fixture(); await createFactoryOrder(f.registry,f.charter,f.authority);
  const c=await openFactoryOrder(f.registry,f.charter.orderId,f.authority);
  const before=await c.inspect(); assert.deepEqual(before.nodes.filter(n=>n.action==="dispatch").map(n=>n.nodeId),["node:0","node:1"]);
  const run=await c.advance(await prepareDigestProfile(f.budget)); const view=await run.boundary;
  assert.equal(view.nodes[0].state,"exhausted"); assert.equal(view.nodes[1].state,"decision-required"); assert.equal(view.nodes[2].state,"dependency-blocked");
  assert.equal((await openResourceBudget(f.budget).inspect()).attempts,5);
  const decision={version:"factory-decision-v1" as const,requestId:"decision:one",bindingDigest:c.bindingDigest,nodeId:"node:1",evidenceDigest:view.nodes[1].evidenceDigest!,authorityId,choice:"approve" as const};
  await assert.rejects(c.decide(decision,f.authority),/authority/);
  await c.decide(decision,{...f.authority,decisionDigests:[factoryDecisionDigest(decision)]});
  const done=await run.completion; assert.equal(done.nodes[3].state,"satisfied"); assert.equal(done.nodes[0].state,"exhausted");
  assert.equal(done.acceptance,"not-assessed"); assert.equal((await openResourceBudget(f.budget).inspect()).active,0);
  const old=await readFile(join(f.charter.directory,"experiment.jsonl"));
  await c.decide(decision,{...f.authority,decisionDigests:[factoryDecisionDigest(decision)]});
  const restarted=await openFactoryOrder(f.registry,f.charter.orderId,f.authority); await (await restarted.advance(await prepareDigestProfile(f.budget))).completion;
  assert.deepEqual(await readFile(join(f.charter.directory,"experiment.jsonl")),old);
});

test("default authority, changed scope and cyclic/unsupported charters refuse before extra launches",async()=>{
  const f=await fixture(); await assert.rejects(createFactoryOrder(f.registry,f.charter,null),/authority/);
  const bad=JSON.parse(JSON.stringify(f.charter)); bad.nodes[0].dependencies=["node:2"];
  await assert.rejects(createFactoryOrder(f.registry,bad,{...f.authority,orderDigests:[factoryOrderDigest(bad)]}),/cycle/);
  const changed={...f.charter,scopeDigest:"c".repeat(64)};
  await assert.rejects(createFactoryOrder(f.registry,changed,{...f.authority,orderDigests:[factoryOrderDigest(changed)]}),/scope/);
  assert.equal((await openResourceBudget(f.budget).inspect()).attempts,0);
});

test("actual activation validates pinned predicates and only subsequent matching orders change",async()=>{
  const f=await fixture(); await createFactoryOrder(f.registry,f.charter,f.authority);
  const candidate={...f.baseline,suffixBase64:Buffer.from("new").toString("base64")};
  const binding=buildAdoptionBinding({hypothesisDigest:"1".repeat(64),experimentDigest:"2".repeat(64),candidateDigest:fixedPolicyDigest(candidate),scopeDigest:f.charter.scopeDigest,assessmentPolicyDigest:candidate.acceptancePolicyDigest,rollbackCandidateDigest:fixedPolicyDigest(f.baseline),activationBoundary:"next-orders",expiresAt:now+600000});
  const adoption={id:authorityId,adoptions:[binding.id],rollbacks:[]}; const facts={experimentDigest:binding.experimentDigest,candidateDigest:binding.candidateDigest,scopeDigest:binding.scopeDigest,assessmentPolicyDigest:binding.assessmentPolicyDigest,eligible:true};
  const receipt=authorizeAdoption(binding,adoption,facts,Date.now()), request={version:"factory-activation-v1" as const,requestId:"activate:one",expectedRevision:0,expectedCandidateDigest:fixedPolicyDigest(f.baseline),candidate,binding,receipt};
  const authority={...f.authority,adoption,facts:[{bindingId:binding.id,facts}],activationDigests:[activationRequestDigest(request)]};
  const registry=openFactoryRegistry(f.registry);
  await assert.rejects(registry.activate(request,null),/authority/);
  const forged=JSON.parse(JSON.stringify(request));forged.receipt.grantExpansion=true;
  await assert.rejects(registry.activate(forged,{...authority,activationDigests:[activationRequestDigest(forged)]}),/receipt/);
  const {version:ignoredVersion,id:ignoredId,...expiredInput}=binding, expiredBinding=buildAdoptionBinding({...expiredInput,expiresAt:Date.now()-1});
  const expiredAuthority={...authority,adoption:{...adoption,adoptions:[expiredBinding.id]},facts:[{bindingId:expiredBinding.id,facts}]};
  const expiredRequest={...request,requestId:"expired",binding:expiredBinding,receipt:authorizeAdoption(expiredBinding,expiredAuthority.adoption,facts,0)};
  await assert.rejects(registry.activate(expiredRequest,{...expiredAuthority,activationDigests:[activationRequestDigest(expiredRequest)]}),/expired/);
  const changedScope={...request,requestId:"changed-scope",binding:{...binding,scopeDigest:"c".repeat(64)}};
  await assert.rejects(registry.activate(changedScope,{...authority,activationDigests:[activationRequestDigest(changedScope)]}),/scope/);
  await registry.activate(request,authority); await registry.activate(request,authority);
  assert.equal((await registry.inspect()).revision,1);
  const old=await openFactoryOrder(f.registry,f.charter.orderId,f.authority);assert.equal(old.pin.candidateDigest,f.charter.pin.candidateDigest);
  const oldRun=await old.advance(await prepareDigestProfile(f.budget)), oldBoundary=await oldRun.boundary;
  assert.equal(JSON.parse(Buffer.from(await old.readArtifact("order:one:1:0")).toString()).digest,byteHash("common1"));
  const decline={version:"factory-decision-v1" as const,requestId:"decline-old",bindingDigest:old.bindingDigest,nodeId:"node:1",evidenceDigest:oldBoundary.nodes[1].evidenceDigest!,authorityId,choice:"reject" as const};
  await old.decide(decline,{...f.authority,decisionDigests:[factoryDecisionDigest(decline)]});await oldRun.completion;
  const next:FactoryOrderCharter={...f.charter,orderId:"order:two",directory:join(f.root,"order-two"),pin:{revision:1,candidateDigest:fixedPolicyDigest(candidate)},nodes:f.charter.nodes.map(n=>({...n,decision:null,dependencies:[],expectedDigest:byteHash("commonnew"+n.nodeId.slice(-1)),attempts:n.attempts.map((a,i)=>({...a,executionId:"next:"+n.nodeId+":"+i}))}))};
  const nextAuthority={...authority,orderDigests:[factoryOrderDigest(next)]}; await createFactoryOrder(f.registry,next,nextAuthority);
  const c=await openFactoryOrder(f.registry,next.orderId,nextAuthority), run=await c.advance(await prepareDigestProfile(f.budget));
  assert.ok((await run.completion).nodes.every(n=>n.state==="satisfied"));
  await assert.rejects(registry.activate({...request,requestId:"stale"},{...authority,activationDigests:[activationRequestDigest({...request,requestId:"stale"})]}),/stale/);
  const rollback=buildRollbackRequest(receipt,"operator-request",["d".repeat(64)],Date.now()+60000);
  await registry.rollback(rollback,{...authority,adoption:{...adoption,rollbacks:[rollback.id]}});
  assert.equal((await registry.inspect()).candidateDigest,f.charter.pin.candidateDigest);assert.equal((await registry.inspect()).revision,2);
});

test("unknown artifact branch pauses while an independent authorized branch continues",async()=>{
  const f=await fixture();await createFactoryOrder(f.registry,f.charter,f.authority);const c=await openFactoryOrder(f.registry,f.charter.orderId,f.authority),run=await c.advance(await prepareDigestProfile(f.budget)),view=await run.boundary;
  const path=join(f.charter.directory,"variant-"+byteHash("order:one:0:0"),"result.json");await rename(path,path+".preserved");assert.equal((await c.inspect()).nodes[0].state,"unknown");
  const request={version:"factory-decision-v1" as const,requestId:"decision-independent",bindingDigest:c.bindingDigest,nodeId:"node:1",evidenceDigest:view.nodes[1].evidenceDigest!,authorityId,choice:"approve" as const};
  const stale={...request,evidenceDigest:"0".repeat(64)};await assert.rejects(c.decide(stale,{...f.authority,decisionDigests:[factoryDecisionDigest(stale)]}),/stale/);
  await c.decide(request,{...f.authority,decisionDigests:[factoryDecisionDigest(request)]});const done=await run.completion;assert.equal(done.nodes[0].state,"unknown");assert.equal(done.nodes[3].state,"satisfied");
});

test("factory cancellation uses the original running controller handle and no model transport",async()=>{
  const f=await fixture(),charter:FactoryOrderCharter={...f.charter,nodes:f.charter.nodes.map((n,i)=>i===0?{...n,attempts:n.attempts.map((a,j)=>j===0?{...a,operation:"hold"}:a)}:n)};
  const authority={...f.authority,orderDigests:[factoryOrderDigest(charter)]};await createFactoryOrder(f.registry,charter,authority);
  const c=await openFactoryOrder(f.registry,charter.orderId,authority),run=await c.advance(await prepareDigestProfile(f.budget));assert.equal(await run.started[0],"spawned");
  const cancel={version:"experiment-cancel-v1" as const,requestId:"factory-cancel",bindingDigest:c.bindingDigest,executionId:"order:one:0:0"};
  await assert.rejects(c.cancel(cancel,authority),/authority/);await c.cancel(cancel,{...authority,cancellationDigests:[experimentCancellationDigest(cancel)]});
  const view=await run.boundary,request={version:"factory-decision-v1" as const,requestId:"decline-after-cancel",bindingDigest:c.bindingDigest,nodeId:"node:1",evidenceDigest:view.nodes[1].evidenceDigest!,authorityId,choice:"reject" as const};
  await c.decide(request,{...authority,decisionDigests:[factoryDecisionDigest(request)]});await run.completion;
  const result=JSON.parse(Buffer.from(await c.readArtifact("order:one:0:0")).toString());assert.equal(result.output.aborted,true);assert.ok(result.output.signal);assert.equal((await openResourceBudget(f.budget).inspect()).active,0);
});

test("lost materialization acknowledgement is read back, never rematerialized or relaunched",async()=>{
  const f=await fixture(),handle=await open(join(f.root,"sync-probe"),"wx"),proto=Object.getPrototypeOf(handle),original=proto.sync;let hit=false;
  proto.sync=async function(){await original.call(this);const st=await this.stat({bigint:true});if(!hit&&String(st.ino)===f.registry.journalInode&&(await readFile(join(f.registry.directory,"control.jsonl"),"utf8")).includes('"order-materialized"')){hit=true;throw new Error("lost acknowledgement");}};
  try{await assert.rejects(createFactoryOrder(f.registry,f.charter,f.authority),/lost acknowledgement/);}finally{proto.sync=original;await handle.close();}
  assert.equal(hit,true);const before=await readFile(join(f.registry.directory,"control.jsonl"));const b=await createFactoryOrder(f.registry,f.charter,f.authority);assert.equal(b.directory,f.charter.directory);assert.deepEqual(await readFile(join(f.registry.directory,"control.jsonl")),before);assert.equal((await openResourceBudget(f.budget).inspect()).attempts,0);
  await rename(join(f.charter.directory,"experiment.jsonl"),join(f.charter.directory,"experiment.preserved"));await assert.rejects(openFactoryOrder(f.registry,f.charter.orderId,f.authority),/ENOENT/);
});

test("explicit unstarted migration supersedes only the original order and renews all obligations",async()=>{
  const f=await fixture();await createFactoryOrder(f.registry,f.charter,f.authority);
  const successor:FactoryOrderCharter={...f.charter,orderId:"order:successor",directory:join(f.root,"successor"),nodes:f.charter.nodes.map(n=>({...n,decision:null,attempts:n.attempts.map((a,i)=>({...a,executionId:"successor:"+n.nodeId+":"+i}))}))};
  const request={version:"factory-migration-v1" as const,requestId:"migration:one",sourceOrderId:f.charter.orderId,successor};
  const authority={...f.authority,orderDigests:[...f.authority.orderDigests,factoryOrderDigest(successor)],migrationDigests:[factoryMigrationDigest(request)]};
  await assert.rejects(migrateFactoryOrder(f.registry,request,f.authority),/authority/);
  assert.equal((await migrateFactoryOrder(f.registry,request,authority)).application,"applied");
  assert.equal((await migrateFactoryOrder(f.registry,request,authority)).application,"applied");
  const old=await openFactoryOrder(f.registry,f.charter.orderId,authority);assert.equal((await old.inspect()).superseded,true);await assert.rejects(old.advance(await prepareDigestProfile(f.budget)),/migrated/);
  const next=await openFactoryOrder(f.registry,successor.orderId,authority);await (await next.advance(await prepareDigestProfile(f.budget))).completion;
  const active={...request,requestId:"migration:active",sourceOrderId:successor.orderId,successor:{...successor,orderId:"order:third",directory:join(f.root,"third")}};
  const activeAuthority={...authority,orderDigests:[...authority.orderDigests,factoryOrderDigest(active.successor)],migrationDigests:[factoryMigrationDigest(active)]};
  assert.equal((await migrateFactoryOrder(f.registry,active,activeAuthority)).application,"refused-active");
});

test("missing/torn control data is unknown or refused, never an invitation to relaunch",async()=>{
  const f=await fixture();await createFactoryOrder(f.registry,f.charter,f.authority);
  const supplied=JSON.parse(JSON.stringify(f.registry)), reader=openFactoryRegistry(supplied);supplied.initial.baseline.suffixBase64="Y2hhbmdlZA==";
  assert.equal((await reader.inspect()).candidateDigest,f.charter.pin.candidateDigest);
  const c=await openFactoryOrder(f.registry,f.charter.orderId,null);const before=await readFile(join(f.registry.directory,"control.jsonl"));
  await c.inspect();assert.deepEqual(await readFile(join(f.registry.directory,"control.jsonl")),before);
  await assert.rejects(c.advance(await prepareDigestProfile(f.budget)),/authority/);
  await appendFile(join(f.registry.directory,"control.jsonl"),"{");await assert.rejects(openFactoryRegistry(f.registry).inspect(),/torn/);
  assert.equal((await openResourceBudget(f.budget).inspect()).attempts,0);
});
