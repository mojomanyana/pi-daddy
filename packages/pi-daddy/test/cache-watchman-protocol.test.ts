import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { WatchmanConnection } from "../src/executors/cache-watchman-protocol.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("Watchman JSON replies and subscriptions remain distinct under split packets", async () => {
  const dir = await tempDir("cache-watchman-wire");
  const path = join(dir, "sock");
  const server = createServer((socket) => {
    socket.on("data", () => {
      socket.write('{"subscription":"s","clock":"c:1","files":[]}\n{"ver');
      socket.write('sion":"4.9.0"}\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const events: unknown[] = [],
    losses: string[] = [];
  const client = await WatchmanConnection.connect(
    path,
    (event) => events.push(event),
    (why) => losses.push(why),
  );
  try {
    assert.deepEqual(await client.command(["version"]), { version: "4.9.0" });
    assert.equal(events.length, 1);
    assert.equal(losses.length, 0);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const response of ['{"error":"no such capability"}\n', "not-json\n", '{"a":"' + "x".repeat(256) + '"}\n']) {
  test(`Watchman error, malformed or over-limit replies cannot establish freshness: ${response.slice(0, 35)}`, async () => {
    const dir = await tempDir("cache-watchman-bad");
    const path = join(dir, "sock");
    const server = createServer((socket) => socket.on("data", () => socket.write(response)));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const losses: string[] = [];
    const client = await WatchmanConnection.connect(
      path,
      () => {},
      (why) => losses.push(why),
      { maxMessageBytes: 128 },
    );
    try {
      await assert.rejects(client.command(["version"]), /Watchman/);
      if (!response.includes('"error"')) assert.equal(losses.length, 1);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

for (const payload of [
  { error: 7 },
  { error: { message: "corrupt" } },
  { subscription: "scope", error: "subscription lost", clock: "c:1", files: [] },
]) {
  test(`Watchman error discriminator cannot silently succeed: ${JSON.stringify(payload)}`, async () => {
    const dir = await tempDir("cache-watchman-error-field");
    const path = join(dir, "sock");
    const server = createServer((socket) => socket.on("data", () => socket.write(`${JSON.stringify(payload)}\n`)));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const losses: string[] = [];
    const client = await WatchmanConnection.connect(
      path,
      () => {},
      (why) => losses.push(why),
      { timeoutMs: 50 },
    );
    try {
      await assert.rejects(client.command(["query"]), /Watchman.*(malformed error|subscription refused)/);
      assert.equal(losses.length, 1);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

for (const bad of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xe2, 0x82])]) {
  test(`Watchman invalid UTF-8 ${bad.toString("hex")} cannot become a successful observation`, async () => {
    const dir = await tempDir("cache-watchman-utf8");
    const path = join(dir, "sock");
    const server = createServer((socket) =>
      socket.on("data", () =>
        socket.write(
          Buffer.concat([Buffer.from('{"clock":"c:1","files":[{"name":"'), bad, Buffer.from('","exists":true}]}\n')]),
        ),
      ),
    );
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const losses: string[] = [];
    const client = await WatchmanConnection.connect(
      path,
      () => {},
      (why) => losses.push(why),
    );
    try {
      await assert.rejects(client.command(["query"]), /Watchman.*UTF-8/);
      assert.equal(losses.length, 1);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("valid split multibyte filename survives Watchman packet boundaries exactly", async () => {
  const dir = await tempDir("cache-watchman-split-utf8");
  const path = join(dir, "sock");
  const response = Buffer.from(`${JSON.stringify({ files: [{ name: "test-🧪.ts", exists: true }] })}\n`);
  const split = response.indexOf(Buffer.from("🧪")) + 2;
  const server = createServer((socket) =>
    socket.on("data", () => {
      socket.write(response.subarray(0, split));
      setTimeout(() => socket.write(response.subarray(split)), 5);
    }),
  );
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const losses: string[] = [];
  const client = await WatchmanConnection.connect(
    path,
    () => {},
    (why) => losses.push(why),
  );
  try {
    assert.deepEqual(await client.command(["query"]), { files: [{ name: "test-🧪.ts", exists: true }] });
    assert.deepEqual(losses, []);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Watchman response timeout invalidates transport instead of shifting late responses to later requests", async () => {
  const dir = await tempDir("cache-watchman-timeout");
  const path = join(dir, "sock");
  const server = createServer((socket) => socket.resume());
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const losses: string[] = [];
  const client = await WatchmanConnection.connect(
    path,
    () => {},
    (why) => losses.push(why),
    { timeoutMs: 20 },
  );
  try {
    await assert.rejects(client.command(["query"]), /Watchman.*timeout/);
    await assert.rejects(client.command(["query"]), /Watchman.*unavailable/);
    assert.equal(losses.length, 1);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
