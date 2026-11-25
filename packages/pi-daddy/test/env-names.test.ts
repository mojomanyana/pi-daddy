import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ENV_GRANT, GOVERNANCE_ENV_KEYS } from "../src/kernel/env-names.ts";
import { planDelegation } from "../src/kernel/delegate.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

test("no retired PI_GRANTS_ literal survives anywhere in shipped code", async () => {
  const dirs = [join(packageRoot, "src"), join(packageRoot, "extensions")];
  const files = (await Promise.all(dirs.map(sourceFiles))).flat();
  const strays: string[] = [];
  for (const file of files) {
    const rel = relative(packageRoot, file).replace(/\\/g, "/");
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (line.includes("PI_GRANTS_")) strays.push(`${rel}:${index + 1}`);
    });
  }
  assert.deepEqual(strays, []);
});

test("every variable the planner writes into a child's environment is a governance key", () => {
  const planned = planDelegation(
    { task: "read", tools: ["read"] },
    {
      ownGrant: ["tool:read", "tool:delegate"],
      episodeId: "episode:00000000-0000-4000-8000-000000000001",
      depth: 0,
      maxDepth: 2,
      gated: [],
      extensionPath: "/ext/grants.ts",
    },
  );
  assert.ok(planned.ok);
  for (const key of Object.keys(planned.env)) {
    assert.ok(GOVERNANCE_ENV_KEYS.includes(key), `planned env key ${key} missing from GOVERNANCE_ENV_KEYS`);
  }
  assert.ok(GOVERNANCE_ENV_KEYS.includes(ENV_GRANT));
});
