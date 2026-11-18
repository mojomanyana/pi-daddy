import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import type { GrantsSession } from "./session.ts";

const TARGET = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}\.service$/;
type Execute = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;
export type TelemetryReading = {
  enabled: boolean;
  status: "disabled" | "missing-dependency" | "stopped" | "disconnected" | "stale" | "connected";
  sampledAt?: number;
  gpuPercent?: number;
  temperatureC?: number;
  ramUsedBytes?: number;
  ramTotalBytes?: number;
  note?: string;
};

// execFile's abort callback can precede process close. Keep the owned sample busy
// until close so disable/re-enable and reload cannot overlap the old SSH process.
export const executeTelemetry: Execute = (file, args, options) =>
  new Promise((resolve, reject) => {
    const { signal, ...commandOptions } = options;
    signal?.throwIfAborted();
    let aborted = false;
    let closed = false;
    let result: { error: Error | null; stdout: string; stderr: string } | undefined;
    const finish = () => {
      if (!closed || !result) return;
      if (result.error) reject(result.error);
      else resolve({ stdout: result.stdout, stderr: result.stderr });
    };
    const child = execFile(file, args, { ...commandOptions, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      result = { error: aborted ? new DOMException("Telemetry probe cancelled", "AbortError") : error, stdout, stderr };
      finish();
    });
    const abort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("close", () => {
      signal?.removeEventListener("abort", abort);
      closed = true;
      finish();
    });
  });

function safeNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}
export function parseGpuJson(text: string): Pick<TelemetryReading, "gpuPercent" | "temperatureC"> {
  const root = JSON.parse(text) as {
    devices?: Array<{
      gpu_activity?: Record<string, { value?: unknown }>;
      Sensors?: Record<string, { value?: unknown }>;
    }>;
  };
  const device = root.devices?.[0];
  if (!device) throw new Error("amdgpu_top response contains no device");
  const gpuPercent = safeNumber(device.gpu_activity?.GFX?.value, 0, 100);
  const temperatureC = safeNumber(device.Sensors?.["Edge Temperature"]?.value, -50, 200);
  return {
    ...(gpuPercent === undefined ? {} : { gpuPercent }),
    ...(temperatureC === undefined ? {} : { temperatureC }),
  };
}
export function parseSystemMemory(text: string): Pick<TelemetryReading, "ramUsedBytes" | "ramTotalBytes"> {
  const value = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB\\s*$`, "m").exec(text);
    const bytes = match ? Number(match[1]) * 1024 : NaN;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  };
  const total = value("MemTotal"),
    available = value("MemAvailable");
  if (total === undefined || total === 0) return {};
  return {
    ramTotalBytes: total,
    ...(available === undefined || available > total ? {} : { ramUsedBytes: total - available }),
  };
}
export async function sampleTelemetry(
  env: NodeJS.ProcessEnv = process.env,
  execute: Execute = executeTelemetry,
  signal?: AbortSignal,
): Promise<TelemetryReading> {
  signal?.throwIfAborted();
  const target = env.PI_DADDY_LLM_TELEMETRY_SSH_TARGET;
  const identity = env.PI_DADDY_LLM_TELEMETRY_SSH_IDENTITY;
  const service = env.PI_DADDY_LLM_TELEMETRY_SERVICE;
  if (!target || !identity || !service || !TARGET.test(target) || !identity.startsWith("/") || !SERVICE.test(service))
    return {
      enabled: true,
      status: "missing-dependency",
      note: "Set SSH target, absolute identity path, and systemd service in Pi environment.",
    };
  try {
    const ssh = ["-i", identity, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=2", target];
    let running = false;
    try {
      await execute("ssh", [...ssh, `systemctl is-active --quiet ${service}`], {
        encoding: "utf8",
        signal,
        timeout: 3000,
        maxBuffer: 1024,
      });
      running = true;
    } catch (error) {
      signal?.throwIfAborted();
      const exitCode = (error as { code?: unknown }).code;
      if (exitCode !== 3 && exitCode !== "3") throw error;
    }
    signal?.throwIfAborted();
    const { stdout } = await execute(
      "ssh",
      [...ssh, "~/.local/bin/amdgpu_top --apu --single --no-pc --json -n 1 -s 1000"],
      { encoding: "utf8", signal, timeout: 4000, maxBuffer: 64 * 1024 },
    );
    signal?.throwIfAborted();
    const parsed = parseGpuJson(stdout);
    const { stdout: memory } = await execute("ssh", [...ssh, "cat /proc/meminfo"], {
      encoding: "utf8",
      signal,
      timeout: 3000,
      maxBuffer: 8192,
    });
    signal?.throwIfAborted();
    return {
      enabled: true,
      status: running ? "connected" : "stopped",
      sampledAt: Date.now(),
      ...parsed,
      ...parseSystemMemory(memory),
      note: "System RAM is the shared APU pool; GPU-only allocation and live prompt/generation speed are unavailable.",
    };
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { enabled: true, status: "missing-dependency", note: "OpenSSH client is not installed or not on PATH." };
    return {
      enabled: true,
      status: "disconnected",
      note: "SSH telemetry probe failed; check configured SSH access and amdgpu_top.",
    };
  }
}

export class TelemetryMonitor {
  private enabled = false;
  private reading: TelemetryReading = { enabled: false, status: "disabled" };
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private sample: (signal: AbortSignal) => Promise<TelemetryReading>;
  constructor(sample = (signal: AbortSignal) => sampleTelemetry(process.env, executeTelemetry, signal)) {
    this.sample = sample;
  }
  snapshot(): TelemetryReading {
    if (!this.enabled) return { enabled: false, status: "disabled" };
    const reading = this.reading.enabled
      ? this.reading
      : {
          enabled: true,
          status: "missing-dependency" as const,
          note: "Checking configured SSH telemetry prerequisites.",
        };
    return reading.sampledAt !== undefined && Date.now() - reading.sampledAt > 6000
      ? { ...reading, status: "stale" }
      : reading;
  }
  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.generation++;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.enabled = false;
      this.reading = { enabled: false, status: "disabled" };
      this.controller?.abort();
      return;
    }
    if (this.enabled) return;
    this.enabled = true;
    const generation = ++this.generation;
    const later = () => {
      this.timer = setTimeout(poll, 2000);
      this.timer.unref();
    };
    const poll = () => {
      if (!this.enabled || this.generation !== generation) return;
      if (this.pending) {
        later();
        return;
      }
      const controller = new AbortController();
      this.controller = controller;
      this.pending = Promise.resolve()
        .then(() => this.sample(controller.signal))
        .then((reading) => {
          if (this.enabled && this.generation === generation) this.reading = reading;
        })
        .catch(() => {
          if (this.enabled && this.generation === generation)
            this.reading = { enabled: true, status: "disconnected", note: "Telemetry probe failed." };
        })
        .finally(() => {
          this.controller = undefined;
          this.pending = undefined;
          if (this.enabled && this.generation === generation) later();
        });
    };
    poll();
  }
  async close(): Promise<void> {
    this.setEnabled(false);
    await this.pending;
  }
}
const states = new WeakMap<GrantsSession, TelemetryMonitor>();
export function telemetrySnapshot(session: GrantsSession): TelemetryReading {
  return states.get(session)?.snapshot() ?? { enabled: false, status: "disabled" };
}
export function setTelemetryEnabled(session: GrantsSession, enabled: boolean): void {
  let state = states.get(session);
  if (!state) {
    state = new TelemetryMonitor();
    states.set(session, state);
  }
  state.setEnabled(enabled);
}
export async function closeTelemetry(session: GrantsSession): Promise<void> {
  await states.get(session)?.close();
}
