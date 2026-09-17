import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { uniqueAgentName } from "../src/herdr-name.ts";

const run = promisify(execFile);
const moduleUrl = new URL("../src/herdr-name.ts", import.meta.url).href;

test("parallel parents using the same definition and child ID have distinct names", async () => {
  const script = "import { uniqueAgentName } from " + JSON.stringify(moduleUrl)
    + "; console.log(JSON.stringify(Array.from({length: 12}, () => uniqueAgentName('review-d0.1'))));";
  const replies = await Promise.all(Array.from({ length: 8 }, () =>
    run(process.execPath, ["--input-type=module", "-e", script])));
  const names = replies.flatMap(reply => JSON.parse(reply.stdout) as string[]);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^review-d0-1-[a-f0-9]{20}$/);
});

test("fresh module instances do not reuse names after reload", async () => {
  const modules = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    import(moduleUrl + "?reload=" + index)));
  const names = modules.map(module => module.uniqueAgentName("review-d0.1") as string);
  assert.equal(new Set(names).size, names.length);
});

test("long and non-Latin bases preserve the full execution suffix and Herdr grammar", () => {
  for (const base of ["x".repeat(100), "日本語", "", "9leading", "Review.d0.1"]) {
    const name = uniqueAgentName(base);
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
    assert.match(name, /-[a-f0-9]{20}$/);
  }
});
