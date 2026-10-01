import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { WatchmanTracker } from "../src/executors/cache-watchman.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

interface FixtureOptions {
  configReply?: Record<string, unknown>;
  warningCommand?: string;
  warningAfterStartup?: boolean;
  delayVersionMs?: number;
  delayRepliesMs?: number;
  subscribeReply?: string;
}
async function serverFixture(warnDuringInitialReply: boolean | "disconnect", options: FixtureOptions = {}) {
  const root = await tempDir("cache-watchman-health");
  const socketPath = join(root, "sock");
  let subscription = "",
    initial = true;
  const commands: unknown[] = [];
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    let delay: NodeJS.Timeout | undefined;
    socket.once("close", () => clearTimeout(delay));
    socket.on("data", (bytes: string) => {
      input += bytes;
      let newline: number;
      while ((newline = input.indexOf("\n")) !== -1) {
        const request = JSON.parse(input.slice(0, newline)) as unknown[];
        input = input.slice(newline + 1);
        const command = request[0];
        commands.push(command);
        let response: Record<string, unknown>;
        if (command === "version")
          response = {
            capabilities: Object.fromEntries(
              ["cmd-watch", "cmd-query", "cmd-subscribe", "cmd-clock", "cmd-flush-subscriptions"].map((key) => [
                key,
                true,
              ]),
            ),
          };
        else if (command === "watch") response = { watch: root };
        else if (command === "get-config") response = options.configReply ?? { config: {} };
        else if (command === "subscribe") {
          subscription = request[2] as string;
          response = { subscribe: options.subscribeReply ?? subscription };
          if (options.warningCommand === command) response.warning = "command observation uncertain";
          socket.write(
            `${JSON.stringify(response)}\n${JSON.stringify({
              root,
              subscription,
              clock: "c:1:1:1:1",
              files: [],
              is_fresh_instance: true,
            })}\n`,
          );
          continue;
        } else if (command === "flush-subscriptions") response = { synced: [], no_sync_needed: [subscription] };
        else if (command === "query") {
          response = { clock: "c:1:1:1:1", files: [], is_fresh_instance: initial };
          if (initial && warnDuringInitialReply) {
            const unsolicited =
              warnDuringInitialReply === "disconnect"
                ? "not-json"
                : JSON.stringify({
                    root,
                    subscription,
                    clock: "c:1:1:1:1",
                    files: [],
                    warning: "observation uncertain during startup",
                  });
            socket.write(`${JSON.stringify(response)}\n${unsolicited}\n`);
            initial = false;
            continue;
          }
          initial = false;
        } else throw new Error(`unexpected fake Watchman command: ${command}`);
        if (options.warningCommand === command && (!options.warningAfterStartup || !initial))
          response.warning = "command observation uncertain";
        const delayMs = options.delayRepliesMs ?? (command === "version" ? options.delayVersionMs : 0);
        if (delayMs) delay = setTimeout(() => socket.write(`${JSON.stringify(response)}\n`), delayMs);
        else socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { root, socketPath, commands, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("subscription uncertainty arriving with initial query cannot be overwritten by startup success", async () => {
  const fixture = await serverFixture(true);
  const losses: string[] = [];
  let tracker: WatchmanTracker | undefined;
  try {
    await assert.rejects(async () => {
      tracker = await WatchmanTracker.connect({
        root: fixture.root,
        socketPath: fixture.socketPath,
        onUncertain: (reason) => losses.push(reason),
      });
    }, /Watchman.*startup.*uncertain/);
    assert.ok(losses.some((reason) => reason.includes("observation uncertain during startup")));
  } finally {
    tracker?.close();
    await fixture.close();
  }
});

test("transport loss arriving with initial reply cannot be cleared by startup completion", async () => {
  const fixture = await serverFixture("disconnect");
  const losses: string[] = [];
  let tracker: WatchmanTracker | undefined;
  try {
    await assert.rejects(async () => {
      tracker = await WatchmanTracker.connect({
        root: fixture.root,
        socketPath: fixture.socketPath,
        onUncertain: (reason) => losses.push(reason),
      });
    }, /Watchman.*startup.*uncertain/);
    assert.ok(losses.some((reason) => reason.includes("malformed reply")));
  } finally {
    tracker?.close();
    await fixture.close();
  }
});

for (const command of ["version", "watch", "get-config", "subscribe", "flush-subscriptions"]) {
  test(`Watchman ${command} command warning cannot admit startup`, async () => {
    const fixture = await serverFixture(false, { warningCommand: command });
    let tracker: WatchmanTracker | undefined;
    try {
      await assert.rejects(async () => {
        tracker = await WatchmanTracker.connect({
          root: fixture.root,
          socketPath: fixture.socketPath,
          onUncertain: () => {},
        });
      }, /Watchman/);
    } finally {
      tracker?.close();
      await fixture.close();
    }
  });
}

for (const configReply of [{}, { config: null }, { config: [] }, { config: 1 }, { config: "text" }, { config: true }]) {
  test(`Watchman malformed configuration ${JSON.stringify(configReply)} cannot establish coverage`, async () => {
    const fixture = await serverFixture(false, { configReply });
    let tracker: WatchmanTracker | undefined;
    try {
      await assert.rejects(async () => {
        tracker = await WatchmanTracker.connect({
          root: fixture.root,
          socketPath: fixture.socketPath,
          onUncertain: () => {},
        });
      }, /Watchman.*config/);
    } finally {
      tracker?.close();
      await fixture.close();
    }
  });
}

test("subscription command must acknowledge exactly the requested subscription", async () => {
  const fixture = await serverFixture(false, { subscribeReply: "different-subscription" });
  let tracker: WatchmanTracker | undefined;
  try {
    await assert.rejects(async () => {
      tracker = await WatchmanTracker.connect({
        root: fixture.root,
        socketPath: fixture.socketPath,
        onUncertain: () => {},
      });
    }, /Watchman.*subscription.*acknowledg/);
  } finally {
    tracker?.close();
    await fixture.close();
  }
});

test("flush warning after startup makes an otherwise clean query non-fresh", async () => {
  const fixture = await serverFixture(false, { warningCommand: "flush-subscriptions", warningAfterStartup: true });
  const losses: string[] = [];
  const tracker = await WatchmanTracker.connect({
    root: fixture.root,
    socketPath: fixture.socketPath,
    onUncertain: (reason) => losses.push(reason),
  });
  try {
    assert.equal((await tracker.barrier()).fresh, false);
    assert.ok(losses.some((why) => why.includes("command observation uncertain")));
  } finally {
    tracker.close();
    await fixture.close();
  }
});

for (const startupMs of [0, -1, NaN, Infinity, 30001]) {
  test(`Watchman invalid startup budget ${startupMs} refuses before connecting`, async () => {
    const fixture = await serverFixture(false);
    let tracker: WatchmanTracker | undefined;
    try {
      await assert.rejects(async () => {
        tracker = await WatchmanTracker.connect({
          root: fixture.root,
          socketPath: fixture.socketPath,
          startupMs,
          onUncertain: () => {},
        });
      }, /Watchman.*startupMs/);
    } finally {
      tracker?.close();
      await fixture.close();
    }
  });
}

test("Watchman startup budget bounds delayed handshake and closes its connection", async () => {
  const fixture = await serverFixture(false, { delayVersionMs: 80 });
  let tracker: WatchmanTracker | undefined;
  const started = performance.now();
  try {
    await assert.rejects(async () => {
      tracker = await WatchmanTracker.connect({
        root: fixture.root,
        socketPath: fixture.socketPath,
        startupMs: 20,
        onUncertain: () => {},
      });
    }, /Watchman/);
    assert.ok(performance.now() - started < 70);
  } finally {
    tracker?.close();
    await fixture.close();
  }
});

test("individually fast replies cannot cumulatively exceed the one startup budget", async () => {
  const fixture = await serverFixture(false, { delayRepliesMs: 30 });
  let tracker: WatchmanTracker | undefined;
  const losses: string[] = [];
  try {
    await assert.rejects(async () => {
      tracker = await WatchmanTracker.connect({
        root: fixture.root,
        socketPath: fixture.socketPath,
        startupMs: 100,
        onUncertain: (why) => losses.push(why),
      });
    }, /Watchman/);
    assert.ok(fixture.commands.length < 6, JSON.stringify(fixture.commands));
    assert.ok(
      losses.some((why) => why.includes("timeout")),
      JSON.stringify(losses),
    );
  } finally {
    tracker?.close();
    await fixture.close();
  }
});

test("Watchman startup budget bounds unavailable socket retries", async () => {
  const root = await tempDir("cache-watchman-unavailable");
  const started = performance.now();
  await assert.rejects(
    WatchmanTracker.connect({ root, socketPath: join(root, "absent.sock"), startupMs: 30, onUncertain: () => {} }),
    /Watchman.*startup/,
  );
  assert.ok(performance.now() - started < 100);
});

test("only expected initial subscription snapshot is suppressed during healthy startup", async () => {
  const fixture = await serverFixture(false);
  const losses: string[] = [];
  const tracker = await WatchmanTracker.connect({
    root: fixture.root,
    socketPath: fixture.socketPath,
    onUncertain: (reason) => losses.push(reason),
  });
  try {
    assert.equal((await tracker.barrier()).fresh, true);
    assert.deepEqual(losses, []);
  } finally {
    tracker.close();
    await fixture.close();
  }
});
