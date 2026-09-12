import assert from "node:assert/strict";
import { createServer } from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("timed out waiting for local lifecycle reports");
}

test("the pinned Herdr Pi integration reports native start/settled lifecycle and registers no tools", async () => {
  const socket = join(tmpdir(), `pi-daddy-herdr-lifecycle-${process.pid}-${Date.now()}.sock`);
  const reports: any[] = [];
  const server = createServer((connection) => connection.on("data", (bytes) => {
    reports.push(JSON.parse(bytes.toString()));
    connection.write('{"result":{}}\n');
  }));
  await new Promise<void>((resolve, reject) => server.listen(socket, () => resolve()).once("error", reject));
  const original = { HERDR_ENV: process.env.HERDR_ENV, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w1:p9" });

  try {
    const handlers = new Map<string, Function>();
    const blocked = new Map<string, Function>();
    const registeredTools: unknown[] = [];
    const pi = {
      on: (event: string, handler: Function) => handlers.set(event, handler),
      events: { on: (event: string, handler: Function) => blocked.set(event, handler) },
      registerTool: (...args: unknown[]) => registeredTools.push(args),
    };
    const module = await import(`${new URL("../src/vendor/herdr-pi-lifecycle.ts", import.meta.url).href}?socket=${encodeURIComponent(socket)}`);
    module.default(pi);
    assert.ok(handlers.has("session_start"), "the extension activates only for this Herdr child pane");
    await handlers.get("session_start")!({}, { mode: "tui", isIdle: () => true });
    await eventually(() => reports.filter((report) => report.method === "pane.report_agent").length === 1);
    handlers.get("agent_start")!({}, { sessionManager: {} });
    await eventually(() => reports.filter((report) => report.method === "pane.report_agent").length === 2);
    handlers.get("agent_settled")!({}, { isIdle: () => true });
    await eventually(() => reports.filter((report) => report.method === "pane.report_agent").length === 3);

    assert.deepEqual(reports.filter((report) => report.method === "pane.report_agent").map((report) => report.params.state), ["idle", "working", "idle"]);
    assert.equal(registeredTools.length, 0, "the official lifecycle integration has no child tools");
    assert.ok(blocked.has("herdr:blocked"), "the only additional hook is lifecycle blocking state");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socket, { force: true });
  }
});
