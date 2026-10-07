import assert from "node:assert/strict";
import { after, test } from "node:test";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { BoundedReadCleanupError, readBoundedFile } from "../src/kernel/bounded-read.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);
import { CacheBrokerChannel, type CacheBrokerPeer } from "../src/executors/cache-broker-channel.ts";
const identity = { pid: 123, bootId: "927c7116-1149-4220-a967-a1cd8328bb9d", startTicks: "789" };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(extra: Record<string, unknown> = {}) {
  const writes: string[] = [],
    peers: CacheBrokerPeer[] = [],
    received: Buffer[] = [],
    closed: CacheBrokerPeer[] = [];
  let authorized = true,
    stopped = 0;
  const channel = new CacheBrokerChannel({
    write: (line: string) => {
      writes.push(line);
    },
    stop: async () => {
      stopped++;
    },
    identify: async () => identity,
    authorize: (owner: typeof identity) => authorized && owner.startTicks === identity.startTicks,
    onPeer: (peer: CacheBrokerPeer) => {
      peers.push(peer);
    },
    onData: (_peer: CacheBrokerPeer, bytes: Buffer) => {
      received.push(bytes);
    },
    onClosed: (peer: CacheBrokerPeer) => {
      closed.push(peer);
    },
    deadlineMs: 100,
    ...extra,
  });
  const feed = (text: string) => channel.feed(Buffer.from(text));
  feed("CP1 READY\n");
  const open = async () => {
    feed("CP1 OPEN 1 123\n");
    await turn();
    feed("CP1 VERIFIED 1 123\n");
    return peers[0];
  };
  return {
    channel,
    writes,
    peers,
    received,
    closed,
    feed,
    open,
    revoke: () => {
      authorized = false;
    },
    stopped: () => stopped,
  };
}
test("CP1 adapter binds actual birth identity and delivers byte-exact data only after verification", async () => {
  const f = fixture();
  await f.channel.ready;
  f.feed("CP1 OPEN 1 123\n");
  assert.equal(f.peers.length, 0);
  await turn();
  assert.deepEqual(f.writes, ["CP1 VERIFY 1 123\n"]);
  f.feed("CP1 VER");
  f.feed("IFIED 1 123\nCP1 DATA 1 e99baa00ff\n");
  assert.deepEqual(f.peers[0].identity, identity);
  assert.deepEqual(f.received, [Buffer.from("e99baa00ff", "hex")]);
  const reply = f.peers[0].send(Buffer.from("aa00", "hex"));
  assert.equal(f.writes.at(-1), "CP1 SEND 1 aa00\n");
  f.feed("CP1 SENT 1 2\n");
  await reply;
  await f.channel.shutdown();
  assert.equal(f.stopped(), 1);
  assert.equal(f.closed.length, 1);
});
test("current authority is checked after identity waits, at data, send and acknowledgement", async () => {
  let release!: (value: typeof identity) => void;
  const f = fixture({
    identify: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  f.feed("CP1 OPEN 1 123\n");
  f.revoke();
  release(identity);
  await turn();
  assert.deepEqual(f.writes, ["CP1 CLOSE 1\n"]);
  assert.equal(f.peers.length, 0);
  await f.channel.shutdown();
  const data = fixture();
  await data.open();
  data.revoke();
  data.feed("CP1 DATA 1 ff\n");
  assert.equal(data.received.length, 0);
  assert.equal(data.writes.at(-1), "CP1 CLOSE 1\n");
  await assert.rejects(data.peers[0].send(Buffer.from("x")), /closed|authoriz/);
  await data.channel.shutdown();
  const send = fixture();
  const p = await send.open();
  const pending = p.send(Buffer.from("x"));
  send.revoke();
  send.feed("CP1 SENT 1 1\n");
  await assert.rejects(pending, /authoriz/);
  await send.channel.shutdown();
  const pre = fixture();
  const peer = await pre.open();
  pre.revoke();
  await assert.rejects(peer.send(Buffer.from("x")), /authoriz/);
  assert.ok(!pre.writes.some((line) => line.includes("SEND")));
  await pre.channel.shutdown();
});
test("peer send credit is bounded and byte counts must match; disconnect rejects delivery", async () => {
  const f = fixture();
  const peer = await f.open();
  await assert.rejects(peer.send(Buffer.alloc(4097)), /chunk/);
  await assert.rejects(peer.send(Buffer.alloc(0)), /chunk/);
  const pending = peer.send(Buffer.alloc(4096, 1));
  await assert.rejects(peer.send(Buffer.from("x")), /outstanding/);
  f.feed("CP1 CLOSED 1\n");
  await assert.rejects(pending, /closed/);
  await f.channel.shutdown();
  assert.equal(f.closed.length, 1);
  const mismatch = fixture();
  const p = await mismatch.open();
  const task = p.send(Buffer.from("xy"));
  mismatch.feed("CP1 SENT 1 1\n");
  await assert.rejects(task, /protocol/);
  await assert.rejects(mismatch.channel.shutdown(), /protocol/);
});
test("deadline never retries an ambiguously delivered send", async () => {
  const f = fixture({ deadlineMs: 5 });
  const peer = await f.open();
  await assert.rejects(peer.send(Buffer.from("x")), /deadline/);
  assert.equal(f.writes.filter((line) => line.includes("SEND")).length, 1);
  assert.equal(f.writes.at(-1), "CP1 CLOSE 1\n");
  await f.channel.shutdown();
});
test("closed or denied identities never become peers; shutdown joins late identity acquisition", async () => {
  let release!: (value: typeof identity) => void;
  const f = fixture({
    identify: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  f.feed("CP1 OPEN 1 123\nCP1 CLOSED 1\n");
  let settled = false;
  const stopping = f.channel.shutdown().then(() => {
    settled = true;
  });
  await turn();
  assert.equal(settled, false);
  release(identity);
  await stopping;
  assert.equal(f.peers.length, 0);
  assert.ok(!f.writes.some((line) => line.includes("VERIFY")));
  const denied = fixture({ identify: async () => ({ ...identity, startTicks: "different" }) });
  denied.feed("CP1 OPEN 1 123\n");
  await turn();
  assert.deepEqual(denied.writes, ["CP1 CLOSE 1\n"]);
  await denied.channel.shutdown();
});
test("identity read failure and wrong PID close connection without creating authority", async () => {
  for (const identify of [
    async () => {
      throw Error("cache owner unavailable");
    },
    async () => ({ ...identity, pid: 999 }),
  ]) {
    const f = fixture({ identify });
    f.feed("CP1 OPEN 1 123\n");
    await turn();
    assert.deepEqual(f.writes, ["CP1 CLOSE 1\n"]);
    assert.equal(f.peers.length, 0);
    await f.channel.shutdown();
  }
});
test("identity descriptor close failure faults the channel and survives shutdown and explicit reader retry", async () => {
  const dir = await tempDir("broker-reader-close"),
    path = join(dir, "identity");
  await writeFile(path, "identity observation");
  let handle: FileHandle | undefined,
    failure: BoundedReadCleanupError | undefined,
    closes = 0;
  const f = fixture({
    identify: async () => {
      try {
        await readBoundedFile(
          path,
          { maxBytes: 128, timeoutMs: 1000 },
          {
            async open(name, flags) {
              handle = await open(name, flags);
              return handle;
            },
            read: (fd, buffer, offset, length, position) => fd.read(buffer, offset, length, position),
            async close(fd) {
              if (++closes === 1) throw Object.assign(Error("close failed"), { code: "ENOENT" });
              await fd.close();
            },
          },
        );
      } catch (error) {
        assert.ok(error instanceof BoundedReadCleanupError);
        failure = error;
        throw error;
      }
      return identity;
    },
  });
  try {
    f.feed("CP1 OPEN 1 123\n");
    await turn();
    // Acquisition uses real I/O, so join its owned task rather than assuming one event-loop turn suffices.
    await assert.rejects(
      f.channel.shutdown(),
      (error) => error instanceof AggregateError && error.errors.includes(failure),
    );
    assert.ok(failure);
    assert.ok(handle && (await handle.stat()).isFile());
    assert.equal(closes, 1);
    await failure.cleanup();
    assert.equal(handle.fd, -1);
    await assert.rejects(
      f.channel.shutdown(),
      (error) => error instanceof AggregateError && error.errors.includes(failure),
    );
    f.feed("CP1 OPEN 2 123\nCP1 VERIFIED 2 123\n");
    assert.equal(f.peers.length, 0, "reader recovery cannot revive channel admission");
    assert.equal(f.stopped(), 1);
  } finally {
    if (failure) await failure.cleanup();
    else if (handle && handle.fd !== -1) await handle.close();
  }
});

test("protocol corruption is loud, stops admission and joins cleanup", async () => {
  for (const frame of [
    "CP2 READY\n",
    "CP1 READY\n",
    "CP1 DATA 1 aa\n",
    "CP1 OPEN 01 123\n",
    "CP1 OPEN 1 0\n",
    "CP1 CLOSED 99\n",
    "CP1 DATA 1 FF\n",
    "x".repeat(8257),
    "CP1 OPEN 1 123\0\n",
  ]) {
    const f = fixture();
    f.feed(frame);
    await assert.rejects(f.channel.shutdown(), /protocol/);
    assert.equal(f.stopped(), 1);
  }
});
test("unverified data, duplicate IDs and mismatched VERIFIED fail closed", async () => {
  for (const frame of ["CP1 DATA 1 aa\n", "CP1 OPEN 1 123\n", "CP1 VERIFIED 1 124\n"]) {
    const f = fixture();
    f.feed("CP1 OPEN 1 123\n");
    f.feed(frame);
    await assert.rejects(f.channel.shutdown(), /protocol/);
    assert.equal(f.received.length, 0);
  }
});
test("pending identity owners stay charged after socket close; peer bounds cannot be churned away", async () => {
  const releases: Array<() => void> = [];
  const f = fixture({
    identify: () =>
      new Promise((resolve) => {
        releases.push(() => resolve(identity));
      }),
  });
  for (let id = 1; id <= 32; id++) f.feed(`CP1 OPEN ${id} 123\nCP1 CLOSED ${id}\n`);
  f.feed("CP1 OPEN 33 123\n");
  const stopping = f.channel.shutdown();
  for (const release of releases) release();
  await assert.rejects(stopping, /bound/);
  assert.equal(releases.length, 32);
});
test("write, callback and cleanup failures retain a rejected shutdown rather than inventing success", async () => {
  const f = fixture({
    write: () => {
      throw Error("pipe unavailable");
    },
  });
  f.feed("CP1 OPEN 1 123\n");
  await turn();
  await assert.rejects(f.channel.shutdown(), /pipe unavailable/);
  const callback = fixture({
    onData: () => {
      throw Error("RPC decoder unavailable");
    },
  });
  await callback.open();
  callback.feed("CP1 DATA 1 aa\n");
  await assert.rejects(callback.channel.shutdown(), /RPC decoder/);
  const cleanup = fixture({
    stop: async () => {
      throw Error("termination unresolved");
    },
  });
  await assert.rejects(cleanup.channel.shutdown(), /cleanup unresolved/);
  await assert.rejects(cleanup.channel.shutdown(), /cleanup unresolved/);
});
test("shutdown callbacks cannot start duplicate cleanup through reentrancy", async () => {
  let channel!: CacheBrokerChannel;
  const f = fixture({
    onClosed: () => {
      void channel.shutdown().catch(() => {});
    },
  });
  channel = f.channel;
  await f.open();
  const stopping = channel.shutdown();
  assert.equal(channel.shutdown(), stopping);
  await stopping;
  assert.equal(f.stopped(), 1);
});
test("unexpected control EOF and incomplete frames cannot be accepted as a normal terminal state", async () => {
  const f = fixture();
  await f.open();
  f.feed("CP1 DA");
  f.channel.end();
  await assert.rejects(f.channel.shutdown(), /control.*(EOF|incomplete)/);
});
