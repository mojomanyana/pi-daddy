import assert from "node:assert/strict";
import { test } from "node:test";
import { qualifyHerdr } from "../src/executors/herdr-qualification.ts";
import { chooseExecutor } from "../src/executors/executor.ts";
test("reachable Herdr requires measured client and server transport versions before governed selection", async () => {
  const exec = async (args: string[]) => ({
    code: 0,
    stderr: "",
    stdout:
      args[0] === "--version" ? "herdr 0.8.2\n" : "status: running\nversion: 0.8.2\nprotocol: 20\ncompatible: yes\n",
  });
  assert.ok(chooseExecutor("1", { ok: true }).refusal);
  const qualified = await qualifyHerdr({ ok: true }, exec);
  assert.equal(qualified.qualified, true);
  assert.equal(chooseExecutor("1", qualified).refusal, undefined);
  for (const field of ["version: 0.8.2", "protocol: 20", "compatible: yes"]) {
    const result = await qualifyHerdr({ ok: true }, async (args) => {
      const r = await exec(args);
      return { ...r, stdout: r.stdout.replace(field, field + ":changed") };
    });
    assert.equal(result.qualified, false);
    assert.ok(chooseExecutor("1", result).refusal);
  }
});
