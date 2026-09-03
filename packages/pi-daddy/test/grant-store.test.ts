/**
 * The project store — a root source for the grant and explicit ledger consent, never a second child channel.
 *
 * **The production change that breaks these tests** (rule 7): letting the store outrank the environment,
 * honouring a file that names another directory, inferring ledger consent from v1, or accepting malformed
 * input as anything but nothing. Each decides configuration on behalf of someone other than the operator.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  clearGrant,
  grantStorePath,
  loadGrant,
  loadGrantSync,
  loadStoredGrant,
  loadStoredGrantSync,
  loadStoredGrantState,
  loadStoredGrantStateSync,
  parseGrantFile,
  projectLedgerPath,
  saveGrant,
} from "../src/grant-store.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { expandSubsumed, type Capability } from "../src/resolve.ts";

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

test("a new init opts this project into its ledger, while a legacy grant does not", async () => {
  const legacyCwd = await temp();
  assert.equal(await saveGrant(legacyCwd, ["tool:read"]), "saved");
  assert.deepEqual(loadStoredGrantSync(legacyCwd), {
    grant: ["tool:read"],
    projectLedger: false,
  }, "an existing v1 choice is not reinterpreted as ledger consent after upgrade");
  await writeFile(grantStorePath(legacyCwd), JSON.stringify({
    version: 1,
    cwd: legacyCwd,
    grant: ["tool:read"],
    projectLedger: true,
    writtenAt: "x",
  }), "utf8");
  assert.equal(
    loadStoredGrantSync(legacyCwd)?.projectLedger,
    false,
    "even a lookalike field cannot smuggle ledger consent into the v1 grammar",
  );

  const cwd = await tempDir("grants-project-");
  assert.equal(await saveGrant(cwd, ["tool:read"], { projectLedger: true }), "saved");
  const expected = { grant: ["tool:read"], projectLedger: true };
  assert.deepEqual(loadStoredGrantSync(cwd), expected);
  assert.deepEqual(await loadStoredGrant(cwd), expected, "sync factory and async diagnostics share one parser");
  assert.equal(projectLedgerPath(cwd), join(cwd, ".pi", "grants.jsonl"));

  const raw = JSON.parse(await readFile(grantStorePath(cwd), "utf8")) as Record<string, unknown>;
  assert.equal(raw.version, 2, "ledger consent is explicit in a versioned store, never inferred from existence");
  assert.equal(raw.projectLedger, true);
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

test("the loader distinguishes absent, malformed, unsupported, unreadable and wrong-cwd stores", async (t) => {
  const cwd = await temp();
  const path = grantStorePath(cwd);
  await mkdir(dirname(path), { recursive: true });

  assert.deepEqual(loadStoredGrantStateSync(cwd), { state: "absent" });
  await writeFile(path, "{ not json", "utf8");
  assert.deepEqual(loadStoredGrantStateSync(cwd), { state: "refuse", reason: "malformed" });
  await writeFile(path, JSON.stringify({ version: 99, cwd, grant: ["tool:read"] }), "utf8");
  assert.deepEqual(await loadStoredGrantState(cwd), { state: "refuse", reason: "unsupported-version" });
  await writeFile(path, JSON.stringify({ version: 2, cwd: "/elsewhere", grant: ["tool:read"], projectLedger: true }), "utf8");
  assert.deepEqual(loadStoredGrantStateSync(cwd), { state: "refuse", reason: "wrong-cwd" });

  if (process.getuid?.() === 0) return t.skip("root ignores file permissions");
  await writeFile(path, JSON.stringify({ version: 2, cwd, grant: ["tool:read"], projectLedger: true }), "utf8");
  const { chmod } = await import("node:fs/promises");
  await chmod(path, 0o000);
  try {
    assert.deepEqual(await loadStoredGrantState(cwd), { state: "refuse", reason: "unreadable" });
  } finally {
    await chmod(path, 0o600);
  }
});

test("the parser rejects every malformed store shape", async () => {
  // The parser returns null on each doubt and never constructs a partial ceiling. Session-level absent versus
  // invalid handling is a separate, currently open problem (R-175); do not overclaim that boundary here.
  const cwd = "/p";
  for (const [label, text] of [
    ["not json", "{ this is not json"],
    ["wrong version", JSON.stringify({ version: 3, cwd: "/p", grant: ["tool:read"] })],
    ["v2 missing ledger consent", JSON.stringify({ version: 2, cwd: "/p", grant: ["tool:read"] })],
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

test("R-76: a capability already conferred by subsumption is not asked about", async () => {
  // Three defects found by running `/grants init` end to end, of which this is the worst. `tool:bash`
  // subsumes `write`, `edit` and `edit-diff`, so once bash is granted those are conferred — and the dialog
  // asked about them anyway. An operator could answer NO to `tool:write`, then watch `/grants` allow
  // `build` with `tool:write`, and conclude the dialog was decorative. It was: R-47's shape, inside a
  // control built to prevent exactly that.
  //
  // **The production change that breaks this test** (rule 7): asking about a capability that
  // `expandSubsumed` already reports as held.
  const held: Capability[] = ["tool:bash"];
  const expanded = expandSubsumed(held);
  for (const c of ["tool:write", "tool:edit", "tool:edit-diff"] as Capability[]) {
    assert.ok(expanded.includes(c), `${c} is conferred by bash, so asking about it is a question with no answer`);
  }
  // And the converse, so "skip it" has not become "skip everything": bash confers no authority to spawn.
  assert.ok(!expandSubsumed(["tool:read"]).includes("tool:write"), "read confers nothing");
  assert.ok(!expanded.includes("agent:build"), "a tool never confers an agent: id");
});
