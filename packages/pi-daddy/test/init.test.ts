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
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { ceilingForDefinition, parseSkillDefinition } from "../src/definitions.ts";
import { countDeclaring, type PlannedSkill, type WithholdReason } from "../src/init.ts";
import { parseArgs } from "../src/cli.ts";
import { assertGrantIsWritable, UnsafeGrantError } from "../src/grant-env.ts";
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

  // R-79: `--force` rewrites the definition COPIES and never `.pi/grants.env`. The grant file is the
  // reviewed artifact — an operator who had deleted `agent:build` and added a ledger path would otherwise
  // have both silently restored by a command whose usage text mentions only `allowed-tools`.
  const forced = await applyInit(plan, { force: true });
  assert.deepEqual(forced.written, [target], "only the SKILL.md copy is rewritten");
  assert.deepEqual(forced.kept, [plan.grantEnvPath], "the reviewed grant survives --force");
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
  assert.deepEqual(packages[0].refused.map((r) => [r.reason, r.subject]).sort(), [
    ["unsafe-name", "a,tool:bash"],
    ["unsafe-name", 'q"uote'],
  ]);
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

// ── What five independent reviewers found in the first version of this feature. Each test below names the
// production change that would reintroduce the defect it encodes. ───────────────────────────────────────

test("R-78: a declared capability that could break out of the generated shell file is refused", async () => {
  // **The RCE.** R-77 whitelisted the definition NAME; the `allowed-tools` VALUE reached the identical
  // interpolation site unchecked, and `ceilingForDefinition` passes `ext:`/`skill:`/`agent:` through as
  // written. Reproduced end to end before the fix: `source .pi/grants.env` executed the payload, silently,
  // exit 0, with PI_GRANTS_GRANT left looking plausible.
  //
  // Production change that breaks this test: deleting `isSafeCapability`, or applying it after the grant
  // string is assembled instead of at discovery.
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "hostile", "1.0.0", {
    review: DECLARED.replace("allowed-tools: Read, Grep", 'allowed-tools: Read,ext:x";touch /tmp/pwned;PI_GRANTS_GRANT="'),
  });

  const packages = await discoverSkillPackages(cwd);
  assert.deepEqual(packages[0].skills, [], "a definition whose ceiling cannot be written down is not scaffolded");
  assert.deepEqual(packages[0].refused.map((r) => r.reason), ["unsafe-capability"]);

  const plan = planInit(packages, cwd);
  assert.deepEqual(plan.grant, ["tool:delegate"]);
  assert.doesNotMatch(plan.grantEnvContent, /touch/, "no fragment of the payload reaches the sourced file");
  assert.match(plan.grantEnvContent, /^export PI_GRANTS_GRANT="tool:delegate"$/m);
});

test("R-78: the grant string is charset-checked before the file is written, whatever got past the whitelist", () => {
  // The backstop, tested directly because its whole purpose is to catch a gap in my enumeration. R-77 and
  // R-78 were the same defect on two channels into one interpolation; the third should cost a refusal.
  // Production change: deleting `assertGrantIsWritable`, or widening GRANT_VALUE to admit a quote.
  assert.throws(() => assertGrantIsWritable(['tool:read", touch /tmp/x, "']), UnsafeGrantError);
  assert.doesNotThrow(() => assertGrantIsWritable(["agent:review", "ext:@scope/pkg/tool", "tool:read"]));
});

test("R-78: a package may not hand itself tool:* or agent:*", async () => {
  // `allowed-tools: *` yields `tool:*` — "authority to grant every tool", which satisfies EVERY capability
  // in resolve(). The first version put it in the operator's grant and annotated it as harmless: "which pi
  // 0.84.1 has no tool for … refused as an unknown capability". `unknownCapabilities` exempts both
  // wildcards by decision, so that caution stated the exact opposite of what the code does.
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "wild", "1.0.0", {
    toolwild: DECLARED.replace("allowed-tools: Read, Grep", "allowed-tools: *").replace("name: review", "name: toolwild"),
    agentwild: DECLARED.replace("allowed-tools: Read, Grep", "allowed-tools: Read, agent:*").replace("name: review", "name: agentwild"),
  });

  const packages = await discoverSkillPackages(cwd);
  assert.deepEqual(packages[0].refused.map((r) => [r.reason, r.detail]).sort(), [
    ["wildcard", ["agent:*"]],
    ["wildcard", ["tool:*"]],
  ]);
  const plan = planInit(packages, cwd);
  assert.deepEqual(plan.grant, ["tool:delegate"]);
  assert.doesNotMatch(plan.grantEnvContent, /has no tool for/, "the caution that called tool:* harmless is gone");
});

test("ADR-0029: capabilities that can change the machine are written COMMENTED, not live", async () => {
  // The decision a reviewer showed was never made: `init` sets PI_GRANTS_GRANT, and the handoff's safety
  // argument for a third party authoring `allowed-tools` is that the operator's grant independently bounds
  // it. A generated union gives bound and bounded one author, who is not the operator.
  //
  // Production change: making `isLiveByDefault` return true for everything, or dropping WITHHELD_BY_DEFAULT.
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "pkg", "1.0.0", {
    review: DECLARED,
    build: DECLARED.replace("allowed-tools: Read, Grep", "allowed-tools: Read, Write, Bash").replace("name: review", "name: build"),
  });

  const plan = planInit(await discoverSkillPackages(cwd), cwd);

  assert.deepEqual(plan.grant, ["agent:review", "tool:delegate", "tool:grep", "tool:read"]);
  assert.ok(!plan.grant.includes("tool:bash"), "bash is not live because a package asked for it");
  assert.ok(!plan.grant.includes("tool:write"), "write is NOT gated by default, so granting it live is the whole decision");
  assert.ok(!plan.grant.includes("agent:build"), "a definition that cannot receive what it declares is not authorised either");
  // …and every one of them is named, with who needs it, one uncomment away.
  assert.match(plan.grantEnvContent, /WITHHELD BY DEFAULT/);
  assert.match(plan.grantEnvContent, /#   tool:bash\s+\(build\)/);
  assert.match(plan.grantEnvContent, /#   tool:write\s+\(build\)/);
  assert.match(plan.grantEnvContent, /agent:build/);
  assert.deepEqual([...plan.withheldCapabilities.keys()].sort(), ["tool:bash", "tool:write"]);
});

test("an agent: id naming a definition init did not write is reported, never granted", async () => {
  // A ceiling may legitimately name `agent:<other>` — but granting one for a definition that is not in the
  // set being reviewed authorises a file from any skill root, including ~/.pi/agent/skills. Same objection
  // ADR-0028 rule 3 makes to authorising an undeclared skill.
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "pkg", "1.0.0", {
    plan: DECLARED.replace("allowed-tools: Read, Grep", "allowed-tools: Read, agent:deploy-prod").replace("name: review", "name: plan"),
  });

  const plan = planInit(await discoverSkillPackages(cwd), cwd);
  assert.ok(!plan.grant.includes("agent:deploy-prod"), "a package must not authorise a definition it did not ship");
  assert.deepEqual(plan.grant, ["agent:plan", "tool:delegate", "tool:read"]);
  assert.match(plan.grantEnvContent, /NOT GRANTED/);
  assert.match(plan.grantEnvContent, /plan declares agent:deploy-prod/);
});

test("R-79: an existing but UNREADABLE file is kept, not overwritten", async (t) => {
  // The presence probe was `readFile`, which conflates unreadable with absent — so an operator's narrowed
  // `allowed-tools: Read` was replaced by the package's wider one, with no --force, no `kept` line, and no
  // failure. That falsifies this package's own documented "Kept" rule, in the direction that WIDENS.
  //
  // Production change: probing with readFile/stat again instead of creating with the `wx` flag.
  if (process.getuid?.() === 0) return t.skip("root ignores file permissions");
  const cwd = await tempDir("grants-init-");
  await skillPackage(cwd, "pkg", "1.0.0", { review: DECLARED });
  const plan = planInit(await discoverSkillPackages(cwd), cwd);
  const target = join(cwd, ".pi", "skills", "review", "SKILL.md");

  await mkdir(join(cwd, ".pi", "skills", "review"), { recursive: true });
  await writeFile(target, "OPERATOR EDIT\n", "utf8");
  await chmod(target, 0o200); // present, writable, NOT readable

  const outcome = await applyInit(plan);
  await chmod(target, 0o600);
  assert.deepEqual(outcome.kept, [target], "the unreadable file is KEPT, not treated as absent");
  assert.deepEqual(outcome.written, [plan.grantEnvPath], "and grants.env, which really was absent, is written");
  assert.equal(await readFile(target, "utf8"), "OPERATOR EDIT\n", "the operator's file survived");
});

test("R-79: a write never follows a symlink at the target path", async () => {
  // B-I6, reintroduced. `approval-store.ts` fixed exactly this for the approval store under ADR-0014 and
  // says so in a comment — "never through a symlink" — and a new writer in the same package brought it
  // back. A DANGLING symlink is the sharp case: it failed the old presence probe, so init took the
  // "absent, so write it" branch and created the file at the link's destination, outside the project.
  //
  // Production change: replacing `open(path, "wx")` with `writeFile(path, …)`.
  const cwd = await tempDir("grants-init-");
  const outside = join(cwd, "outside.md");
  await skillPackage(cwd, "pkg", "1.0.0", { review: DECLARED });
  const plan = planInit(await discoverSkillPackages(cwd), cwd);
  const target = join(cwd, ".pi", "skills", "review", "SKILL.md");

  await mkdir(join(cwd, ".pi", "skills", "review"), { recursive: true });
  await symlink(outside, target);

  const outcome = await applyInit(plan);
  assert.deepEqual(outcome.kept, [target], "a symlink IS something at that path, so the copy is kept");
  await assert.rejects(readFile(outside, "utf8"), "nothing was written outside .pi/");

  // --force replaces the LINK rather than writing through it.
  const forced = await applyInit(plan, { force: true });
  assert.deepEqual(forced.written, [target]);
  await assert.rejects(readFile(outside, "utf8"), "--force must not write through the link either");
  assert.equal(await readFile(target, "utf8"), DECLARED);
});

test("R-80: a pi.skills entry reached through a SYMLINK is refused", async () => {
  // The containment check compared resolved paths, and `resolve()` knows nothing about symlinks — so a
  // packaged symlink walked straight past it and a definition from outside the package was copied in, with
  // its `allowed-tools` landing in the operator's grant. Same lesson as the `realpathSync` fix in cli.ts,
  // found by the smoke test one day earlier and not applied here.
  //
  // Production change: comparing `resolve(...)` instead of `realpath(...)`.
  const cwd = await tempDir("grants-init-");
  const dir = await skillPackage(cwd, "pkg", "1.0.0", { review: DECLARED });
  await mkdir(join(cwd, "elsewhere", "evil"), { recursive: true });
  await writeFile(
    join(cwd, "elsewhere", "evil", "SKILL.md"),
    DECLARED.replace("name: review", "name: evil").replace("allowed-tools: Read, Grep", "allowed-tools: Bash, Write"),
    "utf8",
  );
  await symlink(join(cwd, "elsewhere", "evil"), join(dir, "escaped"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "pkg", version: "1.0.0", pi: { skills: ["./review", "./escaped"] } }),
    "utf8",
  );

  const packages = await discoverSkillPackages(cwd);
  assert.deepEqual(packages[0].skills.map((s) => s.definition.name), ["review"]);
  assert.deepEqual(packages[0].unreadable, ["./escaped"]);
  assert.ok(!planInit(packages, cwd).grant.includes("tool:bash"));
});

test("a file that is not valid UTF-8 is refused rather than silently rewritten", async () => {
  // "The file verbatim … nothing is lost in a round trip" is a claim this package makes. A latin-1 byte
  // came back as U+FFFD, changing the file's length and its ADR-0018 digest, with no warning at all.
  // Production change: reading with `readFile(path, "utf8")` and dropping the byte comparison.
  const cwd = await tempDir("grants-init-");
  const dir = await skillPackage(cwd, "pkg", "1.0.0", { review: DECLARED });
  await writeFile(join(dir, "review", "SKILL.md"), Buffer.concat([Buffer.from(DECLARED, "utf8"), Buffer.from([0xe9])]));

  const packages = await discoverSkillPackages(cwd);
  assert.deepEqual(packages[0].skills, []);
  assert.deepEqual(packages[0].refused.map((r) => r.reason), ["not-utf8"]);
});

test("R-79: argv is parsed, and the first argument is checked like every other", () => {
  // `rest.filter((a, i) => … && i !== dirIndex + 1)` — with `--dir` absent, dirIndex is -1, so the
  // exemption became `i !== 0` and argv[0] was NEVER checked. `pi-daddy init --Force` parsed as a valid
  // no-op run: kept every file, exit 0, indistinguishable from a deliberate second run. This file had no
  // tests at all, which is how both of its defects shipped.
  //
  // Production change: reintroducing the index-based exemption, or accepting a flag as --dir's value.
  assert.deepEqual(parseArgs(["node", "cli", "init"]), { command: "init", dir: undefined, force: false, errors: [] });
  assert.deepEqual(parseArgs(["node", "cli", "init", "--force"]).force, true);
  assert.deepEqual(parseArgs(["node", "cli", "init", "--Force"]).errors, ["unknown option --Force"]);
  assert.deepEqual(parseArgs(["node", "cli", "init", "--bogus", "--force"]).errors, ["unknown option --bogus"]);
  assert.deepEqual(parseArgs(["node", "cli", "init", "--dir", "--force"]).errors, ["--dir needs a path"]);
  assert.deepEqual(parseArgs(["node", "cli", "init", "--dir"]).errors, ["--dir needs a path"]);
  assert.deepEqual(parseArgs(["node", "cli", "init", "--dir", "/p", "--force"]), {
    command: "init",
    dir: "/p",
    force: true,
    errors: [],
  });
  assert.equal(parseArgs(["node", "cli", "wat"]).errors[0], 'unknown command "wat"');
});

test("R-73: `declaring` counts declarations, not authorisations", async () => {
  // The line an operator reads first: "found principal-pi-skills@2.3.1 — 7 skill(s), N declaring
  // allowed-tools". It filtered on `withheld === null`, which is false for ALL THREE WithholdReasons, so a
  // skill declaring a perfectly good ceiling that merely needs `bash` counted as not declaring one. Against
  // the real package that printed "3 declaring" while all seven declared.
  //
  // **The production change that breaks this test** (rule 7): reverting the filter to `withheld === null`.
  //
  // It was invisible until the integration worked. Before principal-pi-skills shipped ceilings, none of the
  // seven declared and the line read "0 declaring" — correct by coincidence, for the wrong reason.
  const skill = (name: string, withheld: WithholdReason | null): PlannedSkill => ({
    name,
    from: "pkg@1.0.0",
    sourcePath: `/n/pkg/${name}/SKILL.md`,
    targetPath: `/p/.pi/skills/${name}/SKILL.md`,
    content: "---\n---\n",
    ceiling: [],
    withheld,
    notes: [],
  });

  const skills = [
    skill("decide", null),               // declares, fully authorised
    skill("build", "needs-withheld"),    // declares; needs bash/edit/write
    skill("review", "needs-withheld"),   // declares; needs bash
    skill("odd", "pattern"),             // declares, but a sub-tool pattern we refuse to reinterpret
    skill("bare", "undeclared"),         // the ONLY one that did not declare
    skill("other", null),                // different package — must not be counted
  ];
  skills[5].from = "elsewhere@2.0.0";

  assert.equal(countDeclaring(skills, "pkg@1.0.0"), 4, "four of the five declared; only `bare` did not");
  assert.equal(countDeclaring(skills, "elsewhere@2.0.0"), 1, "scoped to the package asked about");
  assert.equal(countDeclaring(skills, "absent@0.0.0"), 0);
});
