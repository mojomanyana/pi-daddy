import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compareOpenRouter } from "./openrouter.mjs";

const ids = ["typesafe/jev-1.14", "openai/gpt-6-luna-decisions", "jaredpalmer/kev-4b"];
const key = "test-fixture";
const catalog = () =>
  Response.json({
    data: [
      ...ids.map((id) => ({ id, architecture: { output_modalities: ["decisions"] } })),
      { id: "chat-only", architecture: { output_modalities: ["text"] } },
    ],
  });

test("list and preflight use the public catalog without sending a key or calling inference", async () => {
  const fetchCatalog = (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/models?output_modalities=decisions");
    assert.equal(options.headers, undefined);
    return catalog();
  };
  const logs = [];
  const run = (args, token) => compareOpenRouter(args, token, fetchCatalog, (line) => logs.push(line));
  await run(["--list"]);
  assert.deepEqual(logs.pop().split("\n"), [...ids].sort());
  await run(["--check", ...ids], key);
  assert.equal(JSON.parse(logs.pop()).status, "ready");
  await assert.rejects(run(["--check", ...ids]), /OPENROUTER_API_KEY/);
  await assert.rejects(run(["--check", ids[0], "chat-only"], key), /does not list/);
});

test("OpenRouter rotates three models over identical blinded turns, thresholds noul probabilities and attributes reported costs", async () => {
  const calls = [],
    logs = [];
  const request = (url, options) => {
    if (!options.method) return catalog();
    assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(options.headers.Authorization, "Bearer " + key);
    const payload = JSON.parse(options.body);
    calls.push(payload);
    assert.deepEqual(Object.keys(payload.state), ["turn"]);
    assert.equal(payload.questions.save.type, "noul");
    const probability = payload.model === ids[2] ? 0.74 : 0.75;
    return Response.json({
      model: payload.model + "-snapshot",
      answers: { save: { type: "noul", noul: probability } },
      usage: { input_tokens: 100, output_tokens: 2, cost: 0 },
    });
  };
  await compareOpenRouter(["--live", ...ids], key, request, (line) => logs.push(line));
  const report = JSON.parse(readFileSync(logs[0].slice("Report: ".length)));
  assert.equal(calls.length, 165);
  assert.equal(report.status, "complete");
  assert.deepEqual(
    calls.slice(0, 9).map((p) => p.model),
    [...ids, ids[1], ids[2], ids[0], ids[2], ids[0], ids[1]],
  );
  for (let i = 0; i < calls.length; i += 3) {
    assert.deepEqual(calls[i].state, calls[i + 1].state);
    assert.deepEqual(calls[i].state, calls[i + 2].state);
  }
  assert.equal(report.summary.disagreements.length, 55);
  assert.deepEqual(report.summary.arms[ids[0]].billedUsd, { reportingCalls: 55, total: 0 });
  assert.equal(report.rows.find((r) => r.eligible)[ids[1]].resolvedModel, ids[1] + "-snapshot");
});

test("model errors retain the first round and the HTTP status in a partial report", async () => {
  const logs = [];
  const request = (_url, options) => (options.method ? new Response(null, { status: 403 }) : catalog());
  await assert.rejects(
    compareOpenRouter(["--live", ...ids], key, request, (line) => logs.push(line)),
    /request failed/,
  );
  const report = JSON.parse(readFileSync(logs[0].slice("Report: ".length)));
  assert.equal(report.status, "partial");
  const called = report.rows.filter((row) => row.eligible);
  assert.equal(called.length, 1);
  assert.equal(called[0][ids[0]].httpStatus, 403);
});
import { loadCorpus } from "./benchmark.mjs";

test("holdout uses distinct tasks, frozen model thresholds, and only the eligible turns", async () => {
  const { cases: oldCases } = loadCorpus("./cases.jsonl");
  const { cases: fresh } = loadCorpus("./holdout.jsonl");
  const oldPrompts = new Set(oldCases.map((c) => c.signals.prompt));
  assert.ok(fresh.every((c) => !oldPrompts.has(c.signals.prompt)));
  let count = 0;
  const logs = [];
  const request = (_url, options) => {
    if (!options.method) return catalog();
    count++;
    return Response.json({ answers: { save: { type: "noul", noul: 0.53 } } });
  };
  await compareOpenRouter(["--holdout", "--live"], key, request, (line) => logs.push(line));
  const report = JSON.parse(readFileSync(logs[0].slice("Report: ".length)));
  assert.equal(report.dataset, "holdout-v1");
  assert.deepEqual(report.thresholds, Object.fromEntries(ids.map((id, i) => [id, [0.53, 0.65, 0.50][i]])));
  assert.equal(count, 168);
  assert.equal(report.eligible, 56);
  assert.equal(report.rows.length, 60);
  assert.equal(report.summary.sharedGateMisses.length, 2);
  for (const row of report.rows.filter((r) => r.eligible)) {
    assert.equal(row[ids[0]].save, true);
    assert.equal(row[ids[1]].save, false);
    assert.equal(row[ids[2]].save, true);
  }
});
