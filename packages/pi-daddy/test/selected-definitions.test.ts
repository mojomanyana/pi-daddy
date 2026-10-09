import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { selectedDefinitions } from "../src/kernel/selected-definitions.ts";
import { ceilingForDefinition } from "../src/kernel/definitions.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const legacyPhases = ["plan", "build", "review", "debug", "investigate"];
async function fixture(phases = legacyPhases) {
  const root = await tempDir("selected-principal-");
  await mkdir(join(root, "agents"));
  const bindings: Record<string, unknown> = {};
  for (const phase of phases) {
    await mkdir(join(root, phase));
    const skill = `---\nname: ${phase}\ndescription: inline\nallowed-tools: read\n---\nINLINE`;
    const agent = `---\nname: principal-${phase}\ndescription: delegated\nallowed-tools: read, write\n---\n  EXACT DELEGATED ${phase}  \n`;
    await writeFile(join(root, phase, "SKILL.md"), skill);
    await writeFile(join(root, "agents", `principal-${phase}.md`), agent);
    bindings[phase] = {
      skill: `${phase}/SKILL.md`,
      agent: `agents/principal-${phase}.md`,
      skillSha256: hash(skill),
      agentSha256: hash(agent),
    };
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "principal-pi-skills", version: "4.7.3" }));
  await writeFile(
    join(root, "principal-agents.json"),
    JSON.stringify({ version: 1, package: "principal-pi-skills", bindings }),
  );
  const commands = [{ source: "skill", name: "skill:build", sourceInfo: { path: join(root, "build", "SKILL.md") } }];
  return { root, commands };
}
test("selected Principal phase uses verified delegated bytes and intersected ceilings", async () => {
  const { commands } = await fixture();
  const result = await selectedDefinitions(commands);
  const d = result.definitions.get("build")!;
  assert.equal(result.definitions.size, 1);
  assert.equal(d.body, "  EXACT DELEGATED build  \n");
  assert.deepEqual(ceilingForDefinition(d).capabilities, ["tool:read"]);
  assert.deepEqual(d.binding, { package: "principal-pi-skills", phase: "build" });
  assert.match(d.definitionId!, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(d));
});
test("tampered selected agent refuses and does not fall back to inline body", async () => {
  const { commands, root } = await fixture();
  await writeFile(join(root, "agents", "principal-build.md"), "tampered");
  const result = await selectedDefinitions(commands);
  assert.equal(result.definitions.size, 0);
  assert.match(result.skips.join(" "), /hash/);
});
test("selected inventory alone governs discovery and snapshot stays fixed until reload", async () => {
  const { commands, root } = await fixture();
  const first = await selectedDefinitions(commands);
  await writeFile(join(root, "agents", "principal-build.md"), "changed");
  assert.match(first.definitions.get("build")!.body, /EXACT DELEGATED/);
  assert.equal((await selectedDefinitions([])).definitions.size, 0);
  assert.equal((await selectedDefinitions(commands)).definitions.size, 0);
});
test("duplicate selected phase names refuse rather than choosing an ambiguous body", async () => {
  const { commands } = await fixture();
  const result = await selectedDefinitions([...commands, ...commands]);
  assert.equal(result.definitions.size, 0);
  assert.match(result.skips.join(" "), /duplicate/);
});
test("unrelated same-named definition is never treated as Principal", async () => {
  const { commands, root } = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "other" }));
  const d = (await selectedDefinitions(commands)).definitions.get("build")!;
  assert.equal(d.binding, undefined);
  assert.equal(d.body, "INLINE");
});

// Review regression: an expected Principal phase may not become inline when identity disappears.
test("marked Principal phase refuses missing or replaced package identity", async () => {
  for (const missing of [true, false]) {
    const { commands, root } = await fixture();
    const skill = join(root, "build", "SKILL.md");
    const bytes = (await readFile(skill, "utf8")).replace(
      "description: inline",
      "metadata:\n  principal-package: principal-pi-skills\ndescription: inline",
    );
    await writeFile(skill, bytes);
    if (missing) await rm(join(root, "package.json"));
    else await writeFile(join(root, "package.json"), '{"name":"other"}');
    const result = await selectedDefinitions(commands);
    assert.equal(result.definitions.size, 0);
    assert.equal(result.skips.length, 1);
  }
});

test("marked Principal phase rejects a noncanonical selected path", async () => {
  const { root } = await fixture();
  const path = join(root, "build.md");
  await writeFile(
    path,
    "---\nname: build\ndescription: misplaced\nallowed-tools: read\nmetadata:\n  principal-package: principal-pi-skills\n---\nbody\n",
  );
  const result = await selectedDefinitions([{ source: "skill", name: "skill:build", sourceInfo: { path } }]);
  assert.equal(result.definitions.size, 0);
  assert.match(result.skips.join(" "), /noncanonical/);
});

test("opt-in Principal source snapshot contains exact admitted package, manifest, skill, agent and body", async () => {
  const { root, commands } = await fixture();
  const d = (await selectedDefinitions(commands, true)).definitions.get("build")!;
  const snapshot = d.sourceSnapshot!;
  assert.deepEqual(
    snapshot.resources.map((s) => s.kind),
    ["selected-skill", "package", "binding-manifest", "delegated-agent"],
  );
  for (const source of snapshot.resources) {
    assert.deepEqual(Buffer.from(source.base64, "base64"), await readFile(source.path));
    await writeFile(source.path, "changed after frozen selection");
  }
  assert.equal(snapshot.body, "  EXACT DELEGATED build  \n");
  assert.equal(snapshot.body, d.body);
  assert.equal(snapshot.resources.at(-1)!.path, join(root, "agents", "principal-build.md"));
  assert.ok(Object.isFrozen(snapshot.resources[0]));
});

test("native binding supports the legacy five phases and the optional test-review role without widening ceilings", async () => {
  for (const phases of [legacyPhases, [...legacyPhases, "test-review"]]) {
    const { root } = await fixture(phases);
    const commands = phases.map((phase) => ({
      source: "skill",
      name: `skill:${phase}`,
      sourceInfo: { path: join(root, phase, "SKILL.md") },
    }));
    const result = await selectedDefinitions(commands, true);
    assert.deepEqual(result.skips, []);
    assert.equal(result.definitions.size, phases.length);
    for (const phase of phases) {
      const definition = result.definitions.get(phase)!;
      assert.deepEqual(definition.binding, { package: "principal-pi-skills", phase });
      assert.equal(definition.body, `  EXACT DELEGATED ${phase}  \n`);
      assert.deepEqual(ceilingForDefinition(definition).capabilities, ["tool:read"]);
      assert.equal(definition.sourceSnapshot!.resources.at(-1)!.path, join(root, "agents", `principal-${phase}.md`));
    }
  }
});

test("optional test-review does not admit unknown phases, partial manifests or malformed binding rows", async () => {
  const { root, commands } = await fixture([...legacyPhases, "test-review"]);
  const path = join(root, "principal-agents.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const row = manifest.bindings["test-review"];
  const { investigate: _removed, ...partial } = manifest.bindings;
  for (const bindings of [
    { ...manifest.bindings, unexpected: row },
    partial,
    { ...manifest.bindings, "test-review": null },
    { ...manifest.bindings, "test-review": { ...row, agentSha256: "invalid" } },
    { ...manifest.bindings, "test-review": { ...row, agent: "agents/principal-review.md" } },
    { ...manifest.bindings, "test-review": { skill: row.skill, agent: row.agent, skillSha256: row.skillSha256 } },
  ]) {
    await writeFile(path, JSON.stringify({ ...manifest, bindings }));
    const result = await selectedDefinitions(commands);
    assert.equal(result.definitions.size, 0);
    assert.match(result.skips.join(" "), /invalid Principal binding (manifest|row)/);
  }
});

test("selected test-review must have its own exact manifest binding and verified agent bytes", async () => {
  const { root } = await fixture([...legacyPhases, "test-review"]);
  const commands = [
    { source: "skill", name: "skill:test-review", sourceInfo: { path: join(root, "test-review", "SKILL.md") } },
  ];
  const path = join(root, "principal-agents.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const { "test-review": _removed, ...bindings } = manifest.bindings;
  await writeFile(path, JSON.stringify({ ...manifest, bindings }));
  let result = await selectedDefinitions(commands);
  assert.equal(result.definitions.size, 0);
  assert.match(result.skips.join(" "), /no binding row/);
  await writeFile(path, JSON.stringify(manifest));
  await writeFile(join(root, "agents", "principal-test-review.md"), "tampered");
  result = await selectedDefinitions(commands);
  assert.equal(result.definitions.size, 0);
  assert.match(result.skips.join(" "), /hash mismatch/);
});
