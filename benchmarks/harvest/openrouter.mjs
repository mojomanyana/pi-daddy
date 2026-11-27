import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cases,
  corpusHash,
  cutoff,
  loadCorpus,
  runHarvestModels,
  saveQuestion,
  scoreDecision,
  summarize,
} from "./benchmark.mjs";
import { hasHarvestSignal } from "../../packages/pi-daddy/src/products/session-harvest.ts";

const endpoint = "https://openrouter.ai/api/alpha/decisions";

export async function compareOpenRouter(args, apiKey, request = fetch, log = console.log) {
  const holdout = args[0] === "--holdout";
  const thresholds = holdout
    ? {
        "typesafe/jev-1.14": 0.53,
        "openai/gpt-6-luna-decisions": 0.65,
        "jaredpalmer/kev-4b": 0.5,
      }
    : null;
  const [mode, ...selected] = holdout ? args.slice(1) : args;
  if (holdout && (selected.length || !["--live", "--check"].includes(mode))) {
    throw Error("Use --holdout --check or --holdout --live. The comparison models and thresholds are fixed.");
  }
  const ids = holdout ? Object.keys(thresholds) : selected;
  const dataset = holdout ? loadCorpus("./holdout.jsonl") : { cases, corpusHash };
  if (holdout && dataset.corpusHash !== "9128c4b4898bde9c102debbf28d7ddfe5778b6a80682ea8477386b6e204fb48b")
    throw Error("Holdout corpus differs from its frozen hash.");
  if (
    !(mode === "--list" && ids.length === 0) &&
    !(["--check", "--live"].includes(mode) && ids.length >= 2 && new Set(ids).size === ids.length)
  ) {
    throw Error("Use --list, --check MODEL_A MODEL_B, or --live MODEL_A MODEL_B [MODEL_C ...] with distinct model IDs");
  }
  const catalog = await request("https://openrouter.ai/api/v1/models?output_modalities=decisions", {
    signal: AbortSignal.timeout(20000),
  });
  if (!catalog.ok) throw Error("OpenRouter model catalog returned HTTP " + catalog.status);
  const available = (await catalog.json()).data.filter((m) => m.architecture?.output_modalities?.includes("decisions"));
  const names = available.map((m) => m.id).sort();
  if (mode === "--list") return log(names.join("\n"));
  for (const id of ids) {
    if (!names.includes(id)) throw Error("OpenRouter does not list " + id + " as a decision model. Use --list.");
  }
  if (!apiKey?.trim()) throw Error("Set OPENROUTER_API_KEY in this shell.");
  const report = {
    status: "ready",
    models: ids,
    corpusSha256: dataset.corpusHash,
    cases: dataset.cases.length,
    eligible: dataset.cases.filter((c) => hasHarvestSignal(c.signals)).length,
    ...(holdout ? { dataset: "holdout-v1", thresholds } : { threshold: cutoff }),
  };
  if (mode === "--check") return log(JSON.stringify(report, null, 2));

  const path = join(mkdtempSync(join(tmpdir(), "openrouter-harvest-")), "report.json");
  const rows = [];
  const persist = () => writeFileSync(path, JSON.stringify({ ...report, rows }, null, 2) + "\n");
  log("Report: " + path);
  report.status = "running";
  persist();
  const arms = Object.fromEntries(
    ids.map((id) => [
      id,
      async (_signals, digest, signal) => {
        const response = await request(endpoint, {
          method: "POST",
          redirect: "error",
          headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: id,
            state: { turn: digest },
            questions: { save: { type: "noul", ...saveQuestion } },
          }),
          signal,
        });
        if (!response.ok) return { status: "request-error", save: false, httpStatus: response.status };
        const { answers, usage, model, error } = await response.json();
        const answer = answers?.save;
        const outcome = scoreDecision(
          answer?.type === "noul" ? answer.noul : undefined,
          !error,
          thresholds?.[id] ?? cutoff,
        );
        return {
          ...outcome,
          resolvedModel: model ?? null,
          tokens:
            Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens)
              ? usage.input_tokens + usage.output_tokens
              : null,
          billedUsd: Number.isFinite(usage?.cost) ? usage.cost : null,
        };
      },
    ]),
  );
  try {
    await runHarvestModels(
      arms,
      (row) => {
        rows.push(row);
        persist();
      },
      dataset.cases,
    );
    report.status = "complete";
  } catch (error) {
    report.status = "partial";
    throw error;
  } finally {
    report.summary = summarize(rows, ids);
    persist();
    log(JSON.stringify(report, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await compareOpenRouter(process.argv.slice(2), process.env.OPENROUTER_API_KEY);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
