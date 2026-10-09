import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { herdrAgentDisplay } from "../src/executors/herdr-agent-display.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);

test("sidebar lifecycle and role metadata are ordered, scoped, and distinguish unknown cleanup", async (t) => {
  const path = join(await tempDir("pd-sidebar-"), "ui.sock");
  const requests: any[] = [];
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (bytes) => {
      input += bytes.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input);
      requests.push(request);
      // A split response ensures we wait for a complete frame, not just any received byte.
      const reply = JSON.stringify({ id: request.id, result: {} }) + "\n";
      socket.write(reply.slice(0, 5));
      socket.end(reply.slice(5));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const display = herdrAgentDisplay(
    { source: "pi-daddy:test", role: "review" },
    { HERDR_ENV: "1", HERDR_SOCKET_PATH: path, HERDR_PANE_ID: "owned-pane" },
  );
  const started = display.working();
  const finished = display.finish(true);
  assert.equal(await started, true);
  assert.equal(await finished, true);
  assert.deepEqual(
    requests.map((r) => [r.method, r.params.seq]),
    [
      ["pane.report_agent", 1],
      ["pane.report_metadata", 1],
      ["pane.release_agent", 2],
    ],
  );
  for (const request of requests) {
    assert.equal(request.params.pane_id, "owned-pane");
    assert.equal(request.params.source, "pi-daddy:test");
    assert.equal(request.params.agent, "pi");
  }
  assert.equal(requests[0].params.state, "working");
  assert.equal(requests[1].params.applies_to_source, "pi-daddy:test");
  assert.equal(requests[1].params.title, "review");
  assert.equal(requests[1].params.display_agent, "Pi / review");

  const uncertain = herdrAgentDisplay(
    { source: "pi-daddy:uncertain", role: "build" },
    { HERDR_ENV: "1", HERDR_SOCKET_PATH: path, HERDR_PANE_ID: "other-owned-pane" },
  );
  await uncertain.working();
  await uncertain.finish(false);
  assert.equal(requests.at(-1).method, "pane.report_agent");
  assert.equal(requests.at(-1).params.state, "unknown");
  assert.equal(requests.at(-1).params.message, "Native cleanup is unverified");
});

test("missing or rejected sidebar delivery remains a failed observation, not an execution exception", async (t) => {
  const path = join(await tempDir("pd-sidebar-failure-"), "ui.sock");
  const warnings: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => warnings.push(args));
  const absent = herdrAgentDisplay({ source: "pi-daddy:absent", role: "plan" }, {});
  assert.equal(await absent.working(), false);
  assert.equal(await absent.finish(true), false);
  assert.equal(warnings.length, 0);
  const server = createServer((socket) => {
    socket.on("data", (bytes) => {
      const request = JSON.parse(bytes.toString());
      socket.end(JSON.stringify({ id: request.id, error: { message: "Unavailable" } }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const rejected = herdrAgentDisplay(
    { source: "pi-daddy:rejected", role: "plan" },
    { HERDR_ENV: "1", HERDR_SOCKET_PATH: path, HERDR_PANE_ID: "owned-pane" },
  );
  assert.equal(await rejected.working(), false);
  assert.equal(await rejected.finish(true), false);
  assert.ok(warnings.length > 0);
});
