/** Useful command qualification, not determinism/source eligibility or cache publication. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import { checksumFixture, checksumRun, checksumInit } from "./cache-checksum-profile-fixture.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const quote = (s: string) => JSON.stringify(s);
before(async () => {
  if (enabled) await checksumInit();
});
const meaningful = `cd ${quote(repo)} && exec /usr/bin/sha256sum -c .principal/plans/cache-command-inputs.sha256`;

async function members() {
  const f = await checksumFixture();
  const bytes = await readFile(new URL("../src/kernel/cache-owner.ts", import.meta.url));
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(f.directory, "member.ts"), bytes);
  await writeFile(join(f.directory, "manifest"), `${digest}  member.ts\n`);
  return { f, bytes, digest, command: "exec /usr/bin/sha256sum -c manifest" };
}

test(
  "useful repository source/tool manifest through actual SDK matches native shell and observed execution",
  { skip: !enabled },
  async () => {
    const f = await checksumFixture();
    const native = await checksumRun(f, meaningful, false);
    const observed = await checksumRun(f, meaningful, true);
    assert.equal(native.ok, true, native.text);
    assert.equal(observed.ok, true, observed.text);
    assert.equal(observed.text, native.text);
    assert.equal(native.text.split("\n").filter(Boolean).length, 14);
    assert.ok(observed.trace.includes('execve("/usr/bin/sha256sum"'));
    assert.ok(observed.trace.includes("cache-command-inputs.sha256"));
    assert.ok(observed.trace.includes("cache-mount.it.ts"));
  },
);

test(
  "same useful manifest is an ordinary tool call in the bundled CLI, not a synthetic check tool",
  { skip: !enabled },
  async () => {
    const f = await checksumFixture();
    const result = await checksumRun(f, meaningful, true, true);
    assert.equal(result.ok, true, result.text);
    assert.equal(result.text.split("\n").filter(Boolean).length, 15); // Existing CLI fixture's literal prefix plus fourteen checks.
    assert.match(result.text, /^prefix\n/);
    assert.ok(result.trace.includes('execve("/usr/bin/sha256sum"'));
  },
);

test(
  "real source bytes change checker success; restoring bytes does not establish reusable state",
  { skip: !enabled },
  async () => {
    const { f, bytes, command } = await members();
    assert.equal((await checksumRun(f, command, true)).ok, true);
    await writeFile(join(f.directory, "member.ts"), Buffer.concat([bytes, Buffer.from("\nchanged\n")]));
    const changed = await checksumRun(f, command, true);
    assert.equal(changed.ok, false);
    assert.match(changed.text, /FAILED/);
    await writeFile(join(f.directory, "member.ts"), bytes);
    assert.equal((await checksumRun(f, command, true)).ok, true);
  },
);

test(
  "relative manifest members resolve from command cwd, not the manifest's directory",
  { skip: !enabled },
  async () => {
    const { f, command } = await members();
    await mkdir(join(f.directory, "sub"));
    await rename(join(f.directory, "manifest"), join(f.directory, "sub", "manifest"));
    assert.equal((await checksumRun(f, command.replace("manifest", "sub/manifest"), true)).ok, true);
    const missing = await checksumRun(f, "cd sub && exec /usr/bin/sha256sum -c manifest", true);
    assert.equal(missing.ok, false);
    assert.match(missing.text, /member.ts/);
    assert.ok(missing.trace.includes("ENOENT"));
  },
);

test(
  "symlink retargeting changes verification without changing the former inode's bytes",
  { skip: !enabled },
  async () => {
    const { f, bytes, command } = await members();
    await rename(join(f.directory, "member.ts"), join(f.directory, "original.ts"));
    await writeFile(join(f.directory, "other.ts"), "different source\n");
    await symlink("original.ts", join(f.directory, "member.ts"));
    assert.equal((await checksumRun(f, command, true)).ok, true);
    await symlink("other.ts", join(f.directory, "replacement"));
    await rename(join(f.directory, "replacement"), join(f.directory, "member.ts"));
    const replaced = await checksumRun(f, command, true);
    assert.equal(replaced.ok, false);
    assert.match(replaced.text, /FAILED/);
    assert.deepEqual(await readFile(join(f.directory, "original.ts")), bytes);
  },
);

test(
  "exit zero with malformed manifest records is not a complete declared dependency inventory",
  { skip: !enabled },
  async () => {
    const { f, command } = await members();
    await writeFile(
      join(f.directory, "manifest"),
      (await readFile(join(f.directory, "manifest"), "utf8")) + "not a checksum record\n",
    );
    const loose = await checksumRun(f, command, true);
    assert.equal(loose.ok, true, loose.text);
    assert.match(loose.text, /improperly formatted|malformed/);
    const strict = await checksumRun(f, command.replace(" -c ", " --strict -c "), true);
    assert.equal(strict.ok, false);
  },
);

test(
  "actual checksum success can include synthetic loader write effects outside manifest members",
  { skip: !enabled },
  async () => {
    const { f, command } = await members();
    const effect = join(f.directory, "loader-effect");
    const result = await checksumRun(
      f,
      `CHECKSUM_FIXTURE_EFFECT=${quote(effect)} LD_PRELOAD=${quote(f.preload)} ${command}`,
      true,
    );
    assert.equal(result.ok, true, result.text);
    assert.equal(await readFile(effect, "utf8"), "fixture constructor effect\n");
    assert.ok(
      result.trace
        .split("\n")
        .some((line) => line.startsWith("openat(") && line.includes(effect) && line.includes("O_WRONLY")),
    );
  },
);

test("creation of a previously missing member changes failed verification to success", { skip: !enabled }, async () => {
  const { f, bytes, command } = await members();
  await rename(join(f.directory, "member.ts"), join(f.directory, "saved.ts"));
  const absent = await checksumRun(f, command, true);
  assert.equal(absent.ok, false);
  assert.match(absent.text, /FAILED open or read|No such file/);
  await writeFile(join(f.directory, "member.ts"), bytes);
  assert.equal((await checksumRun(f, command, true)).ok, true);
});

test("a dash member consumes inherited stdin EOF rather than a named regular file", { skip: !enabled }, async () => {
  const f = await checksumFixture();
  const empty = createHash("sha256").digest("hex");
  await writeFile(join(f.directory, "manifest"), `${empty}  -\n`);
  const result = await checksumRun(f, "exec /usr/bin/sha256sum -c manifest", true);
  assert.equal(result.ok, true, result.text);
  assert.equal(result.text, "-: OK\n");
  assert.ok(result.trace.split("\n").some((line) => /^read\(0[<,]/.test(line) && / = 0$/.test(line)));
});

test(
  "loader inputs and negative runtime probes are visible on the checksum tracee, not inferred from member lists",
  { skip: !enabled },
  async () => {
    const { f, command } = await members();
    const result = await checksumRun(f, command, true);
    assert.equal(result.ok, true, result.text);
    assert.ok(result.trace.includes("ld.so.cache"));
    assert.ok(result.trace.includes("libc.so.6"));
    assert.ok(result.trace.includes("ENOENT"));
    // Save scoped observations; no absence-of-effects/completeness assertion.
    console.log(
      `CHECKSUM_RUNTIME_RECEIPT ${JSON.stringify(result.trace.split("\n").filter((line) => /^(?:openat|statx|newfstatat|access|readlink|getrandom|clock_gettime)\(/.test(line)))}`,
    );
  },
);
