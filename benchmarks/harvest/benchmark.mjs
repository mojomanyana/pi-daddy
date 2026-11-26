import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  classifyHarvestCandidate,
  harvestClassifierDigest,
  hasHarvestSignal,
} from "../../packages/pi-daddy/src/products/session-harvest.ts";
import {
  resolveEcosystemModelCandidates,
  selectRegistryModel,
} from "../../packages/pi-daddy/src/kernel/ecosystem-config.ts";
import { supportedModelEfforts } from "../../packages/pi-daddy/src/kernel/model-preflight.ts";

const signalNames = ["thrashDetected", "escalated", "reviewBlockers", "userSteered", "toolFailedAndEdited"];
export function loadCorpus(file) {
  const corpus = readFileSync(new URL(file, import.meta.url), "utf8")
    .replaceAll("\r\n", "\n")
    .trimEnd();
  const corpusHash = createHash("sha256").update(corpus).digest("hex");
  const cases = corpus.split("\n").map((line) => {
    const { id, expected, prompt, editedFile, verifyCommand, signal, summary } = JSON.parse(line);
    assert.ok(typeof expected === "boolean" && [...signalNames, "none"].includes(signal));
    const signals = {
      prompt,
      editedFiles: [editedFile],
      verifyCommands: [verifyCommand],
      failureSummary: summary,
      ...Object.fromEntries(
        signalNames.map((key) => [key, key === "reviewBlockers" ? Number(key === signal) : key === signal]),
      ),
    };
    return { id, expected, signals };
  });
  assert.equal(new Set(cases.map((row) => row.id)).size, 60);
  assert.equal(cases.length, 60);
  assert.equal(cases.filter((row) => row.expected).length, 30);
  return { cases, corpusHash };
}

export const { cases, corpusHash } = loadCorpus("./cases.jsonl");
export const cutoff = 0.75;
const modelId = "gpt-6-luna-decisions";
const provider = "github-copilot";
const label = (model) => (model ? model.provider + "/" + model.id : null);

export async function inspect(registry, sessionModel) {
  const { model: baseline } = selectRegistryModel(registry, resolveEcosystemModelCandidates("fast"), sessionModel);
  const blockers = [];
  if (!baseline || !registry.hasConfiguredAuth(baseline))
    blockers.push("No configured Daddy fast-tier or session chat model");
  else if (!supportedModelEfforts(baseline).includes("off")) blockers.push("The baseline cannot run with thinking off");
  let luna;
  if (!registry.getProviderAuthStatus(provider).configured)
    blockers.push("GitHub Copilot is not configured in this Pi profile");
  else if (typeof registry.getAvailableOfType !== "function" || typeof registry.classify !== "function")
    blockers.push("This Pi registry does not support decision models");
  else {
    const available = await registry.getAvailableOfType("classifier", provider);
    luna = available.find((model) => model.provider === provider && model.id === modelId);
    if (!luna) blockers.push("Copilot does not offer " + modelId + " to this profile");
  }
  return { baseline, luna, blockers };
}

function usageFields(usage) {
  return {
    tokens: Number.isFinite(usage?.totalTokens) ? usage.totalTokens : null,
    billedUsd: usage?.cost?.totalFromProvider === true ? usage.cost.total : null,
    estimatedUsd:
      usage?.cost?.totalFromProvider !== true && Number.isFinite(usage?.cost?.total) ? usage.cost.total : null,
  };
}

const categories = ["thrash", "review-blocker", "user-correction", "tool-failure", "trivial"];
function validChatSchema(text) {
  try {
    const raw = JSON.parse(text.trim());
    return (
      typeof raw.harvest === "boolean" &&
      categories.includes(raw.category) &&
      Number.isFinite(raw.confidence) &&
      raw.confidence >= 0 &&
      raw.confidence <= 1 &&
      typeof raw.scenarioId === "string" &&
      typeof raw.reason === "string"
    );
  } catch {
    return false;
  }
}
async function baselineCall(registry, model, signals, digest, signal) {
  let usage,
    validSchema = false,
    returned = false;
  const adapter = {
    find: registry.find.bind(registry),
    hasConfiguredAuth: registry.hasConfiguredAuth.bind(registry),
    streamSimple(picked, context, options) {
      assert.equal(label(picked), label(model), "Fast-tier selection changed during this run");
      const prompt = context.messages[0].content[0].text;
      assert.ok(prompt.endsWith("\n\n" + digest), "The two arms received different turn data");
      const stream = registry.streamSimple(picked, context, options);
      return {
        result: async () => {
          const message = await stream.result();
          returned = message.stopReason === "stop";
          usage = message.usage;
          validSchema = validChatSchema(
            (message.content ?? [])
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join(""),
          );
          return message;
        },
      };
    },
  };
  const result = await classifyHarvestCandidate({
    signals,
    registry: adapter,
    fallbackModel: model,
    minConfidence: cutoff,
    signal,
  });
  return {
    save: result.harvest,
    status: !returned ? "request-error" : validSchema ? "ok" : "invalid-response",
    ...usageFields(usage),
  };
}

export const saveQuestion = {
  instructions: "Should this completed coding-agent turn be saved as a regression evaluation?",
  criteria: {
    true: "A generalizable agent or skill failure, such as a thrash loop, wrong assumption, review blocker, or tool misuse.",
    false: "Routine work, a preference change, or a one-off environment hiccup.",
  },
};

async function lunaCall(registry, model, digest, signal) {
  const result = await registry.classify(
    model,
    { state: { turn: digest }, questions: { save: { type: "bool", ...saveQuestion } } },
    { signal },
  );
  const answer = result.answers?.save;
  const probability = answer?.type === "bool" ? answer.probability : undefined;
  return { ...scoreDecision(probability, result.stopReason === "stop"), ...usageFields(result.usage) };
}

export function scoreDecision(probability, completed = true, threshold = cutoff) {
  const valid = Number.isFinite(probability) && probability >= 0 && probability <= 1;
  const status = completed ? (valid ? "ok" : "invalid-response") : "request-error";
  return { save: status === "ok" && probability >= threshold, probability: valid ? probability : null, status };
}

export async function pairedRun(registry, models, onRow) {
  assert.equal(models.blockers.length, 0);
  return runHarvestModels(
    {
      baseline: (signals, digest, signal) => baselineCall(registry, models.baseline, signals, digest, signal),
      luna: (_signals, digest, signal) => lunaCall(registry, models.luna, digest, signal),
    },
    onRow,
  );
}

export async function runHarvestModels(arms, onRow, dataset = cases) {
  const names = Object.keys(arms);
  assert.ok(names.length >= 2, "Choose at least two different models");
  let eligibleIndex = 0;
  for (const { id, signals, expected } of dataset) {
    const row = { id, expected, eligible: hasHarvestSignal(signals) };
    if (row.eligible) {
      const digest = harvestClassifierDigest(signals);
      const first = eligibleIndex++ % names.length;
      const order = [...names.slice(first), ...names.slice(0, first)];
      for (const arm of order) {
        const start = performance.now();
        const signal = AbortSignal.timeout(45000);
        try {
          row[arm] = await arms[arm](signals, digest, signal);
        } catch {
          row[arm] = { status: "request-error", save: false, ...usageFields() };
        }
        row[arm].latencyMs = Math.round(performance.now() - start);
      }
    }
    onRow(row);
    if (row.eligible && names.some((arm) => row[arm].status === "request-error"))
      throw Error("A provider request failed at " + id + "; see the partial report. No further cases were sent.");
  }
}
export function summarize(rows, arms = ["baseline", "luna"]) {
  const eligible = rows.filter((r) => r.eligible);
  const summaries = {};
  for (const arm of arms) {
    const values = eligible.map((r) => r[arm]);
    const latency = values
      .filter((v) => v.status === "ok")
      .map((v) => v.latencyMs)
      .sort((a, b) => a - b);
    const percentile = (p) => (latency.length ? latency[Math.ceil(latency.length * p) - 1] : null);
    function total(field) {
      const reported = values.filter((v) => v[field] != null);
      return {
        reportingCalls: reported.length,
        total: reported.length ? reported.reduce((a, v) => a + v[field], 0) : null,
      };
    }
    summaries[arm] = {
      missedEligible: eligible.filter((r) => r.expected && !r[arm].save).length,
      falseSaves: eligible.filter((r) => !r.expected && r[arm].save).length,
      missedEndToEnd: rows.filter((r) => r.expected && !(r.eligible && r[arm].save)).length,
      invalidResponses: values.filter((v) => v.status === "invalid-response").length,
      requestErrors: values.filter((v) => v.status === "request-error").length,
      validLatencySamples: latency.length,
      medianMs: percentile(0.5),
      p95Ms: percentile(0.95),
      billedUsd: total("billedUsd"),
      estimatedUsd: total("estimatedUsd"),
      tokens: total("tokens"),
    };
  }
  return {
    observed: rows.length,
    eligible: eligible.length,
    sharedGateMisses: rows.filter((r) => !r.eligible && r.expected).map((r) => r.id),
    disagreements: eligible.filter((r) => arms.some((arm) => r[arm].save !== r[arms[0]].save)).map((r) => r.id),
    arms: summaries,
  };
}
export const modelLabels = (models) => ({ baseline: label(models.baseline), luna: label(models.luna) });
