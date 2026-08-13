import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalsPath,
  loadApprovals,
  revokeAll,
  revokeApproval,
  saveApproval,
} from "../src/approval-store.ts";
import type { ApprovalEntry } from "../src/approval.ts";

const NOW = new Date("2026-08-20T00:00:00.000Z");

/**
 * A fresh project directory **and a fresh store**.
 *
 * The store part is not tidiness. `approvalsPath()` resolves to `$PI_CODING_AGENT_DIR/grants-approvals.json`
 * and used to take a `cwd` it ignored, so these tests passed a `mkdtemp` directory, believed they were
 * hermetic, and spent every `npm test` rewriting and clearing the developer's REAL store in `$HOME` — one
 * test writing `{ this is not json` over it, another emptying it. Invisible while nothing could write the
 * store; destructive from the moment ADR-0019 made it reachable. Found by a red-team pass, and confirmed by
 * finding this suite's fixtures sitting in `~/.pi/agent/grants-approvals.json`.
 *
 * Per TEST rather than per file, because entries from another project are now preserved on write (as they
 * must be) — so a shared store would leak one test's fixtures into the next one's assertions.
 */
const temp = async () => {
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "grants-agentdir-"));
  return mkdtemp(join(tmpdir(), "grants-approvals-"));
};

/** The body digest every entry here was approved against, unless a test says otherwise (ADR-0019). */
const BODY = "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * A subject lookup. Named for the ceiling because that is what most of these tests vary; the body digest
 * is held constant so a ceiling test stays a ceiling test.
 */
const ceiling = (caps: string[] | null, body: string = BODY) => () =>
  caps === null ? null : { ceiling: caps, bodySha256: body };

const entryFor = (cwd: string, over: Partial<ApprovalEntry> = {}): ApprovalEntry => ({
  approvedAt: "2026-08-09T00:00:00.000Z",
  expiresAt: "2026-09-08T00:00:00.000Z",
  cwd,
  grantAtApproval: ["tool:read", "tool:write"],
  bodyAtApproval: BODY,
  ...over,
});

test("a missing file is empty, not an error", async () => {
  const cwd = await temp();
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read"]) });
  assert.equal(r.valid.size, 0);
  assert.deepEqual(r.dropped, []);
});

test("a corrupt file grants nothing and does not throw", async () => {
  const cwd = await temp();
  await writeFile(approvalsPath(), "{ this is not json", "utf8");
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read"]) });
  assert.equal(r.valid.size, 0, "a broken cache grants nothing");
});

test("round trip: a saved approval loads back", async () => {
  const cwd = await temp();
  const ok = await saveApproval(cwd, "tool:write@docs-writer", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  assert.equal(ok, true);
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read", "tool:write"]) });
  assert.deepEqual([...r.valid.keys()], ["tool:write@docs-writer"]);
});

test("the file records version 1 and is human-readable", async () => {
  const cwd = await temp();
  await saveApproval(cwd, "tool:write@docs-writer", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  const parsed = JSON.parse(await readFile(approvalsPath(), "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.approvals["tool:write@docs-writer"].cwd, cwd);
  assert.ok(await readFile(approvalsPath(), "utf8").then((t) => t.includes("\n")), "pretty-printed");
});

test("R-27: an entry from another checkout is dropped with a reason", async () => {
  const cwd = await temp();
  await writeFile(
    approvalsPath(),
    JSON.stringify({ version: 1, approvals: { "tool:write@docs-writer": entryFor("/somewhere/else") } }),
    "utf8",
  );
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 0);
  assert.equal(r.dropped[0].verdict, "foreign-cwd");
});

test("a changed agent type drops the entry with a reason", async () => {
  const cwd = await temp();
  await saveApproval(cwd, "tool:write@docs-writer", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:bash", "tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 0);
  assert.equal(r.dropped[0].verdict, "type-changed");
});

test("ADR-0019: a rewritten BODY drops the entry, even when the tools are untouched", async () => {
  // The gap `grantAtApproval` alone could not see. A human approves `tool:write` for a definition that
  // says "fix typos"; the file is later rewritten to say something else while keeping `allowed-tools`
  // identical. The key still matches and the ceiling still matches — the instructions do not.
  const cwd = await temp();
  await saveApproval(cwd, "tool:write@docs-writer", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  const r = await loadApprovals({
    cwd,
    now: NOW,
    snapshotOf: ceiling(["tool:read", "tool:write"], "a-different-body-digest-entirely"),
  });
  assert.equal(r.valid.size, 0);
  assert.equal(r.dropped[0].verdict, "instructions-changed");
});

test("ADR-0019: an entry with no body pin is dropped — unverifiable is not unchanged", async () => {
  // Entries written before 0.10.0 carry no `bodyAtApproval`. Failing closed costs one re-approval;
  // failing open would silently honour a yes given about text nobody can now identify.
  const cwd = await temp();
  await writeFile(
    approvalsPath(),
    JSON.stringify({
      version: 1,
      approvals: { "tool:write@docs-writer": entryFor(cwd, { bodyAtApproval: undefined }) },
    }),
    "utf8",
  );
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 0);
  assert.equal(r.dropped[0].verdict, "instructions-changed");
});

test("revoke removes one entry and leaves the others", async () => {
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);
  await saveApproval(cwd, "tool:write@a", entryFor(cwd), c, NOW);
  await saveApproval(cwd, "tool:write@b", entryFor(cwd), c, NOW);
  assert.equal(await revokeApproval(cwd, "tool:write@a", c, NOW), true);
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: c });
  assert.deepEqual([...r.valid.keys()], ["tool:write@b"]);
});

test("revoking something that was never approved reports false", async () => {
  const cwd = await temp();
  assert.equal(await revokeApproval(cwd, "tool:write@nope", ceiling(["tool:read", "tool:write"]), NOW), false);
});

test("revokeAll clears THIS project and leaves other projects alone", async () => {
  // It used to write an empty file, so `/grants revoke --all` in one checkout silently revoked every other
  // checkout on the machine. An operator running it in one project is answering for that project; there is
  // no interface for "and everywhere else", so it must not be the default reading.
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);
  await saveApproval(cwd, "tool:write@a", entryFor(cwd), c, NOW);
  await saveApproval("/work/other", "tool:write@b", entryFor("/work/other"), c, NOW);

  assert.equal(await revokeAll(cwd, c, NOW), true);

  assert.equal((await loadApprovals({ cwd, now: NOW, snapshotOf: c })).valid.size, 0, "this project is cleared");
  assert.equal(
    (await loadApprovals({ cwd: "/work/other", now: NOW, snapshotOf: c })).valid.size,
    1,
    "the other project's approval survives",
  );
});

test("saving prunes entries that are DEAD, and only those", async () => {
  // Re-targeted. This test used to stage `entryFor("/elsewhere")` — another project's approval — and assert
  // it was "pruned on write". That is the defect, not the specification: the store is one file for every
  // project, so pruning it deleted a live approval belonging to a different checkout. An entry this session
  // can see is dead (expired) is a different thing, and is what pruning is for.
  const cwd = await temp();
  await writeFile(
    approvalsPath(),
    JSON.stringify({
      version: 1,
      approvals: { "tool:write@expired": entryFor(cwd, { expiresAt: "2026-01-01T00:00:00.000Z" }) },
    }),
    "utf8",
  );
  await saveApproval(cwd, "tool:write@fresh", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  const parsed = JSON.parse(await readFile(approvalsPath(), "utf8"));
  assert.deepEqual(Object.keys(parsed.approvals), ["tool:write@fresh"], "the expired entry was pruned on write");
});

test("saving in one project does not delete another project's approvals", async () => {
  // The measured failure: approve in /work/api, then approve anything at all in /work/web, and the first
  // entry is not merely ignored in /work/web — it is GONE from the file, so /work/api prompts again. Two
  // active projects turned `always` into "always, until I approve something anywhere else", which is the
  // prompt fatigue ADR-0019 exists to remove. Breaks if `saveApproval` writes only the `valid` set.
  const api = await temp();          // also fixes the store for both halves of this test
  const web = "/work/web";
  const c = ceiling(["tool:read", "tool:write"]);

  await saveApproval(api, "tool:write@deploy", entryFor(api), c, NOW);
  await saveApproval(web, "tool:write@build", entryFor(web), c, NOW);

  const back = await loadApprovals({ cwd: api, now: NOW, snapshotOf: c });
  assert.deepEqual([...back.valid.keys()], ["tool:write@deploy"], "project A's approval must survive project B's");
  assert.deepEqual(
    back.dropped.map((d) => d.verdict),
    ["foreign-cwd"],
    "and B's is present but inert here, which is exactly what foreign-cwd means",
  );
});

test("two concurrent saves in one process both land", async () => {
  // The temp file was named `${path}.${pid}.tmp` — per PROCESS, not per call. So two concurrent writes
  // collided: the second's `wx` failed EEXIST, its catch unlinked the FIRST's in-flight temp, and the
  // first's rename then failed ENOENT. Measured: both returned false and nothing was written, with two
  // DIFFERENT keys — so it was never limited to the shared-dialog case. `delegate_all` is this shape.
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);

  const results = await Promise.all([
    saveApproval(cwd, "tool:write@a", entryFor(cwd), c, NOW),
    saveApproval(cwd, "tool:write@b", entryFor(cwd), c, NOW),
  ]);

  assert.deepEqual(results, [true, true], "a writable store must not report failure to either caller");
  const back = await loadApprovals({ cwd, now: NOW, snapshotOf: c });
  assert.ok(back.valid.size >= 1, "and at least one write must survive rather than both being lost");
});

test("an unwritable location reports failure rather than throwing", async () => {
  // ADR-0014 moved the store out of the workspace, so the unwritable location has to be the STORE's
  // directory, not the project's — pointing a cwd at /dev/null no longer has any bearing on where we write.
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/dev/null/nope";
  try {
  const ok = await saveApproval(
    "/dev/null",
    "tool:write@x",
    entryFor("/dev/null"),
    ceiling(["tool:read", "tool:write"]),
    NOW,
  );
  assert.equal(ok, false, "the caller downgrades to session scope rather than failing the work");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("a null entry drops without taking valid entries with it", async () => {
  const cwd = await temp();
  await writeFile(
    approvalsPath(),
    JSON.stringify({ version: 1, approvals: { "tool:write@good": entryFor(cwd), "tool:write@bad": null } }),
    "utf8",
  );
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 1, "the valid entry loads");
  assert.deepEqual([...r.valid.keys()], ["tool:write@good"]);
  assert.equal(r.dropped.length, 1, "the null entry is reported as dropped");
  assert.equal(r.dropped[0].verdict, "expired", "malformed entries are marked expired");
});

test("a non-object entry (string) drops without taking valid entries with it", async () => {
  const cwd = await temp();
  await writeFile(
    approvalsPath(),
    JSON.stringify({ version: 1, approvals: { "tool:write@good": entryFor(cwd), "tool:write@bad": "not an object" } }),
    "utf8",
  );
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 1, "the valid entry loads");
  assert.deepEqual([...r.valid.keys()], ["tool:write@good"]);
});

test("revokeApproval prunes a dead entry but keeps another project's", async () => {
  // Also re-targeted: the injected entry was `entryFor("/elsewhere")` and the assertion was that revoking
  // one approval deleted it. Revoking in one checkout must not revoke in another.
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);
  await saveApproval(cwd, "tool:write@target", entryFor(cwd), c, NOW);

  const current = JSON.parse(await readFile(approvalsPath(), "utf8"));
  current.approvals["tool:write@expired"] = entryFor(cwd, { expiresAt: "2026-01-01T00:00:00.000Z" });
  current.approvals["tool:write@other-project"] = entryFor("/elsewhere");
  await writeFile(approvalsPath(), JSON.stringify(current), "utf8");

  await revokeApproval(cwd, "tool:write@target", c, NOW);

  const parsed = JSON.parse(await readFile(approvalsPath(), "utf8"));
  assert.deepEqual(
    Object.keys(parsed.approvals).sort(),
    ["tool:write@other-project"],
    "the target is revoked and the expired one pruned; the other project's is untouched",
  );
});

test("a wrong-version file grants nothing", async () => {
  const cwd = await temp();
  await writeFile(
    approvalsPath(),
    JSON.stringify({ version: 2, approvals: { "tool:write@x": entryFor(cwd) } }),
    "utf8",
  );
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 0, "wrong version grants nothing");
  assert.deepEqual(r.dropped, [], "entries from wrong-version files are not reported (they are silently ignored)");
});
