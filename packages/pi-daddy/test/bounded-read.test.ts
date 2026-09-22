import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBoundedFile } from "../src/kernel/bounded-read.ts";

/**
 * The guards on the two session-start reads, each forced by a test rather than by a reviewer.
 *
 * **Why this file exists.** Measured at `7096f78`: deleting the registry reader's deadline check outright
 * left all 876 tests passing. A bound nothing can fail is rule 7's decoration, and this one guards the
 * defect class (R-79) that hung session start indefinitely. The clock is injectable for exactly this
 * reason — a real deadline cannot be provoked in a unit test without a slow disk or a FIFO, and FIFOs are
 * not creatable in every environment this suite runs in.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pi-daddy-bounded-"));
}

test("the deadline refuses a read that outruns it — DELETE the now() > deadline branch and this fails", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "slow.json");
    writeFileSync(path, "{}");
    // First call sets the deadline, the next is already past it. No slow disk required.
    let calls = 0;
    const result = await readBoundedFile(path, {
      maxBytes: 1024,
      timeoutMs: 50,
      now: () => (calls++ === 0 ? 0 : 10_000),
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.why, "timed-out");
    assert.match(result.ok === false ? result.detail : "", /did not finish reading within 50ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file over the bound is refused before it is read — DELETE the size check and this fails", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "big.json");
    writeFileSync(path, "x".repeat(4096));
    const result = await readBoundedFile(path, { maxBytes: 1024, timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.why, "too-large");
    assert.equal(result.ok === false && result.why === "too-large" && result.size, 4096);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-regular file is refused rather than read — DELETE the isFile check and this fails", async () => {
  const dir = scratch();
  try {
    // A directory stands in for the FIFO the registry's comment block is about: both are what `isFile()`
    // exists to reject, and a directory can be created where `mkfifo` is unavailable. What this does NOT
    // establish is the FIFO case itself — that a blocking special file does not wedge the open. Only
    // `O_NONBLOCK` bounds that, and it is not measured here.
    const path = join(dir, "adirectory");
    mkdirSync(path);
    const result = await readBoundedFile(path, { maxBytes: 1024, timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.ok(
      result.ok === false && (result.why === "not-a-regular-file" || result.why === "unopenable"),
      `a directory must not be read as a file, got ${result.ok === false ? result.why : "ok"}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing file is a reason, not a throw", async () => {
  const result = await readBoundedFile(join(scratch(), "absent.json"), { maxBytes: 1024, timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.why, "unopenable");
});

test("an ordinary file reads back exactly, including across several chunks", async () => {
  const dir = scratch();
  try {
    const path = join(dir, "ok.json");
    const body = JSON.stringify({ version: 1, filler: "y".repeat(200_000) });
    writeFileSync(path, body);
    const result = await readBoundedFile(path, { maxBytes: 1 << 20, timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.text, body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
