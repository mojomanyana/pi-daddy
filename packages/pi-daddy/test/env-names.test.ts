import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  adoptLegacyEnvironment,
  ENV_GRANT,
  GOVERNANCE_ENV_KEYS,
  LEGACY_ENV_NAMES,
  legacyEnvironmentWarning,
} from "../src/kernel/env-names.ts";
import { DELEGATE_CAPABILITY, planDelegation } from "../src/kernel/delegate.ts";

const packageRoot = join(import.meta.dirname, "..");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

// ADR-0076 PR 3b: one namespace. Production change that breaks this: a new `PI_DADDY_*` literal anywhere
// in shipped code outside the legacy table, or a governance key that does not start with PI_DADDY_.
test("no PI_GRANTS_ literal survives in shipped code outside the legacy table", async () => {
  const offenders: string[] = [];
  for (const file of [...(await walk(join(packageRoot, "src"))), ...(await walk(join(packageRoot, "extensions")))]) {
    if (file.endsWith("kernel/env-names.ts")) continue;
    const source = await readFile(file, "utf8");
    source.split("\n").forEach((line, i) => {
      if (/PI_GRANTS_[A-Z_]+/.test(line)) offenders.push(`${file.slice(packageRoot.length + 1)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
  for (const key of GOVERNANCE_ENV_KEYS) assert.match(key, /^PI_DADDY_[A-Z_]+$/);
  for (const [legacy, current] of Object.entries(LEGACY_ENV_NAMES)) {
    assert.match(legacy, /^PI_GRANTS_[A-Z_]+$/);
    assert.match(current, /^PI_DADDY_[A-Z_]+$/);
  }
});

// Production change that breaks this: the planner writing a child variable that GOVERNANCE_ENV_KEYS does
// not name — which is exactly the variable the childEnv guard would then let a product overwrite.
test("every variable the planner writes into a child's environment is a governance key", () => {
  const plan = planDelegation(
    { task: "x", tools: ["read"] },
    {
      ownGrant: ["tool:read", "tool:bash", DELEGATE_CAPABILITY],
      depth: 0,
      maxDepth: 2,
      gated: ["tool:bash"],
      approved: [],
      ledgerPath: "/tmp/ledger.jsonl",
      fanoutBudget: 4,
      spawnId: "p1",
      childSpawnId: "c1",
      childExecutionId: "e1",
    },
  );
  assert.ok(plan.ok, JSON.stringify(plan));
  const written = Object.keys(plan.env).filter((k) => k.startsWith("PI_"));
  assert.ok(written.length >= 5, `planner wrote ${written.join(", ")}`);
  for (const key of written)
    assert.ok(GOVERNANCE_ENV_KEYS.includes(key), `${key} written by the planner but not a governance key`);
  assert.ok(GOVERNANCE_ENV_KEYS.includes(ENV_GRANT));
});

test("legacy names are adopted once, never win over the new name, and are reported", () => {
  const env: NodeJS.ProcessEnv = {
    PI_GRANTS_HERDR: "1",
    PI_GRANTS_LEDGER: "/old",
    PI_DADDY_LEDGER: "/new",
    OTHER: "x",
  };
  const adopted = adoptLegacyEnvironment(env);
  assert.deepEqual(adopted, ["PI_GRANTS_HERDR"]);
  assert.equal(env.PI_DADDY_HERDR, "1");
  assert.equal(env.PI_DADDY_LEDGER, "/new", "an explicit new name is never overwritten by a legacy one");
  assert.equal(env.PI_GRANTS_HERDR, "1", "the legacy variable is left for older siblings");
  assert.deepEqual(adoptLegacyEnvironment(env), [], "a second pass adopts nothing");
  assert.match(legacyEnvironmentWarning(adopted), /PI_GRANTS_HERDR is deprecated .* rename to PI_DADDY_HERDR/);
});
