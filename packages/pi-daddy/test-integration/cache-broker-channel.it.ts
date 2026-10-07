import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CacheBrokerChannel, type CacheBrokerPeer } from "../src/executors/cache-broker-channel.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { startSupervisedCache, type CacheSupervisorHandle } from "../src/executors/cache-supervisor.ts";
import { cleanupTempDirs, tempDir } from "../test/tmp.ts";
after(cleanupTempDirs);
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
async function wait(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("Node broker fixture deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture() {
  const dir = await tempDir("cache-broker-channel"),
    binary = join(dir, "broker"),
    path = join(dir, "socket");
  await chmod(dir, 0o700);
  await promisify(execFile)("cc", [
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(new URL("../src/executors/native/cache-broker.c", import.meta.url)),
    "-o",
    binary,
  ]);
  const owner = await readCacheOwner(process.pid),
    peers: CacheBrokerPeer[] = [],
    bytes: Buffer[] = [],
    closed: CacheBrokerPeer[] = [],
    sockets: Socket[] = [];
  let authorized = true,
    diagnostics = "",
    handle: CacheSupervisorHandle | undefined;
  let admission: Promise<CacheSupervisorHandle>;
  const channel = new CacheBrokerChannel({
    write: (line) => {
      assert.ok(handle, "private writer available only after owned admission");
      handle.process.stdin.write(line);
    },
    stop: async () => {
      await (await admission).stop();
    },
    authorize: (actual) =>
      authorized &&
      actual.pid === owner.pid &&
      actual.bootId === owner.bootId &&
      actual.startTicks === owner.startTicks,
    onPeer: (peer) => {
      peers.push(peer);
    },
    onData: (_peer, data) => {
      bytes.push(data);
    },
    onClosed: (peer) => {
      closed.push(peer);
    },
    deadlineMs: 2000,
  });
  admission = startSupervisedCache({
    owner,
    entry: new URL("./cache-broker-entry.mjs", import.meta.url),
    args: [binary, path],
    onData: (stream, data) => {
      if (stream === "stdout") channel.feed(data);
      else diagnostics = (diagnostics + data.toString()).slice(-8192);
    },
  });
  try {
    handle = await admission;
    await channel.ready;
  } catch (error) {
    await channel.shutdown().catch((cleanup) => {
      throw new AggregateError([error, cleanup], "broker fixture startup failed");
    });
    throw error;
  }
  handle.process.stdout.on("end", () => channel.end());
  handle.process.stdout.on("error", (error) => channel.end(error));
  handle.process.stdin.on("error", (error) => channel.end(error));
  async function connect() {
    const socket = createConnection(path);
    sockets.push(socket);
    await once(socket, "connect");
    return socket;
  }
  return {
    channel,
    peers,
    bytes,
    closed,
    handle,
    connect,
    revoke: () => {
      authorized = false;
    },
    diagnostics: () => diagnostics,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await channel.shutdown();
    },
  };
}
test(
  "Node CP1 channel and real namespace bridge preserve raw bytes and bound original process birth",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const socket = await f.connect();
      await wait(() => f.peers.length === 1);
      assert.deepEqual(f.peers[0].identity, await readCacheOwner(process.pid));
      const input = Buffer.alloc(12000);
      for (let i = 0; i < input.length; i++) input[i] = i % 256;
      socket.write(input);
      await wait(() => Buffer.concat(f.bytes).length === input.length);
      assert.deepEqual(Buffer.concat(f.bytes), input);
      assert.ok(f.bytes.every((chunk) => chunk.length <= 4096));
      const received: Buffer[] = [];
      socket.on("data", (data) => {
        received.push(data);
      });
      for (const chunk of [input.subarray(0, 4096), input.subarray(4096, 8192), input.subarray(8192)])
        await f.peers[0].send(chunk);
      await wait(() => Buffer.concat(received).length === input.length);
      assert.deepEqual(Buffer.concat(received), input);
      const closed = once(socket, "close");
      f.peers[0].close();
      await closed;
      assert.equal(f.closed.length, 1);
      await f.channel.shutdown();
      assert.notEqual((await f.handle.stopped).code, undefined);
    } finally {
      await f.close();
    }
  },
);
test(
  "current authorization revocation closes real peer without dispatching its queued application bytes",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const socket = await f.connect();
      await wait(() => f.peers.length === 1);
      const closed = once(socket, "close");
      f.revoke();
      socket.write("claimed_root_role=anything");
      await closed;
      assert.equal(f.bytes.length, 0);
      assert.equal(f.closed.length, 1);
      await assert.rejects(f.peers[0].send(Buffer.from("private-result")), /authoriz|closed/);
      const stranger = await f.connect();
      const denied = once(stranger, "close");
      await denied;
      assert.equal(f.peers.length, 1, "claimed IDs never authorize a new peer");
    } finally {
      await f.close();
    }
  },
);
test(
  "unexpected native control EOF faults Node channel and rejects all further delivery",
  { skip: !enabled, timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const socket = await f.connect();
      await wait(() => f.peers.length === 1);
      const closed = once(socket, "close");
      f.handle.process.stdin.end();
      await closed;
      await wait(() => f.handle.process.stdout.readableEnded);
      await assert.rejects(f.channel.shutdown(), /control.*EOF/);
      await assert.rejects(f.peers[0].send(Buffer.from("x")), /closed|authoriz/);
      assert.equal((await f.handle.stopped).code, 0, f.diagnostics());
    } finally {
      await f.close().catch((error) => {
        assert.match(String(error), /control.*EOF/);
      });
    }
  },
);
