import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { activitySessionFor } from "../src/executors/activity-session.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const zero = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = () => ({ role: "user", content: "PRIVATE TASK", timestamp: 1 }) as const;
const answer = (input: number, total: number) =>
  ({
    role: "assistant",
    provider: "local",
    model: "model",
    api: "test",
    stopReason: "stop",
    content: [{ type: "text", text: "PRIVATE ANSWER" }],
    timestamp: 2,
    usage: { ...structuredClone(zero), input, totalTokens: input, cost: { ...zero.cost, total } },
  }) as const;
const bytes = (manager: SessionManager) =>
  `${[manager.getHeader(), ...manager.getEntries()].map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`;
async function fixture(source?: string | Buffer) {
  const path = join(await tempDir("activity-usage-"), "session.jsonl");
  if (source !== undefined) await writeFile(path, source);
  return activitySessionFor(["--print", "--session", path, "task"], "exec:usage-review");
}

test("usage follows actual SDK active ancestry, excluding abandoned user/model/usage branches", async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user());
  manager.appendMessage(answer(100, 10) as never);
  manager.appendModelChange("local", "model");
  manager.appendThinkingLevelChange("high");
  manager.appendMessage(user());
  const active = manager.appendMessage(answer(5, 0.25) as never);
  manager.appendMessage(user());
  manager.appendModelChange("foreign", "wrong");
  manager.appendThinkingLevelChange("low");
  manager.appendMessage(answer(90, 9) as never);
  manager.branch(active);
  manager.appendMessage(answer(7, 0.5) as never);
  const session = await fixture(bytes(manager));
  const result = await session.usage();
  assert.equal(result.usage?.input, 12);
  assert.equal(result.usage?.cost.total, 0.75);
  assert.equal(result.effectiveThinkingLevel, "high");
  assert.deepEqual(result.resolvedModel, { provider: "local", modelId: "model" });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test("explicit zero cost remains observed; missing assistant cost never becomes zero", async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user());
  manager.appendMessage(answer(0, 0) as never);
  const session = await fixture(bytes(manager));
  assert.equal((await session.usage()).usage?.cost.total, 0);
  const rows = [manager.getHeader(), ...manager.getEntries()] as any[];
  delete rows.at(-1).message.usage.cost;
  await writeFile(session.path, `${rows.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`);
  assert.deepEqual(await session.usage(), { unavailable: "session-invalid" });
});

test("additional current-turn SDK usage counts, and unmeasured compaction keeps aggregate unavailable", async () => {
  const manager = SessionManager.inMemory();
  const id = manager.appendMessage(user());
  manager.appendMessage(answer(2, 0.25) as never);
  manager.appendUsage("cache_warm", "local", "model", answer(3, 0.5).usage);
  manager.appendCompaction("PRIVATE SUMMARY", id, 2, undefined, undefined, answer(4, 0.75).usage);
  const session = await fixture(bytes(manager));
  assert.equal((await session.usage()).usage?.cost.total, 1.5);
  assert.equal((await session.usage()).usage?.input, 9);
  manager.appendCompaction("PRIVATE SUMMARY", id, 2);
  await writeFile(session.path, bytes(manager));
  const result = await session.usage();
  assert.equal(result.usage, undefined);
  assert.equal(result.unavailable, "usage-missing");
  assert.equal(result.compactionCount, 2);
});

test("malformed, incomplete, invalid UTF-8 and noncanonical tree files never yield usage", async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(user());
  manager.appendMessage(answer(1, 1) as never);
  const good = bytes(manager),
    rows = JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()]));
  const orphan = structuredClone(rows);
  orphan.at(-1).parentId = "missing";
  const duplicate = structuredClone(rows);
  duplicate.at(-1).id = duplicate[1].id;
  const noHeader = rows.slice(1);
  for (const source of [
    good.trimEnd(),
    Buffer.concat([Buffer.from(good.slice(0, -1)), Buffer.from([0xff, 0x0a])]),
    `${orphan.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`,
    `${duplicate.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`,
    `${noHeader.map((entry: unknown) => JSON.stringify(entry)).join("\n")}\n`,
    `${good}not-json\n`,
  ]) {
    const session = await fixture(source);
    assert.deepEqual(await session.usage(), { unavailable: "session-invalid" });
  }
  const missing = await fixture();
  assert.deepEqual(await missing.usage(), { unavailable: "session-missing" });
});

test("oversized session reads are refused before parsing or returning partial totals", async () => {
  const session = await fixture();
  const handle = await open(session.path, "w");
  try {
    await handle.truncate(64 * 1024 * 1024 + 1);
  } finally {
    await handle.close();
  }
  assert.deepEqual(await session.usage(), { unavailable: "session-invalid" });
});

test("FIFO session cannot block the bounded usage reader", async (t) => {
  if (process.platform !== "linux") return t.skip("POSIX FIFO fixture");
  const session = await fixture();
  execFileSync("mkfifo", [session.path]);
  // A separate process gives the regression a real outer deadline if a blocking open is restored.
  const module = new URL("../src/executors/activity-session.ts", import.meta.url).href;
  const script = `import {activitySessionFor} from ${JSON.stringify(module)}; const s=await activitySessionFor(['--session',${JSON.stringify(session.path)},'task'],'exec:fifo'); console.log(JSON.stringify(await s.usage()));`;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.deepEqual(JSON.parse(result), { unavailable: "session-invalid" });
});
