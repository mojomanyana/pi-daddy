import assert from "node:assert/strict";
import { test } from "node:test";
import { WILDCARD } from "../src/pi-tools.ts";
import {
  childEnv,
  deriveOwnGrant,
  ENV_APPROVED,
  ENV_DEPTH,
  ENV_GATED,
  ENV_GRANT,
  ENV_LEDGER,
  ENV_MAX_DEPTH,
  mergeChildEnv,
  observeToolNames,
  parseList,
} from "../src/propagation.ts";
import { planDelegation } from "../src/delegate.ts";

test("the race is gone by construction: child env depends only on parent-level facts", () => {
  // Two different concurrent spawns from the same parent must inherit byte-identical environments.
  const parent = { ownGrant: ["tool:read", "tool:grep"], depth: 1, maxDepth: 3, gated: [] };
  const forChildA = childEnv(parent);
  const forChildB = childEnv(parent);
  assert.deepEqual(forChildA, forChildB, "siblings inherit identical env, so there is nothing to race on");
  assert.equal(forChildA[ENV_DEPTH], "2", "children are one level deeper than the parent");
  assert.equal(forChildA[ENV_GRANT], "tool:read,tool:grep");
  assert.equal(forChildA[ENV_MAX_DEPTH], "3");
});

test("child env round-trips through parseList", () => {
  const env = childEnv({ ownGrant: ["tool:read", "ext:pkg/web_search"], depth: 0, maxDepth: 2, gated: ["tool:write"] });
  assert.deepEqual(parseList(env[ENV_GRANT]), ["tool:read", "ext:pkg/web_search"]);
});

test("unobserved: inherited grant is used unchanged as an upper bound", () => {
  assert.deepEqual(deriveOwnGrant(["tool:read", "tool:bash"], null), ["tool:read", "tool:bash"]);
});

test("observed: grant tightens to the intersection with the real tool surface", () => {
  // pi handed this session only `read`, even though it inherited read+bash.
  assert.deepEqual(deriveOwnGrant(["tool:read", "tool:bash"], ["read"]), ["tool:read"]);
});

test("observation cannot WIDEN a grant — defence in depth", () => {
  // Even if pi gave the session bash, an inherited grant without it stays without it.
  assert.deepEqual(deriveOwnGrant(["tool:read"], ["read", "bash", "write"]), ["tool:read"]);
});

test("observing an empty tool set yields an empty grant, not the inherited one", () => {
  assert.deepEqual(deriveOwnGrant(["tool:read", "tool:bash"], []), []);
});

test("ext: capabilities match on their bare tool name", () => {
  assert.deepEqual(
    deriveOwnGrant(["ext:pi-web-access/web_search", "tool:read"], ["web_search"]),
    ["ext:pi-web-access/web_search"],
  );
});

test("a wildcard holder stays a wildcard holder after observing", () => {
  const g = deriveOwnGrant([WILDCARD], ["read", "bash"]);
  assert.ok(g.includes(WILDCARD), "an explicitly unlimited root must not be silently downgraded");
  assert.ok(g.includes("tool:read") && g.includes("tool:bash"), "and observed names are enumerated too");
});

test("the wildcard is HELD but never INHERITED — otherwise attenuation dies below the root", () => {
  const root = deriveOwnGrant([WILDCARD], ["read", "bash"]);
  assert.ok(root.includes(WILDCARD), "the root still holds it");
  const inheritedByChild = parseList(childEnv({ ownGrant: root, depth: 0, maxDepth: 3, gated: [] })[ENV_GRANT]);
  assert.ok(!inheritedByChild.includes(WILDCARD), "children must not receive authority to grant anything");
  assert.deepEqual(inheritedByChild.sort(), ["tool:bash", "tool:read"]);
});

test("a wildcard root that never observed its tools hands down nothing (fails closed)", () => {
  const env = childEnv({ ownGrant: [WILDCARD], depth: 0, maxDepth: 2, gated: [] });
  assert.equal(env[ENV_GRANT], "", "no enumeration available -> empty grant, not unlimited");
});

test("transitivity across three levels holds with derivation", () => {
  const root = deriveOwnGrant([WILDCARD], ["read", "bash", "write"]);
  const child = deriveOwnGrant(parseList(childEnv({ ownGrant: root, depth: 0, maxDepth: 3, gated: [] })[ENV_GRANT]), ["read", "bash"]);
  const grandchild = deriveOwnGrant(parseList(childEnv({ ownGrant: child, depth: 1, maxDepth: 3, gated: [] })[ENV_GRANT]), ["read", "bash", "write"]);
  assert.ok(!grandchild.includes("tool:write"), "write was dropped at level 1 and cannot be reacquired at level 2");
  assert.deepEqual(grandchild.sort(), ["tool:bash", "tool:read"]);
});

test("observeToolNames handles Anthropic-style and OpenAI-nested tool shapes", () => {
  assert.deepEqual(observeToolNames({ tools: [{ name: "read" }, { name: "bash" }] }), ["read", "bash"]);
  assert.deepEqual(observeToolNames({ tools: [{ function: { name: "read" } }] }), ["read"]);
  assert.deepEqual(observeToolNames({ functions: [{ name: "grep" }] }), ["grep"]);
});

test("observeToolNames distinguishes 'no tools' from 'could not observe'", () => {
  assert.deepEqual(observeToolNames({ tools: [] }), [], "empty array is a real observation");
  assert.equal(observeToolNames({}), null, "absent key means not observed");
  assert.equal(observeToolNames(null), null);
  assert.equal(observeToolNames("nonsense"), null);
});

test("an inherited approval is intersected with what the child actually gets", () => {
  const env = childEnv({
    ownGrant: ["tool:read", "tool:write"],
    depth: 0,
    maxDepth: 2,
    gated: ["tool:write"],
    approved: [{ capability: "tool:write", subject: "docs-writer", scope: "session" }, { capability: "tool:bash", subject: "docs-writer", scope: "session" }],
  });
  // ADR-0014: the published value is `capability@subject`, so an approval cannot satisfy a subject
  // it was never given for.
  assert.equal(env[ENV_APPROVED], "tool:write@docs-writer", "bash was approved upstream but is not held here");
});

test("no approvals means the variable is EMPTY, not absent — an absent key would not overwrite", () => {
  // The interceptor path publishes by assigning into the process-global `process.env`, so a key this
  // object omits is a key whose previous value survives. If a session narrows its grant to nothing, an
  // omitted ENV_APPROVED would leave the parent's own unclamped approvals visible to every child.
  const env = childEnv({ ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [] });
  assert.equal(ENV_APPROVED in env, true, "the key is present so assignment overwrites");
  assert.equal(env[ENV_APPROVED], "");
});

test("an empty approvals value reads back as no approvals", () => {
  // The whole always-write scheme rests on this: "" must not parse as a one-element list.
  assert.deepEqual(parseList(""), []);
  assert.deepEqual(parseList(childEnv({ ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [] })[ENV_APPROVED]), []);
});

test("publishing a narrowed grant CLEARS a previously published approval", () => {
  // The stale-value case, in the shape `publishChildEnv` uses: assign the keys of one childEnv over the
  // keys of an earlier one. Nothing deletes, so only an always-written key can clear.
  const target: Record<string, string> = {};
  const publish = (env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) target[k] = v;
  };

  publish(childEnv({ ownGrant: ["tool:read", "tool:write"], depth: 0, maxDepth: 2, gated: ["tool:write"], approved: [{ capability: "tool:write", subject: "docs-writer", scope: "session" }] }));
  assert.equal(target[ENV_APPROVED], "tool:write@docs-writer");

  // The session observes its real tool surface and loses `write`; the approval no longer applies.
  publish(childEnv({ ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: ["tool:write"], approved: [{ capability: "tool:write", subject: "docs-writer", scope: "session" }] }));
  assert.equal(target[ENV_APPROVED], "", "the stale approval is cleared, not left behind");
});

test("the wildcard is never inherited as an approval", () => {
  const env = childEnv({
    ownGrant: ["tool:*", "tool:read"],
    depth: 0,
    maxDepth: 2,
    gated: [],
    approved: [{ capability: "tool:*", subject: "docs-writer", scope: "session" }, { capability: "tool:read", subject: "docs-writer", scope: "session" }],
  });
  assert.equal(env[ENV_APPROVED], "tool:read@docs-writer");
});

test("delegate hands the child only approvals for capabilities it was actually granted", () => {
  const plan = planDelegation(
    { task: "edit the docs", tools: ["read", "write"] },
    {
      ownGrant: ["tool:read", "tool:write", "tool:bash"],
      depth: 0,
      maxDepth: 2,
      gated: ["tool:write", "tool:bash"],
      approved: [{ capability: "tool:write", subject: "docs-writer", scope: "session" }, { capability: "tool:bash", subject: "docs-writer", scope: "session" }],
    },
  );
  assert.equal(plan.ok, true, plan.reason ?? "expected ok");
  assert.equal(plan.env[ENV_APPROVED], "tool:write@docs-writer", "bash was approved but not granted to this child");
});

test("an approved capability the child was NOT granted never reaches it", () => {
  // Named for the property the CHILD sees, so it is asserted on the environment the child is actually
  // spawned with — not on `plan.env` alone. `plan.env` is merged over the parent's own environment, and
  // the parent here holds exactly the approval this child must not see.
  const plan = planDelegation(
    { task: "read the docs", tools: ["read"] },
    {
      ownGrant: ["tool:read", "tool:write"],
      depth: 0,
      maxDepth: 2,
      gated: ["tool:write"],
      approved: [{ capability: "tool:write", subject: "docs-writer", scope: "session" }],
    },
  );
  assert.equal(plan.ok, true, plan.reason ?? "expected ok");
  assert.equal(plan.env[ENV_APPROVED], "", "the plan states an empty approval set rather than omitting it");

  const parentEnv = { PATH: "/usr/bin", [ENV_APPROVED]: "tool:write", [ENV_GRANT]: "tool:read,tool:write" };
  const childProcessEnv = mergeChildEnv(parentEnv, plan.env);
  assert.equal(childProcessEnv[ENV_APPROVED], "", "the parent's approval does not survive the merge");
  assert.equal(childProcessEnv[ENV_GRANT], "tool:read", "and the grant is the plan's, not the parent's");
});

test("mergeChildEnv lets the plan be the only source of every governance variable", () => {
  const parentEnv = {
    PATH: "/usr/bin",
    HOME: "/home/someone",
    [ENV_GRANT]: "tool:read,tool:write,tool:bash",
    [ENV_DEPTH]: "0",
    [ENV_MAX_DEPTH]: "5",
    [ENV_GATED]: "tool:write",
    [ENV_APPROVED]: "tool:write",
    [ENV_LEDGER]: "/parent/ledger.jsonl",
  };
  const merged = mergeChildEnv(parentEnv, { [ENV_GRANT]: "tool:read", [ENV_DEPTH]: "1" });

  assert.equal(merged[ENV_GRANT], "tool:read");
  assert.equal(merged[ENV_DEPTH], "1");
  for (const key of [ENV_MAX_DEPTH, ENV_GATED, ENV_APPROVED, ENV_LEDGER]) {
    assert.equal(key in merged, false, `${key} was not set by the plan, so the child must not see one`);
  }
  assert.equal(merged.PATH, "/usr/bin", "everything else the child needs is untouched");
  assert.equal(merged.HOME, "/home/someone");
});

test("mergeChildEnv does not mutate the environment it was handed", () => {
  const parentEnv = { [ENV_APPROVED]: "tool:write" };
  mergeChildEnv(parentEnv, {});
  assert.equal(parentEnv[ENV_APPROVED], "tool:write", "the live process.env must survive a spawn intact");
});
