import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { ensureSessionModelPrompt, type SessionModelPromptState } from "../extensions/session-model-prompt.ts";
import { readRecords } from "../src/governance/record.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const EPISODE = "episode:00000000-0000-4000-8000-0000000000f1";

async function state(mode: "ask" | "never" = "ask"): Promise<SessionModelPromptState> {
  const dir = await tempDir("session-model-prompt-");
  return {
    episodeId: EPISODE,
    ledgerPath: `${dir}/grants.jsonl`,
    definitions: new Map([
      ["review", { name: "review" }],
      ["build", { name: "build" }],
    ]),
    definitionRuntimeSettings: {
      defaults: { model: "global/model", thinking: "low" },
      definitions: new Map([["review", { model: "definition/model", thinking: "medium" }]]),
    },
    definitionRuntimeOverrides: new Map(),
    sessionModelPrompt: mode,
    sessionModelPrompted: false,
  };
}

async function events(value: SessionModelPromptState): Promise<any[]> {
  const parsed = readRecords(await readFile(value.ledgerPath!, "utf8"));
  assert.equal(parsed.damage, null);
  return parsed.records.map((record) => record.body);
}

test("first delegation keeps defaults once and records the empty session map", async () => {
  const value = await state();
  let prompts = 0;
  await ensureSessionModelPrompt(value, ["review"], {
    hasUI: true,
    input: async (title) => {
      prompts += 1;
      assert.match(title, /review.*definition\/model.*medium/s);
      return "";
    },
    notify: () => {},
  });
  await ensureSessionModelPrompt(value, ["build"], {
    hasUI: true,
    input: async () => assert.fail("the session prompt must run once"),
    notify: () => {},
  });
  assert.equal(prompts, 1);
  assert.deepEqual([...value.definitionRuntimeOverrides], []);
  assert.deepEqual(
    (await events(value)).map((event) => [event.event, event.outcome, event.overrides]),
    [["session_config", "kept", {}]],
  );
});

test("change accepts per-definition and all edits into the session map", async () => {
  const value = await state();
  await ensureSessionModelPrompt(value, ["review", "build"], {
    hasUI: true,
    input: async () => "all openai-codex:gpt-5.6-sol high\nreview anthropic:claude-opus-4-6 xhigh",
    notify: () => {},
  });
  assert.deepEqual(
    [...value.definitionRuntimeOverrides],
    [
      ["build", { model: "openai-codex/gpt-5.6-sol", thinking: "high" }],
      ["review", { model: "anthropic/claude-opus-4-6", thinking: "xhigh" }],
    ],
  );
  assert.equal((await events(value))[0].outcome, "changed");
});

test("invalid edits are rejected with valid values and cannot spawn past the prompt", async () => {
  const value = await state();
  const answers = ["review bad-model turbo", "review anthropic:claude-opus-4-6 high"];
  const notices: string[] = [];
  await ensureSessionModelPrompt(value, ["review"], {
    hasUI: true,
    input: async () => answers.shift(),
    notify: (message) => notices.push(message),
  });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /off, minimal, low, medium, high, xhigh, max/);
  assert.deepEqual(value.definitionRuntimeOverrides.get("review"), {
    model: "anthropic/claude-opus-4-6",
    thinking: "high",
  });
});

test("sessionModelPrompt never skips UI but still records kept defaults", async () => {
  const value = await state("never");
  await ensureSessionModelPrompt(value, ["review"], {
    hasUI: true,
    input: async () => assert.fail("never must not prompt"),
    notify: () => {},
  });
  assert.equal((await events(value))[0].outcome, "kept");
});
