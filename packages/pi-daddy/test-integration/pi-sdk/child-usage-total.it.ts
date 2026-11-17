/**
 * A real Pi root delegates to a real Pi child, which delegates to a real Pi leaf; Pi's own session statistics hold
 * every model call of the tree exactly once (owner decision 2026-11-17). Model-free: every process uses the scripted
 * local provider with fixed usage per call (`child-usage-extension.ts`).
 *
 * Runs on the lockfile's Pi by default. `DADDY_TEST_PI_CLI=<pi-coding-agent>/dist/cli.js` selects another Pi (the
 * qualification run uses 1.5.2). The root runs in RPC mode, so the totals are Pi's `get_session_stats` answer, the
 * figures its footer and cost show, not a re-implementation of them.
 *
 * Breaks if: a delegation result stops reporting its children's usage (the root misses 28 tokens); a child's reader
 * counts its own delegation result as its own call (the leaf's 16 tokens arrive twice, and the ledger holds them
 * twice); or the ledger stops recording each execution's own calls.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CALLS } from "./child-usage-extension.ts";
import { MODEL, PROVIDER } from "./scripted-provider.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const sum = (calls: Array<{ input: number; cost: { total: number } }>) => ({
  input: calls.reduce((total, call) => total + call.input, 0),
  cost: calls.reduce((total, call) => total + call.cost.total, 0),
});

async function runTree() {
  const root = await mkdtemp(join(tmpdir(), "daddy-child-usage-"));
  const agent = join(root, "agent"),
    bin = join(root, "bin"),
    ledger = join(root, "grants.jsonl");
  await Promise.all([mkdir(agent), mkdir(bin)]);
  await writeFile(join(agent, "auth.json"), "{}");
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProjectTrust: "always",
      enableAnalytics: false,
      enableInstallTelemetry: false,
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: "off",
    }),
  );
  const cli =
    process.env.DADDY_TEST_PI_CLI ||
    fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const extension = fileURLToPath(new URL("./child-usage-extension.ts", import.meta.url));
  const grants = fileURLToPath(new URL("../../extensions/grants.ts", import.meta.url));
  // Every governed level is started as `pi`: the same CLI plus the scripted provider. Daddy's own arguments follow.
  await writeFile(
    join(bin, "pi"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} -e ${quote(extension)} "$@"\n`,
  );
  await chmod(join(bin, "pi"), 0o700);
  const args = [
    cli,
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-mcp",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-skills",
    "-e",
    extension,
    "-e",
    grants,
    "--tools",
    "read,delegate",
    "--provider",
    PROVIDER,
    "--model",
    MODEL,
  ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: root,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      NO_COLOR: "1",
      TERM: "dumb",
      PI_DADDY_HERDR: "0",
      PI_DADDY_AUTO_MODE: "0",
      PI_DADDY_ACTIVITY_TIMELINE: "off",
      PI_DADDY_LEDGER: ledger,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: any[] = [];
  let stderr = "",
    buffered = "";
  const waiters: Array<{ match: (event: any) => boolean; resolve: (event: any) => void }> = [];
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      events.push(event);
      for (const waiter of waiters.splice(0))
        if (waiter.match(event)) waiter.resolve(event);
        else waiters.push(waiter);
    }
  });
  const next = (match: (event: any) => boolean) =>
    new Promise<any>((resolve, reject) => {
      const found = events.find(match);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`root Pi did not answer:\n${stderr}`)), 120_000);
      waiters.push({ match, resolve: (event) => (clearTimeout(timer), resolve(event)) });
    });
  const send = (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`);
  try {
    send({ id: "prompt", type: "prompt", message: "Delegate the answer." });
    await next((event) => event.type === "agent_end");
    send({ id: "stats", type: "get_session_stats" });
    const stats = await next((event) => event.type === "response" && event.id === "stats");
    return { root, events, stats, ledger: await readFile(ledger, "utf8").catch(() => ""), stderr };
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

test("a three-level governed tree reaches the root Pi session's statistics once per model call", async () => {
  const run = await runTree();
  try {
    assert.equal(run.stats.success, true, run.stderr);
    const tree = sum([...CALLS.root, ...CALLS.child, ...CALLS.leaf]);
    assert.deepEqual({ input: run.stats.data.tokens.input, cost: run.stats.data.cost }, tree, "31 tokens, $1.9375");
    const delegated = run.events.find((event) => event.type === "tool_execution_end" && event.toolName === "delegate");
    assert.equal(delegated.isError, false, JSON.stringify(delegated.result.content));
    const below = sum([...CALLS.child, ...CALLS.leaf]);
    assert.deepEqual({ input: delegated.result.usage.input, cost: delegated.result.usage.cost.total }, below);
    assert.deepEqual(delegated.result.details.childUsage, {
      reported: true,
      measured: 2,
      unmeasured: 0,
      coverage: "complete",
    });
    // The persisted tool result carries it: what Pi's statistics and footer sum.
    const persisted = run.events.find(
      (event) =>
        event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "delegate",
    );
    assert.equal(persisted.message.usage.input, below.input);
    // The ledger holds each execution's own calls, so summing it over the episode holds the tree once, root excluded.
    const terminal = run.ledger
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).body)
      .filter((body) => body.event === "child_lifecycle" && ["completed", "failed"].includes(body.state));
    assert.deepEqual(
      terminal.map((body) => [body.state, body.usage.input, body.usage.cost.total]).sort(),
      [
        ["completed", 12, 0.375],
        ["completed", 16, 0.0625],
      ],
      "the child's own two calls, and the leaf's one; never the leaf's again inside the child's",
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});
