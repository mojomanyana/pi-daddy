/** Execute the unmodified SDK's real native Bash definition; only synthetic fixture environment is inherited. */
import { readFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { shellReturnedOutcome } from "./cache-shell-result.ts";
const sdk = await import(process.argv[2]);
const spec = JSON.parse(process.argv[3]);
const updates = [];
const controller = new AbortController();
const timer = spec.abortMs ? setTimeout(() => controller.abort(), spec.abortMs) : undefined;
const cwd = process.cwd();
const ctx = { cwd: spec.contextCwd || cwd, thinkingLevel: "medium", model: { provider: "fixture", id: "local" },
  sessionManager: { getSessionId: () => "fixture-session", getSessionFile: () => `${cwd}/fixture-session` } };
const nativeOptions = {
  shellPath: spec.shell,
  commandPrefix: spec.prefix,
  exposeSessionEnvironment: true,
  ...(spec.hook ? { spawnHook: context => ({ command: `printf 'hook\\n'; ${context.command}`,
    cwd: spec.hookCwd || context.cwd, env: { ...context.env, IT_HOOK: "hook value",
      ...(spec.bridgeStringHook ? {} : { IT_ABSENT: undefined }) } }) } : {}),
};
let bridge, images;
const nativeCalls = [];
let closes = 0, nativeCompleted = false, shutdownJoinedNativeResult, shutdownObserver;
const nativeExports = spec.shutdownAtOperations ? {
  ...sdk,
  createBashToolDefinition: (...args) => {
    const native = sdk.createBashToolDefinition(...args);
    return { ...native, execute: async (...args) => {
      const result = await native.execute(...args);
      nativeCompleted = true;
      return result;
    } };
  },
  createLocalBashOperations: (...args) => {
    const operations = sdk.createLocalBashOperations(...args);
    return { ...operations, exec: async (...args) => {
      const result = await operations.exec(...args);
      shutdownObserver = bridge.shutdown().then(() => { shutdownJoinedNativeResult = nativeCompleted; });
      void shutdownObserver.catch(() => {}); // Owned and rethrown by finally, not discarded.
      return result;
    } };
  },
} : sdk;
if (spec.bridgeTemplate) {
  const { CacheNativeBashFactory } = await import("../extensions/cache-native-bash.ts");
  const { CacheNativeImages } = await import("../src/executors/cache-native-images.ts");
  const image = await readFile(spec.bridgeTemplate);
  images = new CacheNativeImages({ directory: spec.imageDirectory, image, sha256: createHash("sha256").update(image).digest("hex"),
    socket: join(cwd, "unavailable-socket"), admissionMs: 100, maxLeases: 2, maxImageBytes: image.length,
    maxStorageBytes: 2 * (image.length + 8192) });
  bridge = new CacheNativeBashFactory({ cwd, options: nativeOptions, maxCalls: 2, native: nativeExports,
    authorize: () => true,
    allocate: async (invocation, context) => {
      const lease = await images.allocate(invocation.shell, context.signal);
      if (!lease) return undefined;
      nativeCalls.push({ invocation, toolCallId: context.toolCallId, shellPath: lease.shellPath });
      return { shellPath: lease.shellPath, close: async () => { await lease.close(); closes++; } };
    },
  });
}
const definition = bridge?.definition ?? sdk.createBashToolDefinition(cwd, nativeOptions);
let outcome;
try {
  if (spec.parallelCalls) {
    const batch = await Promise.all(spec.parallelCalls.map((args, index) => definition.execute(`call-${index}`, args, controller.signal, undefined, ctx)));
    outcome = { batch };
  } else {
  const result = await definition.execute("fixture-call", spec.args, controller.signal,
    update => updates.push(update.content.map(item => item.text || "").join("")), ctx);
  let fullOutput;
  const path = result.details?.fullOutputPath;
  if (path) {
    fullOutput = (await readFile(path)).toString("base64");
    await unlink(path);
  }
  outcome = shellReturnedOutcome(result, updates, fullOutput);
  }
} catch (error) {
  outcome = { ok: false, error: error.message, updates };
} finally {
  clearTimeout(timer);
  const settled = await Promise.allSettled([bridge?.shutdown(), images?.close(), shutdownObserver]);
  const errors = settled.flatMap(row => row.status === "rejected" ? [row.reason] : []);
  if (errors.length) throw new AggregateError(errors, "native fixture cleanup unresolved; retain");
}
if (bridge) outcome.nativeFactory = { calls: nativeCalls, closes, shutdownJoinedNativeResult, images: images.stats(), ...bridge.stats() };
console.log(JSON.stringify(outcome));
