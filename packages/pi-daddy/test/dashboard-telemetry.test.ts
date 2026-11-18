import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseGpuJson,
  parseSystemMemory,
  TelemetryMonitor,
  executeTelemetry,
  sampleTelemetry,
  telemetrySnapshot,
  setTelemetryEnabled,
  closeTelemetry,
} from "../extensions/dashboard-telemetry.ts";
import type { GrantsSession } from "../extensions/session.ts";
after(cleanupTempDirs);

test("amdgpu_top JSON preserves unsupported/null readings instead of inventing zeros", () => {
  assert.deepEqual(
    parseGpuJson(
      JSON.stringify({
        devices: [
          {
            gpu_activity: { GFX: { value: 21 } },
            Sensors: { "Edge Temperature": { value: 45 }, "CPU Tctl": { value: 55 } },
          },
        ],
      }),
    ),
    { gpuPercent: 21, temperatureC: 45 },
  );
  assert.deepEqual(
    parseGpuJson(
      JSON.stringify({
        devices: [{ gpu_activity: { GFX: { value: null } }, Sensors: { "Edge Temperature": { value: null } } }],
      }),
    ),
    {},
  );
  assert.throws(() => parseGpuJson("{}"));
});

test("missing SSH prerequisites and probe failures are classified without throwing", async () => {
  const missing = await sampleTelemetry({});
  assert.equal(missing.status, "missing-dependency");
  const failure = Object.assign(new Error("private host error text"), { code: "ECONNREFUSED" });
  const disconnected = await sampleTelemetry(
    {
      PI_DADDY_LLM_TELEMETRY_SSH_TARGET: "user@example",
      PI_DADDY_LLM_TELEMETRY_SSH_IDENTITY: "/key",
      PI_DADDY_LLM_TELEMETRY_SERVICE: "llm.service",
    },
    (async () => {
      throw failure;
    }) as never,
  );
  assert.equal(disconnected.status, "disconnected");
  assert.doesNotMatch(disconnected.note ?? "", /private host/);
});

test("SSH target rejects option injection before invoking the client", async () => {
  let calls = 0;
  const result = await sampleTelemetry(
    {
      PI_DADDY_LLM_TELEMETRY_SSH_TARGET: "-oProxyCommand=touch /tmp/pwned",
      PI_DADDY_LLM_TELEMETRY_SSH_IDENTITY: "/key",
      PI_DADDY_LLM_TELEMETRY_SERVICE: "llm.service",
    },
    (async () => {
      calls++;
      return { stdout: "", stderr: "" };
    }) as never,
  );
  assert.equal(result.status, "missing-dependency");
  assert.equal(calls, 0);
});

test("failed service queries are disconnected; only systemd inactive is stopped", async () => {
  const env = {
    PI_DADDY_LLM_TELEMETRY_SSH_TARGET: "user@example",
    PI_DADDY_LLM_TELEMETRY_SSH_IDENTITY: "/key",
    PI_DADDY_LLM_TELEMETRY_SERVICE: "llm.service",
  };
  const denied = Object.assign(new Error("ssh denied"), { code: 255 });
  const disconnected = await sampleTelemetry(env, (async () => {
    throw denied;
  }) as never);
  assert.equal(disconnected.status, "disconnected");
  const stopped = Object.assign(new Error("service inactive"), { code: 3 });
  let calls = 0;
  const inactive = await sampleTelemetry(env, (async () => {
    calls++;
    if (calls === 1) throw stopped;
    if (calls === 2) return { stdout: JSON.stringify({ devices: [{}] }), stderr: "" };
    return { stdout: "MemTotal: 100 kB\nMemAvailable: 50 kB\n", stderr: "" };
  }) as never);
  assert.equal(inactive.status, "stopped");
  assert.equal(inactive.ramUsedBytes, 50 * 1024);
  assert.equal(inactive.ramTotalBytes, 100 * 1024);
});

test("telemetry is off by default and shutdown disables its poller", async () => {
  const session = {} as GrantsSession;
  assert.deepEqual(telemetrySnapshot(session), { enabled: false, status: "disabled" });
  setTelemetryEnabled(session, true);
  assert.equal(telemetrySnapshot(session).enabled, true);
  await closeTelemetry(session);
  assert.deepEqual(telemetrySnapshot(session), { enabled: false, status: "disabled" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(telemetrySnapshot(session), { enabled: false, status: "disabled" });
});

test("physical RAM validates units, range and availability without inventing zero usage", () => {
  assert.deepEqual(parseSystemMemory("MemTotal: 100 kB\nMemAvailable: 25 kB\n"), {
    ramTotalBytes: 102400,
    ramUsedBytes: 76800,
  });
  assert.deepEqual(parseSystemMemory("MemTotal: 100 kB\nMemAvailable: 0 kB\n"), {
    ramTotalBytes: 102400,
    ramUsedBytes: 102400,
  });
  for (const text of ["", "MemTotal: 0 kB", "MemTotal: -1 kB", "MemTotal: 100 MB", "MemTotal: 99999999999999999 kB"])
    assert.deepEqual(parseSystemMemory(text), {}, text);
  for (const value of ["101 kB", "-1 kB", "NaN kB", "1 MB", "1.5 kB"])
    assert.deepEqual(parseSystemMemory(`MemTotal: 100 kB\nMemAvailable: ${value}\n`), { ramTotalBytes: 102400 });
});

test("cancellation at each probe stage prevents subsequent commands and late readings", async () => {
  const env = {
    PI_DADDY_LLM_TELEMETRY_SSH_TARGET: "user@example",
    PI_DADDY_LLM_TELEMETRY_SSH_IDENTITY: "/key",
    PI_DADDY_LLM_TELEMETRY_SERVICE: "llm.service",
  };
  for (const cancelAt of [1, 2, 3]) {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(
      sampleTelemetry(
        env,
        async (_file, _args, options) => {
          assert.equal(options.signal, controller.signal);
          calls++;
          if (calls === cancelAt) controller.abort();
          return {
            stdout: calls === 2 ? JSON.stringify({ devices: [{}] }) : "MemTotal: 100 kB\nMemAvailable: 50 kB\n",
            stderr: "",
          };
        },
        controller.signal,
      ),
      { name: "AbortError" },
    );
    assert.equal(calls, cancelAt);
  }
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("disable/re-enable waits for the previous owned sample to settle and ignores its late result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0,
    active = 0,
    maximum = 0;
  let firstSignal: AbortSignal | undefined;
  let release!: () => void;
  const monitor = new TelemetryMonitor(async (signal) => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    if (calls === 1) {
      firstSignal = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    active--;
    return { enabled: true, status: "connected", gpuPercent: calls, sampledAt: Date.now() };
  });
  try {
    monitor.setEnabled(true);
    await flush();
    monitor.setEnabled(false);
    assert.equal(firstSignal?.aborted, true);
    assert.deepEqual(monitor.snapshot(), { enabled: false, status: "disabled" });
    monitor.setEnabled(true);
    t.mock.timers.tick(4000);
    await flush();
    assert.equal(calls, 1, "re-enable must not overlap the unfinished sample");
    release();
    await flush();
    assert.equal(monitor.snapshot().gpuPercent, undefined, "cancelled result cannot reappear");
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
    assert.equal(monitor.snapshot().gpuPercent, 2);
  } finally {
    release?.();
    await monitor.close();
  }
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(calls, 2, "shutdown cancels future polls");
});

test("shutdown/reload cleanup does not resolve before the active sample closes", async () => {
  let release!: () => void;
  let signal: AbortSignal | undefined;
  const monitor = new TelemetryMonitor(async (value) => {
    signal = value;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { enabled: true, status: "connected", gpuPercent: 50 };
  });
  monitor.setEnabled(true);
  await flush();
  let closed = false;
  const closing = monitor.close().then(() => {
    closed = true;
  });
  await flush();
  assert.equal(signal?.aborted, true);
  assert.equal(closed, false);
  release();
  await closing;
  assert.deepEqual(monitor.snapshot(), { enabled: false, status: "disabled" });
});

test(
  "owned process cancellation settles only after process exit, including a SIGTERM-resistant probe",
  { timeout: 15000 },
  async () => {
    const folder = await tempDir("pi-telemetry-cancel-");
    const pidFile = join(folder, "pid");
    const controller = new AbortController();
    const result = executeTelemetry(
      process.execPath,
      [
        "-e",
        `require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`,
        pidFile,
      ],
      { encoding: "utf8", signal: controller.signal, timeout: 10000, maxBuffer: 1024 },
    );
    const settled = result.then(
      () => ({ ok: true, error: undefined }),
      (error: unknown) => ({ ok: false, error }),
    );
    try {
      let pid = 0;
      for (let index = 0; index < 200; index++) {
        try {
          pid = Number(await readFile(pidFile, "utf8"));
          break;
        } catch {
          await delay(25);
        }
      }
      assert.ok(pid > 0, "local owned fixture must have started");
      controller.abort();
      const outcome = await settled;
      assert.equal(outcome.ok, false);
      assert.equal((outcome.error as Error).name, "AbortError");
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
    } finally {
      controller.abort();
      await settled;
    }
  },
);
