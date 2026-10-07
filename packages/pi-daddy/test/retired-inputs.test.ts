import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withoutRetiredDelegationArguments } from "../extensions/retired-inputs.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
test("only the retired call argument is removed, without coercing active input", () => {
  const raw = { task: 13, episodeCostCeiling: { malformed: true }, typoCost: "unchanged", tools: ["read"] };
  assert.deepEqual(withoutRetiredDelegationArguments(raw), { task: 13, typoCost: "unchanged", tools: ["read"] });
  assert.ok(Object.hasOwn(raw, "episodeCostCeiling"), "preparation must not mutate the caller");
  assert.equal(withoutRetiredDelegationArguments(null), null);
});
test("malformed retired settings and environment cannot disable active delegation bounds", async () => {
  const cwd = await tempDir("retired-inputs-");
  await mkdir(join(cwd, ".pi", "pi-daddy"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "pi-daddy", "settings.json"),
    JSON.stringify({
      episodeCostCeiling: { invalid: true },
      advisor: { enabled: true, key: "not-a-credential" },
      sessionModelPrompt: ["invalid"],
      defaults: { thinking: "low" },
    }),
  );
  const previousCwd = process.cwd();
  const names = ["PI_DADDY_EPISODE_COST_CEILING", "PI_DADDY_ADVISOR", "PI_DADDY_ADVISOR_KEY"];
  const previous = names.map((name) => process.env[name]);
  try {
    process.chdir(cwd);
    names.forEach((name) => {
      process.env[name] = "invalid retired input";
    });
    const session = createGrantsSession(undefined);
    assert.equal(session.malformedBounds.length, 0);
    assert.ok(session.maxDepth > 0);
    assert.equal(session.definitionRuntimeSettings.defaults.thinking, "low");
    assert.equal("advisorSession" in session, false);
    assert.equal("episodeCostGate" in session, false);
    assert.equal("sessionModelPrompt" in session, false);
  } finally {
    process.chdir(previousCwd);
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
  }
});
