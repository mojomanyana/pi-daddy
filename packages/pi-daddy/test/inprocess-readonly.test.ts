/** Unit tests for Tier-1 fast in-process read-only subagent runner. */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { resolveTierModel, runInProcessReadOnly } from "../src/executors/inprocess-readonly.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("resolveTierModel routes review/architect to STRONG and investigate to FAST when configured", () => {
  const registry = {
    find: (provider: string, id: string) => ({ provider, id }),
  };
  const fallback = { provider: "google", id: "gemini-3.8-flash" };
  const env = {
    PI_ECO_MODEL_STRONG: "fireworks/qwen3.8-max",
    PI_ECO_MODEL_FAST: "fireworks/glm-5.3-flash",
  };
  assert.equal(resolveTierModel(registry, "review", fallback, undefined, env).label, "fireworks/qwen3.8-max");
  assert.equal(resolveTierModel(registry, "architect", fallback, undefined, env).label, "fireworks/qwen3.8-max");
  assert.equal(resolveTierModel(registry, "investigate", fallback, undefined, env).label, "fireworks/glm-5.3-flash");
  assert.equal(resolveTierModel(registry, "review", fallback, undefined, {}).label, "google/gemini-3.8-flash");
});

test("runInProcessReadOnly reads bounded workspace files, blocks traversal/binaries, and streams result", async () => {
  const cwd = await tempDir("inproc-ro-");
  await writeFile(join(cwd, "app.mjs"), "export const x = 42;\n");
  await writeFile(join(cwd, "bin.dat"), Buffer.from([0, 1, 2, 0, 3]));
  let capturedPrompt = "";
  const res = await runInProcessReadOnly({
    role: "review",
    question: "Check app.mjs",
    cwd,
    files: ["app.mjs", "bin.dat", "../outside.txt"],
    defaultModel: { provider: "google", id: "gemini-3.8-flash" },
    registry: {
      streamSimple: (_model, context) => {
        capturedPrompt = context.messages[0].content[0].text;
        return {
          result: async () => ({ content: [{ type: "text", text: "VERDICT: PASS" }] }),
        };
      },
    },
  });

  assert.equal(res.text, "VERDICT: PASS");
  assert.deepEqual(res.filesRead, ["app.mjs"]);
  assert.equal(res.skippedFiles.length, 2);
  assert.match(capturedPrompt, /export const x = 42;/);
});
