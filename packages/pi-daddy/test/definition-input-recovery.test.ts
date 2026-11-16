import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDefinitionIdentity } from "../extensions/definition-describe.ts";
import { registerDelegationTools } from "../extensions/delegation.ts";
import { claimDelegationOperation } from "../extensions/delegation-operations.ts";
import { createAutoModeAuthority } from "../src/governance/auto-mode-policy.ts";
import type { SkillDefinition } from "../src/kernel/definitions.ts";

const definition: SkillDefinition = Object.freeze({
  name: "build",
  description: "Build a local change",
  allowedTools: "read",
  body: "Read the selected file.",
  source: "/fixture/build/SKILL.md",
  definitionId: "a".repeat(64),
});

async function fixture() {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  const tools = new Map<string, any>();
  const counts = { claims: 0, reservations: 0, executions: 0 };
  const session = {
    ownGrant: ["tool:read", "tool:delegate", "agent:build"],
    gated: [],
    depth: 0,
    maxDepth: 2,
    ownerBound: true,
    mayDelegate: true,
    ownSpawnId: "d0",
    autoMode: {
      ...owner,
      operations: {
        ...owner.operations!,
        claim: (...args: Parameters<NonNullable<typeof owner.operations>["claim"]>) => {
          counts.claims++;
          return owner.operations!.claim(...args);
        },
      },
    },
    definitions: new Map([["build", definition]]),
    definitionRuntimeOverrides: new Map(),
    ensureDefinitions: async () => {},
    executor: {
      kind: "process",
      execute: () => {
        counts.executions++;
        throw Error("input-only checks must not execute a child");
      },
    },
    capacity: {
      available: 2,
      retainedReservations: [],
      reserve: () => {
        counts.reservations++;
        throw Error("invalid definition input must not reserve capacity");
      },
    },
    delegationContext: async () => ({
      ownGrant: session.ownGrant,
      definitions: session.definitions,
      depth: session.depth,
      maxDepth: session.maxDepth,
      gated: session.gated,
    }),
  };
  registerDelegationTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as never, session as never);
  return { owner, session, tools, counts };
}

test("describe returns the exact dispatch pair without claiming work or widening authority", async () => {
  const f = await fixture();
  try {
    const result = await f.tools.get("delegate_describe").execute("describe", { agent: "build" });
    const pair = { agent: "build", definitionId: definition.definitionId };
    assert.deepEqual(result.details.delegationArguments, pair);
    assert.deepEqual(JSON.parse(result.content[0].text).delegationArguments, pair);
    assertDefinitionIdentity(f.session as never, result.details.delegationArguments);
    assert.deepEqual(f.counts, { claims: 0, reservations: 0, executions: 0 });
    assert.equal(await f.owner.admit(), false, "describing is not permission approval");
    const single = f.tools.get("delegate").parameters.properties;
    const batch = f.tools.get("delegate_all").parameters.properties.children.items.properties;
    const chain = f.tools.get("delegate_chain").parameters.properties.steps.items.properties;
    for (const schema of [single, batch, chain]) {
      assert.match(schema.definitionId.description, /Copy its agent together/);
      assert.match(schema.agent.description, /delegationArguments/);
    }
    f.session.ownGrant = ["tool:read", "tool:delegate"];
    await assert.rejects(
      f.tools.get("delegate_describe").execute("describe-revoked", { agent: "build" }),
      /outside this session's grant/,
    );
  } finally {
    await f.owner.close();
  }
});

test("missing, unknown and stale definition inputs have distinct corrective errors and are never guessed", async () => {
  const f = await fixture();
  try {
    const cases = [
      [{ definitionId: definition.definitionId }, /Missing delegation agent.*BOTH agent and definitionId/],
      [
        { agent: "buid", definitionId: definition.definitionId },
        /agent "buid" is not in the current selected definitions/,
      ],
      [
        { agent: "build", definitionId: "wrong" },
        /snapshot changed or is unavailable.*supplied definitionId does not match/,
      ],
    ] as const;
    for (const [spec, message] of cases) {
      const original = { ...spec };
      assert.throws(
        () => assertDefinitionIdentity(f.session as never, spec),
        (error: Error) => {
          assert.match(error.message, message);
          assert.doesNotMatch(error.message, /before operation admission|started no child/);
          return true;
        },
      );
      assert.deepEqual(spec, original, "no inferred agent or replacement ID");
    }
    f.session.definitions.set("build", { ...definition, binding: { package: "principal-pi-skills", phase: "build" } });
    assert.throws(
      () => assertDefinitionIdentity(f.session as never, { agent: "build" }),
      /Principal delegation.*missing definitionId/,
    );
    assertDefinitionIdentity(f.session as never, { agent: "build", definitionId: definition.definitionId });
    assertDefinitionIdentity(f.session as never, {});
    f.session.definitions.set("build", { ...definition, definitionId: undefined });
    assertDefinitionIdentity(f.session as never, { agent: "build" });
    assert.deepEqual(f.counts, { claims: 0, reservations: 0, executions: 0 });
  } finally {
    await f.owner.close();
  }
});

for (const surface of ["delegate", "delegate_all", "delegate_chain"]) {
  test(`${surface} input correction leaves operation IDs unused until corrected and retains repeat protection`, async () => {
    const f = await fixture();
    const first = {
      operation_id: "correction:first",
      agent: "build",
      definitionId: definition.definitionId,
      task: "Read the selected file",
    };
    const second = { operation_id: "correction:second", definitionId: definition.definitionId, task: first.task };
    try {
      const args =
        surface === "delegate" ? second : { [surface === "delegate_all" ? "children" : "steps"]: [first, second] };
      await assert.rejects(
        f.tools.get(surface).execute("invalid", args, undefined, undefined, { cwd: "/tmp" }),
        (error: Error) => {
          assert.match(error.message, /Missing delegation agent/);
          assert.match(error.message, /This call stopped before operation admission; it started no child/);
          assert.match(error.message, /does not establish whether an earlier call used the same operation ID/);
          return true;
        },
      );
      assert.deepEqual(f.counts, { claims: 0, reservations: 0, executions: 0 });
      assert.equal(await f.owner.operations!.read(first.operation_id), null, "earlier batch entries are not consumed");
      assert.equal(await f.owner.operations!.read(second.operation_id), null);
      const described = await f.tools.get("delegate_describe").execute("describe", { agent: "build" });
      const corrected = { ...second, ...described.details.delegationArguments };
      const ids = { executionId: "exec:correction", parentId: "d0", childId: "d0.0" };
      const claim = await claimDelegationOperation(
        f.session as never,
        corrected,
        ids as never,
        { cwd: "/tmp" } as never,
      );
      assert.equal(claim?.reused, false, "the original caller ID is still usable after an input-only refusal");
      await assert.rejects(
        f.tools.get(surface).execute("invalid-after-admission", args, undefined, undefined, { cwd: "/tmp" }),
        /does not establish whether an earlier call used the same operation ID/,
      );
      const existing = await f.owner.operations!.read(second.operation_id);
      assert.equal(existing?.state, "admitting", "a later bad call cannot revoke or reinterpret earlier admission");
      assert.equal(existing?.executionId, claim?.operation.executionId);
      assert.equal(f.counts.claims, 1, "the contextual no-start statement refers only to the rejected call");
      const repeated = await claimDelegationOperation(
        f.session as never,
        corrected,
        { ...ids, executionId: "exec:repeated" } as never,
        { cwd: "/tmp" } as never,
      );
      assert.equal(repeated?.reused, true);
      assert.equal(repeated?.operation.executionId, claim?.operation.executionId);
      await claim!.finish!("not-started", { cleanup: { state: "not-started" } });
      const terminal = await claimDelegationOperation(
        f.session as never,
        corrected,
        ids as never,
        { cwd: "/tmp" } as never,
      );
      assert.equal(terminal?.reused, true, "terminal IDs retain their existing no-replay semantics");
      assert.equal(f.counts.executions, 0);
      assert.equal(f.counts.reservations, 0);
    } finally {
      await f.owner.close();
    }
  });
}

test("a described pair cannot bypass an agent grant withdrawn before corrected admission", async () => {
  const f = await fixture();
  try {
    const described = await f.tools.get("delegate_describe").execute("describe", { agent: "build" });
    f.session.ownGrant = ["tool:delegate", "tool:read"];
    await assert.rejects(
      claimDelegationOperation(
        f.session as never,
        { operation_id: "revoked:pair", ...described.details.delegationArguments, task: "Read" },
        { executionId: "exec:revoked", parentId: "d0", childId: "d0.0" } as never,
        { cwd: "/tmp" } as never,
      ),
      /not.*grant|outside.*grant|not authorized|not in your grant/,
    );
    assert.equal(f.counts.executions, 0);
    assert.equal(f.counts.reservations, 0);
    assert.equal((await f.owner.operations!.read("revoked:pair"))?.state, "not-started");
  } finally {
    await f.owner.close();
  }
});
