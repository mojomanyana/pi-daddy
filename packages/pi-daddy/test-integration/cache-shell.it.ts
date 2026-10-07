/** Existing Pi shellPath qualification only. No hits, configuration installation or source-proof claim. */
import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { tempDir, cleanupTempDirs } from "../test/tmp.ts";
import {
  shellExec as execute,
  runShellFixture as run,
  shellFixtureEnv as env,
  shellSdkRun,
  shellComparable as comparable,
  type ShellReply,
  shellCliRun,
  type ShellCliOptions,
} from "./cache-shell-harness.ts";

const enabled = process.env.PI_DADDY_IT_CACHE === "1";
let directory: string, adapter: string, cli: string, sdk: string;
before(async () => {
  if (!enabled) return;
  assert.equal(process.platform, "linux");
  directory = await tempDir("cache-shell-");
  adapter = join(directory, "forwarder");
  await execute("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(new URL("./cache-shell-forward.c", import.meta.url)),
    "-o",
    adapter,
  ]);
  cli = await realpath((await execute("which", ["pi"])).stdout.trim());
  sdk = pathToFileURL(join(dirname(cli), "index.js")).href;
});
after(cleanupTempDirs);

function sdkRun(
  shell: string,
  args: { command: string; timeout?: number },
  options: Record<string, unknown> = {},
  beforeStop?: (reply: ShellReply) => Promise<void>,
) {
  return shellSdkRun({ directory, sdk }, shell, args, options, beforeStop);
}

for (const command of [
  "printf 'stdout 日本語\\n'; sleep .04; printf 'stderr\\n' >&2; sleep .04; printf 'tail\\n'",
  "printf ''",
  "printf 'partial error\\n'; exit 7",
  "kill -TERM $$",
  `printf '%s|%s|%s\\n' "$0" "$BASH_ARGV0" "$SHLVL"; read value || printf 'stdin EOF\\n'`,
])
  test(
    `stock SDK forwards bytes/status without changing Bash semantics: ${command.slice(0, 35)}`,
    { skip: !enabled },
    async () => {
      const baseline = await sdkRun("/bin/bash", { command }),
        forwarded = await sdkRun(adapter, { command });
      assert.deepEqual(comparable(forwarded), comparable(baseline));
      assert.equal(forwarded.updates.at(-1), baseline.updates.at(-1));
    },
  );

test(
  "current stock SDK returned failure retains raw status, diagnostic bytes and measured timing",
  { skip: !enabled },
  async (t) => {
    const values = [];
    for (const shell of ["/bin/bash", adapter]) {
      const result = await sdkRun(shell, { command: "printf 'diagnostic 日本語\\n'; exit 7" });
      assert.equal(result.ok, false);
      assert.ok(result.result, "current native failure is a returned result, not a lost exception");
      assert.equal(result.result.isError, true);
      const structured = result.result.structuredContent!;
      assert.equal(structured.exit_code, 7);
      assert.equal(structured.output, "diagnostic 日本語\n");
      assert.equal(structured.truncated, false);
      assert.ok(
        typeof structured.wall_time_seconds === "number" &&
          Number.isFinite(structured.wall_time_seconds) &&
          structured.wall_time_seconds >= 0,
      );
      assert.equal(result.error, result.result.content[0].text);
      assert.match(result.error!, /Command exited with code 7/);
      values.push(result);
    }
    assert.deepEqual(comparable(values[1]), comparable(values[0]));
    t.diagnostic(
      JSON.stringify({
        exitCodes: values.map((v) => v.result!.structuredContent!.exit_code),
        rawWallTimes: values.map((v) => v.result!.structuredContent!.wall_time_seconds),
        scope: "current SDK returned-error/status/timing preservation, not cache reuse",
      }),
    );
  },
);

test(
  "stock SDK retains effective prefix/hook/cwd/full synthetic environment and session attribution",
  { skip: !enabled },
  async () => {
    const cwd = await tempDir("shell-context-"),
      hookCwd = await tempDir("shell-hook-");
    const code = `console.log(JSON.stringify({cwd:process.cwd(),env:process.env,args:process.argv.slice(1)}))`;
    const args = { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} -- 'space arg' '日本語'` };
    const options = { contextCwd: cwd, hookCwd, prefix: "export IT_PREFIX='prefix value'", hook: true };
    const baseline = await sdkRun("/bin/bash", args, options),
      forwarded = await sdkRun(adapter, args, options);
    assert.deepEqual(comparable(forwarded), comparable(baseline));
    const text = forwarded.result!.content[0].text;
    assert.match(text, /^hook\n/);
    const data = JSON.parse(text.slice(5)) as { cwd: string; env: Record<string, string>; args: string[] };
    assert.equal(data.cwd, hookCwd);
    assert.equal(data.env.IT_HOOK, "hook value");
    assert.equal(data.env.IT_PREFIX, "prefix value");
    assert.equal(data.env.PI_SESSION_ID, "fixture-session");
    assert.equal(Object.hasOwn(data.env, "IT_ABSENT"), false);
    assert.deepEqual(data.args, ["space arg", "日本語"]);
  },
);

test("stock SDK preserves real streaming and complete truncated-output bytes", { skip: !enabled }, async () => {
  const code = `process.stdout.write('BEGIN\\n');setTimeout(()=>{for(let i=0;i<3000;i++)console.log('line-'+i+'-'+ 'x'.repeat(30));},180)`;
  const args = { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}` };
  const baseline = await sdkRun("/bin/bash", args),
    forwarded = await sdkRun(adapter, args);
  assert.deepEqual(comparable(forwarded), comparable(baseline));
  assert.ok(forwarded.fullOutput);
  assert.ok(
    forwarded.updates.some((text) => text.includes("BEGIN")),
    "streaming must expose output before final truncation",
  );
  assert.equal(Buffer.from(forwarded.fullOutput!, "base64").toString().startsWith("BEGIN\nline-0-"), true);
});

async function runningCommand(root: string): Promise<string> {
  const identity = pathToFileURL(fileURLToPath(new URL("../src/kernel/cache-owner.ts", import.meta.url))).href;
  const common =
    `import {readCacheOwner} from ${JSON.stringify(identity)};import{readlinkSync,writeFileSync,existsSync}from'node:fs';\n` +
    `const host='/run/pi-daddy-cache-host-proc';const owner=await readCacheOwner(Number(readlinkSync(host+'/self')),host);`;
  const childCode =
    common + `writeFileSync(${JSON.stringify(join(root, "child"))},JSON.stringify(owner));setInterval(()=>{},1000);`;
  const parentCode =
    common +
    `writeFileSync(${JSON.stringify(join(root, "parent"))},JSON.stringify(owner));` +
    `const{spawn}=await import('node:child_process');spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)}],{stdio:'ignore'});` +
    `while(!existsSync(${JSON.stringify(join(root, "child"))}))await new Promise(ok=>setTimeout(ok,5));console.log('STARTED');setInterval(()=>{},1000);`;
  const script = join(root, "living.mjs");
  await writeFile(script, parentCode);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}
async function terminatedBeforeShutdown(root: string): Promise<void> {
  const identities = await Promise.all(
    ["parent", "child"].map(async (name) => JSON.parse(await readFile(join(root, name), "utf8")) as CacheOwnerIdentity),
  );
  const deadline = performance.now() + 2000;
  while (true) {
    if ((await Promise.all(identities.map((owner) => cacheProcessTerminated(owner)))).every(Boolean)) return;
    assert.ok(performance.now() < deadline, "ordinary descendants must die BEFORE namespace shutdown");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}
for (const mode of ["timeout", "abort"])
  test(`stock SDK ${mode} stops the real ordinary descendant group`, { skip: !enabled }, async () => {
    const results: Awaited<ReturnType<typeof sdkRun>>[] = [];
    for (const shell of ["/bin/bash", adapter]) {
      const root = await tempDir("shell-lifetime-");
      const command = await runningCommand(root);
      let checked = false;
      results.push(
        await sdkRun(
          shell,
          { command, ...(mode === "timeout" ? { timeout: 0.75 } : {}) },
          mode === "abort" ? { abortMs: 750 } : {},
          async () => {
            await terminatedBeforeShutdown(root);
            checked = true;
          },
        ),
      );
      assert.equal(checked, true, "termination assertion must run before cleanup");
    }
    assert.deepEqual(comparable(results[1]), comparable(results[0]));
    assert.equal(results[1].ok, false);
    assert.match(results[1].error!, mode === "timeout" ? /timed out after 0.75 seconds/ : /Command aborted/);
  });

test("forwarder refuses incompatible shell argv before executing a command", { skip: !enabled }, async () => {
  const reply = await run(adapter, ["-s", "printf should-not-run"], await env(directory), directory);
  assert.equal(reply.code, 126);
  assert.equal(reply.stdout, "");
  assert.match(reply.stderr, /unsupported shell invocation/);
});

function cliRun(shell: string, extra: ShellCliOptions = {}) {
  return shellCliRun(cli, shell, extra);
}

test(
  "unmodified bundled CLI uses shellPath after actual agent-loop argument mutation",
  { skip: !enabled },
  async () => {
    const baseline = await cliRun("/bin/bash", { mutate: true }),
      forwarded = await cliRun(adapter, { mutate: true });
    assert.deepEqual(forwarded.content, baseline.content);
    assert.equal(forwarded.isError, false);
    assert.equal(forwarded.commandRan, true);
    assert.equal(forwarded.content[0].text, "prefix\nlate-mutation\nbody\n");
  },
);
test("unmodified bundled CLI keeps custom Bash selection and tool allowlist intact", { skip: !enabled }, async () => {
  const override = await cliRun(adapter, { override: true });
  assert.equal(override.content[0].text, "custom override wins");
  assert.equal(override.isError, false);
  assert.equal(override.commandRan, false);
  const denied = await cliRun(adapter, { tools: "read" });
  assert.equal(denied.isError, true);
  assert.equal(denied.commandRan, false);
  assert.match(denied.content[0].text!, /not found|not available|Unknown tool/i);
});

for (const mode of ["timeout", "abort"])
  test(`unmodified bundled CLI ${mode} cancels started work before namespace cleanup`, { skip: !enabled }, async () => {
    const results: Awaited<ReturnType<typeof cliRun>>[] = [];
    for (const shell of ["/bin/bash", adapter]) {
      const root = await tempDir("shell-cli-lifetime-");
      const command = await runningCommand(root);
      let checked = false;
      results.push(
        await cliRun(shell, {
          args: { command, ...(mode === "timeout" ? { timeout: 0.75 } : {}) },
          rpc: mode === "abort",
          beforeStop: async () => {
            await terminatedBeforeShutdown(root);
            checked = true;
          },
        }),
      );
      assert.equal(checked, true);
    }
    assert.deepEqual(results[1].content, results[0].content);
    assert.equal(results[1].isError, true);
    assert.match(results[1].content[0].text!, mode === "timeout" ? /timed out after 0.75 seconds/ : /Command aborted/);
  });

test(
  "large UTF8 output remains intact across fixture and native pipe chunk boundaries",
  { skip: !enabled },
  async () => {
    const code = `process.stdout.write(('日本語é\\n').repeat(16000))`;
    const args = { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}` };
    const baseline = await sdkRun("/bin/bash", args),
      forwarded = await sdkRun(adapter, args);
    assert.deepEqual(comparable(forwarded), comparable(baseline));
    assert.equal(Buffer.from(forwarded.fullOutput!, "base64").toString(), "日本語é\n".repeat(16000));
    assert.equal(forwarded.result!.content[0].text.includes("�"), false);
  },
);

test("fixture reports JSON null as a protocol fault, not a lost-reply timeout", { skip: !enabled }, async () => {
  const root = await tempDir("shell-null-protocol-");
  await assert.rejects(
    run(
      process.execPath,
      ["-e", "process.stdout.write('null\\n');setInterval(()=>{},1000)"],
      await env(root),
      root,
      "fixture",
    ),
    /fixture RPC protocol/,
  );
});

test("ordinary SDK timeout validation precedes adapter execution", { skip: !enabled }, async () => {
  const result = await sdkRun(adapter, { command: "printf should-not-run", timeout: -1 });
  assert.equal(result.ok, false);
  assert.match(result.error!, /Invalid timeout/);
  assert.equal(
    result.updates.every((value) => value === ""),
    true,
  );
});

test(
  "known boundary: downstream original-shell exec failure is NOT a native spawn error",
  { skip: !enabled },
  async () => {
    const broken = join(directory, "broken-original");
    const missing = join(directory, "absent-shell");
    await execute("cc", [
      "-static",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-DPI_DADDY_FORWARD_SHELL=${JSON.stringify(missing)}`,
      fileURLToPath(new URL("./cache-shell-forward.c", import.meta.url)),
      "-o",
      broken,
    ]);
    const baseline = await sdkRun(missing, { command: "printf should-not-run" }),
      forwarded = await sdkRun(broken, { command: "printf should-not-run" });
    assert.equal(baseline.ok, false);
    assert.equal(forwarded.ok, false);
    assert.match(baseline.error!, /Custom shell path not found/);
    assert.match(forwarded.error!, /original shell exec failed.*errno 2/s);
    assert.notEqual(forwarded.error, baseline.error, "do not claim blanket original spawn-error parity");
  },
);
