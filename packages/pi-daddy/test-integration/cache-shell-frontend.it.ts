import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile, writeFile, unlink, symlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  CacheShellRequestDecoder,
  cacheShellOutput,
  cacheShellExit,
  cacheShellSignal,
  type CacheShellRequest,
} from "../src/kernel/cache-shell-protocol.ts";
import { cleanupTempDirs, tempDir } from "../test/tmp.ts";
after(cleanupTempDirs);
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
async function fixture(handler?: (socket: Socket, invocation: CacheShellRequest) => void, timeout = 500) {
  const dir = await tempDir("cache-shell-frontend"),
    frontend = join(dir, "shell"),
    socketPath = join(dir, "socket");
  await chmod(dir, 0o700);
  await promisify(execFile)("cc", [
    "-static",
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(new URL("../src/executors/native/cache-shell.c", import.meta.url)),
    "-o",
    frontend,
  ]);
  await writeFile(frontend + ".config", `CF1\n/bin/bash\n${socketPath}\n${timeout}\n`, { mode: 0o600 });
  const sockets: Socket[] = [],
    invocations: CacheShellRequest[] = [],
    failures: unknown[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") failures.push(error);
    });
    const decoder = new CacheShellRequestDecoder();
    const receive = (bytes: Buffer) => {
      try {
        const invocation = decoder.feed(bytes);
        if (invocation) {
          socket.off("data", receive);
          invocations.push(invocation);
          handler?.(socket, invocation);
        }
      } catch (error) {
        failures.push(error);
        socket.destroy();
      }
    };
    socket.on("data", receive);
  });
  if (handler) {
    server.listen(socketPath);
    await once(server, "listening");
  }
  async function run(
    command: string,
    extra: { args?: string[]; env?: Record<string, string>; input?: Buffer; closedStdout?: boolean } = {},
  ) {
    const env = extra.env ?? { PATH: "/usr/bin:/bin", LC_ALL: "C", ODD: "'\"\n雪", EMPTY: "" };
    const child = spawn(
      extra.closedStdout ? "/bin/bash" : frontend,
      extra.closedStdout
        ? ["-c", 'exec 1>&-; exec "$1" -c "$2"', "fixture", frontend, command]
        : (extra.args ?? ["-c", command]),
      { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    child.stdout.on("data", (bytes) => {
      stdout.push(bytes);
    });
    child.stderr.on("data", (bytes) => {
      stderr.push(bytes);
    });
    const done = once(child, "close");
    child.stdin.end(extra.input);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [code, signal] = await done;
      return { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), pid: child.pid, env };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    frontend,
    dir,
    run,
    invocations,
    failures,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      assert.deepEqual(failures, []);
    },
  };
}
test(
  "transport descriptors never occupy a closed inherited output descriptor",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const received: Buffer[] = [];
    const f = await fixture((socket) => {
      socket.on("data", (bytes) => {
        received.push(bytes);
        if (bytes.equals(Buffer.from("G")))
          socket.end(Buffer.concat([cacheShellOutput("stdout", Buffer.from("must-not-leak")), cacheShellExit(0)]));
      });
      socket.write("A");
    });
    try {
      const result = await f.run("printf duplicate >> marker", { closedStdout: true });
      assert.equal(result.code, 78);
      assert.match(result.stderr.toString(), /committed output lost/);
      assert.deepEqual(Buffer.concat(received), Buffer.from("G"));
      await assert.rejects(readFile(join(f.dir, "marker")), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  },
);
const markerCommand = "printf ran >> marker; printf 'fallback\\000雪'; printf 'err\\n' >&2; exit 7";
test(
  "native frontend executes original shell exactly once on absent service, refusal and pre-commit loss",
  { skip: !enabled, timeout: 20000 },
  async () => {
    for (const handler of [
      undefined,
      (socket: Socket) => {
        socket.end("B");
      },
      (socket: Socket) => {
        socket.destroy();
      },
    ]) {
      const f = await fixture(handler);
      try {
        const result = await f.run(markerCommand);
        assert.equal(result.code, 7);
        assert.equal(result.signal, null);
        assert.deepEqual(result.stdout, Buffer.from("fallback\0雪"));
        assert.deepEqual(result.stderr, Buffer.from("err\n"));
        assert.equal(await readFile(join(f.dir, "marker"), "utf8"), "ran");
      } finally {
        await f.close();
      }
    }
  },
);
test(
  "explicit coordinator refusal is not converted into optimization bypass",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture((socket) => {
      socket.end("R");
    });
    try {
      const result = await f.run("printf unauthorized >> marker");
      assert.equal(result.code, 126);
      assert.match(result.stderr.toString(), /coordinator rejected.*not attempted/);
      await assert.rejects(readFile(join(f.dir, "marker")), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  },
);
test(
  "native frontend records exact invocation, streams raw framed channels and never runs fallback after G",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const output = Buffer.from([0, 255, 10, 239, 187, 191]),
      error = Buffer.from("original error\0雪"),
      commits: Buffer[] = [];
    const f = await fixture((socket) => {
      socket.once("data", (bytes) => {
        commits.push(bytes);
        const frames = Buffer.concat([
          cacheShellOutput("stdout", output),
          cacheShellOutput("stderr", error),
          cacheShellExit(7),
        ]);
        for (const byte of frames) socket.write(Buffer.from([byte]));
      });
      socket.write("A");
    });
    try {
      const command = "printf forbidden > marker";
      const result = await f.run(command);
      assert.equal(result.code, 7);
      assert.equal(result.signal, null);
      assert.deepEqual(result.stdout, output);
      assert.deepEqual(result.stderr, error);
      assert.deepEqual(commits, [Buffer.from("G")]);
      assert.equal(f.invocations.length, 1);
      assert.equal(f.invocations[0].cwd, f.dir);
      assert.equal(f.invocations[0].shell, "/bin/bash");
      assert.deepEqual(f.invocations[0].args, ["-c", command]);
      assert.deepEqual(
        f.invocations[0].environment,
        Object.entries(result.env).map(([key, value]) => `${key}=${value}`),
      );
      await assert.rejects(readFile(join(f.dir, "marker")), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  },
);
test(
  "post-commit loss and malformed output report uncertainty without duplicate original execution",
  { skip: !enabled, timeout: 20000 },
  async () => {
    for (const reply of [undefined, Buffer.from([79, 0, 0, 16, 1]), Buffer.from([88, 0, 0, 1, 0]), Buffer.from("B")]) {
      const f = await fixture((socket) => {
        socket.once("data", (bytes) => {
          assert.deepEqual(bytes, Buffer.from("G"));
          if (reply) socket.end(reply);
          else socket.destroy();
        });
        socket.write("A");
      });
      try {
        const result = await f.run("printf duplicate >> marker");
        assert.equal(result.code, 78);
        assert.match(result.stderr.toString(), /committed.*(lost|invalid|uncertain)/);
        await assert.rejects(readFile(join(f.dir, "marker")), { code: "ENOENT" });
      } finally {
        await f.close();
      }
    }
  },
);
test(
  "pre-admission deadline bypasses without altering PID, cwd, full environment, stdin or inherited output",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture(() => {}, 20);
    try {
      const command = 'printf \'%s\\n\' "$$" "$PWD" "$ODD" "$EMPTY"; cat; printf err >&2';
      const result = await f.run(command, { input: Buffer.from([0, 255, 10]) });
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.deepEqual(
        result.stdout,
        Buffer.concat([Buffer.from(`${result.pid}\n${f.dir}\n${result.env.ODD}\n\n`), Buffer.from([0, 255, 10])]),
      );
      assert.equal(result.stderr.toString(), "err");
    } finally {
      await f.close();
    }
  },
);
test(
  "unsupported argv bypasses unchanged and does not contact broker",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture(() => {
      throw Error("unsupported argv contacted service");
    });
    try {
      const result = await f.run("unused", { args: ["-c", "printf '%s' \"$0\"", "custom-zero"] });
      assert.equal(result.code, 0);
      assert.equal(result.stdout.toString(), "custom-zero");
      assert.equal(f.invocations.length, 0);
    } finally {
      await f.close();
    }
  },
);
test(
  "static frontend does not run command LD_PRELOAD constructors before original Bash",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const library = join(f.dir, "effect.so"),
        source = join(f.dir, "effect.c"),
        marker = join(f.dir, "effect-marker");
      await writeFile(
        source,
        '#include <unistd.h>\n#include <stdlib.h>\n#include <fcntl.h>\n__attribute__((constructor)) static void effect(void) { const char *p=getenv("LD_EFFECT"); if(p){int fd=open(p,O_WRONLY|O_APPEND|O_CREAT,0600); if(fd>=0){write(fd,"x",1);close(fd);}} }\n',
      );
      await promisify(execFile)("cc", ["-shared", "-fPIC", "-Wall", "-Wextra", "-Werror", source, "-o", library]);
      const result = await f.run("printf done; exit 7", {
        env: { PATH: "/usr/bin:/bin", LD_PRELOAD: library, LD_EFFECT: marker },
      });
      assert.equal(result.code, 7);
      assert.equal(result.stdout.toString(), "done");
      assert.equal(result.stderr.length, 0);
      assert.equal(
        await readFile(marker, "utf8"),
        "x",
        "only original Bash, not an extra frontend loader, runs the constructor",
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "native terminal signals preserve signal status rather than fabricated normal exits",
  { skip: !enabled, timeout: 10000 },
  async () => {
    for (const [number, signal] of [
      [15, "SIGTERM"],
      [9, "SIGKILL"],
    ] as const) {
      const f = await fixture((socket) => {
        socket.once("data", () => {
          socket.end(cacheShellSignal(number));
        });
        socket.write("A");
      });
      try {
        const result = await f.run("printf duplicate >> marker");
        assert.equal(result.code, null);
        assert.equal(result.signal, signal);
        await assert.rejects(readFile(join(f.dir, "marker")), { code: "ENOENT" });
      } finally {
        await f.close();
      }
    }
  },
);
test(
  "private sidecar is mandatory and malformed/unsafe configuration cannot invent a shell",
  { skip: !enabled, timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      for (const content of [
        "CF2\n/bin/bash\n/tmp/s\n50\n",
        "CF1\nbash\n/tmp/s\n50\n",
        "CF1\n/bin/bash\n/tmp/s\n0\n",
        "CF1\n/bin/bash\n/tmp/s\n50\nextra\n",
      ]) {
        await writeFile(f.frontend + ".config", content);
        const result = await f.run("printf duplicate >> marker");
        assert.equal(result.code, 78);
        assert.match(result.stderr.toString(), /configuration/);
      }
      await writeFile(f.frontend + ".config", `CF1\n/bin/bash\n/tmp/s\n50\n`);
      await chmod(f.frontend + ".config", 0o644);
      assert.equal((await f.run("printf duplicate >> marker")).code, 78);
      await unlink(f.frontend + ".config");
      assert.equal((await f.run("printf duplicate >> marker")).code, 78);
      await symlink("/dev/null", f.frontend + ".config");
      assert.equal((await f.run("printf duplicate >> marker")).code, 78);
      await unlink(f.frontend + ".config");
      await promisify(execFile)("mkfifo", [f.frontend + ".config"]);
      assert.equal((await f.run("printf duplicate >> marker")).code, 78);
      await assert.rejects(readFile(join(f.dir, "marker")), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  },
);
