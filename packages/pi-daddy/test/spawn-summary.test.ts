/**
 * The startup line that says what is spawnable, and what is being withheld (B1 / P4).
 *
 * **The production changes that break these tests** (rule 7), one per case:
 *
 *  - counting every discovered definition as spawnable — dropping the classification and reporting the map
 *    size, which is what the line looked like before it distinguished the two;
 *  - reporting a gate as an escalation, or an escalation as a gate. They have different fixes (answer a
 *    dialog vs. widen the grant) and `planDelegation` decides escalation first for a reason;
 *  - returning `null` when nothing is spawnable — the handoff proposed printing "only when at least one
 *    definition is spawnable", which is silent for exactly the operator in P2's state;
 *  - dropping the "… and N more" clause, so a large skill root silently truncates (R-48's shape);
 *  - **classifying a session-level refusal as a per-definition one** (R-81) — ignoring `mayDelegate`, or
 *    previewing definitions when the depth bound already forbids every spawn;
 *  - **grouping the missing capabilities** across withheld definitions (R-82), which reported one
 *    definition as needing another's;
 *  - discarding `plan.reason` for the refusals the two designated signals do not explain (R-81).
 *
 * The classification cases drive the summariser through **the real `planDelegation`**, not a hand-written
 * stand-in, so a change to what refuses a spawn changes what this test sees. That is the point: the line
 * exists to agree with the enforcer, and two diagnostics in this package had already disagreed with it
 * (R-28, R-38) before this line became the third (R-81).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { planDelegation } from "../src/delegate.ts";
import type { SkillDefinition } from "../src/definitions.ts";
import type { Capability } from "../src/resolve.ts";
import {
  renderSpawnableSummary,
  summariseSpawnable,
  type SessionFacts,
  type SpawnableSummary,
} from "../extensions/spawn-summary.ts";

function definition(name: string, allowedTools?: string): SkillDefinition {
  return {
    name,
    description: `the ${name} definition`,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    body: `do ${name}`,
    source: `/p/.pi/skills/${name}/SKILL.md`,
  };
}

const ABLE: SessionFacts = { mayDelegate: true, depth: 0, maxDepth: 2 };

/** The real planner, wrapped in the shape `summariseSpawnable` consumes. No approvals, no human, no I/O. */
function previewWith(
  definitions: Map<string, SkillDefinition>,
  ownGrant: Capability[],
  gated: Capability[] = [],
  session: SessionFacts = ABLE,
) {
  return async (name: string) => ({
    plan: planDelegation(
      { task: "(preview)", agent: name },
      { ownGrant, depth: session.depth, maxDepth: session.maxDepth, gated, definitions },
    ),
  });
}

test("each definition is classified by what actually blocks it", async () => {
  const definitions = new Map(
    [
      definition("review", "Read, Grep"), // fully held
      // `Delegate` rather than `Write` on purpose, and this is the measured part: the grant below holds
      // `tool:bash`, and `SUBSUMPTION` says bash confers write — so a ceiling of `Read, Write` is COVERED
      // here and spawnable. Reasoning said otherwise; `resolve()` was right.
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
    ABLE,
  );

  assert.deepEqual(summary.spawnable, ["review"]);
  assert.deepEqual(
    summary.withheld.map((w) => [w.name, w.reason, w.missing]),
    [
      ["build", "capability", ["tool:delegate"]],
      ["deploy", "approval", ["tool:bash"]],
      ["notes", "declaration", []],
      // ADR-0017's authorisation refusal is an escalation, not a file problem: the fix is the grant.
      ["secret", "capability", ["agent:secret"]],
    ],
  );
  // The `declaration` bucket carries the ENFORCER's words rather than a category this module invented.
  assert.match(summary.withheld[2].reasonText ?? "", /declares no `allowed-tools`/);
});

test("an escalation is reported ahead of a gate, because approval cannot conjure a capability", async () => {
  const definitions = new Map([["deploy", definition("deploy", "Read, Write")]]);
  const summary = await summariseSpawnable(
    definitions,
    previewWith(definitions, ["agent:deploy", "tool:read"], ["tool:read"]),
    ABLE,
  );

  assert.deepEqual(summary.withheld.map((w) => [w.name, w.reason]), [["deploy", "capability"]]);
});

test("R-81: a session that cannot delegate says so, and previews nothing", async () => {
  // `registerDelegationTools` returns early without `tool:delegate`, so the session has NO delegate tool
  // and can spawn nothing — while the line reported definitions as spawnable. The exact question this line
  // exists to answer, answered wrong in the one session where nothing can ever run.
  const definitions = new Map([["review", definition("review", "Read")]]);
  let previews = 0;
  const summary = await summariseSpawnable(
    definitions,
    async (name) => {
      previews += 1;
      return previewWith(definitions, ["agent:review", "tool:read"])(name);
    },
    { mayDelegate: false, depth: 0, maxDepth: 2 },
  );

  assert.equal(previews, 0, "previewing to print one environment problem N times is wrong and wasteful");
  assert.deepEqual(summary.spawnable, []);
  assert.match(summary.sessionBlocked ?? "", /no tool:delegate/);
  assert.match(renderSpawnableSummary(summary, 1) ?? "", /1 definition found, none spawnable — .*no tool:delegate/);
});

test("R-81: a depth bound is a fact about the SESSION, never about the files", async () => {
  const definitions = new Map([
    ["a", definition("a", "Read")],
    ["b", definition("b", "Read")],
  ]);
  const grant = ["agent:a", "agent:b", "tool:read"];

  // maxDepth 0 — which is also what a MALFORMED PI_GRANTS_MAX_DEPTH produces, failing closed.
  const disabled = await summariseSpawnable(definitions, previewWith(definitions, grant), {
    mayDelegate: true,
    depth: 0,
    maxDepth: 0,
  });
  assert.match(disabled.sessionBlocked ?? "", /spawning is disabled for this session/);
  assert.doesNotMatch(
    renderSpawnableSummary(disabled, 2) ?? "",
    /files? (is|are) written/,
    "blaming two well-formed SKILL.md files for one environment variable is what R-81 was",
  );

  // At the limit: a grandchild in a default session.
  const atLimit = await summariseSpawnable(definitions, previewWith(definitions, grant), {
    mayDelegate: true,
    depth: 2,
    maxDepth: 2,
  });
  assert.match(atLimit.sessionBlocked ?? "", /depth limit \(2 of 2\)/);
});

test("R-82: each withheld definition names ITS OWN missing capabilities", () => {
  const line =
    renderSpawnableSummary(
      {
        spawnable: [],
        notChecked: 0,
        withheld: [
          { name: "alpha", reason: "capability", missing: ["tool:bash"] },
          { name: "beta", reason: "capability", missing: ["agent:beta"] },
        ],
      },
      2,
    ) ?? "";

  assert.match(line, /alpha \(needs tool:bash\)/);
  assert.match(line, /beta \(needs agent:beta\)/);
  assert.doesNotMatch(line, /alpha \(needs agent:beta/, "the union across a group misattributed the fix");
});

test("ADR-0024: a gated agent: id is the PARENT's authority, not something a child receives", () => {
  const line =
    renderSpawnableSummary(
      { spawnable: [], notChecked: 0, withheld: [{ name: "deploy", reason: "approval", missing: ["agent:deploy"] }] },
      1,
    ) ?? "";
  assert.match(line, /deploy \(needs your approval for agent:deploy\)/);
  assert.doesNotMatch(line, /before a child receives/, "ADR-0024 says the id never reaches the child");
});

test("nothing spawnable still speaks — that is P2's state, and the one worth reporting", () => {
  const summary: SpawnableSummary = {
    spawnable: [],
    notChecked: 0,
    withheld: ["architect", "build", "decide", "plan", "review"].map((name) => ({
      name,
      reason: "declaration" as const,
      missing: [],
      reasonText: "declares no `allowed-tools`",
    })),
  };
  const line = renderSpawnableSummary(summary, 5);
  assert.ok(line, "a session with definitions and no spawnable one must not be silent");
  assert.match(line, /0 of 5 definitions spawnable/);
  assert.match(line, /withheld: architect \(declares no `allowed-tools`\)/);
});

test("no definitions at all says nothing", () => {
  assert.equal(renderSpawnableSummary({ spawnable: [], withheld: [], notChecked: 0 }, 0), null);
});

test("a long list is truncated with the remainder COUNTED, never silently dropped", () => {
  const names = Array.from({ length: 11 }, (_, i) => `skill-${String(i).padStart(2, "0")}`);
  const line = renderSpawnableSummary({ spawnable: names, withheld: [], notChecked: 3 }, 14) ?? "";
  assert.match(line, /11 of 14 definitions spawnable/);
  assert.match(line, /skill-07 … and 3 more/);
  assert.doesNotMatch(line, /skill-08/);
  assert.match(line, /3 more not checked \(first 24 only\)/, "the preview cap must state what it dropped");
});

test("a definition name is third-party text, so a newline cannot forge a line", () => {
  const line =
    renderSpawnableSummary({ spawnable: ["ok\ngrants: everything is fine"], withheld: [], notChecked: 0 }, 1) ?? "";
  assert.equal(line.split("\n").length, 1, "a name with a newline used to print a second `grants:` line");
  assert.match(line, /"ok\\ngrants/);
});

test("both halves are named: the spawnable ones and why the others are not", () => {
  const line =
    renderSpawnableSummary(
      {
        spawnable: ["decide", "review"],
        notChecked: 0,
        withheld: [
          { name: "build", reason: "capability", missing: ["agent:build", "tool:bash"] },
          { name: "deploy", reason: "approval", missing: ["tool:bash"] },
        ],
      },
      4,
    ) ?? "";

  assert.match(line, /2 of 4 definitions spawnable — decide, review/);
  assert.match(line, /build \(needs agent:build, tool:bash\)/);
  assert.match(line, /deploy \(needs your approval for tool:bash\)/);
});
