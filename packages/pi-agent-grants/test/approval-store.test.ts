import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
const temp = () => mkdtemp(join(tmpdir(), "grants-approvals-"));
const ceiling = (caps: string[] | null) => () => caps;

const entryFor = (cwd: string, over: Partial<ApprovalEntry> = {}): ApprovalEntry => ({
  approvedAt: "2026-08-09T00:00:00.000Z",
  expiresAt: "2026-09-08T00:00:00.000Z",
  cwd,
  grantAtApproval: ["tool:read", "tool:write"],
  ...over,
});

test("a missing file is empty, not an error", async () => {
  const cwd = await temp();
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read"]) });
  assert.equal(r.valid.size, 0);
  assert.deepEqual(r.dropped, []);
});

test("a corrupt file grants nothing and does not throw", async () => {
  const cwd = await temp();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(approvalsPath(cwd), "{ this is not json", "utf8");
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read"]) });
  assert.equal(r.valid.size, 0, "a broken cache grants nothing");
});

test("round trip: a saved approval loads back", async () => {
  const cwd = await temp();
  const ok = await saveApproval(cwd, "tool:write@docs-writer", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  assert.equal(ok, true);
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read", "tool:write"]) });
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
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    approvalsPath(cwd),
    JSON.stringify({ version: 1, approvals: { "tool:write@docs-writer": entryFor("/somewhere/else") } }),
    "utf8",
  );
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 0);
  assert.equal(r.dropped[0].verdict, "foreign-cwd");
});

test("a changed agent type drops the entry with a reason", async () => {
  const cwd = await temp();
  await saveApproval(cwd, "tool:write@docs-writer", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:bash", "tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 0);
  assert.equal(r.dropped[0].verdict, "type-changed");
});

test("revoke removes one entry and leaves the others", async () => {
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);
  await saveApproval(cwd, "tool:write@a", entryFor(cwd), c, NOW);
  await saveApproval(cwd, "tool:write@b", entryFor(cwd), c, NOW);
  assert.equal(await revokeApproval(cwd, "tool:write@a", c, NOW), true);
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: c });
  assert.deepEqual([...r.valid.keys()], ["tool:write@b"]);
});

test("revoking something that was never approved reports false", async () => {
  const cwd = await temp();
  assert.equal(await revokeApproval(cwd, "tool:write@nope", ceiling(["tool:read", "tool:write"]), NOW), false);
});

test("revokeAll clears the file", async () => {
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);
  await saveApproval(cwd, "tool:write@a", entryFor(cwd), c, NOW);
  const ok = await revokeAll(cwd);
  assert.equal(ok, true);
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: c });
  assert.equal(r.valid.size, 0);
});

test("saving prunes entries that have become invalid", async () => {
  const cwd = await temp();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    approvalsPath(cwd),
    JSON.stringify({ version: 1, approvals: { "tool:write@stale": entryFor("/elsewhere") } }),
    "utf8",
  );
  await saveApproval(cwd, "tool:write@fresh", entryFor(cwd), ceiling(["tool:read", "tool:write"]), NOW);
  const parsed = JSON.parse(await readFile(approvalsPath(cwd), "utf8"));
  assert.deepEqual(Object.keys(parsed.approvals), ["tool:write@fresh"], "the stale entry was pruned on write");
});

test("an unwritable location reports failure rather than throwing", async () => {
  const ok = await saveApproval(
    "/dev/null",
    "tool:write@x",
    entryFor("/dev/null"),
    ceiling(["tool:read", "tool:write"]),
    NOW,
  );
  assert.equal(ok, false, "the caller downgrades to session scope rather than failing the work");
});

test("a null entry drops without taking valid entries with it", async () => {
  const cwd = await temp();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    approvalsPath(cwd),
    JSON.stringify({ version: 1, approvals: { "tool:write@good": entryFor(cwd), "tool:write@bad": null } }),
    "utf8",
  );
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 1, "the valid entry loads");
  assert.deepEqual([...r.valid.keys()], ["tool:write@good"]);
  assert.equal(r.dropped.length, 1, "the null entry is reported as dropped");
  assert.equal(r.dropped[0].verdict, "expired", "malformed entries are marked expired");
});

test("a non-object entry (string) drops without taking valid entries with it", async () => {
  const cwd = await temp();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    approvalsPath(cwd),
    JSON.stringify({ version: 1, approvals: { "tool:write@good": entryFor(cwd), "tool:write@bad": "not an object" } }),
    "utf8",
  );
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 1, "the valid entry loads");
  assert.deepEqual([...r.valid.keys()], ["tool:write@good"]);
});

test("revokeApproval prunes an unrelated stale entry while revoking its target", async () => {
  const cwd = await temp();
  const c = ceiling(["tool:read", "tool:write"]);
  // Create a valid entry
  await saveApproval(cwd, "tool:write@target", entryFor(cwd), c, NOW);
  // Manually inject a stale entry (foreign-cwd) that should be pruned
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const current = JSON.parse(await readFile(approvalsPath(cwd), "utf8"));
  current.approvals["tool:write@stale"] = entryFor("/elsewhere");
  await writeFile(approvalsPath(cwd), JSON.stringify(current), "utf8");
  // Revoke the target — should also prune the stale one
  await revokeApproval(cwd, "tool:write@target", c, NOW);
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: c });
  assert.equal(r.valid.size, 0, "target is removed");
  const parsed = JSON.parse(await readFile(approvalsPath(cwd), "utf8"));
  assert.deepEqual(Object.keys(parsed.approvals), [], "stale entry is pruned on revoke");
});

test("a wrong-version file grants nothing", async () => {
  const cwd = await temp();
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    approvalsPath(cwd),
    JSON.stringify({ version: 2, approvals: { "tool:write@x": entryFor(cwd) } }),
    "utf8",
  );
  const r = await loadApprovals({ cwd, now: NOW, ceilingOf: ceiling(["tool:read", "tool:write"]) });
  assert.equal(r.valid.size, 0, "wrong version grants nothing");
  assert.deepEqual(r.dropped, [], "entries from wrong-version files are not reported (they are silently ignored)");
});
