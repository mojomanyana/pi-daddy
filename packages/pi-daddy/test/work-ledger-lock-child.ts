// TEST ONLY. One Node child, no model/agent/authority loader. Faults affect only the supplied fresh
// fixture path (and, for cleanup-* only, its owned lock descriptor/sidecar), never product source.
// No historical cleanup or append rollback occurs here; replacement tokens are explicit fixture actors.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, resolve, sep } from "node:path";
import { createServer } from "node:net";

const [operation, fault, pathArg, protectionArg, eventText] = process.argv.slice(2);
const observing = fault === "observe-encoding";
// JSON escapes preserve the caller's UTF-16; sending a lone surrogate directly in argv loses it.
const path: string = observing ? JSON.parse(pathArg) : pathArg;
const protection: string = observing ? (JSON.parse(protectionArg) ?? "null") : protectionArg;
const root = process.env.P01_FIXTURE_ROOT;
if (!root || !path.startsWith(resolve(root) + sep) || resolve(path) !== path ||
    (protection !== "null" && (!protection.startsWith(resolve(root) + sep) || resolve(protection) !== protection))) {
  throw new Error("child requires exact fresh fixture paths");
}
let hit = false;
const mutations: { operation: string; path: string }[] = [];
function attempted(operation: string, value: unknown): void {
  const target = String(value);
  if (target !== root && !target.startsWith(resolve(root!) + sep)) throw new Error("mutation outside fresh fixture");
  mutations.push({ operation, path: target });
}
const cleanupFault = fault.startsWith("cleanup-");
const cleanupHas = (part: string) => fault.split("-").includes(part);
const cleanup = { closes: 0, reads: 0, removals: 0, token: "" };
let cleanupReady = false;
const lockPath = path + ".lock";
const bodySentinel = operation.endsWith("-undefined") ? undefined : Object.freeze({ fixture: "primary callback error" });
const originalReadFile = fs.readFile, originalRm = fs.rm;
if (cleanupFault) {
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === lockPath && cleanupReady) {
      cleanup.reads++;
      if (cleanupHas("read")) { hit = true; throw Object.assign(new Error("fixture lock read failure"), { code: "EACCES" }); }
    }
    return originalReadFile(...args);
  }) as typeof fs.readFile;
  fs.rm = async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]) === lockPath && cleanupReady) {
      cleanup.removals++;
      if (cleanupHas("unlink")) { hit = true; throw Object.assign(new Error("fixture lock unlink failure"), { code: "EACCES" }); }
    }
    return originalRm(...args);
  };
}
const observation = () => ({ ...(observing ? { observation: { path, protection, mutations } } : {}),
  ...(cleanupFault ? { cleanup } : {}) });
const injected = () => Object.assign(new Error("fixture filesystem failure"), { code: fault === "preflight" ? "EACCES" : "EIO" });
const originalOpen = fs.open, originalLstat = fs.lstat, originalRealpath = fs.realpath, originalStat = fs.stat, originalMkdir = fs.mkdir;
if (["preflight", "resolution"].includes(fault)) fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
  if (String(args[0]).startsWith(resolve(root) + sep) || String(args[0]) === resolve(root)) throw new Error("preflight attempted mkdir");
  return originalMkdir(...args);
}) as typeof fs.mkdir;
if (observing) {
  // Pass-through observation, not injected refusal: detect mkdir/open/write/unlink even when final
  // entries are absent after lock cleanup. Record before the syscall, including failed attempts.
  fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
    attempted("mkdir", args[0]); return originalMkdir(...args);
  }) as typeof fs.mkdir;
  const remove = fs.rm;
  fs.rm = async (...args: Parameters<typeof fs.rm>) => { attempted("rm", args[0]); return remove(...args); };
}
if (fault === "stat") fs.stat = (async (...args: Parameters<typeof fs.stat>) => {
  if (String(args[0]) === path) { hit = true; throw injected(); }
  return originalStat(...args);
}) as typeof fs.stat;
const timer = setTimeout(() => { process.stderr.write("fixture child deadline\n"); process.exit(124); }, 30_000);
if (fault === "preflight") fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
  if (String(args[0]) === path) { hit = true; throw injected(); }
  return originalLstat(...args);
}) as typeof fs.lstat;
if (fault === "resolution") fs.realpath = (async (...args: Parameters<typeof fs.realpath>) => {
  if (String(args[0]) === path) { hit = true; throw injected(); }
  return originalRealpath(...args);
}) as typeof fs.realpath;
fs.open = (async (...args: Parameters<typeof fs.open>) => {
  if (["preflight", "resolution"].includes(fault) && String(args[0]).startsWith(resolve(root) + sep)) throw new Error("preflight attempted open");
  if (String(args[0]) === path && fault === "gone") { hit = true; await fs.rename(path, path + ".gone"); }
  if (String(args[0]) === path && fault === "open") { hit = true; throw injected(); }
  const flags = args[1];
  if (observing && (typeof flags === "number"
    ? flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)
    : typeof flags === "string" && /[wa+]/.test(flags))) attempted("open", args[0]);
  const handle = await originalOpen(...args);
  if (observing) {
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {
      attempted("writeFile", args[0]); return write(...values);
    };
    return handle;
  }
  if (cleanupFault && String(args[0]) === lockPath && flags === "wx") {
    const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
    handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {
      await write(...values); cleanup.token = String(values[0]);
    };
    handle.close = async () => {
      cleanup.closes++; await close(); cleanupReady = true; // close the real descriptor; do not leak it in the test
      if (cleanupHas("replacement")) await fs.writeFile(lockPath, "replacement-owner\n");
      if (cleanupHas("close")) { hit = true; throw Object.assign(new Error("fixture lock close failure"), { code: "EIO" }); }
    };
    return handle;
  }
  if (String(args[0]) !== path) return handle;
  if (fault === "grow") { hit = true; await fs.appendFile(path, " ".repeat(16 * 1024 * 1024)); }
  if (fault === "swap") { hit = true; await fs.rename(path, path + ".displaced"); await fs.writeFile(path, "replacement"); }
  if (fault === "alias-after-open") { hit = true; await fs.link(path, protection); }
  if (fault === "alias-swap") { hit = true; await fs.rename(path, protection); await fs.writeFile(path, "replacement"); }
  const read = handle.read.bind(handle), write = handle.writeFile.bind(handle), stat = handle.stat.bind(handle), close = handle.close.bind(handle);
  if (fault === "close-on-corrupt") handle.close = async () => { await close(); hit = true; throw injected(); };
  handle.read = (async (...values: Parameters<typeof handle.read>) => {
    if (fault === "read") { hit = true; throw injected(); }
    return read(...values);
  }) as typeof handle.read;
  handle.stat = (async (...values: Parameters<typeof handle.stat>) => {
    const value = await stat(...values);
    if (fault === "descriptor") { hit = true; value.isFile = () => false; }
    return value;
  }) as typeof handle.stat;
  handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {
    if (fault === "pause") {
      hit = true;
      const released = new Promise<void>(resolve => process.once("message", message => {
        if (message !== "release") throw new Error("unexpected fixture command");
        resolve();
      }));
      process.send?.("paused"); await released;
    }
    if (fault === "partial") { hit = true; await write("{partial", "utf8"); throw injected(); }
    if (fault === "write") { hit = true; throw injected(); }
    return write(...values);
  };
  return handle;
}) as typeof fs.open;
syncBuiltinESMExports();
try {
  const api = await import("../src/work-ledger.ts");
  if (operation.startsWith("lock-")) {
    if (!cleanupFault) throw new Error("lock characterization requires scoped cleanup fixture");
    const { withFileLock } = await import("../src/file-lock.ts");
    const work = async () => { if (operation.includes("-body")) throw bodySentinel; return "body-result"; };
    const value = operation.startsWith("lock-default") ? await withFileLock(path, "fixture", work)
      : await withFileLock(path, "fixture", work, { staleRecovery: operation.startsWith("lock-disabled") ? "disabled" : "age" });
    process.stdout.write(JSON.stringify({ ok: true, hit, value, ...observation() }) + "\n");
  } else if (operation === "socket") {
    // Relative bind avoids the Unix sockaddr path-length limit; cwd is the exact owned fixture root.
    const server = createServer();
    const released = new Promise<void>(resolve => process.once("message", message => {
      if (message !== "release") throw new Error("unexpected fixture command"); resolve();
    }));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(basename(path), resolve); });
    process.send?.("paused"); await released;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    process.stdout.write(JSON.stringify({ ok: true, hit: true }) + "\n");
  } else if (operation === "inspect") {
    const inspection = await api.inspectWorkLedger({ version: 4, path });
    process.stdout.write(JSON.stringify({ ok: true, hit, inspection }) + "\n");
  } else {
    await api.appendWorkLedgerEvent({ path, grantLedgerPath: protection === "null" ? null : protection }, JSON.parse(eventText));
    process.stdout.write(JSON.stringify({ ok: true, hit, ...observation() }) + "\n");
  }
} catch (error) {
  if (operation.startsWith("lock-") && error === bodySentinel) {
    process.stdout.write(JSON.stringify({ ok: false, hit, bodySentinel: true, ...observation() }) + "\n");
  } else {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    process.stdout.write(JSON.stringify({ ok: false, hit, name: error.name, code: error.code, ...observation() }) + "\n");
  }
} finally {
  clearTimeout(timer);
  process.disconnect?.();
}
