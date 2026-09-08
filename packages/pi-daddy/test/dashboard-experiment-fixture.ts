import { join } from "node:path";
import { createExperimentBudget, resourceBindingDigest } from "../src/resource-budget.ts";
import { createExperiment, openExperiment, experimentCharterDigest, type ExperimentCharter } from "../src/experiment.ts";
import { DIGEST_PROFILE } from "../src/effect-profile.ts";
import { hash } from "./debrief-durable-fixture.ts";
export async function hostExperiment(root:string){
 const bytes=Buffer.from("common"),authorityDigest="a".repeat(64),budget=await createExperimentBudget({directory:join(root,"experiment-budget"),authorityDigest,limits:{maxAttempts:2,maxInputBytes:64,maxConcurrent:2}});
 const charter:ExperimentCharter={version:"fixed-experiment-v1",experimentId:"host-experiment",orderId:"host-order",budgetDigest:resourceBindingDigest(budget),profile:DIGEST_PROFILE,common:{sha256:hash(bytes),bytes:bytes.length,work:null,workTextDigest:null},mode:"concurrent-shadow",deadlineMs:15000,
 variants:[0,1].map(i=>({variantId:"v"+i,executionId:"exec:"+i,kind:i?"shadow":"primary",parentExecutionId:i?"exec:0":null,suffixBase64:"",operation:i?"hold":"digest",configuration:{model:null,effort:null,skills:null}}))};
 const authority={authorityDigest,charterDigests:[experimentCharterDigest(charter)],cancellationDigests:[] as string[]},binding=await createExperiment({directory:join(root,"experiment"),budget,charter,bytes,authority});return {budget,authority,controller:openExperiment(binding,authority)};
}
