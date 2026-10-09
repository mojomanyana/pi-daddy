import assert from "node:assert/strict";
import { test } from "node:test";
import { qualifyHerdr } from "../src/executors/herdr-qualification.ts";
import { chooseExecutor } from "../src/executors/executor.ts";
const legacy = { status: "running", running: true, version: "0.8.2", protocol: 20, compatible: true };
const modern = {
  ...legacy,
  version: "0.9.0",
  protocol: 22,
  endpoint_compatible: true,
  capabilities: { endpoint_protocol_generation: 1 },
  server_binary_stale: true,
};

test("governed selection uses live CLI compatibility, not matching release strings or a fixed protocol", async () => {
  assert.ok(chooseExecutor("1", { ok: true }).refusal);
  for (const status of [
    legacy,
    modern,
    { ...modern, version: "0.9.3" },
    { ...modern, version: "future", protocol: 23 },
  ]) {
    const calls: string[][] = [];
    const result = await qualifyHerdr({ ok: true }, async (args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify(status), stderr: "" };
    });
    assert.deepEqual(calls, [["status", "server", "--json"]]);
    assert.equal(result.qualified, true, JSON.stringify(result));
    assert.equal(chooseExecutor("1", result).refusal, undefined);
  }
});

test("endpoint compatibility cannot bypass incompatible, missing or malformed CLI status", async () => {
  const statuses = [
    { ...modern, compatible: false },
    { ...modern, compatible: "yes" },
    { ...modern, compatible: undefined },
    { ...modern, protocol: 0 },
    { ...modern, protocol: "22" },
    { ...modern, protocol: 22.5 },
    { ...modern, running: false },
    { ...modern, status: "stopped" },
    { ...modern, endpoint_compatible: false },
    { ...modern, endpoint_compatible: undefined },
    null,
    {},
    [],
  ];
  for (const status of statuses) {
    const result = await qualifyHerdr({ ok: true }, async () => ({
      code: 0,
      stdout: JSON.stringify(status),
      stderr: "",
    }));
    assert.equal(result.qualified, false, JSON.stringify(status));
    assert.ok(chooseExecutor("1", result).refusal);
  }
});

test("status command and transport failures refuse without a fallback", async () => {
  for (const reply of [
    { code: 1, stdout: JSON.stringify(modern), stderr: "status failed" },
    { code: 0, stdout: "not json", stderr: "" },
  ]) {
    const result = await qualifyHerdr({ ok: true }, async () => reply);
    assert.equal(result.qualified, false);
    assert.equal(chooseExecutor("1", result).kind, "herdr");
    assert.ok(chooseExecutor("1", result).refusal);
  }
  const unavailable = { ok: false, error: "not reachable" };
  assert.equal(
    await qualifyHerdr(unavailable, async () => {
      throw Error("must not query");
    }),
    unavailable,
  );
});
