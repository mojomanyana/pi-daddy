/**
 * Phase-2 SOTA tools:
 * - `delegate_tournament`: runs 2-3 parallel flash candidates in isolated git worktrees,
 *   verifies each objectively with `verifyCommand`, cold-judges ties, and applies the winner.
 * - `quick_review`: Tier-1 fast in-process read-only review/architect/investigate (<200ms overhead,
 *   cross-platform, routes to PI_ECO_MODEL_STRONG / PI_ECO_MODEL_FAST when configured).
 *
 * Both register with `defaultActive: false` (0 Turn-1 schema bytes in Standard mode) and are
 * auto-activated for Ambitious `range` / `altitude` runs in `extensions/work-mode.ts`.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runWorktreeTournament, type CandidateRunResult } from "../src/executors/worktree-tournament.ts";
import { resolveTierModel, runInProcessReadOnly, type StreamRegistry } from "../src/executors/inprocess-readonly.ts";
import type { GrantsSession } from "./session.ts";

const DEFAULT_APPROACHES = [
  "Clean minimal implementation focused on strict correctness and zero over-engineering.",
  "Concurrency-safe, edge-case-hardened algorithmic design with explicit resource cleanup.",
  "Alternative architecture prioritizing simplicity, clear invariants, and thorough tests.",
];

function runPiCandidate(input: {
  task: string;
  approach: string;
  worktree: string;
  model?: string;
  thinking: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; summary: string; error?: string }> {
  const prompt = [
    input.task,
    "",
    `Design emphasis for this candidate: ${input.approach}`,
    "Implement the changes directly in this workspace, run tests to verify, and summarize concisely.",
  ].join("\n");
  const args = [
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-mcp",
    "--tools",
    "read,bash,edit,write",
    "--thinking",
    input.thinking,
  ];
  if (input.model) args.push("--model", input.model);
  args.push(prompt);
  return new Promise((resolve) => {
    const child = spawn("pi", args, {
      cwd: input.worktree,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_DADDY_HERDR: "0", PI_DADDY_ACTIVITY_TIMELINE: "off" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (res: { ok: boolean; summary: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(res);
    };
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finish({ ok: false, summary: "", error: "candidate aborted" });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finish({ ok: false, summary: "", error: "candidate timed out after 120s" });
    }, 120_000);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d) => {
      if (stdout.length < 256 * 1024) stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < 64 * 1024) stderr += String(d);
    });
    child.once("error", (err) => finish({ ok: false, summary: "", error: err.message.slice(0, 400) }));
    child.once("close", (code) => {
      if (code === 0) finish({ ok: true, summary: stdout.trim().slice(-1500) });
      else finish({ ok: false, summary: "", error: (stderr || stdout || `exit ${code}`).trim().slice(0, 400) });
    });
  });
}

async function judgePassingCandidates(
  ctx: ExtensionContext,
  task: string,
  passing: readonly CandidateRunResult[],
  signal?: AbortSignal,
): Promise<{ winnerIndex: number; rationale: string }> {
  const registry = (ctx as unknown as { modelRegistry?: StreamRegistry }).modelRegistry;
  const fallbackModel = (ctx as unknown as { model?: unknown }).model;
  if (!registry?.streamSimple || !fallbackModel) {
    return { winnerIndex: passing[0].index, rationale: "Selected first passing candidate." };
  }
  const { model } = resolveTierModel(registry, "review", fallbackModel);
  const sections = passing.map(
    (c) =>
      `### CANDIDATE ${c.index + 1} (${c.approach})\nFiles: ${c.changedFiles.join(", ")}\n` +
      `Verify output:\n${c.verifyOutput.slice(0, 800)}\nDiff:\n${c.diff.slice(0, 8000)}`,
  );
  const prompt = [
    "You are a cold senior judge picking the best passing implementation for the task below.",
    "Compare correctness, concurrency safety, edge-case coverage, memory cleanup, and simplicity.",
    'Reply with JSON only: {"winner": <1-based candidate number>, "rationale": "<concise reason>"}',
    "",
    "=== TASK ===",
    task.slice(0, 3000),
    "",
    ...sections,
  ].join("\n");
  try {
    const stream = registry.streamSimple(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      { signal, reasoning: "medium" },
    );
    const msg = await stream.result();
    const raw = (msg?.content ?? [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("\n");
    const match = /\{[\s\S]*\}/.exec(raw);
    if (match) {
      const parsed = JSON.parse(match[0]) as { winner?: number; rationale?: string };
      const chosen = passing.find((c) => c.index === (parsed.winner ?? 0) - 1);
      if (chosen) {
        return {
          winnerIndex: chosen.index,
          rationale: String(parsed.rationale ?? "Selected by cold diff judge.").slice(0, 400),
        };
      }
    }
  } catch {
    /* Fall back cleanly to deterministic smallest passing diff. */
  }
  const smallest = [...passing].sort((a, b) => a.diff.length - b.diff.length)[0];
  return { winnerIndex: smallest.index, rationale: "Selected smallest clean passing diff." };
}

export function registerTournamentTools(pi: ExtensionAPI, session: GrantsSession): void {
  pi.registerTool({
    name: "delegate_tournament",
    label: "Parallel worktree tournament",
    defaultActive: false,
    description:
      "Run 2-3 parallel implementation candidates in isolated git worktrees using fast flash models, " +
      "verify each objectively with verifyCommand, pick the cleanest passing diff via cold judge, " +
      "apply the winning files, and clean up all worktrees.",
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 6000 }),
      verifyCommand: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      candidates: Type.Optional(Type.Integer({ minimum: 2, maximum: 3 })),
      approaches: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { minItems: 2, maxItems: 3 }),
      ),
      applyWinner: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!session.mayDelegate) {
        throw new Error("delegation refused: session does not hold tool:delegate");
      }
      const count = params.approaches?.length ?? params.candidates ?? 2;
      const approaches = params.approaches ?? DEFAULT_APPROACHES.slice(0, count);
      const ctxModel = (ctx as unknown as { model?: { provider?: string; id?: string } }).model;
      const workerModel =
        process.env.PI_ECO_MODEL_WORK?.trim() ||
        process.env.PI_ECO_MODEL_FAST?.trim() ||
        (ctxModel?.provider && ctxModel?.id ? `${ctxModel.provider}/${ctxModel.id}` : undefined);
      const outcome = await runWorktreeTournament({
        repoRoot: ctx.cwd,
        task: params.task,
        approaches,
        verifyCommand: params.verifyCommand,
        applyWinner: params.applyWinner ?? true,
        signal,
        runCandidate: ({ approach, worktree, signal: candSignal }) =>
          runPiCandidate({
            task: params.task,
            approach,
            worktree,
            model: workerModel,
            thinking: "low",
            signal: candSignal,
          }),
        judgeWinner: (passing, judgeSignal) => judgePassingCandidates(ctx, params.task, passing, judgeSignal),
      });
      const summary = {
        winner: outcome.winnerIndex === null ? null : outcome.winnerIndex + 1,
        applied: outcome.applied,
        rationale: outcome.rationale,
        candidates: outcome.candidates.map((c) => ({
          candidate: c.index + 1,
          approach: c.approach,
          ok: c.ok,
          verifyPassed: c.verifyPassed,
          changedFiles: c.changedFiles,
          ...(c.error ? { error: c.error } : {}),
        })),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        details: summary,
      };
    },
  });

  pi.registerTool({
    name: "quick_review",
    label: "Fast in-process read-only review/architect",
    defaultActive: false,
    description:
      "Run a fast (<2s), cross-platform, in-process read-only review, architecture critique, or " +
      "factual investigation over named workspace files without spawning a subprocess.",
    parameters: Type.Object({
      role: Type.Union([Type.Literal("review"), Type.Literal("architect"), Type.Literal("investigate")]),
      question: Type.String({ minLength: 1, maxLength: 6000 }),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 })),
      extraContext: Type.Optional(Type.String({ maxLength: 16000 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const registry = (ctx as unknown as { modelRegistry?: StreamRegistry }).modelRegistry;
      const defaultModel = (ctx as unknown as { model?: unknown }).model;
      if (!registry) throw new Error("Pi modelRegistry is unavailable");
      const res = await runInProcessReadOnly({
        role: params.role,
        question: params.question,
        cwd: ctx.cwd,
        files: params.files,
        extraContext: params.extraContext,
        defaultModel,
        registry,
        signal,
      });
      return {
        content: [{ type: "text" as const, text: res.text }],
        details: {
          role: res.role,
          modelUsed: res.modelUsed,
          filesRead: res.filesRead,
          skippedFiles: res.skippedFiles,
        },
      };
    },
  });
}
