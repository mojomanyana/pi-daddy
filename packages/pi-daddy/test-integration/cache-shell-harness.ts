/** Shared isolated shell-route fixtures. Synthetic environment only; stock SDK/CLI remain untouched. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { startSupervisedCache } from "../src/executors/cache-supervisor.ts";
import { tempDir } from "../test/tmp.ts";
import type { ShellOutcome } from "./cache-shell-result.ts";
export { shellComparable, type ShellOutcome } from "./cache-shell-result.ts";
export const shellExec = promisify(execFile);
export interface ShellReply {
  code: number | null;
  signal: string | null;
  running: boolean;
  observerWitness?: { count: number; terminated: true };
  overflow: boolean;
  controlError: string;
  stdout: string;
  stderr: string;
  aborted: boolean;
}
export async function runShellFixture(
  executable: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  rpcPrompt?: string,
  beforeStop?: (reply: ShellReply) => Promise<void>,
  observerWitness?: string,
): Promise<ShellReply> {
  let output: Buffer = Buffer.alloc(0),
    resolve!: (reply: ShellReply) => void,
    reject!: (error: unknown) => void;
  const reply = new Promise<ShellReply>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  // A fixture can fail before supervisor readiness; observe immediately without hiding its rejection.
  void reply.catch(() => {});
  const handle = await startSupervisedCache({
    owner: await readCacheOwner(process.pid),
    cwd,
    entry: new URL("./cache-shell-runner.ts", import.meta.url),
    args: [JSON.stringify({ executable, args, env, rpcPrompt, abortOnOutput: !!rpcPrompt, observerWitness })],
    onData(stream, bytes) {
      if (stream !== "stdout") return;
      if (output.length + bytes.length > 16 * 1024 * 1024) {
        reject(Error("shell fixture result exceeded 16 MiB"));
        return;
      }
      output = Buffer.concat([output, bytes]);
      const end = output.indexOf(10);
      if (end >= 0) {
        try {
          resolve(JSON.parse(output.subarray(0, end).toString("utf8")) as ShellReply);
        } catch (error) {
          reject(error);
        }
      }
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      reply,
      new Promise<never>((_, no) => {
        timer = setTimeout(() => no(Error("shell fixture did not complete")), 15000);
      }),
    ]);
    assert.equal(result.overflow, false);
    assert.equal(result.controlError, "");
    await beforeStop?.(result);
    return result;
  } finally {
    clearTimeout(timer);
    await handle.stop();
  }
}
export async function shellFixtureEnv(cwd: string): Promise<Record<string, string>> {
  await mkdir(join(cwd, "home"), { recursive: true });
  await mkdir(join(cwd, "tmp"), { recursive: true });
  return {
    HOME: join(cwd, "home"),
    TMPDIR: join(cwd, "tmp"),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    TERM: "dumb",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    IT_VALUE: "quotes ' \" and 日本語",
    IT_ABSENT: "remove me",
  };
}
export async function shellSdkRun(
  fixture: { directory: string; sdk: string },
  shell: string,
  args: { command: string; timeout?: number },
  options: Record<string, unknown> = {},
  beforeStop?: (reply: ShellReply) => Promise<void>,
  observerWitness?: string,
): Promise<ShellOutcome> {
  const cwd = (options.cwd as string) || fixture.directory;
  const reply = await runShellFixture(
    process.execPath,
    [
      fileURLToPath(new URL("./cache-shell-sdk.mjs", import.meta.url)),
      fixture.sdk,
      JSON.stringify({ shell, args, ...options }),
    ],
    await shellFixtureEnv(cwd),
    cwd,
    undefined,
    beforeStop,
    observerWitness,
  );
  assert.equal(reply.code, 0, reply.stderr);
  return JSON.parse(reply.stdout) as ShellOutcome;
}
export interface ShellCliOptions {
  tools?: string;
  override?: boolean;
  mutate?: boolean;
  args?: { command: string; timeout?: number };
  rpc?: boolean;
  cwd?: string;
  beforeStop?: (reply: ShellReply) => Promise<void>;
  observerWitness?: string;
}
export async function shellCliRun(cli: string, shell: string, extra: ShellCliOptions = {}) {
  const root = extra.cwd || (await tempDir("shell-pi-cli-"));
  const environment = await shellFixtureEnv(root);
  environment.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(environment.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(
    join(environment.PI_CODING_AGENT_DIR, "settings.json"),
    JSON.stringify({
      shellPath: shell,
      shellCommandPrefix: "printf 'prefix\\n'",
      cacheWarming: "off",
      enableInstallTelemetry: false,
      enableAnalytics: false,
      defaultProjectTrust: "never",
    }),
  );
  const marker = join(root, "command-ran");
  environment.IT_COMMAND_RAN = marker;
  environment.PI_DADDY_IT_SHELL_CALLS = JSON.stringify([
    extra.args || { command: "printf 'body\\n'; : > \"$IT_COMMAND_RAN\"" },
  ]);
  if (extra.override) environment.PI_DADDY_IT_SHELL_OVERRIDE = "1";
  if (extra.mutate) environment.PI_DADDY_IT_SHELL_MUTATE = "1";
  const reply = await runShellFixture(
    process.execPath,
    [
      cli,
      ...(extra.rpc ? ["--mode", "rpc"] : ["--print", "--mode", "json"]),
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "-e",
      fileURLToPath(new URL("./cache-shell-model.mjs", import.meta.url)),
      "--provider",
      "cache-shell-fixture",
      "--model",
      "local",
      "--tools",
      extra.tools || "bash",
      ...(extra.rpc ? [] : ["fixture"]),
    ],
    environment,
    root,
    extra.rpc ? "fixture" : undefined,
    extra.beforeStop,
    extra.observerWitness,
  );
  if (extra.rpc) {
    assert.equal(reply.aborted, true);
    assert.equal(reply.running, true, "RPC Pi must stay alive until beforeStop asserts descendant death");
    assert.equal(reply.signal, null);
    assert.equal(reply.code, null);
  } else assert.equal(reply.code, 0, reply.stderr || reply.stdout);
  const events = reply.stdout
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          message?: { role: string; content: { text?: string }[]; isError?: boolean };
        },
    );
  const results = events
    .filter((event) => event.type === "message_end" && event.message?.role === "toolResult")
    .map((event) => event.message!);
  assert.equal(results.length, 1, reply.stdout);
  let commandRan = false;
  try {
    await readFile(marker);
    commandRan = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { ...results[0], commandRan };
}
