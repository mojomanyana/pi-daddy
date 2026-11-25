import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(new URL("../scripts/verify-public-notice.mjs", import.meta.url));

function verify(t: TestContext, emit: string, rejectMultiline = true) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-public-notice-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(
    join(cwd, "public-notice.cjs"),
    `const notice = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const message = notice?.message;
if (typeof message !== "string" || !message.length) process.exit(1);
${rejectMultiline ? "if (/[\\r\\n]/.test(message)) process.exit(1);" : ""}
${emit}\n`,
  );
  const result = spawnSync(process.execPath, [verifier], { cwd, encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return result;
}

for (const ending of ["\n", "\r\n"]) {
  test(`verifier accepts exact public output with ${JSON.stringify(ending)} line endings`, (t) => {
    const result = verify(t, `process.stdout.write(message + ${JSON.stringify(ending)});`);
    assert.equal(result.status, 0, result.stderr);
  });
}

test("verifier rejects the old fixed-output false positive", (t) => {
  const result = verify(t, 'console.log("Library opens at ten.");');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected the supplied message/);
});

test("verifier rejects an exporter that prints multiple lines", (t) => {
  const result = verify(t, "console.log(message);", false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LF in message must fail/);
});
