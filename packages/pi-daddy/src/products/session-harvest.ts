/**
 * 2-Stage Classifier-Driven Closed-Loop Session Harvesting (Bucket 4 — Layer 3: products).
 *
 * Stage 1 (0ms, $0): Free deterministic signal filter — skips routine clean turns completely.
 * Stage 2 (Option A): Fast-tier structured JSON classifier (`models.fast` via fallback chain at
 * `reasoning: "off"`) inspects a secret-redacted turn digest and decides whether the turn reveals
 * a generalizable regression worth saving as a Harness-validated `specification.yaml`.
 * Mode 2 ("auto", default): saves directly to `~/.pi/agent/pi-daddy/harvested-evals/<repo>/`
 * (zero git repo pollution), with `"suggest"` and `"off"` configurable in `ecosystem.json`.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
    .replace(/\b(Basic\s+)[A-Za-z0-9+/=]{12,}/gi, "$1[REDACTED_TOKEN]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi, "$1[REDACTED]$3")
    .replace(
      /\b([A-Z0-9_]*(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*)\s*([:=])\s*["']?[^\s"'`;]+["']?/gi,
      "$1$2[REDACTED]",
    );
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

function yamlStr(value: string): string {
  return JSON.stringify(value);
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
  if (input.signal?.aborted || (message?.stopReason && message.stopReason !== "stop")) {
    return skip("classifier-incomplete");
  }

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

function invokeHarnessCli(options: {
  readonly sessionFile: string;
  readonly outRoot: string;
  readonly scenarioId: string;
  readonly uniqueSkill: string;
  readonly prompt: string;
  readonly reason: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cliCommand?: string;
  readonly cliArgsPrefix?: readonly string[];
}): { specPath: string; scenarioId: string } | undefined {
  const cmd = options.cliCommand ?? (process.platform === "win32" ? "skill-harness.cmd" : "skill-harness");
  const cliArgs = [
    ...(options.cliArgsPrefix ?? []),
    "harvest",
    options.sessionFile,
    "--out",
    options.outRoot,
    "--name",
    options.uniqueSkill,
    "--id",
    options.scenarioId,
    "--prompt",
    options.prompt,
    ...(options.reason ? ["--notes", options.reason] : []),
    "--unique",
    "--json",
  ];
  const res = spawnSync(cmd, cliArgs, {
    encoding: "utf8",
    timeout: 15_000,
    env: options.env,
    shell: false,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) return undefined;
  const lines = String(res.stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as { specPath?: unknown; scenarioId?: unknown };
      if (typeof parsed.specPath === "string" && existsSync(parsed.specPath)) {
        return {
          specPath: parsed.specPath,
          scenarioId:
            typeof parsed.scenarioId === "string" && parsed.scenarioId ? parsed.scenarioId : options.scenarioId,
        };
      }
    } catch {
      /* ignore non-JSON prelude line */
    }
  }
  return undefined;
}

export function saveHarvestedEval(options: {
  readonly cwd: string;
  readonly scenarioId: string;
  readonly signals: TurnHarvestSignals;
  readonly reason?: string;
  readonly sessionFile?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly outDirOverride?: string;
  readonly preferCli?: boolean;
  readonly cliCommand?: string;
  readonly cliArgsPrefix?: readonly string[];
}): { saved: boolean; path?: string; scenarioId: string; via: "skill-harness-cli" | "builtin"; error?: string } {
  const env = options.env ?? process.env;
  const outRoot = options.outDirOverride ?? harvestOutputDir(options.cwd, env);
  const id = slugify(redactHarvestText(options.scenarioId));
  const prompt = redactHarvestText(options.signals.prompt).trim();
  if (!prompt) {
    return { saved: false, scenarioId: id, via: "builtin", error: "Cannot harvest an empty turn prompt" };
  }
  const reason = redactHarvestText(options.reason ?? options.signals.failureSummary)
    .trim()
    .slice(0, 400);
  const editedFiles = [
    ...new Set(options.signals.editedFiles.map((f) => redactHarvestText(f).trim()).filter(Boolean)),
  ].slice(0, 12);
  const verifyCommands = [
    ...new Set(options.signals.verifyCommands.map((c) => redactHarvestText(c).trim()).filter(Boolean)),
  ].slice(0, 8);
  const uniqueToken = randomBytes(4).toString("hex");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uniqueSkill = slugify(`${id}-${stamp}-${uniqueToken}`);

  mkdirSync(outRoot, { recursive: true, mode: 0o700 });

  if (options.preferCli !== false && options.sessionFile && existsSync(options.sessionFile)) {
    const cliResult = invokeHarnessCli({
      sessionFile: options.sessionFile,
      outRoot,
      scenarioId: id,
      uniqueSkill,
      prompt: prompt.slice(0, 4000),
      reason,
      env,
      cliCommand: options.cliCommand,
      cliArgsPrefix: options.cliArgsPrefix,
    });
    if (cliResult) {
      return { saved: true, path: cliResult.specPath, scenarioId: cliResult.scenarioId, via: "skill-harness-cli" };
    }
  }

  // Built-in exporter emits the exact schema validated by skill-harness's `loadSpec`/`parseSpec`.
  const skillRoot = join(outRoot, uniqueSkill);
  const testsDir = join(skillRoot, "tests");
  mkdirSync(testsDir, { recursive: true, mode: 0o700 });
  const specPath = join(testsDir, "specification.yaml");
  const checklist = [
    "Satisfies every explicit requirement in the user prompt",
    ...(editedFiles.length
      ? [`Modifies the relevant target file(s) cleanly (${editedFiles.slice(0, 4).join(", ")})`]
      : []),
    ...(verifyCommands.length
      ? [`Runs executable verification checks and confirms they pass (${verifyCommands[0].slice(0, 160)})`]
      : []),
    ...(reason ? [`Addresses harvested failure mode: ${reason}`] : []),
  ];
  const yaml = [
    `skill: ${yamlStr(uniqueSkill)}`,
    `judge_persona: ${yamlStr("rigorous senior engineer grading exact functional correctness, edge cases, and clean verification")}`,
    `ship_bar:`,
    `  total: 1`,
    `  min_pass: 1`,
    `  no_critical_fail: true`,
    `critical:`,
    `  - ${yamlStr(id)}`,
    `scenarios:`,
    `  - id: ${yamlStr(id)}`,
    `    title: ${yamlStr(`Harvested: ${id}`)}`,
    `    critical: true`,
    `    turns:`,
    `      - ${yamlStr(prompt.slice(0, 4000))}`,
    `    checklist:`,
    ...checklist.map((item) => `      - ${yamlStr(item)}`),
    "",
  ].join("\n");
  writeFileSync(specPath, yaml, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const skillMd = join(skillRoot, "SKILL.md");
  if (!existsSync(skillMd)) {
    writeFileSync(
      skillMd,
      `---\nname: ${uniqueSkill}\ndescription: Use when handling tasks similar to harvested scenario ${id}.\n---\n# ${uniqueSkill}\n\nHarvested regression skill placeholder.\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
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
