import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CacheNativeContext, CacheNativeContextCleanupError } from "../src/executors/cache-native-context.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
const bootId = "11111111-1111-1111-1111-111111111111";
function processStat(pid: number, ticks: string, state = "S") {
  const fields = [state, ...Array<string>(18).fill("0"), ticks];
  return `${pid} (fixture) ${fields.join(" ")}\n`;
}
async function fixture(extra: Partial<ConstructorParameters<typeof CacheNativeContext>[0]> = {}) {
  const root = await tempDir("cache-native-context-"),
    proc = join(root, "proc"),
    image = join(root, "shell");
  await fs.writeFile(image, "private known static image fixture");
  const info = await fs.stat(image, { bigint: true });
  const connector = { pid: 100, bootId, startTicks: "101" },
    parent = { pid: 200, bootId, startTicks: "201" };
  const invocation = {
    cwd: root,
    shell: "/bin/bash",
    command: "printf 'hello'",
    env: { Z: "last", A: "first" },
    timeoutMs: 1000,
  };
  const expected = { parent, image: { path: image, dev: String(info.dev), ino: String(info.ino) }, invocation };
  await fs.mkdir(join(proc, "sys/kernel/random"), { recursive: true });
  await fs.writeFile(join(proc, "sys/kernel/random/boot_id"), bootId + "\n");
  for (const identity of [connector, parent]) {
    await fs.mkdir(join(proc, String(identity.pid)), { recursive: true });
    await fs.writeFile(join(proc, String(identity.pid), "stat"), processStat(identity.pid, identity.startTicks));
  }
  const processDir = join(proc, "100");
  await fs.mkdir(join(processDir, "fd"));
  await fs.mkdir(join(processDir, "fdinfo"));
  await fs.symlink(image, join(processDir, "exe"));
  await fs.symlink(root, join(processDir, "cwd"));
  await fs.symlink("/dev/null", join(processDir, "fd/0"));
  await fs.writeFile(join(processDir, "fdinfo/0"), "pos:\t0\nflags:\t0100000\n");
  await fs.writeFile(join(processDir, "status"), "Name:\tfixture\nPPid:\t200\n");
  await fs.writeFile(join(processDir, "cmdline"), Buffer.from([image, "-c", invocation.command, ""].join("\0")));
  await fs.writeFile(join(processDir, "environ"), Buffer.from("Z=last\0A=first\0"));
  const validator = new CacheNativeContext({
    checks: 1,
    maxReadBytes: 1200000,
    maxTotalBytes: 3000000,
    timeoutMs: 1000,
    procRoot: proc,
    ...extra,
  });
  return { validator, expected, connector, processDir, proc, root };
}
test("independent native context qualifies exact birth/image/parent/argv/ordered environment/dev-null input", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.validator.validate(f.connector, f.expected), { kind: "qualified" });
  } finally {
    await f.validator.close();
  }
  assert.deepEqual(f.validator.stats(), { owned: 0, handles: 0, faulted: false, closed: true });
});
test("observed native mismatch rejects rather than admitting claims or normalizing environment", async () => {
  for (const [name, contents] of [
    ["cmdline", "other\0-c\0printf 'hello'\0"],
    ["environ", "A=first\0Z=last\0"],
    ["status", "PPid:\t999\n"],
    ["stat", processStat(100, "999")],
    ["fdinfo/0", "flags:\t0100002\n"],
  ]) {
    const f = await fixture();
    await fs.writeFile(join(f.processDir, name), contents);
    try {
      assert.equal((await f.validator.validate(f.connector, f.expected)).kind, "reject", name);
    } finally {
      await f.validator.close();
    }
  }
  for (const name of ["exe", "cwd", "fd/0"]) {
    const f = await fixture();
    await fs.unlink(join(f.processDir, name));
    await fs.symlink(name === "cwd" ? f.proc : "/etc/hosts", join(f.processDir, name));
    try {
      assert.equal((await f.validator.validate(f.connector, f.expected)).kind, "reject", name);
    } finally {
      await f.validator.close();
    }
  }
});
test("a known native mismatch cannot downgrade to bypass when a later observation is unavailable", async () => {
  for (const [name, contents] of [
    ["stat", processStat(100, "999")],
    ["status", "PPid:\t999\n"],
    ["cmdline", "wrong\0-c\0printf 'hello'\0"],
    ["fdinfo/0", "flags:\t0100002\n"],
  ]) {
    const f = await fixture();
    await fs.writeFile(join(f.processDir, name), contents);
    await fs.unlink(join(f.processDir, "environ"));
    try {
      assert.equal((await f.validator.validate(f.connector, f.expected)).kind, "reject", name);
    } finally {
      await f.validator.close();
    }
  }
});
test("unknown proc observations and malformed/oversized data bypass without qualification", async () => {
  for (const mutate of [
    async (f: Awaited<ReturnType<typeof fixture>>) => fs.unlink(join(f.processDir, "environ")),
    async (f: Awaited<ReturnType<typeof fixture>>) => fs.writeFile(join(f.processDir, "status"), "PPid: bad\n"),
    async (f: Awaited<ReturnType<typeof fixture>>) =>
      fs.writeFile(join(f.processDir, "environ"), Buffer.alloc(1200001, 65)),
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await fs.unlink(join(f.processDir, "cmdline"));
      execFileSync("mkfifo", [join(f.processDir, "cmdline")]);
    },
  ]) {
    const f = await fixture();
    await mutate(f);
    try {
      assert.equal((await f.validator.validate(f.connector, f.expected)).kind, "bypass");
    } finally {
      await f.validator.close();
    }
  }
});
test("birth or parent changes during independent observation cannot qualify", async () => {
  for (const pid of [100, 200]) {
    let altered = false;
    const files = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const h = await fs.open(...args);
        if (!String(args[0]).endsWith("/environ")) return h;
        return new Proxy(h, {
          get(t, p) {
            if (p === "read")
              return async (...a: Parameters<typeof h.read>) => {
                const result = await t.read(...a);
                if (!altered) {
                  altered = true;
                  await fs.writeFile(join(String(args[0]), "../../", String(pid), "stat"), processStat(pid, "999"));
                }
                return result;
              };
            const v = Reflect.get(t, p, t);
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
      },
    };
    const f = await fixture({ files });
    try {
      assert.equal((await f.validator.validate(f.connector, f.expected)).kind, "reject");
    } finally {
      await f.validator.close();
    }
  }
});
test("native validation owns late allocation/read on abort and close and enforces admission before await", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const f = await fixture({
    files: {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        entered();
        await gate;
        return fs.open(...args);
      },
    },
  });
  const controller = new AbortController();
  let settled = false,
    closed = false;
  const check = f.validator.validate(f.connector, f.expected, controller.signal).then((value) => {
    settled = true;
    return value;
  });
  await ready;
  await assert.rejects(f.validator.validate(f.connector, f.expected), /admission/);
  controller.abort();
  const stop = f.validator.close().then(() => {
    closed = true;
  });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(settled, false);
  assert.equal(closed, false);
  assert.equal(f.validator.stats().owned, 1);
  release();
  assert.equal((await check).kind, "bypass");
  await stop;
  assert.equal(f.validator.stats().handles, 0);
});
test("failed native observation close retains actual fd, faults admission, and exposes explicit retry", async () => {
  let fail = true,
    fd = -1;
  const f = await fixture({
    files: {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const h = await fs.open(...args);
        fd = h.fd;
        return new Proxy(h, {
          get(t, p) {
            if (p === "close")
              return async () => {
                if (fail) throw Error("proc close fault");
                return t.close();
              };
            const v = Reflect.get(t, p, t);
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
      },
    },
  });
  let retry!: () => Promise<void>;
  await assert.rejects(f.validator.validate(f.connector, f.expected), (error: unknown) => {
    assert.ok(error instanceof CacheNativeContextCleanupError);
    retry = error.cleanup;
    return true;
  });
  assert.equal(f.validator.stats().owned, 1);
  assert.equal(f.validator.stats().faulted, true);
  await fs.stat(`/proc/self/fd/${fd}`);
  await assert.rejects(f.validator.validate(f.connector, f.expected), /admission/);
  await assert.rejects(f.validator.close(), CacheNativeContextCleanupError);
  fail = false;
  await retry();
  await assert.rejects(fs.stat(`/proc/self/fd/${fd}`), { code: "ENOENT" });
  assert.equal(f.validator.stats().owned, 0);
  assert.equal(f.validator.stats().faulted, true);
});
test("the first native descriptor close failure remains visible even if an implicit retry would succeed", async () => {
  let attempts = 0,
    fd = -1;
  const f = await fixture({
    files: {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const h = await fs.open(...args);
        fd = h.fd;
        return new Proxy(h, {
          get(t, p) {
            if (p === "close")
              return async () => {
                if (++attempts === 1) throw Error("first close fault");
                return t.close();
              };
            const v = Reflect.get(t, p, t);
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
      },
    },
  });
  let retry!: () => Promise<void>;
  await assert.rejects(f.validator.validate(f.connector, f.expected), (error: unknown) => {
    assert.ok(error instanceof CacheNativeContextCleanupError);
    assert.match(String(error.errors[0]), /first close fault/);
    retry = error.cleanup;
    return true;
  });
  assert.equal(attempts, 1, "no automatic retry can turn cleanup failure into bypass");
  assert.equal(f.validator.stats().faulted, true);
  assert.equal(f.validator.stats().owned, 1);
  await fs.stat(`/proc/self/fd/${fd}`);
  await assert.rejects(f.validator.validate(f.connector, f.expected), /admission/);
  await assert.rejects(f.validator.close(), CacheNativeContextCleanupError);
  assert.equal(attempts, 1);
  await retry();
  assert.equal(attempts, 2);
  assert.equal(f.validator.stats().owned, 0);
  await assert.rejects(fs.stat(`/proc/self/fd/${fd}`), { code: "ENOENT" });
  assert.equal(f.validator.stats().faulted, true);
  await assert.rejects(
    f.validator.close(),
    CacheNativeContextCleanupError,
    "original failed close promise stays failed",
  );
});
test("an O_PATH dev-null descriptor is not readable native stdin", async () => {
  const f = await fixture();
  await fs.writeFile(join(f.processDir, "fdinfo/0"), "flags:\t010000000\n");
  try {
    assert.equal((await f.validator.validate(f.connector, f.expected)).kind, "reject");
  } finally {
    await f.validator.close();
  }
});
test("between-operation native deadline includes late opens and cleans them before bypass", async () => {
  const f = await fixture({
    timeoutMs: 1,
    files: {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        await new Promise((r) => setTimeout(r, 10));
        return fs.open(...args);
      },
    },
  });
  try {
    const result = await f.validator.validate(f.connector, f.expected);
    assert.equal(result.kind, "bypass");
    assert.equal(f.validator.stats().handles, 0);
    assert.equal(f.validator.stats().owned, 0);
  } finally {
    await f.validator.close();
  }
});
test("native context limits refuse malformed configuration and total read budget bypasses", async () => {
  for (const extra of [{ checks: 0 }, { maxReadBytes: 1200001 }, { maxTotalBytes: NaN }, { timeoutMs: 0 }])
    await assert.rejects(fixture(extra), /configuration/);
  const f = await fixture({ maxTotalBytes: 1 });
  try {
    assert.equal((await f.validator.validate(f.connector, f.expected)).kind, "bypass");
  } finally {
    await f.validator.close();
  }
});
