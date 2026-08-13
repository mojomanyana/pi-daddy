/**
 * G1 — the argv channel (review findings A-C1 / B-C7).
 *
 * `planSpawn` puts the delegation task into argv as a bare positional element. pi's CLI parses
 * positional arguments BEFORE any tool is constructed (`pi [options] [@files...] [messages...]`), so:
 *
 *   - an argument beginning with `@` is resolved as a FILE and injected into the child's prompt —
 *     absolute paths, `~` expansion, no sandbox — which `--tools`/`--no-tools` cannot touch, because
 *     no tool is involved;
 *   - an argument beginning with `-` is parsed as a FLAG, and pi ships `--approve` ("trust
 *     project-local files for this run"), so a task can change the child's trust posture.
 *
 * The task is model-controlled. These tests pin the rule that closes it: a model-controlled string
 * must never occupy a position pi's CLI will parse.
 *
 * Verified against real pi 0.83.0 before the fix: `pi --print --no-session --no-extensions --no-tools
 * "@/tmp/g1/decoy.env"` answered "How would you like me to work with `decoy.env`?" — the file was read
 * by a child granted NO tools at all.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { planSpawn } from "../src/spawn.ts";

/** The task always lands in the final argv element; these tests are about what pi sees there. */
const promptArg = (args: string[]) => args[args.length - 1];

test("a task beginning with @ cannot reach pi's file-argument parser", () => {
  const plan = planSpawn({ effective: [], prompt: "@/home/user/.ssh/id_rsa" });
  assert.ok(
    !promptArg(plan.args).startsWith("@"),
    "pi resolves any argv element starting with @ as a file, before any tool exists",
  );
});

test("a task beginning with - cannot be parsed as a flag", () => {
  const plan = planSpawn({ effective: [], prompt: "--approve" });
  assert.ok(
    !promptArg(plan.args).startsWith("-"),
    "pi's --approve trusts project-local files; a model-authored task must not be able to pass it",
  );
});

test("the task's own text survives neutralisation", () => {
  const task = "@/etc/passwd";
  const plan = planSpawn({ effective: [], prompt: task });
  assert.ok(
    promptArg(plan.args).includes(task),
    "neutralising the argv position must not silently rewrite what the child is asked to do",
  );
});

test("neutralisation does not depend on recognising pi's current prefixes", () => {
  // The `@` and `-` branches are what pi 0.83.0 happens to parse today, and extensions can register
  // further flags. A fix that only rewrites those two prefixes re-breaks the moment pi adds a third,
  // so the guarantee is positional: the first character is never the task's own.
  const plan = planSpawn({ effective: [], prompt: "ordinary task" });
  assert.equal(promptArg(plan.args)[0], " ");
});

test("an empty task still yields an unparseable argv element", () => {
  const plan = planSpawn({ effective: [], prompt: "" });
  assert.ok(!promptArg(plan.args).startsWith("@"));
  assert.ok(!promptArg(plan.args).startsWith("-"));
});

test("neutralisation is the last argv element, after every flag", () => {
  const plan = planSpawn({ effective: ["tool:read"], prompt: "@x", model: "openai-codex/gpt-5.6-sol" });
  assert.equal(plan.args.indexOf("--tools") + 2, plan.args.length - 1, "the task must stay positional-last");
});

// ---------------------------------------------------------------------------
// R-32 — a governed child inherited every skill the operator had, and CLAUDE.md.
//
// Measured in `docs/probes/g16-herdr`: a child spawned with `--tools read` printed
//   [Context] CLAUDE.md
//   [Skills]  architect, build, debug, decide, git-ops, plan, review, skill-harness
// because `planSpawn` passed `--no-extensions` and nothing else. pi has SEPARATE
// `--no-skills` / `--skill` and `--no-context-files` flags.
//
// From pi's own resolver (`dist/core/resource-loader.js:329`), `--no-skills` drops DISCOVERED skills
// while keeping explicitly-passed `--skill` paths — so "none, then exactly these" is expressible.
// ---------------------------------------------------------------------------

test("R-32: skills are withheld by default", () => {
  const plan = planSpawn({ effective: ["tool:read"], prompt: "audit" });
  assert.ok(plan.args.includes("--no-skills"), "a grant naming no skill must yield a child with no skills");
  assert.ok(!plan.args.includes("--skill"), "and nothing to load");
});

test("R-32: a granted skill is passed by path, and only that one", () => {
  const plan = planSpawn({
    effective: ["tool:read", "skill:review"],
    prompt: "review this diff",
    skillPaths: { review: "/skills/review", debug: "/skills/debug" },
  });
  // `--no-skills` must still be present: it is what drops the operator's OTHER skills. Passing only
  // `--skill` would ADD to the discovered set rather than replace it — the permissive direction.
  assert.ok(plan.args.includes("--no-skills"), "discovery stays off; --skill is an allowlist, not an addition");
  assert.deepEqual(plan.skills, ["/skills/review"]);
  const at = plan.args.indexOf("--skill");
  assert.equal(plan.args[at + 1], "/skills/review");
  assert.ok(!plan.args.includes("/skills/debug"), "an ungranted skill must not be loaded");
});

test("R-32: a granted skill with no known path is reported, never silently dropped", () => {
  // Silently dropping it produces a child that mysteriously cannot do its job; silently loading
  // everything would be the permissive direction. Neither is acceptable, so the caller is told.
  const plan = planSpawn({ effective: ["skill:ghost"], prompt: "x", skillPaths: {} });
  assert.deepEqual(plan.unresolvedSkills, ["skill:ghost"]);
  assert.deepEqual(plan.skills, []);
});

test("R-32: context files are withheld by default and can be opted into", () => {
  // CLAUDE.md is model-directing text that no grant describes and no ledger line records. Under
  // ADR-0012's threat model (prompt injection in scope) an untrusted repo's context file reaching a
  // governed child is the injection vector, so the default is off — but it stays expressible.
  const off = planSpawn({ effective: ["tool:read"], prompt: "x" });
  assert.ok(off.args.includes("--no-context-files"));

  const on = planSpawn({ effective: ["tool:read"], prompt: "x", contextFiles: true });
  assert.ok(!on.args.includes("--no-context-files"), "an explicit opt-in must be honoured");
});

test("R-32: skill flags come before the prompt, which stays last", () => {
  // The G1 guarantee is positional: the task must remain the FINAL argv element regardless of what
  // else is added. A new flag inserted after it would put a model-controlled string back in front of
  // a parser.
  const plan = planSpawn({
    effective: ["tool:read", "skill:review"],
    prompt: "audit",
    skillPaths: { review: "/skills/review" },
  });
  assert.equal(plan.args.at(-1), " audit");
});

test("R-32: prompt templates are withheld too", () => {
  // The same class as skills and context files, found the same way — the fixed child's banner still
  // showed `[Prompts] /bugfix, /feature`. The risk is genuinely LOWER than skills': a template is
  // expanded when a human invokes `/name`, not injected into the system prompt, and a `--print` child
  // has no human. It is withheld anyway for one reason: under a herdr backend a governed child runs in
  // an attachable pane WITH a human, and "only what the grant names" should not depend on which
  // executor ran it.
  const plan = planSpawn({ effective: ["tool:read"], prompt: "x" });
  assert.ok(plan.args.includes("--no-prompt-templates"));
});
