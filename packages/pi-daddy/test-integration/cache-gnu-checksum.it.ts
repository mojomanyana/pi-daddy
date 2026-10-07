/** Existing GNU utility candidate; finite receipts do not certify source freshness or cache eligibility. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checksumFixture, checksumInit, checksumRun } from "./cache-checksum-profile-fixture.ts";
import { parseChecksumMembers } from "../src/kernel/cache-checksum-members.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
const checker = "/usr/bin/gnusha256sum";
const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
before(async () => {
  if (enabled) await checksumInit();
});

test(
  "explicit GNU utility checks real fourteen-object manifest through SDK and CLI without replacing uutils",
  { skip: !enabled },
  async () => {
    const f = await checksumFixture();
    const declared = parseChecksumMembers(await readFile(join(repo, ".principal/plans/cache-command-inputs.sha256")), {
      maxBytes: 1024 * 1024,
      maxMembers: 4096,
    });
    assert.equal(declared.kind, "members");
    if (declared.kind === "members") assert.equal(declared.members.length, 14);
    const command = `cd ${JSON.stringify(repo)} && LC_ALL=C exec ${checker} --strict -c .principal/plans/cache-command-inputs.sha256`;
    const native = await checksumRun(f, command, false, false, checker);
    const observed = await checksumRun(f, command, true, false, checker);
    const cli = await checksumRun(f, command, true, true, checker);
    assert.equal(native.ok, true, native.text);
    assert.equal(observed.ok, true, observed.text);
    assert.equal(cli.ok, true, cli.text);
    assert.equal(observed.text, native.text);
    assert.equal(cli.text, `prefix\n${native.text}`);
    assert.equal(native.text.split("\n").filter(Boolean).length, 14);
    assert.match(observed.trace, /execve\("\/usr\/bin\/gnusha256sum"/);
    assert.doesNotMatch(observed.trace, /execve\("\/usr\/bin\/sha256sum"/);
    assert.match(observed.trace, /libcrypto\.so\.3/);
    // Checked source contents themselves mention proc paths: inspect pathname operations, not arbitrary read buffers.
    const pathnameOperations = observed.trace
      .split("\n")
      .filter((line) =>
        /^(?:open|openat|openat2|access|faccessat|faccessat2|newfstatat|readlink|readlinkat|statx)\(/.test(line),
      )
      .join("\n");
    assert.doesNotMatch(pathnameOperations, /libselinux|\/proc\/(?:mounts|filesystems|self\/maps)/);
    console.log(
      `GNU_CHECKSUM_RUNTIME_RECEIPT ${JSON.stringify(
        observed.trace
          .split("\n")
          .filter((line) =>
            /^(?:open|openat|openat2|access|faccessat|faccessat2|statx|newfstatat|readlink|getrandom|clock_gettime)\(/.test(
              line,
            ),
          ),
      )}`,
    );
  },
);

test(
  "GNU strict check reruns on changed, absent and restored source; no cache or eligibility inferred",
  { skip: !enabled },
  async () => {
    const f = await checksumFixture();
    const bytes = await readFile(new URL("../src/kernel/cache-owner.ts", import.meta.url));
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(f.directory, "source.ts"), bytes);
    await writeFile(join(f.directory, "manifest"), `${digest}  source.ts\n`);
    const command = `LC_ALL=C exec ${checker} --strict -c manifest`;
    assert.equal((await checksumRun(f, command, true, false, checker)).ok, true);
    await writeFile(join(f.directory, "source.ts"), Buffer.concat([bytes, Buffer.from("\nmodified\n")]));
    const changed = await checksumRun(f, command, true, false, checker);
    assert.equal(changed.ok, false);
    assert.match(changed.text, /FAILED/);
    await writeFile(join(f.directory, "source.ts"), bytes);
    assert.equal((await checksumRun(f, command, true, false, checker)).ok, true);
    await writeFile(join(f.directory, "manifest"), `${digest}  absent.ts\n`);
    const absent = await checksumRun(f, command, true, false, checker);
    assert.equal(absent.ok, false);
    assert.match(absent.trace, /absent\.ts.*ENOENT/);
    await writeFile(join(f.directory, "manifest"), `${digest}  source.ts\nmalformed\n`);
    assert.equal(
      parseChecksumMembers(await readFile(join(f.directory, "manifest")), { maxBytes: 1024, maxMembers: 2 }).kind,
      "bypass",
    );
    const malformed = await checksumRun(f, command, true, false, checker);
    assert.equal(malformed.ok, false);
    assert.match(malformed.text, /improperly formatted/);
  },
);
