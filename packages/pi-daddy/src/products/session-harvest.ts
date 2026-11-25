/**
 * 2-Stage Classifier-Driven Closed-Loop Session Harvesting (Bucket 4 — Layer 3: products).
 *
 * Stage 1 (0ms, $0): Free deterministic signal filter — skips routine clean turns completely.
 * Stage 2 (Option A): Fast-tier structured JSON classifier (`models.fast` via fallback chain at
 * `reasoning: "off"`) inspects a secret-redacted turn digest and decides whether the turn reveals
 * a generalizable regression worth saving as a `skill-harness` `specification.yaml`.
 * Mode 2 ("auto", default): saves directly to `~/.pi/agent/pi-daddy/harvested-evals/<repo>/`
 * (zero git repo pollution), with `"suggest"` and `"off"` configurable in `ecosystem.json`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harvestOutputDir, resolveEcosystemModelCandidates, selectRegistryModel } from "../kernel/ecosystem-config.ts";

export interface TurnHarvestSignals {
  readonly prompt: string;
  readonly thrashDetected: boolean;
  readonly escalated: boolean;
  readonly reviewBlockers: number;
  readonly userSteered: boolean;
  readonly toolFailedAndEdited: boolean;
  readonly failureSummary: string;
  readonly editedFiles: readonly string[];
  readonly verifyCommands: readonly string[];
}

export type HarvestCategory = "thrash" | "review-blocker" | "user-correction" | "tool-failure" | "trivial";

export interface HarvestDecision {
  readonly harvest: boolean;
  readonly category: HarvestCategory;
  readonly confidence: number;
  readonly scenarioId: string;
  readonly reason: string;
  readonly modelUsed?: string;
}

export interface HarvestClassifierRegistry {
  find?(provider: string, modelId: string): unknown;
  streamSimple?(
    model: unknown,
    context: { messages: Array<{ role: string; content: Array<{ type: string; text: string }>; timestamp: number }> },
    options?: { signal?: AbortSignal; reasoning?: string },
  ): { result(): Promise<{ stopReason?: string; content?: Array<{ type?: string; text?: string }> }> };
}

export function hasHarvestSignal(s: TurnHarvestSignals): boolean {
  return Boolean(
    s.prompt.trim().length >= 12 &&
    (s.thrashDetected || s.escalated || s.reviewBlockers > 0 || s.userSteered || s.toolFailedAndEdited),
  );
}

export function redactHarvestText(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, "[REDACTED_KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED_SECRET]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED_TOKEN]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"'`]{8,}["']?/gi, "$1=[REDACTED]");
}

function slugify(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "harvested-regression"
  );
}

export async function classifyHarvestCandidate(input: {
  readonly signals: TurnHarvestSignals;
  readonly registry?: HarvestClassifierRegistry;
  readonly fallbackModel?: unknown;
  readonly minConfidence?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<HarvestDecision> {
  const minConfidence = input.minConfidence ?? 0.75;
  const skip = (reason: string): HarvestDecision => ({
    harvest: false,
    category: "trivial",
    confidence: 0,
    scenarioId: "",
    reason,
  });
  if (!hasHarvestSignal(input.signals)) return skip("no-harvest-signal");
  if (input.signal?.aborted) return skip("cancelled");

  const candidates = resolveEcosystemModelCandidates("fast", input.env ?? process.env);
  const picked = selectRegistryModel(input.registry, candidates, input.fallbackModel);
  if (!picked.model || typeof input.registry?.streamSimple !== "function") return skip("classifier-unavailable");

  const digest = redactHarvestText(
    [
      `Prompt: ${input.signals.prompt.slice(0, 800)}`,
      `Signals: thrash=${input.signals.thrashDetected} escalated=${input.signals.escalated}` +
        ` blockers=${input.signals.reviewBlockers} steered=${input.signals.userSteered}` +
        ` toolFailEdit=${input.signals.toolFailedAndEdited}`,
      `Edited files: ${input.signals.editedFiles.slice(0, 10).join(", ") || "(none)"}`,
      `Verify cmds: ${input.signals.verifyCommands.slice(0, 5).join(" ; ") || "(none)"}`,
      `Failure summary: ${input.signals.failureSummary.slice(0, 900) || "(none)"}`,
    ].join("\n"),
  );

  const instruction = [
    "You triage completed coding-agent turns for a regression benchmark suite (`skill-harness`).",
    "Decide if this turn exposed a generalizable agent/skill failure (thrash loop, wrong assumption,",
    "review blocker, tool misuse) worth saving as a regression eval, vs a trivial/one-off/env hiccup.",
    "Reply ONLY with strict JSON (no markdown fences):",
    '{"harvest":true|false,"category":"thrash"|"review-blocker"|"user-correction"|"tool-failure"|"trivial",',
    '"confidence":0.0..1.0,"scenarioId":"short-kebab-id","reason":"<=140 chars"}',
    "",
    digest,
  ].join("\n");

  let message: { stopReason?: string; content?: Array<{ type?: string; text?: string }> };
  try {
    const stream = input.registry.streamSimple(
      picked.model,
      { messages: [{ role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }] },
      { ...(input.signal ? { signal: input.signal } : {}), reasoning: "off" },
    );
    message = await stream.result();
  } catch {
    return skip("classifier-error");
  }
  if (input.signal?.aborted || (message?.stopReason && message.stopReason !== "stop"))
    return skip("classifier-incomplete");

  const text = (message?.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("")
    .trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return skip("invalid-classifier-json");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return skip("invalid-classifier-json");
  }

  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
  const rawCategory = String(parsed.category ?? "trivial");
  const category: HarvestCategory = ["thrash", "review-blocker", "user-correction", "tool-failure", "trivial"].includes(
    rawCategory,
  )
    ? (rawCategory as HarvestCategory)
    : "trivial";
  const scenarioId = slugify(String(parsed.scenarioId ?? input.signals.prompt.slice(0, 48)));
  const reason = redactHarvestText(String(parsed.reason ?? "")).slice(0, 180) || "classifier-triaged";
  const harvest = parsed.harvest === true && confidence >= minConfidence && category !== "trivial";
  return { harvest, category, confidence, scenarioId, reason, modelUsed: picked.label };
}

export function saveHarvestedEval(options: {
  readonly cwd: string;
  readonly scenarioId: string;
  readonly signals: TurnHarvestSignals;
  readonly reason?: string;
  readonly sessionFile?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly preferCli?: boolean;
}): { saved: boolean; path?: string; scenarioId: string; via: "skill-harness-cli" | "builtin"; error?: string } {
  const outRoot = harvestOutputDir(options.cwd, options.env ?? process.env);
  const id = slugify(options.scenarioId);
  mkdirSync(outRoot, { recursive: true, mode: 0o700 });

  if (options.preferCli !== false && options.sessionFile && existsSync(options.sessionFile)) {
    const cli = spawnSync("skill-harness", ["harvest", options.sessionFile, "--out", outRoot, "--id", id], {
      encoding: "utf8",
      timeout: 15_000,
      shell: process.platform === "win32",
    });
    if (cli.status === 0) {
      const m = `${cli.stdout ?? ""}`.match(/->\s*(\S+specification\.yaml)/);
      return { saved: true, path: m?.[1] ?? outRoot, scenarioId: id, via: "skill-harness-cli" };
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const specDir = join(outRoot, `${id}-${stamp}`, "tests");
  mkdirSync(specDir, { recursive: true, mode: 0o700 });
  const specPath = join(specDir, "specification.yaml");
  const prompt = redactHarvestText(options.signals.prompt).trim() || "Reproduce and fix the harvested session issue.";
  const reason = redactHarvestText(options.reason ?? options.signals.failureSummary).trim();
  const yaml = [
    `# Auto-harvested regression eval (pi-daddy Bucket 4)`,
    `skill: ${id}`,
    `version: 1`,
    `scenarios:`,
    `  - id: ${id}`,
    `    title: ${JSON.stringify(`Harvested: ${id}`)}`,
    `    prompt: ${JSON.stringify(prompt.slice(0, 2000))}`,
    ...(reason ? [`    notes: ${JSON.stringify(reason.slice(0, 400))}`] : []),
    `    criteria:`,
    `      - id: regression-fixed`,
    `        description: "Resolves the original task without repeating the harvested failure mode."`,
    ...(options.signals.verifyCommands.length
      ? [
          `      - id: verification-passes`,
          `        description: ${JSON.stringify(`Runs and passes: ${options.signals.verifyCommands[0]}`)}`,
        ]
      : []),
    "",
  ].join("\n");
  writeFileSync(specPath, yaml, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { saved: true, path: specPath, scenarioId: id, via: "builtin" };
}

export function createTurnHarvestTracker() {
  let prompt = "";
  let thrashDetected = false;
  let escalated = false;
  let reviewBlockers = 0;
  let userSteered = false;
  let toolError = false;
  let edited = false;
  let failureSummary = "";
  const editedFiles = new Set<string>();
  const verifyCommands: string[] = [];

  return {
    reset(nextPrompt = "") {
      prompt = nextPrompt;
      thrashDetected = false;
      escalated = false;
      reviewBlockers = 0;
      userSteered = false;
      toolError = false;
      edited = false;
      failureSummary = "";
      editedFiles.clear();
      verifyCommands.length = 0;
    },
    markThrash(detail: string) {
      thrashDetected = true;
      failureSummary = detail.slice(0, 400);
    },
    markEscalated() {
      escalated = true;
    },
    markReviewBlocker(feedback?: string) {
      reviewBlockers++;
      if (feedback) failureSummary = feedback.slice(0, 400);
    },
    markUserSteer() {
      userSteered = true;
    },
    observeToolStart(name: string, args?: Record<string, unknown>) {
      if ((name === "edit" || name === "write") && typeof args?.path === "string") {
        edited = true;
        editedFiles.add(args.path);
      } else if (name === "bash" && typeof args?.command === "string") {
        const cmd = args.command.trim();
        if (
          /\b(npm\s+test|vitest|node\s+--test|pytest|cargo\s+test|go\s+test)\b/i.test(cmd) &&
          !verifyCommands.includes(cmd)
        ) {
          verifyCommands.push(cmd);
        }
      }
    },
    observeToolEnd(isError?: boolean) {
      if (isError) toolError = true;
    },
    snapshot(): TurnHarvestSignals {
      return {
        prompt,
        thrashDetected,
        escalated,
        reviewBlockers,
        userSteered,
        toolFailedAndEdited: toolError && edited,
        failureSummary,
        editedFiles: [...editedFiles],
        verifyCommands: [...verifyCommands],
      };
    },
  };
}
