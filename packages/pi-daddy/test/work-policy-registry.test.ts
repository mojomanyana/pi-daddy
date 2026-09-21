import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import {
  createWorkPolicyRegistry,
  openWorkPolicyRegistry,
  workPolicy,
  workPolicyDigest,
  workPolicyActivationDigest,
  type WorkPolicyActivation,
} from "../src/products/work-policy-registry.ts";
import { buildAdoptionBinding, buildRollbackRequest, authorizeAdoption } from "../src/products/vendor/adoption.ts";
import type { FactoryAuthority } from "../src/products/work-policy-registry.ts";
after(cleanupTempDirs);
const d = (c: string) => c.repeat(64);
const baseline = () =>
  workPolicy({
    version: "ordinary-work-policy-v1",
    scopeDigest: d("a"),
    assessmentPolicyDigest: d("b"),
    profiles: [{ taskId: "read", agent: "reader", model: "p/a", thinking: "low" }],
  });
const authority = (
  activations: string[] = [],
  adoptions: string[] = [],
  rollbacks: string[] = [],
  facts: FactoryAuthority["facts"] = [],
): FactoryAuthority => ({
  id: "human-facts",
  orderDigests: [],
  decisionDigests: [],
  activationDigests: activations,
  migrationDigests: [],
  adoption: { id: "human-facts", adoptions, rollbacks },
  facts,
});
async function fixture() {
  const cwd = await tempDir("ordinary-policy-"),
    base = baseline(),
    candidate = workPolicy({ ...base, profiles: [{ ...base.profiles[0], model: "p/b", thinking: "high" }] }),
    binding = await createWorkPolicyRegistry({
      directory: join(cwd, "registry"),
      authorityId: "human-facts",
      baseline: base,
    }),
    registry = openWorkPolicyRegistry(binding);
  const adoption = buildAdoptionBinding({
    hypothesisDigest: d("c"),
    experimentDigest: d("d"),
    candidateDigest: workPolicyDigest(candidate),
    rollbackCandidateDigest: workPolicyDigest(base),
    scopeDigest: base.scopeDigest,
    assessmentPolicyDigest: base.assessmentPolicyDigest,
    activationBoundary: "next-orders",
    expiresAt: Date.now() + 600000,
  });
  const verified = {
    experimentDigest: adoption.experimentDigest,
    candidateDigest: adoption.candidateDigest,
    scopeDigest: base.scopeDigest,
    assessmentPolicyDigest: base.assessmentPolicyDigest,
    eligible: true,
  };
  const receipt = authorizeAdoption(adoption, authority([], [adoption.id]).adoption, verified, Date.now()),
    facts = [{ bindingId: adoption.id, facts: verified }];
  const activation: WorkPolicyActivation = {
    version: "ordinary-work-activation-v1",
    requestId: "activate",
    expectedRevision: 0,
    expectedCandidateDigest: workPolicyDigest(base),
    binding: adoption,
    receipt,
    candidate,
  };
  return { base, candidate, binding, registry, adoption, receipt, facts, activation };
}

test("ordinary profile activation needs independent eligibility AND exact approval; old orders never migrate", async () => {
  const f = await fixture(),
    expected = { revision: 0, candidateDigest: workPolicyDigest(f.base) },
    first = await f.registry.pin("before", authority(), expected);
  await assert.rejects(f.registry.activate(f.activation, null), /independent/);
  await assert.rejects(f.registry.activate(f.activation, authority([], [], [], f.facts)), /activation approval/);
  await assert.rejects(
    f.registry.activate(f.activation, authority([workPolicyActivationDigest(f.activation)], [f.adoption.id])),
    /eligibility facts/,
  );
  const host = authority([workPolicyActivationDigest(f.activation)], [f.adoption.id], [], f.facts);
  const active = await f.registry.activate(f.activation, host);
  assert.equal(active.revision, 1);
  await assert.rejects(f.registry.pin("stale", host, expected), /changed before order pin/);
  await assert.rejects(
    f.registry.pin("without-current-facts", authority([], [f.adoption.id]), {
      revision: 1,
      candidateDigest: workPolicyDigest(f.candidate),
    }),
    /eligibility/,
  );
  const next = await f.registry.pin("after", host, { revision: 1, candidateDigest: workPolicyDigest(f.candidate) });
  assert.equal(next.adoptionId, f.receipt.id);
  assert.equal(next.candidate.profiles[0].model, "p/b");
  assert.equal(first.candidate.profiles[0].model, "p/a");
  const rollback = buildRollbackRequest(f.receipt, "operator-request", [d("f")]),
    rolled = await f.registry.rollback(rollback, authority([], [], [rollback.id]));
  assert.equal(rolled.candidateDigest, workPolicyDigest(f.base));
  assert.equal(rolled.revision, 2);
  assert.equal(
    (await f.registry.inspect()).orders.find((o) => o.orderId === "after")?.candidateDigest,
    workPolicyDigest(f.candidate),
  );
  const future = await f.registry.pin("future", authority(), {
    revision: 2,
    candidateDigest: workPolicyDigest(f.base),
  });
  assert.equal(future.candidate.profiles[0].model, "p/a");
  assert.equal((await openWorkPolicyRegistry(f.binding).inspect()).revision, 2);
});

test("additive profile cannot change definitions, tasks, scope or assessment meaning", async () => {
  const f = await fixture(),
    bad = workPolicy({ ...f.candidate, profiles: [{ ...f.candidate.profiles[0], agent: "writer" }] }),
    { id, version, ...draft } = f.adoption,
    binding = buildAdoptionBinding({ ...draft, candidateDigest: workPolicyDigest(bad) });
  const verified = { ...f.facts[0].facts, candidateDigest: binding.candidateDigest },
    receipt = authorizeAdoption(binding, authority([], [binding.id]).adoption, verified, Date.now());
  const request = { ...f.activation, candidate: bad, binding, receipt };
  await assert.rejects(
    f.registry.activate(
      request,
      authority([workPolicyActivationDigest(request)], [binding.id], [], [{ bindingId: binding.id, facts: verified }]),
    ),
    /scoped definitions/,
  );
  assert.throws(() => workPolicy({ ...f.base, toolGrant: ["bash"] } as any), /closed experiment/);
  assert.equal((await f.registry.inspect()).revision, 0);
});
