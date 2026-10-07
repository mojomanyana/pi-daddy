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
async function fixture() {
  const root = await tempDir("selected-principal-");
  await mkdir(join(root, "agents"));
  const bindings: Record<string, unknown> = {};
  for (const phase of ["plan", "build", "review", "debug", "investigate"]) {
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
