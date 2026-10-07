import { BoundedReadCleanupError } from "../src/kernel/bounded-read.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChildFinalCapture } from "../src/executors/child-final.ts";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);
const visible = "  complete first\nsecond\u2028third\u2029  ";
const header = {
  type: "session",
  version: 3,
  id: "01a113b7-4fa2-777b-83eb-e8d6177bb10d",
  timestamp: "2026-10-07T00:00:00.000Z",
  cwd: "/tmp",
};
const user = { role: "user", content: [{ type: "text", text: "current" }], timestamp: 1 };
const assistant = { role: "assistant", content: [{ type: "text", text: visible }], stopReason: "stop", timestamp: 2 };
const row = (id: string, parentId: string | null, message: unknown) => ({
  type: "message",
  id,
  parentId,
  message,
  timestamp: "2026-10-07T00:00:00.000Z",
});
const entries = [header, row("u", null, user), row("a", "u", assistant)];
const events = [
  header,
  { type: "agent_start" },
  { type: "message_end", message: user },
  { type: "message_end", message: assistant },
  { type: "agent_end", willRetry: false },
  { type: "agent_settled" },
];
async function capture(stream: unknown[] = events, persisted: unknown[] = entries) {
  const root = await tempDir("child-final-");
  const path = join(root, "session.jsonl");
  await writeFile(path, persisted.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const reader = new ChildFinalCapture();
  const bytes = Buffer.from(stream.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // Force UTF-8 and JSON records across arbitrary byte boundaries.
  for (let i = 0; i < bytes.length; i += 7) reader.observe(bytes.subarray(i, i + 7));
  return { reader, path, result: await reader.finish(path) };
}
test("complete final retains all visible whitespace with exact current turn and branch identity", async () => {
  const { result } = await capture();
  assert.equal(result.state, "complete");
  if (result.state === "complete") {
    assert.equal(result.text, visible);
    assert.equal(result.messageId, "a");
    assert.equal(result.leafId, "a");
  }
});
test("agent_end without settlement never supplies an eligible final", async () => {
  const { result } = await capture(events.slice(0, -1));
  assert.equal(result.state, "unavailable");
  if (result.state === "unavailable") assert.match(result.reason, /not settled/);
});
test("successful-looking earlier run is invalidated by a later error", async () => {
  const error = { ...assistant, stopReason: "error", content: [], timestamp: 3 };
  const { result } = await capture(
    [
      ...events.slice(0, -1),
      { type: "agent_start" },
      { type: "message_end", message: error },
      { type: "agent_settled" },
    ],
    [...entries, row("e", "a", error)],
  );
  assert.equal(result.state, "unavailable");
});
test("foreign session and alternate branch finals are unavailable", async () => {
  assert.equal(
    (await capture(events, [{ ...header, id: "foreign" }, ...entries.slice(1)])).result.state,
    "unavailable",
  );
  assert.equal(
    (
      await capture(events, [
        ...entries,
        row("b", "u", { ...assistant, content: [{ type: "text", text: "other branch" }] }),
      ])
    ).result.state,
    "unavailable",
  );
});
test("empty/pending/tool-use terminal and unfinished tool calls are unavailable", async () => {
  for (const stopReason of ["pending", "error", "aborted", "length", "toolUse"]) {
    const message = { ...assistant, stopReason };
    assert.equal(
      (
        await capture(
          [header, { type: "message_end", message: user }, { type: "message_end", message }, { type: "agent_settled" }],
          [header, row("u", null, user), row("a", "u", message)],
        )
      ).result.state,
      "unavailable",
    );
  }
  assert.equal(
    (
      await capture([
        ...events.slice(0, -1),
        { type: "tool_execution_start", toolCallId: "x" },
        { type: "agent_settled" },
      ])
    ).result.state,
    "unavailable",
  );
});
test("torn malformed or duplicate protocol identity never promotes an old answer", async () => {
  for (const extra of ["{bad}\n", "null\n", JSON.stringify(header) + "\n"]) {
    const { reader, path } = await capture();
    reader.observe(Buffer.from(extra));
    assert.equal((await reader.finish(path)).state, "unavailable");
  }
});
test("actual Pi 1.0.4 captures parse without changing line-separator text; persistence remains required", async () => {
  for (const name of ["success", "nested", "retry", "error", "stop-then-error"]) {
    const reader = new ChildFinalCapture();
    reader.observe(await readFile(new URL(`../test-integration/pi-sdk/fixtures/${name}.jsonl`, import.meta.url)));
    const result = await reader.finish("/missing-current-session");
    assert.equal(result.state, "unavailable");
    if (result.state === "unavailable" && ["success", "nested", "retry"].includes(name)) {
      assert.match(result.reason, /session read unavailable/);
      assert.equal(
        result.diagnosticText,
        visible
          .replace("complete first", "final first")
          .replace("second", "final second")
          .replace("third", "final third"),
      );
    }
  }
});

test("unresolved final read cleanup stays attached to the initiating owner", async () => {
  const cleanup = new BoundedReadCleanupError(Error("close failed"), async () => {});
  const stream = Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const unowned = new ChildFinalCapture();
  unowned.observe(stream);
  await assert.rejects(
    () =>
      unowned.finish("unused", undefined, async () => {
        throw cleanup;
      }),
    (e) => e === cleanup,
  );
  let retained: unknown;
  const owned = new ChildFinalCapture(undefined, (e) => {
    retained = e;
  });
  owned.observe(stream);
  const result = await owned.finish("unused", undefined, async () => {
    throw cleanup;
  });
  assert.equal(result.state, "unavailable");
  assert.equal(retained, cleanup);
});

test("post-final tool or message activity needs a new final and settlement", async () => {
  const cases = [
    [
      { type: "tool_execution_start", toolCallId: "late" },
      { type: "agent_settled" },
      { type: "tool_execution_end", toolCallId: "late" },
    ],
    [
      { type: "tool_execution_start", toolCallId: "late" },
      { type: "tool_execution_end", toolCallId: "late" },
      { type: "agent_settled" },
    ],
    [{ type: "message_start", message: { role: "user" } }],
    [{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late" } }],
    [{ type: "message_end", message: { role: "toolResult", content: [] } }],
    [{ type: "turn_start" }],
  ];
  for (const tail of cases)
    assert.equal((await capture([...events, ...tail])).result.state, "unavailable", JSON.stringify(tail));
});
