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
