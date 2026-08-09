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
