/**
 * The grant store — a second SOURCE for the root session's grant, never a second channel to children.
 *
 * **The production change that breaks these tests** (rule 7): letting the store outrank `PI_GRANTS_GRANT`,
 * honouring a file that names a different directory, or accepting a malformed one as anything but nothing.
 * Each is a way for a ceiling to be decided by something other than the operator who set it.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { after, test } from "node:test";
import { clearGrant, grantStorePath, loadGrant, loadGrantSync, parseGrantFile, saveGrant } from "../src/grant-store.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/** A fresh project AND a fresh store, for the reason `approval-store.test.ts` learned the hard way (R-40). */
const temp = async () => {
  process.env.PI_CODING_AGENT_DIR = await tempDir("grants-storedir-");
  return tempDir("grants-project-");
};

test("round trip: a saved grant loads back, sync and async alike", async () => {
  const cwd = await temp();
  assert.equal(await saveGrant(cwd, ["tool:read", "agent:review"]), "saved");
  // Both readers exist because the factory cannot await (S-5), and two parsers is how they come to
  // disagree. They share one, so this asserts they agree.
  assert.deepEqual(await loadGrant(cwd), ["agent:review", "tool:read"]);
  assert.deepEqual(loadGrantSync(cwd), ["agent:review", "tool:read"]);
});

test("it lives OUTSIDE the project — the whole point", async () => {
  // A grant a governed child can rewrite is not a ceiling. `<cwd>/.pi/grants.env` is writable by any child
  // holding `tool:write`, so storing the live grant there would let a child widen the NEXT session — the
  // self-defeating case ADR-0014 moved the approval store out of the workspace to close.
  const cwd = await temp();
  const path = grantStorePath(cwd);
  assert.ok(!path.startsWith(cwd), `the store must not be inside the project it governs: ${path}`);
  assert.ok(path.startsWith(process.env.PI_CODING_AGENT_DIR!), "it belongs to the agent dir");
});

test("two projects get different files, and one cannot read the other's", async () => {
  const a = await temp();
  const b = await tempDir("grants-project-");
  await saveGrant(a, ["tool:read"]);
  assert.notEqual(grantStorePath(a), grantStorePath(b));
  assert.equal(loadGrantSync(b), null, "a directory with no grant of its own is ungoverned");
});

test("R-27: a grant naming another directory is refused, not honoured", async () => {
  // The store is keyed by path, but the file also RECORDS the path, and the record is what is checked. A
  // file copied to another machine or another checkout describes a directory that is not this one, and
  // honouring it would let a grant travel somewhere nobody authorised it for.
  const cwd = await temp();
  await mkdir(dirname(grantStorePath(cwd)), { recursive: true });
  await writeFile(
    grantStorePath(cwd),
    JSON.stringify({ version: 1, cwd: "/somewhere/else", grant: ["tool:*"], writtenAt: "x" }),
    "utf8",
  );
  assert.equal(loadGrantSync(cwd), null, "a foreign grant grants nothing");
});

test("every malformed shape grants NOTHING, never something", async () => {
  // Fails closed on each doubt. A store that yields a partial grant on damaged input is worse than one
  // that yields none: it would be a ceiling nobody chose.
  const cwd = "/p";
  for (const [label, text] of [
    ["not json", "{ this is not json"],
    ["wrong version", JSON.stringify({ version: 2, cwd: "/p", grant: ["tool:read"] })],
    ["missing grant", JSON.stringify({ version: 1, cwd: "/p" })],
    ["grant not an array", JSON.stringify({ version: 1, cwd: "/p", grant: "tool:read" })],
    ["a non-string entry", JSON.stringify({ version: 1, cwd: "/p", grant: ["tool:read", 7] })],
    ["an empty entry", JSON.stringify({ version: 1, cwd: "/p", grant: ["tool:read", ""] })],
  ] as const) {
    assert.equal(parseGrantFile(text, cwd), null, label);
  }
  // …and the shape that must still work, so "fails closed" has not become "fails always".
  assert.deepEqual(parseGrantFile(JSON.stringify({ version: 1, cwd, grant: ["tool:read"] }), cwd), ["tool:read"]);
});

test("a missing store is null, not an error — governance stays opt-in", async () => {
  const cwd = await temp();
  assert.equal(loadGrantSync(cwd), null);
  assert.equal(await loadGrant(cwd), null);
  assert.equal(await clearGrant(cwd), false, "nothing to clear is not a failure");
});

test("clearGrant removes it, and the directory is ungoverned again", async () => {
  const cwd = await temp();
  await saveGrant(cwd, ["tool:read"]);
  assert.equal(await clearGrant(cwd), true);
  assert.equal(loadGrantSync(cwd), null, "removing the store must actually un-govern the directory");
});
