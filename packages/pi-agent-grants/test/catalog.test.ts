import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCatalog,
  classifyToolNames,
  loadSkills,
  makeCatalog,
  unknownCapabilities,
} from "../src/catalog.ts";

test("classifies pi built-ins vs extension-provided tools", () => {
  const entries = classifyToolNames(["read", "bash", "Agent", "web_search"]);
  const kind = (c: string) => entries.find((e) => e.capability === c)?.kind;
  assert.equal(kind("tool:read"), "builtin");
  assert.equal(kind("tool:bash"), "builtin");
  assert.equal(kind("tool:Agent"), "extension", "not a pi built-in, so extension-provided");
  assert.equal(kind("tool:web_search"), "extension");
});

test("tool names are deduplicated and sorted", () => {
  const entries = classifyToolNames(["read", "read", "bash"]);
  assert.deepEqual(entries.map((e) => e.capability), ["tool:bash", "tool:read"]);
});

test("catalog dedupes, sorts, and answers membership by kind", () => {
  const catalog = makeCatalog([
    { capability: "tool:read", kind: "builtin" },
    { capability: "tool:read", kind: "extension" },
    { capability: "skill:review", kind: "skill" },
    { capability: "agent:plan", kind: "agentType" },
  ]);
  assert.deepEqual(catalog.all, ["agent:plan", "skill:review", "tool:read"]);
  assert.equal(catalog.entries.find((e) => e.capability === "tool:read")?.kind, "builtin", "first wins");
  assert.deepEqual(catalog.byKind("skill"), ["skill:review"]);
  assert.equal(catalog.has("agent:plan"), true);
  assert.equal(catalog.has("tool:nope"), false);
});

test("unknown capabilities are reported separately from denials", () => {
  const catalog = makeCatalog([{ capability: "tool:read", kind: "builtin" }]);
  assert.deepEqual(unknownCapabilities(["tool:read", "tool:typo", "skill:gone"], catalog), [
    "skill:gone",
    "tool:typo",
  ]);
});

test("skills are discovered from SKILL.md directories and top-level .md files", async () => {
  const root = await mkdtemp(join(tmpdir(), "grants-catalog-"));
  const skills = join(root, ".pi", "skills");
  await mkdir(join(skills, "code-review"), { recursive: true });
  await writeFile(join(skills, "code-review", "SKILL.md"), "# review");
  await mkdir(join(skills, "not-a-skill"), { recursive: true }); // no SKILL.md
  await writeFile(join(skills, "quickfix.md"), "# quickfix");

  const found = (await loadSkills(root)).map((e) => e.capability).sort();
  assert.ok(found.includes("skill:code-review"), "directory with SKILL.md is a skill");
  assert.ok(found.includes("skill:quickfix"), "top-level .md is a skill");
  assert.ok(!found.includes("skill:not-a-skill"), "a directory without SKILL.md is not a skill");
});

test("buildCatalog assembles tools, skills, and agent definitions together — the 'skills and tools' requirement", async () => {
  // RETARGETED by ADR-0016: definitions live under the SKILL roots now, not `.pi/agents/`, because a
  // subagent IS a skill you spawn. The property under test is unchanged — the catalog must cover the
  // whole capability surface, not just tools.
  const root = await mkdtemp(join(tmpdir(), "grants-catalog-"));
  await mkdir(join(root, ".pi", "skills", "planner"), { recursive: true });
  await writeFile(
    join(root, ".pi", "skills", "planner", "SKILL.md"),
    "---\nname: planner\ndescription: Plans work\nallowed-tools: Read\n---\n\nPlan it.",
  );
  await writeFile(join(root, ".pi", "skills", "review.md"), "# r");

  const catalog = await buildCatalog({ cwd: root, observedTools: ["read", "web_search"] });
  // Built-ins are seeded from `PI_BUILTIN_TOOLS` rather than derived from the observation, because the
  // catalog is consulted before any provider request happens (`/grants`) and an empty catalog made every
  // capability look "unknown". Observation is what distinguishes an EXTENSION tool, which cannot be
  // known statically.
  assert.ok(catalog.byKind("builtin").includes("tool:read"));
  assert.ok(catalog.byKind("builtin").includes("tool:bash"), "seeded, not observed");
  assert.deepEqual(catalog.byKind("extension"), ["tool:web_search"]);

  // `planner` appears TWICE, under two capability ids, and that is the design rather than duplication:
  // `skill:planner` means "may load these instructions", `agent:planner` means "may spawn a child
  // running them". A grant can hold either without the other.
  assert.ok(catalog.byKind("skill").includes("skill:planner"), "loadable as a skill");
  assert.ok(catalog.byKind("agentType").includes("agent:planner"), "and spawnable as an agent");

  // `review.md` has no frontmatter, so it is a skill but NOT a definition — a plain instruction file
  // cannot be spawned, because nothing in it declares what the child would be allowed to do.
  assert.ok(catalog.byKind("skill").includes("skill:review"));
  assert.ok(!catalog.byKind("agentType").includes("agent:review"), "no frontmatter means not spawnable");
});

test("without an observation the catalog still lists built-ins, skills and definitions", async () => {
  // This is the case that forced the seeding. `/grants` runs before the first provider request, so with
  // an observation-only catalog every grant it previewed was refused as an "unknown capability" —
  // a diagnostic contradicting the enforcer, which is exactly R-28's shape.
  const root = await mkdtemp(join(tmpdir(), "grants-catalog-"));
  await mkdir(join(root, ".pi", "skills"), { recursive: true });
  await writeFile(join(root, ".pi", "skills", "s.md"), "# s");
  const catalog = await buildCatalog({ cwd: root, observedTools: null });
  assert.ok(catalog.byKind("builtin").includes("tool:read"), "pi's built-ins are known statically");
  assert.deepEqual(catalog.byKind("extension"), [], "extension tools still require an observation");
  assert.deepEqual(catalog.byKind("skill"), ["skill:s"]);
});

test("a missing skill root is not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "grants-catalog-"));
  assert.deepEqual(await loadSkills(root), []);
});
