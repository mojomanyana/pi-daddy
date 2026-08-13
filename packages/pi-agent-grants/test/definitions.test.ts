/**
 * ADR-0016 — Agent Skills (`SKILL.md`) is the definition format, and `allowed-tools` is the grant.
 *
 * The interesting property here is the one the OLD format got backwards. In pi-subagents' frontmatter an
 * absent `tools:` key means *pi's full default toolset* — so a definition that declared nothing was the
 * most powerful kind, and a parser that failed to read a `tools:` line produced a wildcard. Two of this
 * project's worst defects (R-28, and finding F18 in review) came from that direction.
 *
 * Here an absent `allowed-tools` means **not spawnable**. Undeclared is the weakest state, not the
 * strongest, so a parse failure or a typo costs a refusal rather than a grant.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ceilingForDefinition, parseSkillDefinition } from "../src/definitions.ts";

const skill = (frontmatter: string, body = "Do the thing.") => `---\n${frontmatter}\n---\n\n${body}\n`;

test("a SKILL.md parses into name, description and body", () => {
  const def = parseSkillDefinition(
    "/skills/review/SKILL.md",
    skill("name: review\ndescription: Reviews code before it lands.", "# Review\n\nFind what breaks."),
  );
  assert.ok(def);
  assert.equal(def.name, "review");
  assert.equal(def.description, "Reviews code before it lands.");
  assert.match(def.body, /Find what breaks\./);
  assert.ok(!def.body.startsWith("---"), "the frontmatter must not leak into the system prompt");
});

test("identity comes from the DIRECTORY, not the frontmatter name", () => {
  // ADR-0013's lesson, kept: pi keys skills by their directory, so trusting a frontmatter `name` lets
  // our registry and the loader disagree about which file a name refers to. The spec agrees — it
  // requires `name` to match the parent directory — so a mismatch is the file's bug, not ours to honour.
  const def = parseSkillDefinition("/skills/review/SKILL.md", skill("name: something-else\ndescription: x"));
  assert.equal(def?.name, "review");
});

test("a top-level .md skill takes its name from the filename", () => {
  const def = parseSkillDefinition("/skills/triage.md", skill("name: triage\ndescription: x"));
  assert.equal(def?.name, "triage");
});

test("a file without frontmatter is not a definition", () => {
  assert.equal(parseSkillDefinition("/skills/x/SKILL.md", "# Just a document\n"), null);
});

test("allowed-tools is space separated, per the spec", () => {
  const def = parseSkillDefinition("/skills/review/SKILL.md", skill("name: review\ndescription: x\nallowed-tools: Read Grep"));
  const ceiling = ceilingForDefinition(def!);
  assert.deepEqual(ceiling.capabilities, ["tool:grep", "tool:read"]);
  assert.equal(ceiling.undeclared, false);
  assert.deepEqual(ceiling.patterns, []);
});

test("commas are tolerated as separators", () => {
  // The spec says space-separated, but `Read, Grep` is the form everybody actually types. Accepting it
  // grants nothing extra — it only avoids turning a comma into a mystery capability named "read," that
  // gets refused as unknown. Being liberal here is not the permissive direction.
  const def = parseSkillDefinition("/skills/r/SKILL.md", skill("name: r\ndescription: x\nallowed-tools: Read, Grep"));
  assert.deepEqual(ceilingForDefinition(def!).capabilities, ["tool:grep", "tool:read"]);
});

test("tool names are matched case-insensitively", () => {
  // The spec's examples use Claude Code's capitalised names; pi's tools are lowercase. Lowercasing is
  // the whole mapping — deliberately not a translation table, because a table would silently map a
  // name pi does not have (`Glob`) onto one it does, and that would be inventing a grant.
  const def = parseSkillDefinition("/skills/r/SKILL.md", skill("name: r\ndescription: x\nallowed-tools: READ bash"));
  assert.deepEqual(ceilingForDefinition(def!).capabilities, ["tool:bash", "tool:read"]);
});

test("ADR-0016: a pattern is reported, never reinterpreted", () => {
  // `--tools` is name-granularity only. Granting bare `bash` would WIDEN a deliberately narrow
  // declaration; dropping it would silently narrow. Both are wrong, so the caller is told.
  const def = parseSkillDefinition(
    "/skills/r/SKILL.md",
    skill("name: r\ndescription: x\nallowed-tools: Bash(git:*) Read"),
  );
  const ceiling = ceilingForDefinition(def!);
  assert.deepEqual(ceiling.patterns, ["Bash(git:*)"]);
  assert.ok(
    !ceiling.capabilities.includes("tool:bash"),
    "a pattern must not silently become the whole tool — that is the permissive direction",
  );
});

test("ADR-0016: an absent allowed-tools is UNDECLARED, not unlimited", () => {
  // The inversion this format exists for. In the old one, absent meant everything.
  const def = parseSkillDefinition("/skills/r/SKILL.md", skill("name: r\ndescription: x"));
  const ceiling = ceilingForDefinition(def!);
  assert.equal(ceiling.undeclared, true);
  assert.deepEqual(ceiling.capabilities, []);
});

test("an EMPTY allowed-tools declares zero tools, which is different from absent", () => {
  // A skill that legitimately needs no tools must be spawnable. Collapsing "declared none" into
  // "declared nothing" would make the honest author's file indistinguishable from the careless one's.
  const def = parseSkillDefinition("/skills/r/SKILL.md", skill("name: r\ndescription: x\nallowed-tools:"));
  const ceiling = ceilingForDefinition(def!);
  assert.equal(ceiling.undeclared, false);
  assert.deepEqual(ceiling.capabilities, []);
});

test("ext: and skill: entries pass through as capability ids", () => {
  const def = parseSkillDefinition(
    "/skills/r/SKILL.md",
    skill("name: r\ndescription: x\nallowed-tools: Read ext:pi-web-access/web_search skill:plan"),
  );
  assert.deepEqual(ceilingForDefinition(def!).capabilities, [
    "ext:pi-web-access/web_search",
    "skill:plan",
    "tool:read",
  ]);
});

test("a block-scalar description does not swallow allowed-tools", () => {
  // `description: >` folded scalars are how principal-pi-skills actually writes descriptions, and the
  // sibling parser skips block scalars rather than reading their continuation lines. If the indented
  // body were mistaken for top-level keys, `allowed-tools` could be lost — and a lost allowed-tools is
  // now a refusal rather than a wildcard, but it would still be a wrong refusal.
  const def = parseSkillDefinition(
    "/skills/review/SKILL.md",
    skill(
      "name: review\ndescription: >\n  Use to review code before it lands — check this diff,\n  is this ready to merge.\nallowed-tools: Read Grep",
    ),
  );
  assert.deepEqual(ceilingForDefinition(def!).capabilities, ["tool:grep", "tool:read"]);
});

test("metadata is read as the spec's extension point", () => {
  // The spec: "Clients can use this to store additional properties not defined by the Agent Skills
  // spec." So pi-daddy-specific settings live here rather than as invented top-level keys, which keeps
  // the file valid for the other tools that read it.
  const def = parseSkillDefinition(
    "/skills/r/SKILL.md",
    skill("name: r\ndescription: x\nallowed-tools: Read\nmetadata:\n  pi-daddy-spawnable: \"true\"\n  author: nemanja"),
  );
  assert.equal(def?.metadata?.["pi-daddy-spawnable"], "true");
  assert.equal(def?.metadata?.author, "nemanja");
});
