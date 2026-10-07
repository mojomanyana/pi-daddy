import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { startSupervisedCache } from "../src/executors/cache-supervisor.ts";
import { cleanupTempDirs, tempDir } from "../test/tmp.ts";
after(cleanupTempDirs);
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
async function fixture(terminalFault = false) {
  const dir = await tempDir("cache-broker"),
    binary = join(dir, "broker"),
    socketPath = join(dir, "socket");
  await chmod(dir, 0o700);
  await promisify(execFile)("cc", [
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(
      new URL(terminalFault ? "./cache-broker-flush.c" : "../src/executors/native/cache-broker.c", import.meta.url),
    ),
    "-o",
    binary,
  ]);
  let partial = "",
    rows: string[] = [],
    waiters: Array<{ test: (line: string) => boolean; resolve: (line: string) => void }> = [],
    diagnostics = "";
  const handle = await startSupervisedCache({
    owner: await readCacheOwner(process.pid),
    entry: new URL("./cache-broker-entry.mjs", import.meta.url),
    args: [binary, socketPath],
    onData: (stream, bytes) => {
      if (stream === "stderr") {
        diagnostics += bytes.toString();
        return;
      }
      partial += bytes.toString();
      for (;;) {
        const end = partial.indexOf("\n");
        if (end < 0) break;
        const line = partial.slice(0, end);
        partial = partial.slice(end + 1);
        const index = waiters.findIndex((row) => row.test(line));
        if (index < 0) rows.push(line);
        else waiters.splice(index, 1)[0].resolve(line);
      }
    },
  });
  async function row(predicate: (line: string) => boolean) {
    const index = rows.findIndex(predicate);
    if (index >= 0) return rows.splice(index, 1)[0];
    let waiter: (typeof waiters)[number];
    let timer: NodeJS.Timeout;
    return new Promise<string>((resolve, reject) => {
      waiter = {
        test: predicate,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      };
      waiters.push(waiter);
      timer = setTimeout(() => {
        waiters = waiters.filter((v) => v !== waiter);
        reject(Error(`broker frame deadline; ${diagnostics}`));
      }, 2000);
    });
  }
  const sockets: Socket[] = [];
  async function connect() {
    const socket = createConnection(socketPath);
    sockets.push(socket);
    await once(socket, "connect");
    const opened = await row((line) => line.startsWith("CP1 OPEN "));
    const [, , id, pid] = opened.split(" ");
    assert.equal(Number(pid), process.pid, "identity comes from peer pidfd, not claimed metadata");
    return { socket, id };
  }
  await row((line) => line === "CP1 READY");
  return {
    handle,
    socketPath,
    connect,
    row,
    rows,
    send: (line: string) => handle.process.stdin.write(line + "\n"),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await handle.stop();
    },
  };
}
test(
  "namespace broker binds ancestor peer and gates byte delivery on live kernel verification",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const { socket, id } = await f.connect();
      socket.write("claimed_pid=1\n雪");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(!f.rows.some((line) => line.startsWith(`CP1 DATA ${id} `)));
      f.send(`CP1 VERIFY ${id} ${process.pid}`);
      await f.row((line) => line === `CP1 VERIFIED ${id} ${process.pid}`);
      const data = await f.row((line) => line.startsWith(`CP1 DATA ${id} `));
      assert.equal(Buffer.from(data.split(" ")[3], "hex").toString(), "claimed_pid=1\n雪");
      const reply = Buffer.from("unchanged\0stderr\n雪");
      const received = once(socket, "data");
      f.send(`CP1 SEND ${id} ${reply.toString("hex")}`);
      assert.deepEqual((await received)[0], reply);
      await f.row((line) => line === `CP1 SENT ${id} ${reply.length}`);
      f.send(`CP1 CLOSE ${id}`);
      await f.row((line) => line === `CP1 CLOSED ${id}`);
    } finally {
      await f.close();
    }
  },
);
test(
  "connecting process death releases its peer even when a different process holds the socket",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture();
    let retained: Socket | undefined;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {createConnection} from 'node:net'; const socket=createConnection(process.argv[1]); socket.on('connect',()=>process.send({ready:true},socket,{keepOpen:false},()=>process.stdin.resume())); process.stdin.on('end',()=>process.exit(0));`,
        f.socketPath,
      ],
      { stdio: ["pipe", "ignore", "pipe", "ipc"] },
    );
    const stopped = once(child, "close");
    try {
      const [message, handle] = await once(child, "message");
      assert.deepEqual(message, { ready: true });
      retained = handle as Socket;
      const opened = await f.row((line) => line.startsWith("CP1 OPEN "));
      const [, , id, pid] = opened.split(" ");
      assert.equal(Number(pid), child.pid);
      f.send(`CP1 VERIFY ${id} ${child.pid}`);
      await f.row((line) => line === `CP1 VERIFIED ${id} ${child.pid}`);
      assert.ok(child.stdin, "fixture explicitly owns the child's piped stdin");
      child.stdin.end();
      await stopped;
      await f.row((line) => line === `CP1 CLOSED ${id}`);
    } finally {
      retained?.destroy();
      child.kill("SIGKILL");
      await stopped;
      await f.close();
    }
  },
);

test(
  "broker output chunk limit fails closed rather than buffering unbounded bytes",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const { id } = await f.connect();
      f.send(`CP1 VERIFY ${id} ${process.pid}`);
      await f.row((line) => line === `CP1 VERIFIED ${id} ${process.pid}`);
      f.send(`CP1 SEND ${id} ${Buffer.alloc(4097, 1).toString("hex")}`);
      assert.equal((await f.handle.stopped).code, 78);
    } finally {
      await f.close();
    }
  },
);

test(
  "terminal control-output failure is not reported as successful shutdown",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture(true);
    try {
      await f.connect();
      f.handle.process.stdin.end();
      assert.equal((await f.handle.stopped).code, 78);
    } finally {
      await f.close();
    }
  },
);

test("trusted control EOF closes transport and peer connections", { skip: !enabled, timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const { socket } = await f.connect();
    const closed = once(socket, "close");
    f.handle.process.stdin.end();
    await closed;
    assert.equal((await f.handle.stopped).code, 0);
  } finally {
    await f.close();
  }
});

test(
  "wrong peer identity closes only that connection; protocol mismatch shuts transport without executing",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const first = await f.connect();
      f.send(`CP1 VERIFY ${first.id} ${process.pid + 1}`);
      await f.row((line) => line === `CP1 CLOSED ${first.id}`);
      const second = await f.connect();
      assert.notEqual(second.id, first.id);
      f.send(`CP2 VERIFY ${second.id} ${process.pid}`);
      const result = await f.handle.stopped;
      assert.equal(result.code, 78);
    } finally {
      await f.close();
    }
  },
);
