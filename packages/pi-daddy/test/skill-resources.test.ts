import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { applyInit, planInit } from "../src/governance/init.ts";
import { discoverSkillPackages } from "../src/kernel/skill-packages.ts";
import { loadDefinitions, ceilingForDefinition } from "../src/kernel/definitions.ts";
import { buildCatalog } from "../src/kernel/catalog.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

const text = (name: string, ceiling = "allowed-tools: Read") => `---\nname: ${name}\ndescription: Test ${name}\n${ceiling}\n---\nInstructions ${name}.\n`;
async function fixture(local = false) {
  const cwd = await tempDir("configured-skill-project-");
  const agent = await tempDir("configured-skill-agent-");
  process.env.PI_CODING_AGENT_DIR = agent;
  const base = local ? join(cwd, ".pi") : agent;
  const pkg = join(base, "npm", "node_modules", "example-skills");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "example-skills", version: "1.0.0", pi: { skills: ["./skills/*"] } }));
  for (const name of ["advice", "other"]) {
    await mkdir(join(pkg, "skills", name), { recursive: true });
    await writeFile(join(pkg, "skills", name, "SKILL.md"), text(name));
  }
  await writeFile(join(base, "settings.json"), JSON.stringify({ packages: ["npm:example-skills"] }));
  return { cwd, agent, base, pkg };
}

// Reintroducing package copying, missing runtime discovery, or bypassing Pi filters breaks these cases.
for (const local of [false, true]) test(`${local ? "project" : "global"} configured npm skills stay installed through init, repeat and force`, async () => {
  const { cwd, pkg } = await fixture(local);
  const path = join(pkg, "skills", "advice", "SKILL.md");
  const original = await readFile(path, "utf8");
  for (const force of [false, false, true]) {
    const plan = planInit(await discoverSkillPackages(cwd), cwd);
    assert.equal(plan.skills.length, 2);
    assert.ok(plan.skills.every(s => s.referenced));
    assert.deepEqual((await applyInit(plan, { force })).failed, []);
    assert.equal(await stat(join(cwd, ".pi", "skills")).then(() => true, () => false), false);
    assert.equal((await loadDefinitions(cwd)).get("advice")?.source, path);
    const catalog = await buildCatalog({ cwd, observedTools: null });
    assert.equal(catalog.entries.find(e => e.capability === "skill:advice")?.source, path);
    assert.equal(catalog.entries.find(e => e.capability === "agent:advice")?.source, path);
  }
  assert.equal(await readFile(path, "utf8"), original);
});

test("package filters exclude disabled skills from setup, runtime and catalog; local override supplies the ceiling", async () => {
  const { cwd, base } = await fixture();
  await writeFile(join(base, "settings.json"), JSON.stringify({ packages: [{ source: "npm:example-skills", skills: ["!skills/other/**"] }] }));
  const override = join(cwd, ".pi", "skills", "advice", "SKILL.md");
  await mkdir(join(override, ".."), { recursive: true });
  await writeFile(override, text("advice", "allowed-tools: Grep"));
  const definitions = await loadDefinitions(cwd);
  assert.equal(definitions.has("other"), false);
  assert.equal(definitions.get("advice")?.source, override);
  const plan = planInit(await discoverSkillPackages(cwd), cwd);
  assert.equal(plan.skills.length, 1);
  assert.deepEqual(plan.skills[0].ceiling, ["tool:grep"]);
  await applyInit(plan, { force: true });
  assert.equal(await readFile(override, "utf8"), text("advice", "allowed-tools: Grep"));
  const catalog = await buildCatalog({ cwd, observedTools: null });
  assert.equal(catalog.has("skill:other"), false);
  assert.equal(catalog.entries.find(e => e.capability === "skill:advice")?.source, override);
});

test("disabled packages cannot return through legacy npm scanning; missing packages do not install", async () => {
  const { cwd, base } = await fixture();
  await writeFile(join(base, "settings.json"), JSON.stringify({ packages: [{ source: "npm:example-skills", skills: [] }, "npm:missing-skills"] }));
  assert.deepEqual(await discoverSkillPackages(cwd), []);
  assert.equal((await loadDefinitions(cwd)).size, 0);
  assert.equal(await stat(join(base, "npm", "node_modules", "missing-skills")).then(() => true, () => false), false);
});

test("missing and unsupported YAML ceilings stay unspawnable; malformed settings fail loudly", async () => {
  const { cwd, base, pkg } = await fixture();
  for (const ceiling of ["", "allowed-tools:\n  - Read", "allowed-tools:\n\n  # comment before collection\n  - Read"]) {
    await writeFile(join(pkg, "skills", "advice", "SKILL.md"), text("advice", ceiling));
    assert.equal(ceilingForDefinition((await loadDefinitions(cwd)).get("advice")!).undeclared, true);
    assert.equal(planInit(await discoverSkillPackages(cwd), cwd).grant.includes("agent:advice"), false);
  }
  await writeFile(join(base, "settings.json"), "{broken");
  await assert.rejects(loadDefinitions(cwd), /Cannot discover skills.*settings/);
});


test("a missing configured pin cannot fall back to a different unregistered npm version", async () => {
  const { cwd, base } = await fixture();
  const legacy = join(cwd, "node_modules", "example-skills");
  await mkdir(join(legacy, "advice"), { recursive: true });
  await writeFile(join(legacy, "package.json"), JSON.stringify({ name: "example-skills", version: "1.0.0", pi: { skills: ["./advice"] } }));
  await writeFile(join(legacy, "advice", "SKILL.md"), text("advice"));
  await writeFile(join(base, "settings.json"), JSON.stringify({ packages: ["npm:example-skills@2.0.0"] }));
  assert.deepEqual(await discoverSkillPackages(cwd), []);
  assert.equal((await loadDefinitions(cwd)).size, 0);
});

test("top-level Pi exclusions stay excluded and existing grants remain unchanged", async () => {
  const { cwd, base } = await fixture();
  const path = join(cwd, ".pi", "skills", "local", "SKILL.md");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text("local"));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["!skills/local/**"] }));
  await writeFile(join(cwd, ".pi", "grants.env"), "# deliberately retained grant\n");
  const plan = planInit(await discoverSkillPackages(cwd), cwd);
  assert.equal(plan.skills.some(s => s.name === "local"), false);
  assert.equal((await loadDefinitions(cwd)).has("local"), false);
  assert.equal((await buildCatalog({ cwd, observedTools: null })).has("skill:local"), false);
  await applyInit(plan, { force: true });
  assert.equal(await readFile(join(cwd, ".pi", "grants.env"), "utf8"), "# deliberately retained grant\n");
});


test("malformed local override never falls through to a wider installed definition", async () => {
  const { cwd } = await fixture();
  const path = join(cwd, ".pi", "skills", "advice", "SKILL.md");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "# Local instructions without parseable frontmatter\n");
  assert.equal((await loadDefinitions(cwd)).has("advice"), false);
  assert.equal(planInit(await discoverSkillPackages(cwd), cwd).grant.includes("agent:advice"), false);
  const catalog = await buildCatalog({ cwd, observedTools: null });
  assert.equal(catalog.has("agent:advice"), false);
  assert.equal(catalog.entries.find(e => e.capability === "skill:advice")?.source, path);
});

test("invalid UTF-8 is reported even when it prevents configured frontmatter parsing", async () => {
  const { cwd, pkg } = await fixture();
  const path = join(pkg, "skills", "advice", "SKILL.md");
  // Checking bytes only after parsing would silently drop this malformed header.
  await writeFile(path, Buffer.concat([Buffer.from([0xff]), Buffer.from(text("advice"))]));
  const packages = await discoverSkillPackages(cwd);
  assert.deepEqual(packages.flatMap(p => p.refused), [{ subject: "advice", reason: "not-utf8", detail: [] }]);
  assert.equal((await loadDefinitions(cwd)).has("advice"), false);
  assert.equal(planInit(packages, cwd).grant.includes("agent:advice"), false);
});
