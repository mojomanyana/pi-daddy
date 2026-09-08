import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { release } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const BWRAP = "/usr/bin/bwrap";
export const DIAGNOSTIC_LIMITS = Object.freeze({ fileBytes: 8192, binaryBytes: 256 * 1024 * 1024, versionBytes: 1024, versionTimeoutMs: 2000 });
interface Binary { bytes: number; sha256: string; mode: string }
interface FileObservation extends Binary { text?: string }
interface DiagnosticIO {
  kernel(): string;
  read(path: string): Promise<string>;
  binary(): Promise<Binary>;
  version(): Promise<string>;
}
type Observation<T> = { state: "observed"; value: T } | { state: "unavailable"; reason: string; value?: never };
const unavailable = (reason: string): Observation<never> => ({ state: "unavailable", reason });
const observed = <T>(value: T): Observation<T> => ({ state: "observed", value });
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "READ_OR_COMMAND_FAILED";
}
function refusal(code: string): never { throw Object.assign(new Error(code), { code }); }
/** Byte-bounded, regular-file-only reads. Fixed production callers; exported for inert owned fixtures. */
export async function readDiagnosticFile(path: string, limit: number, digestOnly = false): Promise<FileObservation> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DIAGNOSTIC_LIMITS.binaryBytes) refusal("READ_LIMIT");
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let result: FileObservation | undefined, failed = false, primary: unknown;
  try {
    const before = await fd.stat();
    if (!before.isFile()) refusal("NOT_REGULAR");
    if (before.size > limit) refusal("READ_LIMIT");
    const hash = createHash("sha256"), chunks: Buffer[] = [], buffer = Buffer.alloc(Math.min(limit + 1, 65536));
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, limit - bytes + 1), null);
      if (!bytesRead) break;
      bytes += bytesRead; if (bytes > limit) refusal("READ_LIMIT");
      hash.update(buffer.subarray(0, bytesRead));
      if (!digestOnly) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await fd.stat();
    if (digestOnly && (bytes !== before.size || ["dev", "ino", "size", "mode", "mtimeMs", "ctimeMs"].some(k => before[k as keyof typeof before] !== after[k as keyof typeof after]))) refusal("BINARY_CHANGED");
    result = { bytes, sha256: hash.digest("hex"), mode: (before.mode & 0o7777).toString(8), ...(!digestOnly ? { text: Buffer.concat(chunks).toString("utf8") } : {}) };
  } catch (error) { failed = true; primary = error; }
  try { await fd.close(); } catch (error) { if (!failed) { failed = true; primary = error; } }
  if (failed) throw primary;
  return result!;
}
const systemIO: DiagnosticIO = {
  kernel: release,
  read: async path => (await readDiagnosticFile(path, DIAGNOSTIC_LIMITS.fileBytes)).text!,
  binary: () => readDiagnosticFile(BWRAP, DIAGNOSTIC_LIMITS.binaryBytes, true),
  version: async () => (await promisify(execFile)(BWRAP, ["--version"], {
    cwd: "/", env: {}, timeout: DIAGNOSTIC_LIMITS.versionTimeoutMs,
    maxBuffer: DIAGNOSTIC_LIMITS.versionBytes, killSignal: "SIGKILL", encoding: "utf8",
  })).stdout,
};
const publicFields = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp", "Seccomp_filters"] as const;
const restrictions = [
  ["/proc/sys/user/max_user_namespaces", /^\d{1,20}$/],
  ["/proc/sys/user/max_net_namespaces", /^\d{1,20}$/],
  ["/proc/sys/kernel/unprivileged_userns_clone", /^[01]$/],
  ["/proc/sys/kernel/apparmor_restrict_unprivileged_userns", /^[01]$/],
  ["/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined", /^[01]$/],
  ["/sys/module/apparmor/parameters/enabled", /^[YN]$/],
  ["/sys/kernel/security/lsm", /^[a-zA-Z0-9_,.-]{1,256}$/],
  ["/proc/self/attr/current", /^[a-zA-Z0-9_./:() -]{1,256}$/],
] as const;
function boundedValue(text: string, pattern: RegExp, limit: number = DIAGNOSTIC_LIMITS.fileBytes): Observation<string> {
  if (Buffer.byteLength(text) > limit) return unavailable("READ_LIMIT");
  const value = text.replace(/\0$/, "").trim();
  return pattern.test(value) ? observed(value) : unavailable("INVALID_VALUE");
}
/** Informational only. No namespace setup, security modification, network, identity or cause inference. */
export async function inspectNamespaceDiagnostics(io: DiagnosticIO = systemIO) {
  let kernel: Observation<string>, binary: Observation<Binary>, version: Observation<string> = unavailable("BINARY_UNAVAILABLE");
  try { kernel = boundedValue(io.kernel(), /^[a-zA-Z0-9_.+-]{1,256}$/); } catch (error) { kernel = unavailable(errorCode(error)); }
  try {
    const b = await io.binary();
    binary = Number.isSafeInteger(b.bytes) && b.bytes >= 0 && b.bytes <= DIAGNOSTIC_LIMITS.binaryBytes && /^[a-f0-9]{64}$/.test(b.sha256) && /^[0-7]{3,4}$/.test(b.mode)
      ? observed({ bytes: b.bytes, sha256: b.sha256, mode: b.mode }) : unavailable("INVALID_BINARY_METADATA");
    if (binary.state === "observed" && (parseInt(binary.value.mode, 8) & 0o6022) === 0) {
      try { version = boundedValue(await io.version(), /^bubblewrap [0-9][a-zA-Z0-9.+~-]{0,63}$/, DIAGNOSTIC_LIMITS.versionBytes); } catch (error) { version = unavailable(errorCode(error)); }
    } else version = unavailable("UNSAFE_OR_UNAVAILABLE_BINARY");
  } catch (error) { binary = unavailable(errorCode(error)); }
  const processSecurity = {} as Record<typeof publicFields[number], Observation<string>>;
  try {
    const status = await io.read("/proc/self/status");
    if (Buffer.byteLength(status) > DIAGNOSTIC_LIMITS.fileBytes) refusal("READ_LIMIT");
    for (const field of publicFields) {
      const values = status.split("\n").filter(line => line.startsWith(field + ":")).map(line => line.slice(field.length + 1).trim());
      const pattern = field.startsWith("Cap") ? /^[a-fA-F0-9]{1,32}$/ : field === "NoNewPrivs" ? /^[01]$/ : field === "Seccomp" ? /^[012]$/ : /^\d{1,10}$/;
      processSecurity[field] = values.length === 1 ? boundedValue(values[0], pattern) : unavailable(values.length ? "DUPLICATE_FIELD" : "MISSING_FIELD");
    }
  } catch (error) { for (const field of publicFields) processSecurity[field] = unavailable(errorCode(error)); }
  const restrictionReadback: Record<string, Observation<string>> = {};
  for (const [path, pattern] of restrictions) {
    try { restrictionReadback[path] = boundedValue(await io.read(path), pattern); } catch (error) { restrictionReadback[path] = unavailable(errorCode(error)); }
  }
  return { version: "namespace-diagnostics-v1", qualification: "not-assessed", cause: "unknown", kernel,
    bwrap: { file: binary, version }, processSecurity, restrictions: restrictionReadback, limits: DIAGNOSTIC_LIMITS,
    scope: "read-only parent-process observations, not an atomic snapshot or child namespace/LSM attribution" };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("no diagnostic command/path overrides supported");
  console.log(JSON.stringify(await inspectNamespaceDiagnostics()));
}
