import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { supportedModelEfforts as getSupportedThinkingLevels } from "../src/kernel/model-preflight.ts";
import { createWorkPolicyRegistry, openWorkPolicyRegistry, policyForSetup, workPolicy, workPolicyDigest, workPolicyActivationDigest, type WorkPolicy, type WorkPolicyRegistry, type WorkPolicyActivation } from "../src/products/work-policy-registry.ts";
import { loadWorkSetup, type WorkSetup } from "../src/products/work-setup.ts";
import { bindLearningAdoption, learningScopeDigest, type LearningHarness, type LearningWorkspace } from "../src/products/learning-connection.ts";
import type { DeclaredWorkState } from "../src/products/work-command.ts";
import { privateDirectory, readProductJson, writeProductJson } from "../src/products/product-files.ts";
import type { AdoptionBinding, AdoptionFacts } from "../src/products/vendor/adoption.ts";
import type { FactoryAuthority } from "../src/products/factory-contract.ts";
import { experimentHash } from "../src/products/experiment-contract.ts";

const descriptor = (cwd: string) => join(cwd, ".pi", "work-policy-registry.json");
const policyPath = (cwd: string, digest: string) => join(cwd, ".pi", "work-policies", `${digest}.json`);
const registryHistoryPath=(cwd:string,scope:string)=>join(cwd,".pi","work-registry-bindings",`${scope}.json`);
async function retainRegistryBinding(cwd:string,binding:WorkPolicyRegistry){const path=registryHistoryPath(cwd,binding.initial.scopeDigest),old=await readProductJson(path);if(old&&experimentHash(old)!==experimentHash(binding))throw Error("scoped registry binding history conflict");if(!old)await writeProductJson(path,binding);}
function authority(id: string, binding?: AdoptionBinding, facts?: AdoptionFacts): FactoryAuthority { return { id, orderDigests: [], decisionDigests: [], activationDigests: [], migrationDigests: [], adoption: { id, adoptions: binding ? [binding.id] : [], rollbacks: [] }, facts: binding && facts ? [{ bindingId: binding.id, facts }] : [] }; }
async function independentFacts(ctx: ExtensionCommandContext, b: AdoptionBinding): Promise<AdoptionFacts | null> {
  if (!await ctx.ui.confirm("Independent eligibility attestation — not a quality preference", `Have you independently verified that this exact comparison/candidate meets the scoped assessment policy, and is still eligible?\nExperiment: ${b.experimentDigest}\nCandidate: ${b.candidateDigest}\nScope: ${b.scopeDigest}\nAssessment: ${b.assessmentPolicyDigest}\n\nConfirm only with real independent evidence. Missing/uncertain evidence means No. This does not fabricate calibration or accept any result.`)) return null;
  return { experimentDigest: b.experimentDigest, candidateDigest: b.candidateDigest, scopeDigest: b.scopeDigest, assessmentPolicyDigest: b.assessmentPolicyDigest, eligible: true };
}
export async function loadWorkPolicyRegistry(cwd: string, state: DeclaredWorkState): Promise<WorkPolicyRegistry | null> {
  const binding = await readProductJson(descriptor(cwd)) as WorkPolicyRegistry | null;
  if (binding && binding.initial.scopeDigest !== learningScopeDigest(state)) throw Error("Configured adoption registry belongs to different work. Use /grants learning → Adoption / rollback to reconnect or create scoped settings; no adopted setting was carried forward.");
  if (binding) await openWorkPolicyRegistry(binding).inspect(); return binding;
}
async function savePolicy(cwd: string, name: string, policy: WorkPolicy) {
  if(typeof name!=="string"||!name.trim()||Buffer.byteLength(name)>128||/[\p{Cc}\p{Cf}]/u.test(name))throw Error("bounded plain candidate name required");
  const path = policyPath(cwd, workPolicyDigest(policy)), old = await readProductJson(path);
  if(old){await readPolicy(cwd,workPolicyDigest(policy));return;}
  await writeProductJson(path, { version: "named-work-policy-v1", name, policy });
}
async function readPolicy(cwd: string, digest: string) {
  const saved = await readProductJson(policyPath(cwd, digest)) as { version: string; name: string; policy: WorkPolicy } | null;
  if (!saved || Object.keys(saved).sort().join()!=="name,policy,version" || typeof saved.name!=="string" || !saved.name.trim() || Buffer.byteLength(saved.name)>128 || /[\p{Cc}\p{Cf}]/u.test(saved.name) || saved.version !== "named-work-policy-v1" || workPolicyDigest(saved.policy) !== digest) throw Error("Exact candidate policy bytes are missing; prepare the candidate profile first");
  return workPolicy(saved.policy);
}
function retain(h: LearningHarness, root: string, parser: string, value: unknown) {
  return h.retainArchiveSource(root, { sourceId: `${parser}-${experimentHash(value).slice(0, 24)}`, parser: { id: parser, version: "1" }, retention: "exact", bytes: Buffer.from(JSON.stringify(value)) }).manifestId;
}
export async function workPolicyMenu(ctx: ExtensionCommandContext, state: DeclaredWorkState, workspace: LearningWorkspace, harness: LearningHarness): Promise<void> {
  const setup = await loadWorkSetup(state); if (!setup) throw Error("Declare a multi-task work setup before configuring ordinary model/effort adoption");
  let binding = await readProductJson(descriptor(ctx.cwd)) as WorkPolicyRegistry|null;
  if(binding)await openWorkPolicyRegistry(binding).inspect();
  if(binding&&binding.initial.scopeDigest!==learningScopeDigest(state)){
    if(!await ctx.ui.confirm("Settings belong to different selected work","Connect settings for this exact work scope? Previous registry and active/history-bearing orders remain untouched. No adopted setting carries across scopes."))return;
    await retainRegistryBinding(ctx.cwd,binding);binding=null;
  }
  if(!binding){
    const saved=await readProductJson(registryHistoryPath(ctx.cwd,learningScopeDigest(state))) as WorkPolicyRegistry|null;
    if(saved){const view=await openWorkPolicyRegistry(saved).inspect();if(view.scopeDigest!==learningScopeDigest(state))throw Error("saved registry scope mismatch");if(!await ctx.ui.confirm("Reconnect saved settings for this work?",`${view.candidate.profiles.map(p=>`${p.model} / ${p.thinking}`).join(", ")}\nFuture runs still require current eligibility; existing runs do not migrate.`))return;binding=saved;await writeProductJson(descriptor(ctx.cwd),binding,true);}
  }
  if (!binding) {
    const baseline = policyForSetup(setup.setup, learningScopeDigest(state), state.policy.digest);
    if (!await ctx.ui.confirm("Create a scoped next-order registry?", "Baseline is the selected task models/effort. Future adoption can only change model/effort for these same definitions. No existing or active run changes.")) return;
    const root = join(homedir(), ".local", "state", "pi-daddy", "work-registries"); await mkdir(root, { recursive: true, mode: 0o700 }); await privateDirectory(root);
    binding = await createWorkPolicyRegistry({ directory: join(root, randomUUID()), authorityId: "local-operator", baseline });
    await savePolicy(ctx.cwd, "Baseline", baseline); await retainRegistryBinding(ctx.cwd,binding); await writeProductJson(descriptor(ctx.cwd), binding, true);
  }
  const registry = openWorkPolicyRegistry(binding), current = await registry.inspect();
  const menu = ["Prepare candidate model/effort profile", "Activate adopted comparison for next orders", "Roll back active adoption", "Inspect registry", "Recover learning link (no registry change)"];
  const choice = await ctx.ui.select("Scoped settings — existing runs stay pinned", menu);
  if (!choice) return;
  if (choice === menu[3]) { await ctx.ui.editor("Registry details (read-only; editor changes are discarded)", JSON.stringify(current, null, 2)); return; }
  if (choice === menu[0]) {
    const candidate = structuredClone(current.candidate);
    for (const profile of candidate.profiles) {
      const models = ctx.scopedModels?.length ? ctx.scopedModels.map(entry => entry.model) : ctx.modelRegistry.getAvailable();
      if(!models.length)throw Error("No available Pi models. Configure a model in Pi, then reopen settings; no fallback is chosen.");
      const labels = models.map(m => `${m.provider}/${m.id}`), selected = await ctx.ui.select(`Model for ${setup.setup.tasks.find(t => t.id === profile.taskId)!.outcome}`, labels), model = models[labels.indexOf(selected ?? "")]; if (!model) return;
      const thinking = await ctx.ui.select("Requested effort", getSupportedThinkingLevels(model)); if (!thinking) return;
      profile.model = `${model.provider}/${model.id}`; profile.thinking = thinking as typeof profile.thinking;
    }
    const name = await ctx.ui.input("Candidate name", "Alternative profile"); if (!name?.trim()) return;
    await savePolicy(ctx.cwd, name, candidate);
    ctx.ui.notify(`Candidate retained, not adopted. Comparison must bind configuration digest ${workPolicyDigest(candidate)} to actual outputs. Use Learning to review full artifacts, record quality and choose adopt/reject/defer.`, "info"); return;
  }
  const view = workspace.inspect(Date.now()), comparisons = view.comparisons.filter(c => c.state !== "deferred");
  if(!comparisons.length)throw Error("Adoption deferred: no ready retained comparison. Open Learning to connect/review actual evidence and inspect defer reasons. No setting was activated.");
  const labels = comparisons.map((c, i) => `${i + 1}. ${c.title}`), picked = await ctx.ui.select("Retained comparison", labels), comparison = comparisons[labels.indexOf(picked ?? "")]; if (!comparison) return;
  if (choice === menu[1]) {
    let adoptionBinding = workspace.comparisonContext(comparison.name).adoptionBinding;
    if (!adoptionBinding) {
      const files=await readdir(join(ctx.cwd,".pi","work-policies")); if(files.length>128)throw Error("candidate profile bound exceeded");
      const candidates: {name:string;policy:WorkPolicy}[]=[];
      for(const file of files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){const saved=await readProductJson(join(ctx.cwd,".pi","work-policies",file)) as {name:string;policy:WorkPolicy};const policy=await readPolicy(ctx.cwd,file.slice(0,-5));if(policy.scopeDigest===current.scopeDigest)candidates.push({name:saved.name,policy});}
      const names=candidates.map((c,i)=>`${i+1}. ${c.name}: ${c.policy.profiles.map(p=>`${p.model}/${p.thinking}`).join(", ")}`),picked=await ctx.ui.select("Candidate already compared in this retained evidence",names),selected=candidates[names.indexOf(picked??"")];if(!selected)return;
      if(!await ctx.ui.confirm("Bind this scoped adoption proposal?","This requires linked confirmed cases, hypothesis and a durable full-artifact choice of this exact candidate. It does not create eligibility or activate anything."))return;
      adoptionBinding=bindLearningAdoption(workspace,comparison.name,{candidateDigest:workPolicyDigest(selected.policy),rollbackCandidateDigest:current.candidateDigest,assessmentPolicyDigest:selected.policy.assessmentPolicyDigest,expiresAt:Date.now()+7*86400000});
    }
    const candidate = await readPolicy(ctx.cwd, adoptionBinding.candidateDigest), facts = await independentFacts(ctx, adoptionBinding); if (!facts) return;
    const a = authority(binding.initial.authorityId, adoptionBinding, facts), receipt = workspace.prepareAdoption(comparison.name, a.adoption, facts, Date.now());
    const request: WorkPolicyActivation = { version: "ordinary-work-activation-v1", requestId: `activate-${randomUUID()}`, expectedRevision: current.revision, expectedCandidateDigest: current.candidateDigest, candidate, binding: adoptionBinding, receipt };
    if (!await ctx.ui.confirm("Activate for NEXT orders only?", `${comparison.title}\n${candidate.profiles.map(p => `${p.taskId}: ${p.model} / ${p.thinking}`).join("\n")}\nNo active work changes. This is separate from your quality choice.`)) return;
    a.activationDigests = [workPolicyActivationDigest(request)];
    const applied = await registry.activate(request, a), archiveRoot = workspace.configuration().archiveRoot;
    const registryManifestId = retain(harness, archiveRoot, "producer-registry", applied);
    const wrapper = retain(harness, archiveRoot, "learning-registry-receipt", { version: "learning-registry-receipt-v1", operation: "activate", requestId: request.requestId, adoptionId: receipt.id, scopeDigest: applied.scopeDigest, candidateDigest: applied.candidateDigest, revision: applied.revision, registryManifestId });
    try { workspace.linkActivation(comparison.name, wrapper, [wrapper]); }
    catch (error) { throw Error(`Registry activated but learning link failed (${String(error)}). Do not activate again; use Recover learning link. Retained receipt ${wrapper}.`); }
    ctx.ui.notify("Activated for subsequent bounded work runs. Existing runs remain pinned; later outcomes are still unobserved.", "info"); return;
  }
  if(choice===menu[4]){
    const change=current.lastChange,receipt=workspace.preparedAdoption(comparison.name);
    if(!change||!receipt||change.adoptionId!==receipt.id)throw Error("Last original registry change does not belong to this comparison");
    if(!await ctx.ui.confirm("Reconnect actual registry observation?",`The last ${change.operation} is already applied at revision ${current.revision}. This only retains and links that exact original registry observation; no effect is replayed.`))return;
    const root=workspace.configuration().archiveRoot,registryManifestId=retain(harness,root,"producer-registry",current),wrapper=retain(harness,root,"learning-registry-receipt",{version:"learning-registry-receipt-v1",operation:change.operation,requestId:change.requestId,adoptionId:receipt.id,scopeDigest:current.scopeDigest,candidateDigest:current.candidateDigest,revision:current.revision,registryManifestId});
    if(change.operation==="activate")workspace.linkActivation(comparison.name,wrapper,[wrapper]);else workspace.linkRollback(comparison.name,wrapper,[wrapper]);
    ctx.ui.notify("Original registry observation linked. No activation or rollback replayed.","info");return;
  }
  if (!current.activation) throw Error("No current adoption to roll back");
  const receipt = workspace.preparedAdoption(comparison.name);
  if (!receipt || receipt.id !== current.activation.receipt.id) throw Error("Selected comparison is not the active adoption");
  const root = workspace.configuration().archiveRoot;
  const evidence = retain(harness, root, "producer-rollback-request", { reason: "operator-request", adoptionId: receipt.id, observedRevision: current.revision });
  const request = workspace.previewRollback(comparison.name, "operator-request", [evidence], Date.now() + 120_000);
  const restore = await registry.previewRollback(request);
  if (!await ctx.ui.confirm("Roll back NEXT orders?", `Restore candidate: ${restore.restoreCandidateDigest}\n${restore.candidate.profiles.map(p => `${p.taskId}: ${p.model} / ${p.thinking}`).join("\n")}\nNo active run changes; no defect or improvement is inferred.`)) return;
  const a = authority(binding.initial.authorityId); a.adoption = { id: a.id, adoptions: [], rollbacks: [request.id] };
  workspace.prepareRollback(comparison.name, request, a.adoption, Date.now(), { adoptionId: receipt.id, candidateDigest: current.candidateDigest, scopeDigest: current.scopeDigest });
  const applied = await registry.rollback(request, a), registryManifestId = retain(harness, root, "producer-registry", applied);
  const wrapper = retain(harness, root, "learning-registry-receipt", { version: "learning-registry-receipt-v1", operation: "rollback", requestId: request.id, adoptionId: receipt.id, scopeDigest: applied.scopeDigest, candidateDigest: applied.candidateDigest, revision: applied.revision, registryManifestId });
  try { workspace.linkRollback(comparison.name, wrapper, [wrapper]); }
  catch (error) { throw Error(`Rollback applied but learning link failed (${String(error)}). Use Recover learning link; do not repeat the effect. Retained receipt ${wrapper}.`); }
  ctx.ui.notify("Rollback applied for next orders. Active/history-bearing runs were not changed.", "info");
}
/** Fresh human facts at use; a stored lifecycle/receipt is never treated as independent live authority. */
export async function prepareNextWorkPolicy(ctx: ExtensionCommandContext, state: DeclaredWorkState, setup: WorkSetup) {
  const binding = await loadWorkPolicyRegistry(ctx.cwd, state); if (!binding) return { setup, pin: async (_id: string) => null };
  const registry = openWorkPolicyRegistry(binding), current = await registry.inspect();
  const facts = current.activation ? await independentFacts(ctx, current.activation.binding) : undefined;
  if (facts === null) throw Error("Next-order adoption deferred; no fallback profile or child launched");
  const a = authority(binding.initial.authorityId, current.activation?.binding, facts);
  const configured = { ...setup, tasks: setup.tasks.map(t => { const profile = current.candidate.profiles.find(p => p.taskId === t.id); if (!profile || profile.agent !== t.agent) throw Error("adopted profile no longer matches task definition"); return { ...t, model: profile.model, thinking: profile.thinking }; }) };
  return { setup: configured, async pin(orderId: string) { const pinned = await registry.pin(orderId, a, { revision: current.revision, candidateDigest: current.candidateDigest }); if (pinned.candidateDigest !== current.candidateDigest || pinned.revision !== current.revision) throw Error("registry changed before order pin; no child launched"); return { orderId, candidateDigest: pinned.candidateDigest, adoptionId: pinned.adoptionId, revision: pinned.revision, scopeDigest: binding.initial.scopeDigest }; } };
}
