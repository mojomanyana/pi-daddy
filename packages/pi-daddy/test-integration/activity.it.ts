/** Model-free real-Pi extension regression: session_start exposes default observation without a model call. */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { cleanupTempDirs, fixture, piAvailable, runCommand } from "./harness.ts";

after(cleanupTempDirs);
describe("real Pi activity extension", { skip: piAvailable() ? false : "pi is not on PATH" }, () => {
  test("a normal slash-command session visibly defaults observation on without a model call", async () => {
    const result = await runCommand({ cwd: await fixture(), command: "/grants", env: { PI_DADDY_HERDR: "0" } });
    assert.ok(result.notifies.some((value) => /activity: local observation on/i.test(value.message)));
  });
});
