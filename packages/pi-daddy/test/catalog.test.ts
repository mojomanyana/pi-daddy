import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  buildCatalog,
  classifyToolNames,
  explainDoubledNamespace,
  loadSkills,
  makeCatalog,
  suggestForUnknown,
  unknownCapabilities,
} from "../src/kernel/catalog.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

process.env.PI_CODING_AGENT_DIR = await tempDir("grants-discovery-agent-");

after(cleanupTempDirs);

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
  assert.deepEqual(
    entries.map((e) => e.capability),
    ["tool:bash", "tool:read"],
  );
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
  assert.deepEqual(unknownCapabilities(["tool:read", "tool:typo", "skill:gone"], catalog), ["skill:gone", "tool:typo"]);
});

test("skills are discovered from SKILL.md directories and top-level .md files", async () => {
  const root = await tempDir("grants-catalog-");
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
  const root = await tempDir("grants-catalog-");
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
  const root = await tempDir("grants-catalog-");
  await mkdir(join(root, ".pi", "skills"), { recursive: true });
  await writeFile(join(root, ".pi", "skills", "s.md"), "# s");
  const catalog = await buildCatalog({ cwd: root, observedTools: null });
  assert.ok(catalog.byKind("builtin").includes("tool:read"), "pi's built-ins are known statically");
  assert.deepEqual(catalog.byKind("extension"), [], "extension tools still require an observation");
  assert.deepEqual(catalog.byKind("skill"), ["skill:s"]);
});

test("a missing skill root is not an error", async () => {
  const root = await tempDir("grants-catalog-");
  assert.deepEqual(await loadSkills(root), []);
});

/**
 * The refusal stays a refusal — these assert only that it NAMES the likely intent.
 *
 * `Glob` is the case that matters and the case a distance metric can never reach: it is not a misspelling
 * of `find`, it is a different harness's word for the same job. The rest guard the edges, because a
 * suggestion that fires too eagerly is worse than none — it sends an author to edit the wrong line.
 */
const PI = makeCatalog(
  ["bash", "edit", "edit-diff", "find", "grep", "ls", "parallel", "read", "write"].map((n) => ({
    capability: `tool:${n}`,
    kind: "builtin" as const,
  })),
);

test("names pi's equivalent for a foreign tool name no edit distance could reach", () => {
  assert.equal(suggestForUnknown("tool:glob", PI), "tool:find");
});

test("suggests the nearest built-in for a plain typo", () => {
  assert.equal(suggestForUnknown("tool:raed", PI), "tool:read");
});

test("stays silent when nothing is close, rather than guessing", () => {
  assert.equal(suggestForUnknown("tool:kubernetes", PI), null);
});

test("never crosses namespaces — a mistyped tool must not point at a skill", () => {
  const mixed = makeCatalog([
    { capability: "tool:read", kind: "builtin" },
    { capability: "skill:reed", kind: "skill" },
  ]);
  // `skill:reed` is one edit from `tool:raed`'s bare name too, so a namespace-blind search would
  // offer it — and send the author to install a skill when they mistyped a tool.
  assert.equal(suggestForUnknown("tool:raed", mixed), "tool:read");
  // The same rule read the other way: a mistyped SKILL stays among skills.
  assert.equal(suggestForUnknown("skill:raed", mixed), "skill:reed");
  // And with no same-namespace candidate at all, silence rather than the cross-namespace match.
  const toolsOnly = makeCatalog([{ capability: "tool:read", kind: "builtin" }]);
  assert.equal(suggestForUnknown("skill:raed", toolsOnly), null);
});

test("a name too short to typo-match gets no suggestion", () => {
  // limit = floor(2/3) = 0, so `ls` cannot be reached by distance from `lx`.
  assert.equal(suggestForUnknown("tool:lx", PI), null);
});

test("a foreign name absent from THIS catalog suggests nothing", () => {
  const noFind = makeCatalog([{ capability: "tool:read", kind: "builtin" }]);
  assert.equal(suggestForUnknown("tool:glob", noFind), null);
});

/**
 * A doubled namespace is a mistake with a name, and the diagnostic has to say it.
 *
 * `ceilingForDefinition` adds `tool:` to a bare entry and matches an explicit namespace only in lower
 * case, so `Tool:Read` — the spelling invited by frontmatter copied from a harness whose tools are
 * `Read` and `Grep` — becomes `tool:tool:read`. Measured before this was written, on this tree:
 * `allowed-tools: tool:read, Grep, workspace:prod, skill:foo, Tool:Read` yields
 * `['skill:foo','tool:grep','tool:read','tool:tool:read','workspace:prod']`.
 *
 * Production change that breaks these: deleting the `explainDoubledNamespace` branch from
 * `planDelegation`'s hints (the refusal then names only the mangled id again), or dropping the
 * lower-casing of `inner` so the prefix test here repeats the case-sensitive one that causes the defect.
 */
test("a doubled namespace is explained as the prefix mistake it is, not as a missing capability", () => {
  const explained = explainDoubledNamespace("tool:tool:read");
  assert.match(String(explained), /tool:tool:read is prefixed twice/);
  assert.match(String(explained), /`allowed-tools` adds `tool:`/, "it must name the field that adds the prefix");
  assert.match(String(explained), /write `tool:read`/, "and the entry the author should have written");
});

test("every namespace doubles the same way, and each is explained with its own prefix", () => {
  // `Workspace:prod` and `Agent:review` are lowercased whole, so the mangled id carries the real prefix.
  assert.match(String(explainDoubledNamespace("tool:workspace:prod")), /`workspace:` prefix .* write `workspace:prod`/);
  assert.match(String(explainDoubledNamespace("tool:agent:review")), /write `agent:review`/);
});

// Review of this change, measured: the bare-entry path lower-cases the whole entry before anything here sees it, so
// a workspace or definition id has already lost its own capitalisation and copying the suggestion verbatim may not
// work. Saying so is the difference between a hint and a wrong instruction. Breaks by: offering "or the bare name"
// outside `tool:` (a bare `prod` becomes `tool:prod`, a second unknown capability), or dropping the caveat.
test("the suggestion offers a bare name only where a bare name works, and admits the lost case elsewhere", () => {
  const tool = String(explainDoubledNamespace("tool:tool:read"));
  assert.match(tool, /\(or the bare name `read`\)/);
  assert.doesNotMatch(tool, /capitalisation was folded/);
  for (const id of ["tool:workspace:prod", "tool:agent:review", "tool:skill:foo"] as const) {
    const explained = String(explainDoubledNamespace(id));
    assert.doesNotMatch(explained, /bare name/, `${id}: a bare name is prefixed with tool: and fails again`);
    assert.match(explained, /capitalisation was folded/, `${id}: the id's own case is already gone`);
  }
});

// The model-chosen `tools:` path does not case-fold, so a doubled id can arrive with its capitals intact. Advising
// the author to write back exactly what they typed would be advising the defect. Breaks by: dropping the
// case-insensitive prefix match in `undoubleNamespace`, or re-emitting the prefix as it arrived.
test("a doubled namespace that kept its capitals is suggested in the spelling that actually works", () => {
  assert.match(String(explainDoubledNamespace("tool:Tool:Read")), /write `tool:read`/);
  assert.match(String(explainDoubledNamespace("tool:TOOL:read")), /write `tool:read`/);
});

// Breaks by: making `undoubleNamespace` strip one prefix instead of recursing.
test("an entry prefixed three times is suggested undoubled, not merely less doubled", () => {
  const explained = String(explainDoubledNamespace("tool:tool:tool:read"));
  assert.match(explained, /write `tool:read`/);
  assert.doesNotMatch(explained, /write `tool:tool:/, "the suggestion must not carry the same defect");
});

test("an ordinary unknown capability is left to the typo hint", () => {
  // The legitimate spellings must stay legitimate: neither of these is prefixed twice.
  assert.equal(explainDoubledNamespace("tool:read"), null);
  assert.equal(explainDoubledNamespace("workspace:prod"), null);
  assert.equal(explainDoubledNamespace("tool:raed"), null, "a plain typo is suggestForUnknown's job");
  // `tool:extras` starts with the letters of `ext:` and not the namespace; the colon is what separates them.
  assert.equal(explainDoubledNamespace("tool:extras"), null);
  // Nothing to suggest, so nothing is claimed.
  assert.equal(explainDoubledNamespace("tool:tool:"), null);
});
