/**
 * The fixture directories clean themselves up, and stay that way.
 *
 * Every suite here made a `mkdtemp` directory per test and none removed it: one day's runs left **4,896**
 * under `/tmp`. `test/tmp.ts` fixes it; this file is what keeps it fixed.
 *
 * **The change that breaks these tests** (rule 7): a new suite calling `mkdtemp` directly instead of
 * `tempDir`, a suite forgetting its `after(cleanupTempDirs)`, or `cleanupTempDirs` ceasing to remove
 * anything. That is the whole regression surface, and all three of them fail here.
 *
 * The scan is the important half. A helper nobody is required to use decays back to the state it replaced
 * one suite at a time, which is how the count reached 4,896 in the first place.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupTempDirs, KEEP_ENV, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const packageRoot = join(import.meta.dirname, "..");

/** Where the helper itself lives — the one file allowed to call `mkdtemp`. */
const HELPER = "test/tmp.ts";

test("cleanupTempDirs removes every directory tempDir handed out", async () => {
  // The default-removal oracle owns only its fresh child fixtures, not this suite's retained evidence.
  const env = { ...process.env }; delete env[KEEP_ENV];
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict'; import { existsSync } from 'node:fs';
    import { tempDir, cleanupTempDirs } from ${JSON.stringify(new URL("./tmp.ts", import.meta.url).href)};
    const a=await tempDir('grants-hygiene-a-'), b=await tempDir('grants-hygiene-b-');
    assert.ok(existsSync(a)&&existsSync(b)); await cleanupTempDirs();
    assert.equal(existsSync(a),false); assert.equal(existsSync(b),false);
  `], { env, timeout: 5000 });
});

test(`${KEEP_ENV} keeps fixtures on disk for inspection`, async () => {
  // The property the old "left for inspection when a test fails" comment was protecting. It is worth
  // keeping, but as an opt-in rather than as the default that leaked thousands of directories.
  const prior = process.env[KEEP_ENV]; process.env[KEEP_ENV] = "1";
  const kept = await tempDir("grants-hygiene-kept-");
  try {
    await cleanupTempDirs();
    assert.ok(existsSync(kept), "an explicit keep must survive teardown");
  } finally {
    prior === undefined ? delete process.env[KEEP_ENV] : process.env[KEEP_ENV] = prior;
    if (!prior) await rm(kept, { recursive: true, force: true });
  }
});

test("no suite calls mkdtemp directly, and every suite that makes fixtures tears them down", async () => {
  const offenders: string[] = [];
  const untorn: string[] = [];

  for (const dir of ["test", "test-integration"]) {
    for (const name of await readdir(join(packageRoot, dir))) {
      if (!name.endsWith(".ts")) continue;
      const relative = `${dir}/${name}`;
      if (relative === HELPER) continue;
      const source = await readFile(join(packageRoot, relative), "utf8");

      if (/\bmkdtemp\s*\(/.test(source)) offenders.push(relative);
      // `harness.ts` hands `tempDir` to the suites rather than running tests itself, so it has no hook of
      // its own; the `.it.ts` files that import it are the ones that must register one.
      if (/\btempDir\s*\(/.test(source) && !/\bafter\(cleanupTempDirs\)/.test(source) && !name.endsWith("harness.ts")) {
        untorn.push(relative);
      }
    }
  }

  assert.deepEqual(offenders, [], `call tempDir() from ${HELPER} instead of mkdtemp: ${offenders.join(", ")}`);
  assert.deepEqual(untorn, [], `missing a top-level after(cleanupTempDirs): ${untorn.join(", ")}`);
});
