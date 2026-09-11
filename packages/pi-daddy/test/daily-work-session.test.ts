import assert from "node:assert/strict";
import { test } from "node:test";
import { replacePublishedDailyWork } from "../extensions/daily-work-session.ts";
import { ENV_DAILY_SELECTION, ENV_DAILY_WORK } from "../src/dashboard-cli.ts";

const state = { ledgerPath: "/tmp/work.jsonl", selectedSnapshot: { snapshot: { id: "s", digest: "a".repeat(64) }, event: { eventId: "e", digest: "b".repeat(64) } } } as any;

test("valid to absent or malformed session transitions clear only extension-published dashboard inputs", () => {
  const env: Record<string, string | undefined> = {}, published = {};
  replacePublishedDailyWork(env, published, state);
  assert.equal(env[ENV_DAILY_WORK], state.ledgerPath);
  assert.ok(env[ENV_DAILY_SELECTION]);
  replacePublishedDailyWork(env, published, undefined);
  assert.equal(env[ENV_DAILY_WORK], undefined);
  assert.equal(env[ENV_DAILY_SELECTION], undefined);

  replacePublishedDailyWork(env, published, state);
  env[ENV_DAILY_WORK] = "/operator/override.jsonl";
  replacePublishedDailyWork(env, published, undefined);
  assert.equal(env[ENV_DAILY_WORK], "/operator/override.jsonl");
  assert.equal(env[ENV_DAILY_SELECTION], undefined);
});
