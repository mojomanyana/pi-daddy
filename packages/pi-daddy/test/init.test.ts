/**
 * `pi-daddy init` — the scaffolding, and the line it must not cross.
 *
 * The design constraint this suite exists to hold (B2): **`init` writes files an operator then reviews and
 * commits, and it never chooses a ceiling.** Generating a file a human approves is governance; deciding on
 * their behalf is not, and the difference is one line of code away in both directions — copy the
 * declaration and you are a scaffolder, invent one and you are a policy this package spent twenty-seven
 * ADRs arguing should live in a reviewed file.
 *
 * **The production changes that break these tests** (rule 7), one per case:
 *
 *  - writing a real `allowed-tools:` line for a skill that declares none — i.e. choosing a ceiling;
 *  - regenerating a declared skill's frontmatter instead of copying it, which would put a second opinion
 *    between the author's declaration and the enforcer;
 *  - granting `agent:<name>` for a skill that cannot be spawned, so the grant claims authority over a file
 *    nobody has reviewed the moment somebody fills it in;
 *  - dropping `tool:delegate`, which is what registers the delegation tools at all (S-5) — without it the
 *    generated file is inert and every "governed" session is a leaf;
 *  - reinterpreting a sub-tool pattern as the bare tool, which widens a deliberately narrow declaration;
 *  - overwriting a file that already exists, which is precisely when an operator's hand-written ceiling is
 *    destroyed;
 *  - discovering skills by scanning for files named `SKILL.md` rather than reading each package's own
 *    `pi.skills` declaration, which would offer a package's fixtures and vendored copies as sub-agents.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { ceilingForDefinition, parseSkillDefinition } from "../src/definitions.ts";
import { applyInit, planInit, withPlaceholder } from "../src/init.ts";
import { discoverSkillPackages, readSkillPackage } from "../src/skill-packages.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const DECLARED = `---
name: review
description: Reports findings; never edits.
allowed-tools: Read, Grep
---
Review the diff. Report findings; never edit.
`;

const UNDECLARED = `---
name: plan
description: >
  Writes a plan, in the folded form principal-pi-skills uses for every description.
---
Write the plan.
`;

const PATTERNED = `---
name: git-ops
description: git is bash.
allowed-tools: Read, Bash(git:*)
---
Do git things.
`;

/** An installed package that declares its skills the way `principal-pi-skills@2.3.1` does (measured). */
async function skillPackage(
  root: string,
  name: string,
  version: string,
  skills: Record<string, string>,
  options: { declare?: boolean } = {},
): Promise<string> {
  const dir = join(root, "node_modules", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  for (const [skill, content] of Object.entries(skills)) {
    await mkdir(join(dir, skill), { recursive: true });
    await writeFile(join(dir, skill, "SKILL.md"), content, "utf8");
  }
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version,
      ...(options.declare === false ? {} : { pi: { skills: Object.keys(skills).map((s) => `./${s}`) } }),
    }),
    "utf8",
  );
  return dir;
}

test("a declared ceiling is copied VERBATIM — the author's declaration is the ceiling", async () => {
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "pkg-a", "1.0.0", { review: DECLARED });

  const plan = planInit(await discoverSkillPackages(cwd), cwd);
  const review = plan.skills.find((s) => s.name === "review");

  assert.equal(review?.content, DECLARED, "a byte of difference here is a second opinion about the ceiling");
  assert.deepEqual(review?.ceiling, ["tool:grep", "tool:read"]);
  assert.equal(review?.withheld, null);
});

test("an undeclared skill is written UNDECLARED — init does not choose a ceiling", async () => {
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "pkg-a", "1.0.0", { plan: UNDECLARED });

  const plan = planInit(await discoverSkillPackages(cwd), cwd);
  const written = plan.skills.find((s) => s.name === "plan")?.content ?? "";
  const parsed = parseSkillDefinition("/x/plan/SKILL.md", written);

  assert.ok(parsed, "the copy is still a readable SKILL.md");
  assert.equal(
    ceilingForDefinition(parsed).undeclared,
    true,
    "the placeholder must be a COMMENT — a real `allowed-tools:` line, even an empty one, is a decision " +
      "(empty means 'spawnable with zero tools', which is not the same as 'nobody has decided yet')",
  );
  assert.match(written, /^# allowed-tools: <list the tools this skill needs/m);
  // Uncommented unedited it yields `tool:<list`, which the catalog refuses as unknown — loud, not granting.
  assert.doesNotMatch(written, /^# allowed-tools: (Read|Write|Bash)/m, "a working example invites uncommenting");
  // The body and the original frontmatter survive intact.
  assert.match(written, /^Write the plan\.$/m);
  assert.match(written, /^name: plan$/m);
});

test("the frontmatter is preserved byte for byte around the inserted comment", () => {
  const withCrlf = "---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n";
  const out = withPlaceholder(withCrlf, false);
  assert.match(out, /^---\r\nname: x\r\ndescription: y\r\n# pi-daddy:/);
  assert.ok(out.endsWith("---\r\nbody\r\n"));
  // A file with no frontmatter is left exactly as it is rather than having one invented for it.
  assert.equal(withPlaceholder("no frontmatter here\n", false), "no frontmatter here\n");
  assert.equal(withPlaceholder(DECLARED, true), DECLARED);
});

test("the grant authorises only what can actually be spawned, and always tool:delegate", async () => {
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "pkg-a", "1.0.0", { review: DECLARED, plan: UNDECLARED, "git-ops": PATTERNED });

  const plan = planInit(await discoverSkillPackages(cwd), cwd);

  assert.deepEqual(plan.grant, ["agent:review", "tool:delegate", "tool:grep", "tool:read"]);
  assert.ok(!plan.grant.includes("agent:plan"), "an id for an unspawnable definition is authority nobody reviewed");
  assert.ok(!plan.grant.includes("tool:bash"), "a sub-tool pattern must not be reinterpreted as the bare tool");
  assert.equal(plan.skills.find((s) => s.name === "git-ops")?.withheld, "pattern");
  // The withheld ones are NAMED in the file, not silently absent — that is the difference between
  // "governance is working" and "did the install fail?".
  assert.match(plan.grantEnvContent, /NOT AUTHORISED/);
  assert.match(plan.grantEnvContent, /plan: declares no `allowed-tools`/);
  assert.match(plan.grantEnvContent, /git-ops: declares Bash\(git:\*\)/);
  assert.match(plan.grantEnvContent, /export PI_GRANTS_GRANT="agent:review,tool:delegate,tool:grep,tool:read"/);
});

test("a declared capability pi has no tool for is flagged, because the spawn will be refused", async () => {
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "pkg-a", "1.0.0", {
    // `Glob` is the live case: the handoff's own ceiling table proposes it and pi 0.84.1 has no glob tool,
    // so `tool:glob` reaches the catalog as unknown and the spawn is refused.
    decide: DECLARED.replace("allowed-tools: Read, Grep", "allowed-tools: Read, Glob").replace("name: review", "name: decide"),
  });

  const plan = planInit(await discoverSkillPackages(cwd), cwd);
  assert.equal(plan.cautions.length, 1);
  assert.match(plan.cautions[0], /decide declares tool:glob, which pi 0\.84\.1 has no tool for/);
  assert.match(plan.grantEnvContent, /# CAUTION: decide declares tool:glob/);
});

test("an existing file is KEPT, because the edit an operator made to it is the decision", async () => {
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "pkg-a", "1.0.0", { plan: UNDECLARED });
  const plan = planInit(await discoverSkillPackages(cwd), cwd);

  const first = await applyInit(plan);
  assert.deepEqual(first.kept, []);
  assert.equal(first.written.length, 2, "the SKILL.md and .pi/grants.env");

  // The operator does what the placeholder asks: they decide.
  const target = join(cwd, ".pi", "skills", "plan", "SKILL.md");
  await writeFile(target, DECLARED.replace("name: review", "name: plan"), "utf8");

  const second = await applyInit(plan);
  assert.deepEqual(second.written, [], "a second run must not touch a thing");
  assert.equal(second.kept.length, 2);
  assert.match(await readFile(target, "utf8"), /allowed-tools: Read, Grep/, "the operator's ceiling survived");

  const forced = await applyInit(plan, { force: true });
  assert.equal(forced.written.length, 2);
  assert.doesNotMatch(await readFile(target, "utf8"), /^allowed-tools:/m, "--force discards it, as documented");
});

test("skills are discovered from the package's own declaration, never by scanning for SKILL.md", async () => {
  const cwd = await tempDir("grants-init-");
  // Same files, no `pi.skills` — a package that vendored someone else's skills, or ships them as fixtures.
  await skillPackage(cwd, "pkg-undeclared", "1.0.0", { review: DECLARED }, { declare: false });
  await skillPackage(cwd, "@scope/pkg-scoped", "2.0.0", { review: DECLARED });

  const packages = await discoverSkillPackages(cwd);
  assert.deepEqual(packages.map((p) => p.name), ["@scope/pkg-scoped"], "one scoped package, found via its manifest");
  assert.equal(packages[0].skills.length, 1);
});

test("a pi.skills entry pointing outside its own package is refused", async () => {
  const cwd = await tempDir("grants-init-");
  const dir = await skillPackage(cwd, "pkg-a", "1.0.0", { review: DECLARED });
  // A REAL, readable definition outside the package — so this fails without the containment check rather
  // than merely failing to find a file. The first version of this test pointed at `../../../etc`, which
  // was unreadable either way: it passed with the check deleted, which makes it decoration (rule 7).
  await mkdir(join(cwd, "outside"), { recursive: true });
  await writeFile(join(cwd, "outside", "SKILL.md"), DECLARED.replace("name: review", "name: outside"), "utf8");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "pkg-a", version: "1.0.0", pi: { skills: ["./review", "../../outside"] } }),
    "utf8",
  );

  const pkg = await readSkillPackage(dir);
  assert.deepEqual(pkg?.skills.map((s) => s.definition.name), ["review"]);
  assert.deepEqual(pkg?.unreadable, ["../../outside"], "refused AND reported — a silent skip reads as 'not there'");
});

test("a definition name that could inject a capability, a shell command or a path is refused", async () => {
  // **Found in this module's own first version, by asking what the generated file interpolates.** A skill
  // directory called `a,tool:bash` produced `PI_GRANTS_GRANT="agent:a,tool:bash,tool:delegate,tool:read"` —
  // `tool:bash` in an operator's grant, declared by no definition and chosen by nobody. Reproduced against
  // the real CLI before this check existed.
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "evil", "1.0.0", {
    "a,tool:bash": DECLARED, // a comma splits one capability id into two
    'q"uote': DECLARED, //      a quote escapes the string in a file the operator SOURCES
    "..": DECLARED, //          a path that would write outside .pi/skills/
    "git-ops": DECLARED, //     and the shape that must keep working
  });

  const packages = await discoverSkillPackages(cwd);
  assert.deepEqual(packages[0].skills.map((s) => s.definition.name), ["git-ops"]);
  assert.deepEqual([...packages[0].unsafe].sort(), ["a,tool:bash", 'q"uote']);
  // `..` is refused one guard earlier, by containment: `./..` resolves outside the package, so it never
  // reaches the name check. Asserted where it actually lands rather than where it was expected to — the
  // two guards overlap, and a test that claimed the wrong one would go green if that one were deleted.
  assert.deepEqual(packages[0].unreadable, ["./.."], "reported as the manifest entry, which is what a package author greps for");

  const plan = planInit(packages, cwd);
  assert.deepEqual(plan.grant, ["agent:git-ops", "tool:delegate", "tool:grep", "tool:read"]);
  assert.match(
    plan.grantEnvContent,
    /export PI_GRANTS_GRANT="agent:git-ops,tool:delegate,tool:grep,tool:read"/,
    "a name must not be able to add a capability to the line the operator sources",
  );
  // Every write stays under .pi/skills/, so `..` cannot place a file anywhere else.
  for (const skill of plan.skills) assert.match(skill.targetPath, /\.pi\/skills\/[A-Za-z0-9][A-Za-z0-9._-]*\/SKILL\.md$/);
});

test("two packages declaring the same name: the first wins and the loser is named", async () => {
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "aaa-pkg", "1.0.0", { review: DECLARED });
  await skillPackage(cwd, "zzz-pkg", "9.0.0", { review: DECLARED.replace("Read, Grep", "Read, Write") });

  const plan = planInit(await discoverSkillPackages(cwd), cwd);
  assert.equal(plan.skills.length, 1);
  assert.equal(plan.skills[0].from, "aaa-pkg@1.0.0");
  assert.deepEqual(plan.collisions, ["review (also in zzz-pkg@9.0.0, not written)"]);
  assert.ok(!plan.grant.includes("tool:write"), "the shadowed package's ceiling must not leak into the grant");
});

test("no skill packages installed means no plan and no files", async () => {
  const cwd = await tempDir("grants-init-");
  assert.deepEqual(await discoverSkillPackages(cwd), []);
});
