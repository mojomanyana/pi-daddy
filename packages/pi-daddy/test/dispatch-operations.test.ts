import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import { createCapacityAllocator } from "../src/kernel/capacity.ts";
import { runOneDelegation } from "../extensions/run-delegation.ts";
import { registerDelegationTools } from "../extensions/delegation.ts";
import { claimDelegationOperation } from "../extensions/delegation-operations.ts";
import type { GrantsSession } from "../extensions/session.ts";
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

function refusedWorkspaceHarness(owner: Awaited<ReturnType<typeof createAutoModeAuthority>>, ledgerPath?: string) {
  const tools = new Map<string, any>();
  let reservations = 0;
  const session = {
    ownGrant: ["tool:read", "tool:delegate"],
    gated: [],
    depth: 0,
    maxDepth: 2,
    ownerBound: true,
    mayDelegate: true,
    ownSpawnId: "d0",
    autoMode: owner,
    ledgerPath,
    definitions: new Map(),
    definitionRuntimeOverrides: new Map(),
    ensureDefinitions: async () => {},
    executor: { kind: "process" },
    capacity: {
      available: 1,
      retainedReservations: [],
      reserve: () => {
        reservations++;
        throw Error("refused request must never reserve capacity");
      },
    },
    delegationContext: async () => ({
      ownGrant: session.ownGrant,
      depth: session.depth,
      maxDepth: session.maxDepth,
      gated: session.gated,
    }),
  };
  registerDelegationTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as never, session as never);
  return { tools, session, reservations: () => reservations };
}
const routedSpec = {
  operation_id: "routing:refused",
  task: "must not execute",
  tools: ["read"],
  workspace: { workspace_id: "pilot", access: "read" as const },
};

async function failingLedgerPath() {
  const parent = join(await tempDir("operation-ledger-"), "not-a-directory");
  await writeFile(parent, "ordinary file blocks ledger parent creation");
  return join(parent, "grants.jsonl");
}

// Moving election after a throwing refusal or ledger append loses the only native no-start evidence.
for (const ledger of ["absent", "broken"]) {
  for (const tool of ["delegate", "delegate_all", "delegate_chain"]) {
    test(`${tool}: ${ledger} ledger cannot lose routing refusal or no-start evidence`, async () => {
      const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
      try {
        const harness = refusedWorkspaceHarness(owner, ledger === "broken" ? await failingLedgerPath() : undefined);
        const refused = (error: any) => {
          assert.equal(error.code, "WORKSPACE_NOT_AUTHORIZED");
          if (ledger === "broken") {
            assert.match(error.message, /ledger evidence unavailable.*grant ledger write failed/);
            assert.ok(error.cause instanceof Error);
          }
          return true;
        };
        const params =
          tool === "delegate" ? routedSpec : { [tool === "delegate_all" ? "children" : "steps"]: [routedSpec] };
        const dispatch = () =>
          harness.tools.get(tool).execute("refused-call", params, undefined, undefined, { cwd: "/tmp" });
        await assert.rejects(dispatch(), refused);
        const original = await owner.operations!.read(routedSpec.operation_id);
        assert.equal(original?.state, "not-started");
        assert.deepEqual(original?.runtime?.cleanup, { state: "not-started" });
        assert.equal(original?.workspaceId, "pilot");
        await assert.rejects(dispatch(), refused);
        assert.deepEqual(
          await owner.operations!.read(routedSpec.operation_id),
          original,
          "duplicate refusal cannot replace the first occurrence",
        );
        assert.equal(harness.reservations(), 0);
        assert.equal(await owner.admit(), false, "recording refusal must not enable Auto");
      } finally {
        await owner.close();
      }
    });
  }
}

test("ledger and owner failures remain independently visible without rewriting a running operation", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  try {
    const original = await owner.operations!.claim({ ...input, operationId: routedSpec.operation_id });
    await original.started!("/tmp", null);
    const before = await owner.operations!.read(routedSpec.operation_id);
    const { tools, reservations } = refusedWorkspaceHarness(owner, await failingLedgerPath());
    const check = async (operationError: RegExp) => {
      await assert.rejects(
        tools.get("delegate").execute("combined-failure", routedSpec, undefined, undefined, { cwd: "/tmp" }),
        (error: any) => {
          assert.equal(error.code, "WORKSPACE_NOT_AUTHORIZED");
          assert.match(error.message, /ledger evidence unavailable.*grant ledger write failed/);
          assert.match(error.message, operationError);
          assert.ok(error.cause instanceof AggregateError);
          assert.equal(error.cause.errors.length, 2);
          assert.match(String(error.cause.errors[0]), /grant ledger write failed/);
          assert.match(String(error.cause.errors[1]), operationError);
          return true;
        },
      );
    };
    await check(/identity conflict/);
    assert.deepEqual(await owner.operations!.read(routedSpec.operation_id), before);
    await owner.close();
    await check(/Operation owner unavailable/);
    assert.equal(reservations(), 0);
  } finally {
    await owner.close();
  }
});

test("correcting a grant does not replay a refused ID; an explicit retry receives a separate admission", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  try {
    const { session } = refusedWorkspaceHarness(owner);
    const claim = (spec: typeof routedSpec) =>
      claimDelegationOperation(
        session as unknown as GrantsSession,
        spec,
        { executionId: "exec:retry", parentId: "d0", childId: "d0.0" } as never,
        { cwd: "/tmp" } as never,
      );
    await assert.rejects(claim(routedSpec), { code: "WORKSPACE_NOT_AUTHORIZED" });
    const original = await owner.operations!.read(routedSpec.operation_id);
    session.ownGrant.push("workspace:pilot"); // Fixture-only operator grant correction.
    await assert.rejects(claim(routedSpec), /identity conflict/);
    const retry = await claim({ ...routedSpec, operation_id: "routing:retry" });
    assert.equal(retry?.reused, false);
    assert.equal(retry?.operation.state, "admitting");
    assert.deepEqual(await owner.operations!.read(routedSpec.operation_id), original);
    await retry!.finish!("not-started", { cleanup: { state: "not-started" } });
  } finally {
    await owner.close();
  }
});

test("a conflicting denied request preserves existing running ownership and the typed refusal", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  try {
    const original = await owner.operations!.claim({ ...input, operationId: routedSpec.operation_id });
    await original.started!("/tmp", null);
    const before = await owner.operations!.read(routedSpec.operation_id);
    const { tools, reservations } = refusedWorkspaceHarness(owner);
    await assert.rejects(
      tools.get("delegate").execute("conflict", routedSpec, undefined, undefined, { cwd: "/tmp" }),
      (error: any) => {
        assert.equal(error.code, "WORKSPACE_NOT_AUTHORIZED");
        assert.match(error.message, /operation evidence unavailable.*identity conflict/);
        return true;
      },
    );
    assert.deepEqual(await owner.operations!.read(routedSpec.operation_id), before);
    assert.equal(reservations(), 0);
    await original.finish!("settled", { cleanup: { state: "settled" } });
  } finally {
    await owner.close();
  }
});

test("unavailable operation recording remains a loud typed refusal, never a no-start claim", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  const { tools, reservations } = refusedWorkspaceHarness(owner);
  await owner.close();
  await assert.rejects(
    tools.get("delegate").execute("unavailable", routedSpec, undefined, undefined, { cwd: "/tmp" }),
    (error: any) => {
      assert.equal(error.code, "WORKSPACE_NOT_AUTHORIZED");
      assert.match(error.message, /operation evidence unavailable/);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
  assert.equal(reservations(), 0);
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
