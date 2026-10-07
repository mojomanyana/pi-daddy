/** OS receipt experiment through existing shellPath. No production parser, eligibility or cache publication. */
import assert from "node:assert/strict";
import { mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { startCacheLeaseBridge } from "../src/executors/cache-lease-bridge.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { cleanupTempDirs, tempDir } from "../test/tmp.ts";
import { shellComparable, shellExec, shellSdkRun, shellCliRun } from "./cache-shell-harness.ts";

const enabled = process.env.PI_DADDY_IT_CACHE === "1";
let sdk: string, tracer: string, libraries: string, cli: string, leaseBinary: string, leaseSha256: string;
before(async () => {
  if (!enabled) return;
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  tracer = process.env.PI_DADDY_CACHE_STRACE || "";
  assert.ok(tracer, "PI_DADDY_CACHE_STRACE must name the approved private tracer");
  tracer = await realpath(tracer);
  libraries = join(dirname(dirname(tracer)), "lib/x86_64-linux-gnu");
  cli = await realpath((await shellExec("which", ["pi"])).stdout.trim());
  sdk = pathToFileURL(join(dirname(cli), "index.js")).href;
  leaseBinary = join(await tempDir("typecheck-guard-"), "lease");
  await shellExec("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(new URL("../src/executors/native/cache-lease.c", import.meta.url)),
    "-o",
    leaseBinary,
  ]);
  leaseSha256 = createHash("sha256")
    .update(await readFile(leaseBinary))
    .digest("hex");
});
after(cleanupTempDirs);

async function fixture(follow = true, daemon = true) {
  const root = await tempDir("shell-trace-"),
    directory = join(root, "work"),
    traces = join(root, "traces");
  await mkdir(directory);
  await mkdir(traces);
  const header = join(root, "trace-config.h"),
    adapter = join(root, "trace-shell");
  await writeFile(
    header,
    [
      `#define TRACE_PROGRAM ${JSON.stringify(tracer)}`,
      `#define TRACE_LIBRARIES ${JSON.stringify(libraries)}`,
      `#define TRACE_OUTPUT ${JSON.stringify(join(traces, "trace"))}`,
      `#define TRACE_FOLLOW ${Number(follow)}`,
      `#define TRACE_DAEMON ${Number(daemon)}`,
    ].join("\n"),
  );
  await shellExec("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-DTRACE_CONFIG=${JSON.stringify(header)}`,
    fileURLToPath(new URL("./cache-shell-trace.c", import.meta.url)),
    "-o",
    adapter,
  ]);
  return { directory, sdk, adapter, traces };
}
async function completedTrace(traces: string): Promise<string> {
  const deadline = performance.now() + 3000;
  while (true) {
    const names = (await readdir(traces)).filter((name) => /^trace(?:\.\d+)?$/.test(name));
    const files = await Promise.all(names.map((name) => readFile(join(traces, name), "utf8")));
    assert.ok(
      files.reduce((sum, text) => sum + Buffer.byteLength(text), 0) <= 16 * 1024 * 1024,
      "fixture trace exceeded 16 MiB",
    );
    if (
      files.length &&
      files.every((text) => /\+\+\+ (?:exited with \d+|killed by [A-Z0-9]+.*?) \+\+\+\s*$/.test(text))
    )
      return files.join("\n");
    assert.ok(performance.now() < deadline, "every recorded tracee must finish before namespace teardown");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}
async function runReceipt(
  f: Awaited<ReturnType<typeof fixture>>,
  command: string,
  options: Record<string, unknown> = {},
) {
  let trace = "",
    checked = false;
  const outcome = await shellSdkRun(f, f.adapter, { command }, { ...options, cwd: f.directory }, async () => {
    trace = await completedTrace(f.traces);
    checked = true;
  });
  assert.equal(checked, true);
  assert.equal(outcome.ok, true, outcome.error);
  return { outcome, trace };
}
async function program(directory: string) {
  const input = join(directory, "input"),
    childInput = join(directory, "child-input"),
    effect = join(directory, "child-effect"),
    sock = join(directory, "missing.sock");
  await writeFile(input, "root input");
  await writeFile(childInput, "child input");
  const child = join(directory, "child.mjs"),
    main = join(directory, "main.mjs");
  await writeFile(
    child,
    `import fs from'node:fs';import net from'node:net';fs.readFileSync(${JSON.stringify(childInput)});` +
      `await new Promise(ok=>{const s=net.createConnection(${JSON.stringify(sock)});s.once('error',()=>{s.destroy();ok();});});` +
      `fs.writeFileSync(${JSON.stringify(effect)},'child finished');`,
  );
  await writeFile(
    main,
    `import fs from'node:fs';import{spawn}from'node:child_process';` +
      `fs.readFileSync(${JSON.stringify(input)});fs.existsSync(${JSON.stringify(join(directory, "absent-config"))});fs.readdirSync(${JSON.stringify(directory)});` +
      `spawn(process.execPath,[${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();` +
      `while(!fs.existsSync(${JSON.stringify(effect)}))await new Promise(ok=>setTimeout(ok,5));console.log('receipt-probe-success');`,
  );
  return { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(main)}`, effect, childInput, sock, input };
}
function childEffects(trace: string, p: Awaited<ReturnType<typeof program>>) {
  // Assertions on controlled ASCII fixture paths and syscall lines, NOT a reusable strace parser.
  assert.ok(
    trace
      .split("\n")
      .some((line) => /^(?:openat|openat2)\(/.test(line) && line.includes(p.effect) && line.includes("O_WRONLY")),
    "detached child's actual write-intent syscall must be present",
  );
  assert.ok(
    trace.split("\n").some((line) => line.startsWith("connect(") && line.includes(p.sock) && line.includes("ENOENT")),
    "failed child service access must be present despite exit zero",
  );
  assert.ok(
    trace.split("\n").some((line) => line.startsWith("read(") && line.includes(p.childInput)),
    "detached child's actual input read must be present",
  );
}

test(
  "existing shellPath plus OS tracing records final command, reads, missing probes, enumeration and detached effects",
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      p = await program(f.directory);
    const { outcome, trace } = await runReceipt(f, p.command, {
      prefix: "export IT_PREFIX='trace prefix'",
      hook: true,
    });
    assert.equal(outcome.result!.content[0].text, "hook\nreceipt-probe-success\n");
    childEffects(trace, p);
    assert.ok(trace.split("\n").some((line) => line.startsWith("read(") && line.includes(p.input)));
    assert.ok(
      trace
        .split("\n")
        .some(
          (line) =>
            /^(?:access|newfstatat|statx|openat)\(/.test(line) &&
            line.includes("absent-config") &&
            line.includes("ENOENT"),
        ),
    );
    assert.ok(trace.split("\n").some((line) => line.startsWith("getdents64(") && line.includes(f.directory)));
    assert.ok(
      trace.includes("IT_PREFIX=trace prefix") && trace.includes("IT_HOOK=hook value"),
      "exec environment is full synthetic fixture environment",
    );
    assert.ok(
      trace.includes("printf 'hook") && trace.includes("export IT_PREFIX"),
      "trace must see final prefix/hook-transformed command",
    );
  },
);

test(
  "negative control: observing only the top-level process misses detached child effects",
  { skip: !enabled },
  async () => {
    const f = await fixture(false),
      p = await program(f.directory);
    const { outcome, trace } = await runReceipt(f, p.command);
    assert.equal(outcome.result!.content[0].text, "receipt-probe-success\n");
    assert.throws(() => childEffects(trace, p), /actual write-intent syscall/);
    assert.equal(
      await readFile(p.effect, "utf8"),
      "child finished",
      "missing observation is not proof the effect didn't happen",
    );
  },
);

test(
  "daemonized tracer preserves the shell's original parent relationship; ordinary parent tracing does not",
  { skip: !enabled },
  async () => {
    const code = `const fs=require('node:fs');console.log(JSON.stringify({parentExe:fs.readlinkSync('/proc/'+process.ppid+'/exe'),env:process.env,cwd:process.cwd()}))`;
    const command = `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
    const daemon = await fixture(),
      parent = await fixture(true, false);
    const baseline = await shellSdkRun(daemon, "/bin/bash", { command }, { cwd: daemon.directory });
    const observed = await runReceipt(daemon, command);
    assert.deepEqual(shellComparable(observed.outcome), shellComparable(baseline));
    const changed = await runReceipt(parent, command);
    const first = JSON.parse(baseline.result!.content[0].text) as { parentExe: string },
      second = JSON.parse(changed.outcome.result!.content[0].text) as { parentExe: string };
    assert.notEqual(
      first.parentExe,
      second.parentExe,
      "parent tracing is an observable semantic change, not transparent by default",
    );
  },
);

test("unmodified bundled CLI emits a real OS receipt for its normal Bash tool call", { skip: !enabled }, async () => {
  const f = await fixture(),
    p = await program(f.directory);
  let trace = "",
    checked = false;
  const outcome = await shellCliRun(cli, f.adapter, {
    cwd: f.directory,
    args: { command: p.command },
    mutate: true,
    beforeStop: async () => {
      trace = await completedTrace(f.traces);
      checked = true;
    },
  });
  assert.equal(checked, true);
  assert.equal(outcome.isError, false);
  assert.equal(outcome.content[0].text, "prefix\nlate-mutation\nreceipt-probe-success\n");
  childEffects(trace, p);
  assert.ok(trace.includes("late-mutation"), "OS receipt must observe actual final agent-loop-mutated command");
});

async function typecheckProject(directory: string) {
  const compiler = await realpath(fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)));
  const input = join(directory, "input.ts"),
    config = join(directory, "tsconfig.json");
  await writeFile(input, "export const answer: number = 42;\n");
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: true, target: "ES2023", types: [] },
      files: ["input.ts"],
    }),
  );
  return {
    input,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(compiler)} -p ${JSON.stringify(config)}`,
  };
}
async function contentGuard() {
  const owner = await readCacheOwner(process.pid);
  return startCacheLeaseBridge({
    binary: leaseBinary,
    binarySha256: leaseSha256,
    owner,
    peer: owner,
    onLoss: () => {
      assert.fail("unexpected content loss in controlled qualification");
    },
  });
}

test(
  "useful typecheck OS receipt exposes a real runtime dependency that unprivileged acquisition refuses",
  { skip: !enabled },
  async (t) => {
    const f = await fixture(),
      p = await typecheckProject(f.directory);
    const { outcome, trace } = await runReceipt(f, p.command);
    assert.equal(outcome.result!.content[0].text, "(no output)");
    assert.ok(
      trace.split("\n").some((line) => line.startsWith("read(") && line.includes(p.input)),
      "compiler must actually read source",
    );
    const opened = [
      ...new Set(
        trace.split("\n").flatMap((line) => {
          if (!/^(?:openat|openat2)\(/.test(line)) return [];
          const match = /\) = \d+<([^>]+)>$/.exec(line);
          return match && /^(?:\/usr\/|\/lib\/|\/lib64\/)/.test(match[1]) ? [match[1]] : [];
        }),
      ),
    ];
    const candidates = [];
    for (const path of opened) {
      const handle = await open(path, "r");
      try {
        const stat = await handle.stat();
        if (stat.isFile() && stat.uid === 0) candidates.push(path);
      } finally {
        await handle.close();
      }
    }
    assert.ok(candidates.length, "actual receipt must contain root-owned runtime files, not an invented dependency");
    const bridge = await contentGuard();
    try {
      assert.equal(bridge.privileged, false);
      const source = await open(p.input, "r");
      try {
        const result = await bridge.acquire(source.fd, await source.stat({ bigint: true }));
        assert.equal(result.ok, true, "owned source content is the admission control");
        if (result.ok) await result.lease.release();
      } finally {
        await source.close();
      }
      const runtime = await open(candidates[0], "r");
      try {
        const result = await bridge.acquire(runtime.fd, await runtime.stat({ bigint: true }));
        assert.equal(result.ok, false, `runtime content cannot silently be assumed guarded: ${candidates[0]}`);
        if (!result.ok) {
          assert.match(result.reason, /CAPABILITY/);
          t.diagnostic(
            JSON.stringify({
              observedRuntime: candidates[0],
              refusal: result.reason,
              rootOwnedRuntimeCandidates: candidates.length,
            }),
          );
        }
      } finally {
        await runtime.close();
      }
    } finally {
      await bridge.stop();
    }
  },
);

test(
  "typecheck counterexample: a valid old-inode content lease does not guard the source pathname",
  { skip: !enabled },
  async () => {
    const f = await fixture(),
      p = await typecheckProject(f.directory),
      bridge = await contentGuard(),
      source = await open(p.input, "r");
    try {
      const held = await bridge.acquire(source.fd, await source.stat({ bigint: true }));
      if (!held.ok) assert.fail(held.reason);
      const first = await shellSdkRun(f, "/bin/bash", { command: p.command }, { cwd: f.directory });
      assert.equal(first.ok, true, first.error);
      await rename(p.input, p.input + ".retired");
      await writeFile(p.input, "export const answer: number = 'wrong';\n");
      assert.equal(await held.lease.check(), true, "rename/replacement leaves the old inode's byte lease valid");
      assert.equal(await source.readFile("utf8"), "export const answer: number = 42;\n");
      const fresh = await shellSdkRun(f, "/bin/bash", { command: p.command }, { cwd: f.directory });
      assert.equal(fresh.ok, false);
      assert.match(fresh.error!, /not assignable to type 'number'/);
      await held.lease.release();
    } finally {
      await bridge.stop();
      await source.close();
    }
  },
);
