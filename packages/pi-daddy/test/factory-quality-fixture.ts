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
export async function fixture() {
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
