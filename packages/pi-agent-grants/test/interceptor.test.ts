import assert from "node:assert/strict";
import { test } from "node:test";
import { ceilingFor, parseAgentType, WILDCARD } from "../src/agent-types.ts";
import { decideSpawn } from "../src/interceptor.ts";
import type { AgentType } from "../src/agent-types.ts";

const typeFrom = (text: string): AgentType => {
  const t = parseAgentType("mem://t.md", text);
  assert.ok(t, "frontmatter should parse");
  return t;
};

const types = (...list: AgentType[]) => new Map(list.map((t) => [t.name, t]));

// Frontmatter shapes taken verbatim from real ~/.pi/agent/agents/*.md files.
const PLAN = typeFrom(`---
name: plan
description: >
  multi-line block scalar that must not be mis-parsed
tools: read, grep, find, ls
---
body`);

const REVIEW = typeFrom(`---
name: review
tools: read, grep, find, ls, bash
---
body`);

const DEBUG = typeFrom(`---
name: debug
description: >
  no tools: key at all — pi hands this type the full default toolset
---
body`);

test("frontmatter: tools list parsed, block scalar skipped", () => {
  assert.equal(PLAN.name, "plan");
  assert.deepEqual(PLAN.tools, ["read", "grep", "find", "ls"]);
  assert.equal(PLAN.disallowedTools, undefined);
});

test("frontmatter: absent tools: key is the dangerous case and maps to wildcard", () => {
  assert.equal(DEBUG.tools, undefined);
  assert.deepEqual(ceilingFor(DEBUG), [WILDCARD]);
});

test("ceiling: explicit list, wildcard forms, and none", () => {
  assert.deepEqual(ceilingFor(PLAN), ["tool:find", "tool:grep", "tool:ls", "tool:read"]);
  assert.deepEqual(ceilingFor(typeFrom("---\nname: a\ntools: \"*\"\n---\n")), [WILDCARD]);
  assert.deepEqual(ceilingFor(typeFrom("---\nname: a\ntools: all\n---\n")), [WILDCARD]);
  assert.deepEqual(ceilingFor(typeFrom("---\nname: a\ntools: none\n---\n")), []);
});

test("ceiling: disallowed_tools subtracts, deny wins", () => {
  const t = typeFrom("---\nname: a\ntools: read, bash\ndisallowed_tools: bash\n---\n");
  assert.deepEqual(ceilingFor(t), ["tool:read"]);
});

test("ceiling: ext: selectors are preserved", () => {
  const t = typeFrom("---\nname: a\ntools: read, ext:pi-web-access/web_search\n---\n");
  assert.deepEqual(ceilingFor(t), ["ext:pi-web-access/web_search", "tool:read"]);
});

// ---- the real scenario, using the user's own agent types --------------------------------------

const PLAN_GRANT = ["tool:read", "tool:grep", "tool:find", "tool:ls"];

test("a plan-level session MAY spawn plan (equal ceiling)", () => {
  const d = decideSpawn({ subagentType: "plan" }, {
    parentGrant: PLAN_GRANT, depth: 0, maxDepth: 2, types: types(PLAN, REVIEW, DEBUG),
  });
  assert.equal(d.allow, true);
  assert.deepEqual(d.effective, ["tool:find", "tool:grep", "tool:ls", "tool:read"]);
});

test("a plan-level session may NOT spawn review — review needs bash", () => {
  const d = decideSpawn({ subagentType: "review" }, {
    parentGrant: PLAN_GRANT, depth: 0, maxDepth: 2, types: types(PLAN, REVIEW, DEBUG),
  });
  assert.equal(d.allow, false);
  assert.match(d.reason ?? "", /tool:bash/);
  assert.match(d.reason ?? "", /escalation blocked/);
});

test("a plan-level session may NOT spawn debug — no tools: key means full toolset", () => {
  const d = decideSpawn({ subagentType: "debug" }, {
    parentGrant: PLAN_GRANT, depth: 0, maxDepth: 2, types: types(PLAN, REVIEW, DEBUG),
  });
  assert.equal(d.allow, false);
  assert.match(d.reason ?? "", /full toolset/);
});

test("a wildcard-holding root may spawn anything, including debug", () => {
  for (const name of ["plan", "review", "debug"]) {
    const d = decideSpawn({ subagentType: name }, {
      parentGrant: [WILDCARD], depth: 0, maxDepth: 2, types: types(PLAN, REVIEW, DEBUG),
    });
    assert.equal(d.allow, true, `${name} should be allowed for a wildcard holder`);
  }
});

test("depth is enforced, and maxDepth 0 forbids spawning outright", () => {
  const ctx = { parentGrant: [WILDCARD], types: types(PLAN), gated: [] };
  assert.equal(decideSpawn({ subagentType: "plan" }, { ...ctx, depth: 2, maxDepth: 2 }).allow, false);
  assert.match(
    decideSpawn({ subagentType: "plan" }, { ...ctx, depth: 2, maxDepth: 2 }).reason ?? "",
    /depth limit reached \(2\)/,
  );
  assert.match(
    decideSpawn({ subagentType: "plan" }, { ...ctx, depth: 0, maxDepth: 0 }).reason ?? "",
    /spawning is disabled/,
  );
});

test("fails closed: unknown type, and missing subagent_type", () => {
  const ctx = { parentGrant: PLAN_GRANT, depth: 0, maxDepth: 2, types: types(PLAN) };
  const unknown = decideSpawn({ subagentType: "nope" }, ctx);
  assert.equal(unknown.allow, false);
  assert.match(unknown.reason ?? "", /unknown agent type/);

  const missing = decideSpawn({}, ctx);
  assert.equal(missing.allow, false);
  assert.match(missing.reason ?? "", /without a subagent_type/);
});

test("attenuation across levels: a review-level child cannot re-spawn debug", () => {
  const reviewGrant = decideSpawn({ subagentType: "review" }, {
    parentGrant: [WILDCARD], depth: 0, maxDepth: 3, types: types(PLAN, REVIEW, DEBUG),
  }).effective;
  const grandchild = decideSpawn({ subagentType: "debug" }, {
    parentGrant: reviewGrant, depth: 1, maxDepth: 3, types: types(PLAN, REVIEW, DEBUG),
  });
  assert.equal(grandchild.allow, false, "wildcard must not be re-acquired below the root");
});

test("gated capability blocks a spawn until approved", () => {
  const ctx = { parentGrant: ["tool:read", "tool:bash", "tool:grep", "tool:find", "tool:ls"], depth: 0, maxDepth: 2, types: types(REVIEW) };
  const blocked = decideSpawn({ subagentType: "review" }, { ...ctx, gated: ["tool:bash"] });
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason ?? "", /requires approval for tool:bash/);
  const approved = decideSpawn({ subagentType: "review" }, { ...ctx, gated: ["tool:bash"], approved: ["tool:bash"] });
  assert.equal(approved.allow, true);
});

test("a wildcard delegator is not told to obtain an approval it cannot obtain", () => {
  // ADR-0011 Finding 1 (docs/probes/adr-0011-universal). The gated check on the wildcard branch
  // correctly refuses, but the branch returns before a `ResolveResult` exists, and the extension guards
  // its approval flow with `shouldSeekApproval(decision.result)` — which is false for `undefined`. So no
  // dialog is ever offered, verified live with the driver armed to approve. Saying "requires approval"
  // sends the operator to find a human who cannot help: exactly the defect ADR-0011 removed from
  // `planDelegation`, reintroduced on the other path by the same change.
  const blocked = decideSpawn(
    { subagentType: "review" },
    { parentGrant: [WILDCARD], depth: 0, maxDepth: 2, types: types(REVIEW), gated: ["tool:bash"] },
  );
  assert.equal(blocked.allow, false, "the gate is the operator's, not the delegator's");
  assert.doesNotMatch(
    blocked.reason ?? "",
    /requires approval/,
    "no approval can be given on this path, so the reason must not name one",
  );
  assert.match(blocked.reason ?? "", /tool:bash/, "it must still say WHICH capability was gated");
  assert.match(
    blocked.reason ?? "",
    /PI_GRANTS_GRANT/,
    "and it must name the remedy: an enumerated grant is the path that can be approved",
  );
});

test("an approved gated capability still lets a wildcard delegator spawn", () => {
  const allowed = decideSpawn(
    { subagentType: "review" },
    {
      parentGrant: [WILDCARD],
      depth: 0,
      maxDepth: 2,
      types: types(REVIEW),
      gated: ["tool:bash"],
      approved: ["tool:bash"],
    },
  );
  assert.equal(allowed.allow, true, "an inherited or persisted approval must still be honoured here");
});

// ── ADR-0011: universal capabilities are refused on BOTH spawn paths ─────────────
//
// `ext:pi-fabric/fabric_exec` transitively confers the whole catalog — measured, not
// suspected (docs/probes/pi-fabric-eval, probes 2/4/7/8). Before ADR-0011 the interceptor
// treated it two different ways, neither of them a refusal: a wildcard holder had it
// silently stripped from `effective`, and an enumerated holder had it passed straight
// through. Both were cosmetic, because `Decision.effective` is a RECORD on this path —
// pi-subagents' Agent tool has no `tools` parameter, so the child received it regardless.

const FABRIC = typeFrom(`---
name: fabricator
tools: read, fabric_exec
---
body`);

test("ADR-0011: an enumerated delegator cannot spawn a type declaring a universal capability", () => {
  const d = decideSpawn(
    { subagentType: "fabricator" },
    { parentGrant: ["tool:read", "tool:fabric_exec"], depth: 0, maxDepth: 2, types: types(FABRIC) },
  );
  assert.equal(d.allow, false, "the child would receive the whole catalog");
  assert.match(d.reason ?? "", /fabric_exec/);
  assert.match(d.reason ?? "", /narrow/i, "the reason names WHY, not just what");
});

test("ADR-0011: a wildcard holder cannot either — silent stripping is gone", () => {
  const d = decideSpawn(
    { subagentType: "fabricator" },
    { parentGrant: [WILDCARD], depth: 0, maxDepth: 2, types: types(FABRIC) },
  );
  assert.equal(d.allow, false, "holding tool:* is authority to grant, not to defeat narrowing");
  assert.match(d.reason ?? "", /fabric_exec/);
});

test("ADR-0011: escalation still outranks the narrowing refusal", () => {
  // A type needing more than the parent holds is an escalation ATTEMPT — the more
  // important signal, and the one the ledger keys on. It must not be masked.
  const d = decideSpawn(
    { subagentType: "fabricator" },
    { parentGrant: ["tool:read"], depth: 0, maxDepth: 2, types: types(FABRIC) },
  );
  assert.equal(d.allow, false);
  assert.match(d.reason ?? "", /escalation/i, "reported as escalation, not as non-narrowing");
});

test("ADR-0011: an ordinary type is unaffected", () => {
  const d = decideSpawn(
    { subagentType: "plan" },
    { parentGrant: ["tool:read", "tool:bash"], depth: 0, maxDepth: 2, types: types(PLAN) },
  );
  assert.equal(d.allow, true, d.reason ?? "expected allow");
});

// Found independently by two reviews (A-S2 / B-C5). The wildcard branch returned `allow`
// before the gated check ever ran, so an operator who set PI_GRANTS_GATED without also
// setting PI_GRANTS_GRANT got a gate that silently did nothing. Fixed with ADR-0011
// because it is the same early return.
test("a wildcard holder still cannot skip a configured gate", () => {
  const d = decideSpawn(
    { subagentType: "review" },
    { parentGrant: [WILDCARD], depth: 0, maxDepth: 2, types: types(REVIEW), gated: ["tool:bash"] },
  );
  assert.equal(d.allow, false, "holding tool:* is authority to grant, not authority to skip a gate");
  assert.match(d.reason ?? "", /approval/i);
});

test("a wildcard holder proceeds once the gated capability is approved", () => {
  const d = decideSpawn(
    { subagentType: "review" },
    {
      parentGrant: [WILDCARD], depth: 0, maxDepth: 2, types: types(REVIEW),
      gated: ["tool:bash"], approved: ["tool:bash"],
    },
  );
  assert.equal(d.allow, true, d.reason ?? "expected allow");
});
