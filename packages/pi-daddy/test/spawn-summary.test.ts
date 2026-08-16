/**
 * The startup line that says what is spawnable, and what is being withheld (B1 / P4).
 *
 * **The production changes that break these tests** (rule 7), one per case:
 *
 *  - counting every discovered definition as spawnable — i.e. dropping the classification and reporting the
 *    map size, which is what the line looked like before it distinguished the two;
 *  - reporting a gate as an escalation, or an escalation as a gate. They have different fixes (answer a
 *    dialog vs. widen the grant) and `planDelegation` decides escalation first for a reason: a capability
 *    the session does not hold cannot be approved into existence;
 *  - returning `null` when nothing is spawnable — the handoff proposed printing "only when at least one
 *    definition is spawnable", which is silent for exactly the operator in P2's state (seven skills
 *    installed, none declaring `allowed-tools`, every spawn refused);
 *  - dropping the "… and N more" clause, so a large skill root silently truncates (R-48's shape).
 *
 * The classification cases drive the summariser through **the real `planDelegation`**, not a hand-written
 * stand-in, so a change to what refuses a spawn changes what this test sees. That is the point: the line
 * exists to agree with the enforcer, and two diagnostics in this package have already disagreed with it
 * (R-28, R-38).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { planDelegation } from "../src/delegate.ts";
import type { SkillDefinition } from "../src/definitions.ts";
import type { Capability } from "../src/resolve.ts";
import { renderSpawnableSummary, summariseSpawnable, type SpawnableSummary } from "../extensions/spawn-summary.ts";

function definition(name: string, allowedTools?: string): SkillDefinition {
  return {
    name,
    description: `the ${name} definition`,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    body: `do ${name}`,
    source: `/p/.pi/skills/${name}/SKILL.md`,
  };
}

/** The real planner, wrapped in the shape `summariseSpawnable` consumes. No approvals, no human, no I/O. */
function previewWith(definitions: Map<string, SkillDefinition>, ownGrant: Capability[], gated: Capability[] = []) {
  return async (name: string) => ({
    plan: planDelegation({ task: "(preview)", agent: name }, { ownGrant, depth: 0, maxDepth: 2, gated, definitions }),
  });
}

test("each definition is classified by what actually blocks it", async () => {
  const definitions = new Map(
    [
      definition("review", "Read, Grep"), // fully held
      // `Delegate` rather than `Write` on purpose, and this is the measured part: the grant below holds
      // `tool:bash`, and `SUBSUMPTION` says bash confers write — so a ceiling of `Read, Write` is COVERED
      // here and spawnable. Reasoning said otherwise; `resolve()` was right. `tool:delegate` is subsumed by
      // nothing, so it is a genuine escalation.
      definition("build", "Read, Delegate"),
      definition("deploy", "Read, Bash"), // held, but bash is gated
      definition("notes"), // no allowed-tools at all
      definition("secret", "Read"), // held ceiling, but no agent:secret
    ].map((d) => [d.name, d]),
  );

  const summary = await summariseSpawnable(
    definitions,
    previewWith(
      definitions,
      ["agent:review", "agent:build", "agent:deploy", "agent:notes", "tool:read", "tool:grep", "tool:bash"],
      ["tool:bash"],
    ),
  );

  assert.deepEqual(summary.spawnable, ["review"]);
  assert.deepEqual(summary.withheld, [
    { name: "build", reason: "capability", missing: ["tool:delegate"] },
    { name: "deploy", reason: "approval", missing: ["tool:bash"] },
    { name: "notes", reason: "declaration", missing: [] },
    // ADR-0017's authorisation refusal is an escalation, not a file problem: the fix is the grant.
    { name: "secret", reason: "capability", missing: ["agent:secret"] },
  ]);
});

test("an escalation is reported ahead of a gate, because approval cannot conjure a capability", async () => {
  // `deploy` needs BOTH a capability this session lacks (`tool:write`) and one that is held but gated
  // (`tool:read`, gated here to make the case in two lines). Answering the dialog would not make it
  // spawnable, so reporting "needs your approval" would send the operator to the wrong fix.
  const definitions = new Map([["deploy", definition("deploy", "Read, Write")]]);
  const summary = await summariseSpawnable(
    definitions,
    previewWith(definitions, ["agent:deploy", "tool:read"], ["tool:read"]),
  );

  assert.deepEqual(summary.withheld, [{ name: "deploy", reason: "capability", missing: ["tool:write"] }]);
});

test("nothing spawnable still speaks — that is P2's state, and the one worth reporting", () => {
  const summary: SpawnableSummary = {
    spawnable: [],
    withheld: ["architect", "build", "decide", "plan", "review"].map((name) => ({
      name,
      reason: "declaration" as const,
      missing: [],
    })),
  };
  const line = renderSpawnableSummary(summary);
  assert.ok(line, "a session with definitions and no spawnable one must not be silent");
  assert.match(line, /0 of 5 definitions spawnable/);
  assert.match(line, /withheld: architect, build, decide, plan, review/);
});

test("no definitions at all says nothing", () => {
  assert.equal(renderSpawnableSummary({ spawnable: [], withheld: [] }), null);
});

test("a long list is truncated with the remainder COUNTED, never silently dropped", () => {
  const names = Array.from({ length: 11 }, (_, i) => `skill-${String(i).padStart(2, "0")}`);
  const line = renderSpawnableSummary({ spawnable: names, withheld: [] });
  assert.match(line ?? "", /11 of 11 definitions spawnable/);
  assert.match(line ?? "", /skill-07 … and 3 more/);
  assert.doesNotMatch(line ?? "", /skill-08/);
});

test("both halves are named: the spawnable ones and why the others are not", () => {
  const line =
    renderSpawnableSummary({
      spawnable: ["decide", "review"],
      withheld: [
        { name: "build", reason: "capability", missing: ["agent:build", "tool:bash"] },
        { name: "deploy", reason: "approval", missing: ["tool:bash"] },
      ],
    }) ?? "";

  assert.match(line, /2 of 4 definitions spawnable — decide, review/);
  assert.match(line, /withheld: build — need agent:build, tool:bash, which this session does not hold/);
  assert.match(line, /withheld: deploy — need your approval for tool:bash/);
});
