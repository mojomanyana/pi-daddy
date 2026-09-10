import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, symlink } from "node:fs/promises";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);

test("native cancellation keeps its assertion and supplies bounded original-result diagnostics", async () => {
  const source = await readFile(new URL("./effect-profile.test.ts", import.meta.url), "utf8");
  assert.match(source, /assert\.equal\(result\.aborted, true, nativeResultDiagnostic\(result\)\)/);
  assert.match(source, /maxOutputBytes: NATIVE_DIAGNOSTIC_TEXT_BYTES/);
  assert.match(source, /assert\.ok\(owned\.size >= 2/);
});
test("workflow adds read-only namespace diagnostics after private staging and before unchanged unit tests", async () => {
  const source = await readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(source, /- name: namespace prerequisite diagnostics\n        timeout-minutes: 1\n        working-directory: packages\/pi-daddy\n        run: node scripts\/namespace-diagnostics\.ts/);
  assert.ok(source.indexOf("run: node scripts/private-runtime.ts") < source.indexOf("run: node scripts/namespace-diagnostics.ts"));
  assert.ok(source.indexOf("run: node scripts/namespace-diagnostics.ts") < source.indexOf("- name: unit tests"));
});
test("original failed fixture exposes code and native text without converting failure to success", async () => {
  const { nativeResultDiagnostic } = await import("./native-result-diagnostic.ts");
  const result = Object.freeze({ code: 1, signal: null, text: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n", aborted: false, timedOut: false, truncated: false });
  assert.throws(() => assert.equal(result.aborted, true, nativeResultDiagnostic(result)), (error: any) => {
    assert.match(error.message, /RTM_NEWADDR/); assert.match(error.message, /"code":1/); assert.equal(error.actual, false); assert.equal(error.expected, true); return true;
  });
  const success = Object.freeze({ ...result, code: null, signal: "SIGTERM" as const, text: "ready\n", aborted: true });
  assert.doesNotThrow(() => assert.equal(success.aborted, true, nativeResultDiagnostic(success)));
  assert.equal(result.aborted, false); assert.equal(success.aborted, true);
});
test("native diagnostic whitelists result fields and bounds hostile-length fixture output", async () => {
  const { nativeResultDiagnostic } = await import("./native-result-diagnostic.ts");
  const text = "🦊\u0000".repeat(10000), message = nativeResultDiagnostic({ code: 1, text, spawnError: "x".repeat(10000), aborted: false, timedOut: false, truncated: false, secret: "DO_NOT_LOG" } as any);
  const parsed = JSON.parse(message); assert.ok(Buffer.byteLength(parsed.text) <= 4096); assert.ok(Buffer.byteLength(parsed.spawnError) <= 256); assert.equal(parsed.diagnosticTextTruncated, true); assert.equal(parsed.diagnosticSpawnErrorTruncated, true); assert.ok(Buffer.byteLength(message) < 27000); assert.ok(!message.includes("DO_NOT_LOG"));
});
test("inert metadata fixtures expose only fixed public fields and never infer a setup cause", async () => {
  const { inspectNamespaceDiagnostics } = await import("../scripts/namespace-diagnostics.ts");
  const reads: string[] = []; let versions = 0;
  const result = await inspectNamespaceDiagnostics({ kernel: () => "6.8.0-fixture", binary: async () => ({ bytes: 72, sha256: "a".repeat(64), mode: "755" }), version: async () => { versions++; return "bubblewrap 0.9.0\n"; }, read: async (path: string) => {
    reads.push(path); if (path === "/proc/self/status") return "Name:\tPRIVATE_MARKER\nCapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapInh:\t0000000000000000\nCapBnd:\t000001ffffffffff\nCapAmb:\t0000000000000000\nNoNewPrivs:\t0\nSeccomp:\t2\nSeccomp_filters:\t1\n";
    if (path.endsWith("/enabled")) return "Y\n"; if (path.endsWith("/lsm")) return "capability,apparmor\n"; if (path.endsWith("/current")) return "unconfined\n"; return "1\n";
  }});
  assert.equal(result.qualification, "not-assessed"); assert.equal(result.cause, "unknown"); assert.equal(result.processSecurity.CapEff.value, "0000000000000000"); assert.equal(result.bwrap.version.value, "bubblewrap 0.9.0"); assert.equal(versions, 1); assert.ok(!JSON.stringify(result).includes("PRIVATE_MARKER")); assert.ok(!reads.some(p => /environ|cmdline|auth|session/.test(p))); assert.equal(new Set(reads).size, reads.length);
});
test("missing, denied, malformed and duplicate metadata is unavailable without dumping errors", async () => {
  const { inspectNamespaceDiagnostics } = await import("../scripts/namespace-diagnostics.ts");
  let versionCalls = 0;
  const r = await inspectNamespaceDiagnostics({ kernel: () => "bad\nPRIVATE_MARKER", binary: async () => { throw Object.assign(Error("PRIVATE_MARKER"), { code: "ENOENT" }); }, version: async () => { versionCalls++; return "bad"; }, read: async (path: string) => { if (path === "/proc/self/status") return "CapEff:\t0000\nCapEff:\tffff\nSeccomp:\t99\n"; throw Object.assign(Error("PRIVATE_MARKER"), { code: "EACCES" }); } });
  assert.equal(versionCalls, 0); assert.equal(r.bwrap.file.state, "unavailable"); assert.equal(r.processSecurity.CapEff.state, "unavailable"); assert.equal(r.processSecurity.Seccomp.state, "unavailable"); assert.equal(r.processSecurity.CapPrm.state, "unavailable"); assert.ok(!JSON.stringify(r).includes("PRIVATE_MARKER")); assert.equal(r.cause, "unknown");
});
test("unexpected version output and unsafe binary metadata never become version success", async () => {
  const { inspectNamespaceDiagnostics } = await import("../scripts/namespace-diagnostics.ts");
  let calls = 0; const io = { kernel: () => "6.8.0", read: async () => "", binary: async () => ({ bytes: 72, sha256: "a".repeat(64), mode: "755" }), version: async () => { calls++; return "PRIVATE_MARKER\n"; } };
  assert.equal((await inspectNamespaceDiagnostics(io)).bwrap.version.state, "unavailable"); assert.equal(calls, 1);
  for (const mode of ["777", "4755", "2755"]) { const r = await inspectNamespaceDiagnostics({ ...io, binary: async () => ({ bytes: 72, sha256: "a".repeat(64), mode }) }); assert.equal(calls, 1); assert.equal(r.bwrap.version.state, "unavailable"); assert.ok(!JSON.stringify(r).includes("PRIVATE_MARKER")); }
  assert.equal((await inspectNamespaceDiagnostics({ ...io, version: async () => " ".repeat(1024) + "bubblewrap 0.9.0" })).bwrap.version.state, "unavailable");
  const timeout = (await inspectNamespaceDiagnostics({ ...io, version: async () => { throw Object.assign(Error("PRIVATE_MARKER"), { code: "ETIMEDOUT" }); } })).bwrap.version;
  assert.equal(timeout.state, "unavailable"); if (timeout.state === "unavailable") assert.equal(timeout.reason, "ETIMEDOUT");
});
test("owned diagnostic file reads are byte bounded, nofollow, and hash actual bytes", async () => {
  const { readDiagnosticFile } = await import("../scripts/namespace-diagnostics.ts");
  const root = await tempDir("namespace-diagnostic-"), file = join(root, "input"), link = join(root, "link"); await writeFile(file, "abcd");
  const r = await readDiagnosticFile(file, 4, true); assert.equal(r.sha256, createHash("sha256").update("abcd").digest("hex")); assert.equal(r.bytes, 4); assert.equal(r.text, undefined);
  assert.equal((await readDiagnosticFile(file, 4)).text, "abcd"); await assert.rejects(readDiagnosticFile(file, 3), /READ_LIMIT/); await symlink(file, link); await assert.rejects(readDiagnosticFile(link, 4)); await assert.rejects(readDiagnosticFile(root, 4), /NOT_REGULAR/);
});
test("descriptor read limits, changed binary and close failures remain unavailable/error despite complete bytes", async () => {
  const { readDiagnosticFile } = await import("../scripts/namespace-diagnostics.ts");
  const root = await tempDir("namespace-descriptor-"), file = join(root, "input"); await writeFile(file, "abcd"); const original = promises.open;
  try { for (const mode of ["read-limit", "changed", "close", "primary-close"] as const) {
    promises.open = (async (...args: Parameters<typeof promises.open>) => { const fd = await original(...args); if (String(args[0]) !== file) return fd;
      const stat = fd.stat.bind(fd), close = fd.close.bind(fd); let calls = 0;
      fd.stat = (async () => { const s = await stat(); calls++; if (mode === "read-limit" || mode === "changed" && calls > 1) Object.defineProperty(s, "size", { value: 0 }); return s; }) as typeof fd.stat;
      fd.close = async () => { await close(); if (mode === "close" || mode === "primary-close") throw Object.assign(Error("close fixture"), { code: "CLOSE_FIXTURE" }); }; return fd;
    }) as typeof promises.open; syncBuiltinESMExports();
    await assert.rejects(readDiagnosticFile(file, mode === "read-limit" || mode === "primary-close" ? 3 : 4, mode === "changed"), mode === "close" ? /close fixture/ : mode === "changed" ? /BINARY_CHANGED/ : /READ_LIMIT/);
  } } finally { promises.open = original; syncBuiltinESMExports(); }
});
test("diagnostic executable invocation is only bounded version lookup with empty environment, never a namespace", async () => {
  const source = await readFile(new URL("../scripts/namespace-diagnostics.ts", import.meta.url), "utf8");
  assert.equal((source.match(/promisify\(execFile\)/g) ?? []).length, 1); assert.match(source, /promisify\(execFile\)\(BWRAP, \["--version"\]/); assert.match(source, /cwd: "\/", env: \{\}, timeout: DIAGNOSTIC_LIMITS.versionTimeoutMs/); assert.match(source, /maxBuffer: DIAGNOSTIC_LIMITS.versionBytes, killSignal: "SIGKILL"/);
  assert.doesNotMatch(source, /--unshare|--cap-add|sudo|sysctl -w|process\.env|\/environ|\/cmdline/);
});
