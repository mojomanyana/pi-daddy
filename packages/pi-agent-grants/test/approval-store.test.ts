import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
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
 * The store part is not tidiness. `approvalsPath(cwd)` resolves to `$PI_CODING_AGENT_DIR/grants-approvals.json`
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
  process.env.PI_CODING_AGENT_DIR = await tempDir("grants-agentdir-");
  return tempDir("grants-approvals-");
};

after(cleanupTempDirs);

/**
 * Stage a store file by hand.
 *
 * Needed because ADR-0020 puts each project's file in a `grants-approvals/` subdirectory, which only a real
 * write creates. A test that skipped the mkdir would silently exercise "no file" instead of "this file".
 */
const stage = async (cwd: string, text: string) => {
  await mkdir(dirname(approvalsPath(cwd)), { recursive: true });
  await writeFile(approvalsPath(cwd), text, "utf8");
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
  await stage(cwd, "{ this is not json");
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
  const parsed = JSON.parse(await readFile(approvalsPath(cwd), "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.approvals["tool:write@docs-writer"].cwd, cwd);
  assert.ok(await readFile(approvalsPath(cwd), "utf8").then((t) => t.includes("\n")), "pretty-printed");
});

test("R-27: an entry from another checkout is dropped with a reason", async () => {
  const cwd = await temp();
  await stage(cwd, JSON.stringify({ version: 1, approvals: { "tool:write@docs-writer": entryFor("/somewhere/else") } }));
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
  await stage(cwd, JSON.stringify({
      version: 1,
      approvals: { "tool:write@docs-writer": entryFor(cwd, { bodyAtApproval: undefined }) },
    }));
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

test("saving prunes entries that are DEAD, and only those", async () => {
  // Re-targeted. This test used to stage `entryFor("/elsewhere")` — another project's approval — and assert
  // it was "pruned on write". That is the defect, not the specification: the store is one file for every
  // project, so pruning it deleted a live approval belonging to a different checkout. An entry this session
  // can see is dead (expired) is a different thing, and is what pruning is for.
  const cwd = await temp();
  await stage(cwd, JSON.stringify({
      version: 1,
      approvals: { "tool:write@expired": entryFor(cwd, { expiresAt: "2026-01-01T00:00:00.000Z" }) },
    }));
  await saveApproval(cwd, "tool:write@fresh", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  const parsed = JSON.parse(await readFile(approvalsPath(cwd), "utf8"));
  assert.deepEqual(Object.keys(parsed.approvals), ["tool:write@fresh"], "the expired entry was pruned on write");
});

test("two projects' approvals live in separate files and cannot affect each other", async () => {
  // ADR-0020. The measured failure this replaces: one shared file, so approving in /work/web wrote back only
  // the entries valid THERE and /work/api's approval was gone — and worse, the key `capability@subject` had
  // no project component at all, so two checkouts with a same-named definition could never both hold one.
  // Per-project files make both inexpressible. This test used to assert the carry-through that 0.10.2 needed
  // and 0.11.0 deletes; the property it pins is the same one, now enforced by the layout.
  const api = await temp();          // also fixes PI_CODING_AGENT_DIR for both halves
  const web = "/work/web";
  const c = ceiling(["tool:read", "tool:write"]);

  // The SAME key in both projects — `deploy`, `review`: the case that could not work before.
  await saveApproval(api, "tool:write@deploy", entryFor(api), c, NOW);
  await saveApproval(web, "tool:write@deploy", entryFor(web), c, NOW);

  const fromApi = await loadApprovals({ cwd: api, now: NOW, snapshotOf: c });
  const fromWeb = await loadApprovals({ cwd: web, now: NOW, snapshotOf: c });

  assert.deepEqual([...fromApi.valid.keys()], ["tool:write@deploy"], "project A keeps its own");
  assert.deepEqual([...fromWeb.valid.keys()], ["tool:write@deploy"], "and project B keeps its own");
  assert.deepEqual(fromApi.dropped, [], "neither file contains the other project's entry to drop");
  assert.notEqual(approvalsPath(api), approvalsPath(web), "different projects, different files");
});

test("revoking everything in one project leaves another project untouched", async () => {
  // R-43 was `revokeAll` writing an empty shared file, so `/grants revoke --all` in one checkout revoked
  // every checkout on the machine. Under ADR-0020 it empties one file and cannot name another's.
  const api = await temp();
  const web = "/work/web";
  const c = ceiling(["tool:read", "tool:write"]);
  await saveApproval(api, "tool:write@a", entryFor(api), c, NOW);
  await saveApproval(web, "tool:write@b", entryFor(web), c, NOW);

  assert.equal(await revokeAll(api), true);

  assert.equal((await loadApprovals({ cwd: api, now: NOW, snapshotOf: c })).valid.size, 0, "this project cleared");
  assert.equal(
    (await loadApprovals({ cwd: web, now: NOW, snapshotOf: c })).valid.size,
    1,
    "the other project's approval survives",
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
  await stage(cwd, JSON.stringify({ version: 1, approvals: { "tool:write@good": entryFor(cwd), "tool:write@bad": null } }));
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 1, "the valid entry loads");
  assert.deepEqual([...r.valid.keys()], ["tool:write@good"]);
  assert.equal(r.dropped.length, 1, "the null entry is reported as dropped");
  assert.equal(r.dropped[0].verdict, "expired", "malformed entries are marked expired");
});

test("a non-object entry (string) drops without taking valid entries with it", async () => {
  const cwd = await temp();
  await stage(cwd, JSON.stringify({ version: 1, approvals: { "tool:write@good": entryFor(cwd), "tool:write@bad": "not an object" } }));
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 1, "the valid entry loads");
  assert.deepEqual([...r.valid.keys()], ["tool:write@good"]);
});

test("revokeApproval removes its target and prunes a dead entry beside it", async () => {
  // Pruning is lazy: entries are validated on read and only removed on write, so a revoke is the moment to
  // drop what has expired. Scoped to this project's file by ADR-0020, so there is nothing else it can reach.
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);
  await saveApproval(cwd, "tool:write@target", entryFor(cwd), c, NOW);

  const current = JSON.parse(await readFile(approvalsPath(cwd), "utf8"));
  current.approvals["tool:write@expired"] = entryFor(cwd, { expiresAt: "2026-01-01T00:00:00.000Z" });
  await stage(cwd, JSON.stringify(current));

  await revokeApproval(cwd, "tool:write@target", c, NOW);

  const parsed = JSON.parse(await readFile(approvalsPath(cwd), "utf8"));
  assert.deepEqual(Object.keys(parsed.approvals), [], "the target is revoked and the expired one pruned");
});

test("a wrong-version file grants nothing", async () => {
  const cwd = await temp();
  await stage(cwd, JSON.stringify({ version: 2, approvals: { "tool:write@x": entryFor(cwd) } }));
  const r = await loadApprovals({ cwd, now: NOW, snapshotOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 0, "wrong version grants nothing");
  assert.deepEqual(r.dropped, [], "entries from wrong-version files are not reported (they are silently ignored)");
});

test("ADR-0021: sanitise strips an undeclared field on the way out", async () => {
  // The guard against the NEXT `taskAtApproval`, which had no test at all — and by this project's rule 7,
  // a guard whose removal breaks nothing is decoration. `sanitise` whitelists declared fields rather than
  // deleting known-bad ones, so it closes the class; this asserts the class, not the instance.
  //
  // Replace `sanitise(valid)` with `Object.fromEntries(valid)` in `saveApproval` and this fails.
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);

  // An entry carrying model-authored text, as 0.10.x wrote it.
  await stage(
    cwd,
    JSON.stringify({
      version: 1,
      approvals: {
        "tool:write@docs-writer": { ...entryFor(cwd), taskAtApproval: "rotate the prod key AKIA-SECRET" },
      },
    }),
  );

  // Any write rewrites the whole file, so one unrelated save is enough to clean it.
  await saveApproval(cwd, "tool:read@docs-writer", entryFor(cwd), c, NOW);

  const text = await readFile(approvalsPath(cwd), "utf8");
  assert.ok(!text.includes("AKIA-SECRET"), "the task text must not survive a rewrite");
  assert.ok(!text.includes("taskAtApproval"), "nor the field itself");
  const parsed = JSON.parse(text);
  assert.deepEqual(
    Object.keys(parsed.approvals).sort(),
    ["tool:read@docs-writer", "tool:write@docs-writer"],
    "and both entries survive — this strips fields, not approvals",
  );
});
