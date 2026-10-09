import assert from "node:assert/strict";
import { test } from "node:test";
import { createCapacityAllocator } from "../src/kernel/capacity.ts";
import { runOneDelegation } from "../extensions/run-delegation.ts";
import { registerDelegationTools } from "../extensions/delegation.ts";
import { createAutoModeAuthority, connectAutoMode } from "../src/governance/auto-mode-policy.ts";
const input = {
  operationId: "build:one",
  requestDigest: "a".repeat(64),
  executionId: "exec:one",
  cwd: "/tmp",
  workspaceId: null,
};

test("concurrent tree clients elect exactly one owner; conflicts and terminal replay cannot spawn", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  const a = connectAutoMode(owner.reference),
    b = connectAutoMode(owner.reference);
  try {
    const claims = await Promise.all([
      a.operations!.claim(input),
      b.operations!.claim({ ...input, executionId: "exec:two" }),
    ]);
    assert.equal(claims.filter((x) => !x.reused).length, 1);
    assert.equal(claims.filter((x) => x.reused).length, 1);
    const leader = claims.find((x) => !x.reused)!;
    assert.equal(claims[0].operation.executionId, claims[1].operation.executionId);
    await assert.rejects(b.operations!.claim({ ...input, requestDigest: "b".repeat(64) }), /identity conflict/);
    await leader.started!("/tmp/routed", "pilot");
    assert.equal((await a.operations!.read(input.operationId))?.cwd, "/tmp/routed");
    await leader.finish!("settled", {
      work: "succeeded",
      cleanup: { state: "settled", executionId: leader.operation.executionId, receiptPath: "/tmp/native-receipt" },
    });
    const again = await b.operations!.claim(input);
    assert.equal(again.reused, true);
    assert.equal(again.operation.state, "settled");
    assert.equal(again.finish, undefined);
    assert.equal((again as any).text, undefined, "no mutation output cache");
    assert.equal(await owner.admit(), false, "operation election does not enable Auto permission");
  } finally {
    await a.close();
    await b.close();
    await owner.close();
  }
});

test("lost claim owner stays uncertain; cancelled callers and foreign tokens never acquire authority", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  const child = connectAutoMode(owner.reference);
  try {
    await child.operations!.claim(input);
    await child.close();
    let record;
    for (let i = 0; i < 20; i++) {
      record = await owner.operations!.read(input.operationId);
      if (record?.state === "uncertain") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(record?.state, "uncertain");
    assert.equal((await owner.operations!.claim(input)).reused, true);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(owner.operations!.claim({ ...input, operationId: "cancelled" }, cancelled.signal), /aborted/);
    assert.equal(await owner.operations!.read("cancelled"), null);
    const foreign = connectAutoMode({ ...owner.reference, token: "0".repeat(48) });
    try {
      await assert.rejects(foreign.operations!.claim({ ...input, operationId: "foreign" }), /Unauthorized/);
    } finally {
      await foreign.close();
    }
    assert.equal(await owner.operations!.read("foreign"), null);
    await owner.close();
    await assert.rejects(owner.operations!.read(input.operationId), /unavailable/);
  } finally {
    await child.close();
    await owner.close();
  }
});

// A post-claim refresh can fail before any executor exists. Do not turn that proof into unresolved work.
test("prelaunch definition failure records not-started and releases its capacity", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  const capacity = createCapacityAllocator(1);
  try {
    const claim = await owner.operations!.claim(input);
    const session = {
      capacity,
      depth: 0,
      ensureDefinitions: async () => {
        throw Error("definitions unavailable");
      },
    };
    await assert.rejects(
      runOneDelegation(
        session as never,
        { task: "never execute", tools: [] },
        { executionId: input.executionId } as never,
        0,
        { cwd: "/tmp" } as never,
        undefined,
        { operationClaim: claim },
      ),
      /definitions unavailable/,
    );
    const operation = await owner.operations!.read(input.operationId);
    assert.equal(operation?.state, "not-started");
    assert.deepEqual(operation?.runtime?.cleanup, { state: "not-started" });
    assert.equal(capacity.reserved, 0);
    assert.equal((await owner.operations!.claim(input)).reused, true, "retry still needs an explicit new operation ID");
  } finally {
    await owner.close();
  }
});

// Reservation happens outside runOne in fanout. Its exception must finalize the elected, unlaunched operation.
test("fanout reservation failure does not strand an admitting operation", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  const context = { ownGrant: ["tool:read", "tool:delegate"], depth: 0, maxDepth: 2, gated: [] };
  const tools = new Map<string, any>();
  try {
    const session = {
      ...context,
      ownerBound: true,
      mayDelegate: true,
      ownSpawnId: "d0",
      autoMode: owner,
      definitions: new Map(),
      definitionRuntimeOverrides: new Map(),
      executor: { kind: "process" },
      capacity: {
        available: 1,
        retainedReservations: [],
        reserve: () => {
          throw Error("reservation unavailable");
        },
      },
      delegationContext: async () => context,
    };
    registerDelegationTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as never, session as never);
    await assert.rejects(
      tools.get("delegate_all").execute(
        "call",
        {
          children: [{ operation_id: "fanout:prelaunch", task: "never execute", tools: ["read"] }],
        },
        undefined,
        undefined,
        { cwd: "/tmp" },
      ),
      /reservation unavailable/,
    );
    const operation = await owner.operations!.read("fanout:prelaunch");
    assert.equal(operation?.state, "not-started");
    assert.deepEqual(operation?.runtime?.cleanup, { state: "not-started" });
  } finally {
    await owner.close();
  }
});
