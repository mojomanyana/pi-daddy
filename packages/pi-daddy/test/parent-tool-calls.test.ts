/**
 * Parent-run tool calls on the real owner socket (decision of 2026-11-17), driven by the real child client.
 *
 * **The production changes that break these tests**, one per case:
 *
 *  - answering a request from an unknown, finished or different execution, or with another child's key, or for a
 *    tool the child was not granted, or without the owner token;
 *  - leaving a call running after its child disconnects, settles or the owner closes, or holding the reply
 *    when the tool ignores its signal;
 *  - allowing two calls in flight for one child, or a second run while a cancelled one is still running;
 *  - reporting a waiting child as idle, or an idle one as working;
 *  - widening the 4096-character line for any action other than this one, or raising, removing or loosening this
 *    one's bound (an authenticated call one character over it must get no reply and run nothing);
 *  - forwarding a thrown error's text, which can carry parent state, instead of a fixed refusal.
 */
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { test } from "node:test";
import { createAutoModeAuthority } from "../src/governance/auto-mode-policy.ts";
import { callParentTool, type ParentToolGrant } from "../src/governance/parent-tool-calls.ts";
import {
  MAX_PARENT_TOOL_ARGUMENT_BYTES,
  MAX_PARENT_TOOL_REQUEST_CHARS,
  PARENT_TOOL_REFUSALS,
  type ParentToolReply,
} from "../src/kernel/parent-tools.ts";

const answer = (text: string): ParentToolReply => ({ status: "result", isError: false, text, truncated: false });
const refused = (reason: string): ParentToolReply => ({ status: "refused", reason });

/** A run that records every call and resolves only when the test says so (or the signal ends it). */
function controllableRun() {
  const calls: Array<{ tool: string; args: Record<string, unknown>; signal: AbortSignal }> = [];
  const pending: Array<(reply: ParentToolReply) => void> = [];
  const run: ParentToolGrant["run"] = (tool, args, signal) =>
    new Promise((resolve) => {
      calls.push({ tool, args, signal });
      pending.push(resolve);
    });
  return { calls, run, settle: (reply: ParentToolReply) => pending.shift()!(reply) };
}

/** A reply that never comes is a failure here, not a hung suite. */
function within<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`no reply: ${label}`)), ms))),
  ]).finally(() => clearTimeout(timer));
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("only a registered running child, with its own key and grant, reaches the parent's run", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  try {
    const runs: Array<[string, Record<string, unknown>]> = [];
    const grant = (executionId: string, tools: string[]) =>
      owner.parentTools.register({
        executionId,
        tools,
        run: async (tool, args) => {
          runs.push([tool, args]);
          return answer(`ran for ${executionId}`);
        },
      });
    const a = grant("exec-a", ["scout_research"]);
    const b = grant("exec-b", ["scout_research"]);
    const ungranted = grant("exec-c", []);
    assert.notEqual(a.key, b.key);
    assert.throws(() => grant("exec-a", ["scout_research"]), /already registered/);
    const ask = (executionId: string, key: string, tool = "scout_research", reference = owner.reference) =>
      callParentTool(reference, { executionId, key, tool, arguments: { question: executionId } });

    assert.deepEqual(await ask("exec-a", a.key), answer("ran for exec-a"));
    assert.deepEqual(runs, [["scout_research", { question: "exec-a" }]]);
    const unknown = refused(PARENT_TOOL_REFUSALS.unknownChild);
    assert.deepEqual(await ask("exec-z", a.key), unknown, "unknown execution");
    assert.deepEqual(await ask("exec-a", b.key), unknown, "another child's key");
    assert.deepEqual(await ask("exec-b", a.key), unknown, "another child's identity");
    assert.deepEqual(await ask("exec-c", ungranted.key), refused(PARENT_TOOL_REFUSALS.notGranted));
    assert.deepEqual(await ask("exec-a", a.key, "bookie_search"), refused(PARENT_TOOL_REFUSALS.notGranted));
    assert.deepEqual(await ask("exec-a", a.key, "bookie_write"), refused(PARENT_TOOL_REFUSALS.notAllowlisted));
    await assert.rejects(
      ask("exec-a", a.key, "scout_research", { ...owner.reference, token: "0".repeat(48) }),
      /refused the request \(Error: Unauthorized Auto policy request\)/,
    );
    a.close();
    assert.deepEqual(await ask("exec-a", a.key), unknown, "a settled child");
    assert.deepEqual(await ask("exec-b", b.key), answer("ran for exec-b"));
    assert.equal(runs.length, 2, "no refused request reached the run");
  } finally {
    await owner.close();
  }
});

test("a call ends with its child: disconnect, settlement and owner close each cancel it, and one runs at a time", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  try {
    const run = controllableRun();
    const child = owner.parentTools.register({ executionId: "exec-1", tools: ["scout_research"], run: run.run });
    const ask = (signal?: AbortSignal) =>
      callParentTool(
        owner.reference,
        { executionId: "exec-1", key: child.key, tool: "scout_research", arguments: {} },
        signal,
      );
    assert.equal(child.activity(), "0:idle");

    // The child process going away (its connection closing) cancels the parent's call.
    const leaving = new AbortController();
    const first = ask(leaving.signal);
    await until(() => run.calls.length === 1, "first call");
    assert.match(child.activity(), /^0:\d+$/, "waiting on the parent is activity");
    assert.deepEqual(await within(ask(), "second call while one is in flight"), refused(PARENT_TOOL_REFUSALS.busy));
    leaving.abort();
    await assert.rejects(first, /aborted/);
    await until(() => run.calls[0].signal.aborted, "parent-side cancellation");
    await until(() => child.activity() === "1:idle", "reply slot released");
    // This run ignores its signal and is still going in the parent, so the same child's next call is refused
    // until it settles: one run per child at a time, not only one reply.
    assert.deepEqual(await within(ask(), "a call while the cancelled run goes on"), refused(PARENT_TOOL_REFUSALS.busy));
    assert.equal(run.calls.length, 1);
    run.settle(answer("too late for anyone"));

    // The child settling (registration closed) cancels a call even when the tool ignores its signal.
    const second = ask();
    await until(() => run.calls.length === 2, "second call");
    child.close();
    assert.deepEqual(await within(second, "a call whose child settled"), refused(PARENT_TOOL_REFUSALS.cancelled));
    assert.equal(run.calls[1].signal.aborted, true);

    // Closing the owner cancels whatever any child left in flight.
    const other = owner.parentTools.register({ executionId: "exec-2", tools: ["scout_research"], run: run.run });
    const third = callParentTool(owner.reference, {
      executionId: "exec-2",
      key: other.key,
      tool: "scout_research",
      arguments: {},
    }).catch((error: unknown) => error);
    await until(() => run.calls.length === 3, "third call");
    await owner.close();
    assert.equal(run.calls[2].signal.aborted, true);
    // Closing races the reply against the socket teardown; either way the child is told nothing ran to completion.
    const ended = await within(third, "a call whose owner closed");
    if (ended instanceof Error) assert.match(ended.message, /parent session is unavailable/);
    else assert.deepEqual(ended, refused(PARENT_TOOL_REFUSALS.cancelled));
    assert.throws(() => owner.parentTools.register({ executionId: "exec-3", tools: [], run: run.run }), /closed/);
  } finally {
    await owner.close();
  }
});

test("a run that throws becomes a fixed refusal; its message, which may carry parent state, never crosses", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  try {
    const child = owner.parentTools.register({
      executionId: "exec-1",
      tools: ["scout_research"],
      run: async () => {
        throw new Error("parent secret: /home/operator/.pi/agent/auth.json");
      },
    });
    const reply = await callParentTool(owner.reference, {
      executionId: "exec-1",
      key: child.key,
      tool: "scout_research",
      arguments: {},
    });
    assert.deepEqual(reply, refused(PARENT_TOOL_REFUSALS.failed));
  } finally {
    await owner.close();
  }
});

/** One raw line to the owner socket; resolves with whatever came back before the socket closed. */
function rawLine(path: string, line: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let output = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (output += chunk));
    socket.on("error", () => {});
    socket.on("close", () => resolve(output));
    socket.on("connect", () => socket.write(line));
  });
}

test("only this action carries a longer request line, and it is bounded too", async () => {
  const owner = await createAutoModeAuthority({ enabled: false, source: "default" });
  try {
    const padded = (action: string, pad: number) =>
      JSON.stringify({ ...owner.reference, action, pad: "x".repeat(pad) }) + "\n";
    assert.match(await rawLine(owner.reference.socketPath, padded("read", 100)), /"ok":true/);
    assert.equal(await rawLine(owner.reference.socketPath, padded("read", 5000)), "", "other actions keep 4096");
    const seen: unknown[] = [];
    const child = owner.parentTools.register({
      executionId: "exec-1",
      tools: ["scout_research"],
      run: async (_tool, args) => {
        seen.push(args);
        return answer("ok");
      },
    });
    // An authenticated, well-formed call for a granted tool, padded outside the call so only the line's length
    // differs: at the bound it is answered and run; one character over, the owner closes without a reply and runs
    // nothing. Breaks if the bound is raised, removed or made inclusive (`auto-mode-policy.ts`'s line check).
    const small = { executionId: "exec-1", key: child.key, tool: "scout_research", arguments: { question: "q" } };
    const line = (chars: number) => {
      const bare = JSON.stringify({ ...owner.reference, action: "parent-tool", call: small, pad: "" });
      const pad = "x".repeat(chars - bare.length);
      return JSON.stringify({ ...owner.reference, action: "parent-tool", call: small, pad });
    };
    // The bound counts what the owner has read, newline included.
    const atBound = line(MAX_PARENT_TOOL_REQUEST_CHARS - 1);
    assert.equal(atBound.length + 1, MAX_PARENT_TOOL_REQUEST_CHARS);
    assert.equal(await rawLine(owner.reference.socketPath, line(MAX_PARENT_TOOL_REQUEST_CHARS) + "\n"), "");
    assert.deepEqual(seen, [], "a line over the bound runs nothing");
    assert.deepEqual(JSON.parse(await rawLine(owner.reference.socketPath, atBound + "\n")), {
      ok: true,
      value: answer("ok"),
    });
    assert.deepEqual(seen, [{ question: "q" }]);
    seen.length = 0;
    const big = { question: "q".repeat(MAX_PARENT_TOOL_ARGUMENT_BYTES - 64) };
    const call = { executionId: "exec-1", key: child.key, tool: "scout_research", arguments: big };
    assert.deepEqual(await callParentTool(owner.reference, call), answer("ok"));
    assert.deepEqual(seen, [big]);
    const over = { ...call, arguments: { question: "q".repeat(MAX_PARENT_TOOL_ARGUMENT_BYTES) } };
    assert.deepEqual(await callParentTool(owner.reference, over), refused(PARENT_TOOL_REFUSALS.oversized));
    assert.equal(seen.length, 1);
  } finally {
    await owner.close();
  }
});
