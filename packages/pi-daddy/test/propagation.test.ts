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
import { isWellFormedCapability } from "../src/capabilities.ts";

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

test("R-36: observation does not drop capabilities it cannot speak about", () => {
  // The observation is a list of TOOLS. `skill:` names an instruction file and `agent:` names a spawnable
  // definition — neither is ever a tool, so their absence from the array is not evidence of anything.
  // Before ADR-0017 step 1 this returned ["tool:read"], so a child could not re-grant a skill it held and
  // `/grants` stopped listing it — silently, and in the narrowing direction, which is why it survived.
  assert.deepEqual(
    deriveOwnGrant(["tool:read", "tool:bash", "skill:review", "agent:reviewer"], ["read"]),
    ["agent:reviewer", "skill:review", "tool:read"],
  );
});

test("R-36: a wildcard holder keeps its non-tool capabilities too", () => {
  const g = deriveOwnGrant([WILDCARD, "skill:review", "agent:reviewer"], ["read"]);
  assert.ok(g.includes("skill:review") && g.includes("agent:reviewer"), "enumeration must not evict them");
  assert.ok(g.includes(WILDCARD) && g.includes("tool:read"));
});

test("R-36: an empty tool observation still drops every tool, and only tools", () => {
  // The fail-closed half must survive the fix: nothing about passing `skill:` through may weaken the
  // rule that an unobserved TOOL is gone.
  assert.deepEqual(deriveOwnGrant(["tool:read", "skill:review"], []), ["skill:review"]);
});

test("R-36: a skill survives three levels, which is the property that was broken", () => {
  const root = deriveOwnGrant(["tool:read", "skill:review", "agent:reviewer"], ["read"]);
  const child = deriveOwnGrant(
    parseList(childEnv({ ownGrant: root, depth: 0, maxDepth: 3, gated: [] })[ENV_GRANT]),
    ["read"],
  );
  const grandchild = deriveOwnGrant(
    parseList(childEnv({ ownGrant: child, depth: 1, maxDepth: 3, gated: [] })[ENV_GRANT]),
    ["read"],
  );
  assert.deepEqual(grandchild, ["agent:reviewer", "skill:review", "tool:read"]);
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
    approved: [{ capability: "tool:write", subject: "docs-writer", scope: "session", bodySha256: "body-digest" }, { capability: "tool:bash", subject: "docs-writer", scope: "session", bodySha256: "body-digest" }],
  });
  // ADR-0014: the published value is `capability@subject`, so an approval cannot satisfy a subject
  // it was never given for.
  assert.equal(env[ENV_APPROVED], "tool:write@docs-writer#body-digest", "bash was approved upstream but is not held here");
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

  publish(childEnv({ ownGrant: ["tool:read", "tool:write"], depth: 0, maxDepth: 2, gated: ["tool:write"], approved: [{ capability: "tool:write", subject: "docs-writer", scope: "session", bodySha256: "body-digest" }] }));
  assert.equal(target[ENV_APPROVED], "tool:write@docs-writer#body-digest");

  // The session observes its real tool surface and loses `write`; the approval no longer applies.
  publish(childEnv({ ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: ["tool:write"], approved: [{ capability: "tool:write", subject: "docs-writer", scope: "session", bodySha256: "body-digest" }] }));
  assert.equal(target[ENV_APPROVED], "", "the stale approval is cleared, not left behind");
});

test("the wildcard is never inherited as an approval", () => {
  const env = childEnv({
    ownGrant: ["tool:*", "tool:read"],
    depth: 0,
    maxDepth: 2,
    gated: [],
    approved: [{ capability: "tool:*", subject: "docs-writer", scope: "session", bodySha256: "body-digest" }, { capability: "tool:read", subject: "docs-writer", scope: "session", bodySha256: "body-digest" }],
  });
  assert.equal(env[ENV_APPROVED], "tool:read@docs-writer#body-digest");
});

test("delegate hands the child only approvals for capabilities it was actually granted", () => {
  // **Fixture corrected, not the assertion.** It requested `tools: ["read","write"]` — a `tools:` form, whose
  // approval subject is `<delegate>` (ADR-0019) — while supplying approvals keyed to the definition `docs-writer`.
  // That combination only ever worked because `planDelegation` matched approvals by bare capability NAME and
  // ignored the subject, which is the defect that let `delegate_chain` satisfy one definition's gate with another
  // definition's yes. With subjects enforced, this request is correctly refused for `tool:write`.
  //
  // The property under test is unchanged and is about the CHILD: only a capability that was actually granted
  // reaches it, so an approval for something withheld (`tool:bash`) must not travel.
  const plan = planDelegation(
    { task: "edit the docs", agent: "docs-writer" },
    {
      // `agent:docs-writer` too — ADR-0017 requires the session to hold the id before the file is even read.
      ownGrant: ["agent:docs-writer", "tool:read", "tool:write", "tool:bash"],
      depth: 0,
      maxDepth: 2,
      gated: ["tool:write", "tool:bash"],
      definitions: new Map([
        ["docs-writer", { name: "docs-writer", allowedTools: "Read Write", body: "Write docs.", source: "/x/docs-writer/SKILL.md" } as never],
      ]),
      approved: [{ capability: "tool:write", subject: "docs-writer", scope: "session", bodySha256: "body-digest" }, { capability: "tool:bash", subject: "docs-writer", scope: "session", bodySha256: "body-digest" }],
    },
  );
  assert.equal(plan.ok, true, plan.reason ?? "expected ok");
  assert.equal(plan.env[ENV_APPROVED], "tool:write@docs-writer#body-digest", "bash was approved but not granted to this child");
});

test("an approval for one definition does NOT satisfy another — ADR-0014's A-S6, enforced in the planner", () => {
  // **This is the property whose absence let a chain's first step authorise every later one.** Subject matching used
  // to live only in `resolveApprovals`, so any caller passing `approved` directly — which is exactly what
  // `delegate_chain`'s upfront gate did — bypassed it entirely. Enforcing it in `planDelegation` makes it hold by
  // construction for every caller instead of by everyone remembering.
  //
  // The production change that breaks this: dropping the `a.subject === subject` filter in `planDelegation`.
  const plan = planDelegation(
    { task: "dig", agent: "digger" },
    {
      ownGrant: ["agent:digger", "tool:read", "tool:bash"],
      depth: 0,
      maxDepth: 2,
      gated: ["tool:bash"],
      definitions: new Map([
        ["digger", { name: "digger", allowedTools: "Read Bash", body: "Dig.", source: "/x/digger/SKILL.md" } as never],
      ]),
      // Approved for a DIFFERENT definition.
      approved: [{ capability: "tool:bash", subject: "shaper", scope: "session", bodySha256: "other-body" }],
    },
  );
  assert.equal(plan.ok, false, "another definition's approval must not satisfy this gate");
  assert.match(String(plan.reason), /tool:bash/);
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
      approved: [{ capability: "tool:write", subject: "docs-writer", scope: "session", bodySha256: "body-digest" }],
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

/**
 * A capability id is never a list.
 *
 * **Measured on the published 0.18.0 before this fix.** A root holding `agent:*` (or `tool:*`) that
 * requested `agent:x,tool:bash` had it admitted by the wildcard's PREFIX rule — `"agent:x,tool:bash"`
 * starts with `agent:` — written verbatim into the child's `PI_GRANTS_GRANT`, and split by the child's
 * own `parseList` into two capabilities. The child received a real `tool:bash` from a tree whose root
 * never held it, `denied` was empty, and the ledger line looked clean. That is minting authority, in the
 * package whose entire purpose is to prevent it.
 *
 * Two guards, because `grant-env.ts` already argued for exactly this shape: refuse to GRANT it, and refuse
 * to WRITE it, since "a guard that depends on my enumeration being complete is not a guard".
 *
 * The production changes that break these: removing `isWellFormedCapability` from `covered()` in
 * `resolve.ts`, or removing the `assertCapabilitiesArePropagatable` call from either grant writer.
 */
test("a comma in a capability id is refused, not split into extra capabilities", () => {
  const ownGrant = ["agent:*", "tool:read", "tool:delegate"];
  const plan = planDelegation(
    { task: "t", tools: ["read", "delegate", "agent:x,tool:bash"] },
    { depth: 0, maxDepth: 3, spawnId: "d0", childSpawnId: "d0.1", ownGrant, gated: [] },
  );
  assert.equal(plan.ok, false, "a wildcard prefix must not admit an id that is really two");
  assert.equal(plan.refusal?.code, "CAPABILITY_ESCALATION");
  // Recorded, so the attempt is visible to `isEscalationAttempt` and every audit query rather than silent.
  assert.deepEqual(plan.result.denied, ["agent:x,tool:bash"]);

  // The same shape through `tool:*`, which covers every namespace.
  const viaWildcard = planDelegation(
    { task: "t", tools: ["tool:x,tool:bash"] },
    { depth: 0, maxDepth: 3, spawnId: "d0", childSpawnId: "d0.2", ownGrant: ["tool:*"], gated: [] },
  );
  assert.deepEqual(viaWildcard.result.denied, ["tool:x,tool:bash"]);
});

test("a legitimate grant is unaffected, including the exotic id forms", () => {
  // The fix must not narrow what an operator can already express. `ext:` ids carry `/` and may be
  // npm-scoped; `skill:`/`agent:` names carry `-` and `_`.
  for (const id of ["tool:read", "ext:@scope/pkg/web_search", "skill:my-skill", "agent:my_agent", "tool:*", "agent:*"]) {
    assert.equal(isWellFormedCapability(id), true, id);
  }
  for (const id of ["agent:x,tool:bash", "tool:a\nb", "tool:a\rb", " tool:read", "tool:read ", ""]) {
    assert.equal(isWellFormedCapability(id), false, JSON.stringify(id));
  }
});

test("the write-side backstop refuses rather than emitting a splittable grant", () => {
  // Unreachable through `covered()` — which is the point. It fires only if something upstream admitted a
  // malformed id, and it is loud so that defect surfaces instead of being quietly filtered away.
  assert.throws(
    () => childEnv({ ownGrant: ["tool:read", "agent:x,tool:bash"], depth: 0, maxDepth: 2, gated: [], approved: [] }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "GRANT_ID_MALFORMED");
      assert.match(error.message, /would read these as several capabilities/);
      return true;
    },
  );
  assert.doesNotThrow(() => childEnv({ ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [], approved: [] }));
});
