/** Real stock Pi1.x factory through private CS1 shellPath leases. No coordinator/grant issuer qualification. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir, cleanupTempDirs } from "../test/tmp.ts";
import { shellExec, shellSdkRun, shellComparable, type ShellOutcome } from "./cache-shell-harness.ts";
after(cleanupTempDirs);
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
let directory: string, template: string, sdk: string, imageDirectory: string;
before(async () => {
  if (!enabled) return;
  directory = await tempDir("cache-native-factory");
  imageDirectory = await tempDir("cache-native-storage");
  template = join(directory, "template");
  await shellExec("cc", [
    "-static",
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(new URL("../src/executors/native/cache-shell.c", import.meta.url)),
    "-o",
    template,
  ]);
  const cli = await realpath((await shellExec("which", ["pi"])).stdout.trim());
  sdk = pathToFileURL(join(dirname(cli), "index.js")).href;
});
interface NativeOutcome extends ShellOutcome {
  batch?: Array<{ content: Array<{ text: string }> }>;
  nativeFactory: {
    calls: Array<{
      toolCallId: string;
      shellPath: string;
      invocation: { command: string; cwd: string; timeoutMs: number; env: Record<string, string> };
    }>;
    closes: number;
    owned: number;
    faulted: boolean;
    shutdownJoinedNativeResult?: boolean;
    images: { owned: number; reservedBytes: number; rootOwned: boolean; faulted: boolean };
  };
}
function comparable(result: ShellOutcome) {
  // Private fixture capture is not part of Pi's native tool result or command output.
  const { nativeFactory: _capture, ...native } = result as NativeOutcome;
  return shellComparable(native);
}
async function run(args: { command: string; timeout?: number }, options: Record<string, unknown> = {}) {
  return (await shellSdkRun({ directory, sdk }, "/bin/bash", args, {
    bridgeTemplate: template,
    imageDirectory,
    ...options,
  })) as NativeOutcome;
}
test(
  "stock native factory captures effective prefix/hook/context/environment before per-call shellPath",
  { skip: !enabled },
  async () => {
    const cwd = await tempDir("cache-native-context"),
      hookCwd = await tempDir("cache-native-hook");
    const args = { command: "printf 'body 日本語\\n'; exit 7", timeout: 3 };
    const options = { prefix: "printf 'prefix\\n'", hook: true, bridgeStringHook: true, contextCwd: cwd, hookCwd };
    const ordinary = await shellSdkRun({ directory, sdk }, "/bin/bash", args, options);
    const leased = await run(args, options);
    assert.deepEqual(comparable(leased), comparable(ordinary));
    assert.equal(leased.ok, false);
    assert.equal(leased.nativeFactory.calls.length, 1);
    const call = leased.nativeFactory.calls[0];
    assert.equal(call.toolCallId, "fixture-call");
    assert.equal(call.invocation.command, "printf 'hook\\n'; printf 'prefix\\n'\nprintf 'body 日本語\\n'; exit 7");
    assert.equal(call.invocation.cwd, hookCwd);
    assert.equal(call.invocation.timeoutMs, 3000);
    assert.equal(call.invocation.env.PI_SESSION_ID, "fixture-session");
    assert.equal(call.invocation.env.IT_HOOK, "hook value");
    assert.equal(leased.nativeFactory.closes, 1);
    assert.equal(leased.nativeFactory.owned, 0);
    assert.equal(leased.nativeFactory.faulted, false);
    assert.deepEqual(leased.nativeFactory.images, { owned: 0, reservedBytes: 0, rootOwned: false, faulted: false });
  },
);
test(
  "simultaneous native calls retain independent tool ids/options and private shell images",
  { skip: !enabled },
  async () => {
    const parallelCalls = [
      { command: "sleep .03; printf 'same\\n'", timeout: 1 },
      { command: "sleep .03; printf 'same\\n'", timeout: 2 },
    ];
    const result = await run(parallelCalls[0], { parallelCalls });
    assert.deepEqual(
      result.batch!.map((r) => r.content[0].text),
      ["same\n", "same\n"],
    );
    assert.deepEqual(result.nativeFactory.calls.map((r) => [r.toolCallId, r.invocation.timeoutMs]).sort(), [
      ["call-0", 1000],
      ["call-1", 2000],
    ]);
    assert.equal(new Set(result.nativeFactory.calls.map((r) => r.shellPath)).size, 2);
    assert.equal(result.nativeFactory.closes, 2);
    assert.equal(result.nativeFactory.owned, 0);
  },
);
for (const mode of ["timeout", "abort"])
  test(
    `stock native factory preserves ${mode} through a private frontend and retires lease`,
    { skip: !enabled },
    async () => {
      const args = { command: "printf 'started\\n'; sleep 1", timeout: mode === "timeout" ? 0.2 : 3 };
      const options = mode === "abort" ? { abortMs: 200 } : {};
      const ordinary = await shellSdkRun({ directory, sdk }, "/bin/bash", args, options),
        leased = await run(args, options);
      assert.deepEqual(comparable(leased), comparable(ordinary));
      assert.equal(leased.nativeFactory.calls.length, 1);
      assert.equal(leased.nativeFactory.closes, 1);
      assert.equal(leased.nativeFactory.owned, 0);
      assert.equal(leased.ok, false);
    },
  );
test(
  "shutdown at real stock operations completion joins truncated native accumulator finalization",
  { skip: !enabled },
  async () => {
    const source = "process.stdout.write('x'.repeat(256*1024))";
    const args = { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`, timeout: 3 };
    const ordinary = await shellSdkRun({ directory, sdk }, "/bin/bash", args);
    const leased = await run(args, { shutdownAtOperations: true });
    assert.deepEqual(comparable(leased), comparable(ordinary));
    assert.equal(
      leased.nativeFactory.shutdownJoinedNativeResult,
      true,
      "shutdown must not finish before the actual native accumulator closes and reads its full output",
    );
    assert.equal(Buffer.from(leased.fullOutput!, "base64").length, 256 * 1024);
    assert.equal(leased.nativeFactory.owned, 0);
  },
);
test(
  "no timeout and unsupported undefined env retain original native behavior without a lease",
  { skip: !enabled },
  async () => {
    for (const [args, options] of [
      [{ command: "printf 'body\\n'" }, {}],
      [{ command: "printf 'body\\n'", timeout: 3 }, { hook: true }],
    ] as const) {
      const ordinary = await shellSdkRun({ directory, sdk }, "/bin/bash", args, options),
        leased = await run(args, options);
      assert.deepEqual(comparable(leased), comparable(ordinary));
      assert.equal(leased.nativeFactory.calls.length, 0);
      assert.equal(leased.nativeFactory.closes, 0);
      assert.equal(leased.nativeFactory.owned, 0);
    }
  },
);
