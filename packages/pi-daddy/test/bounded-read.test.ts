import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
 * reason: a real deadline cannot be provoked in a unit test without a slow disk.
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

test("the deadline is checked BETWEEN chunks, not only before the first — HOIST it out of the loop and this fails", async () => {
  const dir = scratch();
  try {
    // Review caught the test above forcing only the branch's EXISTENCE. Hoisting the check out of the chunk
    // loop — evaluated once, before any read — left all 887 tests passing, and "between chunks" is the whole
    // point of the shape: R-79's hang, and the finding that an `AbortSignal` is never observed INSIDE a libuv
    // read, are both about a read that has already begun. A clock that advances per call, over a file that
    // needs several chunks, is what forces the position rather than the presence.
    const path = join(dir, "many-chunks.json");
    writeFileSync(path, "q".repeat(300_000));
    let calls = 0;
    // 0ms sets the deadline; the first in-loop check is still 30ms; by the third the 50ms bound is past. A
    // check made only before the loop would see 30 < 50, read the whole file and return ok.
    const result = await readBoundedFile(path, {
      maxBytes: 1 << 20,
      timeoutMs: 50,
      now: () => calls++ * 30,
    });
    assert.equal(result.ok, false, "a read that outruns the deadline mid-file must not succeed");
    assert.equal(result.ok === false && result.why, "timed-out");
    assert.ok(calls > 2, `the clock must be consulted once per chunk, saw ${calls} calls`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file whose size understates its content is refused, not silently truncated — DELETE the grew-while-reading branch and this fails", async () => {
  // The docstring advertises the size bound as "checked twice ... because a file can grow between the two",
  // and review measured only the first check forced: deleting the second left all 887 tests passing while it
  // turned an overrun into `{ok: true}` holding the first bytes. That is a silent truncation presented as a
  // successful read — for the registry it becomes a misleading "not valid JSON", and for a definition a
  // quietly corrupted ceiling.
  //
  // `/proc/self/maps` needs no race to provoke it: procfs reports size 0 from `fstat` and then yields real
  // content, so every read of it overruns any bound. If this ever runs where procfs is absent, the read
  // fails to open and the assertion below says so rather than passing vacuously.
  const result = await readBoundedFile("/proc/self/maps", { maxBytes: 64, timeoutMs: 2000 });
  assert.equal(result.ok, false, "content past the bound must never come back as a successful read");
  assert.equal(
    result.ok === false && result.why,
    "grew-while-reading",
    "a file that outgrows its stat size is the second half of the bound, not the first",
  );
});

test("a FIFO is refused rather than blocking session start — DROP O_NONBLOCK and this hangs", async () => {
  const dir = scratch();
  try {
    // The real R-79 case, which the first version of this suite could not run and said so. `mkfifo` IS
    // available here; the earlier attempt to measure it failed on an unrelated 40 MiB allocation and the
    // "not established" note drawn from that was wrong. Opening a FIFO with no writer blocks inside
    // `open(2)` before any read starts, so neither the deadline nor a signal can rescue it — only the
    // non-blocking open can, and this is what proves it does.
    const path = join(dir, "SKILL.md");
    execFileSync("mkfifo", [path]);
    const result = await Promise.race([
      readBoundedFile(path, { maxBytes: 1024, timeoutMs: 2000 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("readBoundedFile BLOCKED")), 5_000)),
    ]);
    assert.equal(result.ok, false);
    assert.ok(
      result.ok === false && (result.why === "not-a-regular-file" || result.why === "unreadable"),
      `a FIFO must be refused, got ${result.ok === false ? result.why : "ok"}`,
    );
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
