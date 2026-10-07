/** Enduring qualification-fixture contracts: native fulfilled errors are not success,
 * raw status/timing survive, and parity projects only per-execution measurements/owned filenames.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { shellComparable, type ShellOutcome } from "../test-integration/cache-shell-harness.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
async function sdkOutcome(result: unknown, throws = false) {
  const cwd = await tempDir("shell-result-contract-"),
    sdk = join(cwd, "sdk.mjs");
  await writeFile(
    sdk,
    `export function createBashToolDefinition(){return {execute:async()=>{${throws ? `throw Error(${JSON.stringify(result)})` : `return ${JSON.stringify(result)}`}}};}`,
  );
  const reply = await promisify(execFile)(
    process.execPath,
    [
      new URL("../test-integration/cache-shell-sdk.mjs", import.meta.url).pathname,
      new URL(`file://${sdk}`).href,
      JSON.stringify({ args: { command: "synthetic-fixture-only" } }),
    ],
    { cwd, env: { PATH: process.env.PATH!, HOME: cwd } },
  );
  return JSON.parse(reply.stdout) as ShellOutcome;
}
test("fulfilled native error retains its entire result and produces a failed fixture outcome", async () => {
  const result = {
    content: [{ type: "text", text: "partial 日本語\nCommand exited with code 7" }],
    isError: true,
    structuredContent: { output: "partial 日本語\n", exit_code: 7, truncated: false, wall_time_seconds: 0.3 },
    details: { extra: "preserve" },
  };
  const actual = await sdkOutcome(result);
  assert.equal(actual.ok, false);
  assert.equal(actual.error, result.content[0].text);
  assert.deepEqual(actual.result, result);
});
test("successful returns and thrown failures remain distinct and retain diagnostics", async () => {
  for (const isError of [undefined, false]) {
    const result = { content: [{ type: "text", text: "success" }], ...(isError === undefined ? {} : { isError }) };
    const actual = await sdkOutcome(result);
    assert.equal(actual.ok, true);
    assert.equal(actual.error, undefined);
    assert.deepEqual(actual.result, result);
  }
  const failed = await sdkOutcome("native timeout: partial output", true);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "native timeout: partial output");
  assert.equal(failed.result, undefined);
});
test("malformed returned error flags are diagnosed rather than treated as success", async () => {
  for (const isError of ["true", 1, null]) {
    const actual = await sdkOutcome({ content: [{ text: "not a success" }], isError });
    assert.equal(actual.ok, false);
    assert.match(actual.error!, /isError must be boolean/);
  }
});
test("full-output fixture acquisition does not mutate raw result references or timings", async () => {
  const cwd = await tempDir("shell-result-output-"),
    path = join(cwd, "full-output");
  await writeFile(path, "complete 日本語 bytes");
  const result = {
    content: [{ type: "text", text: `tail\nFull output: ${path}` }],
    details: { fullOutputPath: path },
    structuredContent: {
      output: "tail",
      full_output_path: path,
      exit_code: 0,
      truncated: true,
      wall_time_seconds: 0.4,
    },
  };
  const actual = await sdkOutcome(result);
  assert.deepEqual(actual.result, result);
  assert.equal(Buffer.from(actual.fullOutput!, "base64").toString(), "complete 日本語 bytes");
  await assert.rejects(readFile(path), /ENOENT/);
});
const outcome = (seconds: unknown): ShellOutcome =>
  ({
    ok: true,
    updates: [],
    result: {
      content: [{ text: "same output" }],
      structuredContent: { output: "same output", exit_code: 0, truncated: false, wall_time_seconds: seconds },
    },
  }) as unknown as ShellOutcome;
test("parity validates differing per-execution times without erasing or mutating raw evidence", () => {
  const first = outcome(0.1),
    second = outcome(0.3),
    saved = structuredClone(second);
  Object.freeze(second.result!.structuredContent);
  assert.deepEqual(shellComparable(first), shellComparable(second));
  assert.deepEqual(second, saved);
});
test("invalid or missing timing and semantic output/status/truncation differences cannot pass parity", () => {
  for (const seconds of [-1, Infinity, NaN, "0.2", null, undefined])
    assert.throws(() => shellComparable(outcome(seconds)), /wall.time/i);
  const original = outcome(0.1);
  const missing = structuredClone(original);
  delete missing.result!.structuredContent!.wall_time_seconds;
  assert.notDeepEqual(shellComparable(missing), shellComparable(original));
  for (const [field, value] of [
    ["output", "changed"],
    ["exit_code", 7],
    ["truncated", true],
    ["unexpected", "new field"],
  ] as const) {
    const changed = structuredClone(original);
    changed.result!.structuredContent![field] = value;
    assert.notDeepEqual(shellComparable(changed), shellComparable(original));
  }
});
test("truncated returned errors compare owned filenames without altering raw diagnostics", () => {
  const build = (path: string): ShellOutcome => ({
    ok: false,
    updates: [],
    fullOutput: "Ynl0ZXM=",
    error: `Full output: ${path}\nCommand exited with code 7`,
    result: {
      isError: true,
      content: [{ text: `Full output: ${path}\nCommand exited with code 7` }],
      details: { fullOutputPath: path },
      structuredContent: {
        output: "bytes",
        truncated: true,
        full_output_path: path,
        exit_code: 7,
        wall_time_seconds: 0.1,
      },
    },
  });
  const first = build("/private/a"),
    second = build("/private/b"),
    saved = structuredClone(second);
  assert.deepEqual(shellComparable(first), shellComparable(second));
  assert.deepEqual(second, saved);
});
test("parity normalizes only the matched owned output filename and rejects conflicting references", () => {
  const build = (path: string): ShellOutcome => ({
    ok: true,
    updates: [],
    fullOutput: "Ynl0ZXM=",
    result: {
      content: [{ text: `Full output: ${path}` }],
      details: { fullOutputPath: path },
      structuredContent: {
        output: "bytes",
        truncated: true,
        full_output_path: path,
        exit_code: 0,
        wall_time_seconds: 0.1,
      },
    },
  });
  const first = build("/private/a"),
    second = build("/private/b"),
    saved = structuredClone(second);
  assert.deepEqual(shellComparable(first), shellComparable(second));
  assert.deepEqual(second, saved);
  second.result!.structuredContent!.full_output_path = "/private/wrong";
  assert.throws(() => shellComparable(second), /full.output.*reference/i);
});
