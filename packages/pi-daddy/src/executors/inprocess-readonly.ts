/**
 * Tier-1 Fast In-Process Read-Only Subagent Runner (Layer 2: executors).
 *
 * Executes read-only `review`, `architect`, or `investigate` passes directly in-process
 * via Pi's modelRegistry.streamSimple (<150ms overhead, cross-platform Linux/macOS/Windows,
 * zero OS subprocess spinup, zero write/bash capability by construction).
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveEcosystemModelTier } from "../kernel/ecosystem-config.ts";

export type ReadOnlyRole = "review" | "architect" | "investigate";

export interface StreamRegistry {
  find?(provider: string, modelId: string): unknown;
  streamSimple?(
    model: unknown,
    context: { messages: Array<{ role: string; content: Array<{ type: string; text: string }>; timestamp: number }> },
    options?: { signal?: AbortSignal; reasoning?: string },
  ): { result(): Promise<{ content?: Array<{ type?: string; text?: string }> }> };
}

export interface InProcessReadOnlyInput {
  readonly role: ReadOnlyRole;
  readonly question: string;
  readonly cwd: string;
  readonly files?: readonly string[];
  readonly extraContext?: string;
  readonly defaultModel: unknown;
  readonly registry: StreamRegistry;
  readonly modelOverride?: string;
  readonly reasoning?: string;
  readonly signal?: AbortSignal;
}

export interface InProcessReadOnlyResult {
  readonly role: ReadOnlyRole;
  readonly text: string;
  readonly filesRead: string[];
  readonly skippedFiles: string[];
  readonly modelUsed: string;
}

const MAX_FILES = 12;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024;

const ROLE_INSTRUCTIONS: Record<ReadOnlyRole, string> = {
  review:
    "You are an independent cold senior reviewer. Inspect ONLY the supplied code/diff against the requirements. " +
    "List concrete [BLOCKER] defects (correctness, concurrency, edge cases, resource leaks, API breaks) with file/line " +
    "and minimal fix, or state VERDICT: PASS if solid. Zero style nitpicks.",
  architect:
    "You are a principal software architect. Identify the deciding constraint, key boundary/concurrency/lifecycle risks, " +
    "and recommend the simplest robust design in concise bullets. Name tradeoffs explicitly.",
  investigate:
    "You are a factual codebase investigator. Report only what the supplied files actually do, with exact file/symbol " +
    "citations and explicit gaps for anything not shown.",
};

export function resolveTierModel(
  registry: StreamRegistry,
  role: ReadOnlyRole,
  fallback: unknown,
  explicitOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
): { model: unknown; label: string } {
  const tierEnv =
    explicitOverride?.trim() || resolveEcosystemModelTier(role === "investigate" ? "fast" : "strong", env);
  if (tierEnv && typeof registry.find === "function") {
    const sep = tierEnv.includes("/") ? "/" : ":";
    const idx = tierEnv.indexOf(sep);
    if (idx > 0) {
      const found = registry.find(tierEnv.slice(0, idx).trim(), tierEnv.slice(idx + 1).trim());
      if (found) return { model: found, label: tierEnv };
    }
  }
  const fb = fallback as { provider?: string; id?: string } | undefined;
  return {
    model: fallback,
    label: fb?.provider && fb?.id ? `${fb.provider}/${fb.id}` : "session-default",
  };
}

export async function loadBoundedWorkspaceFiles(
  cwd: string,
  files: readonly string[],
): Promise<{ blocks: string[]; filesRead: string[]; skippedFiles: string[] }> {
  const root = resolve(cwd);
  const blocks: string[] = [];
  const filesRead: string[] = [];
  const skippedFiles: string[] = [];
  let totalBytes = 0;

  for (const rel of files.slice(0, MAX_FILES)) {
    const abs = resolve(root, rel);
    if (!abs.startsWith(root)) {
      skippedFiles.push(`${rel} (outside workspace)`);
      continue;
    }
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        skippedFiles.push(`${rel} (oversized or non-file)`);
        continue;
      }
      const raw = await readFile(abs, "utf8");
      if (raw.includes("\0")) {
        skippedFiles.push(`${rel} (binary)`);
        continue;
      }
      if (totalBytes + raw.length > MAX_TOTAL_BYTES) {
        skippedFiles.push(`${rel} (budget reached)`);
        continue;
      }
      totalBytes += raw.length;
      filesRead.push(rel);
      blocks.push(`=== FILE: ${rel} ===\n${raw}`);
    } catch {
      skippedFiles.push(`${rel} (unreadable)`);
    }
  }
  return { blocks, filesRead, skippedFiles };
}

export async function runInProcessReadOnly(input: InProcessReadOnlyInput): Promise<InProcessReadOnlyResult> {
  if (typeof input.registry.streamSimple !== "function") {
    throw new Error("In-process read-only runner requires Pi modelRegistry.streamSimple");
  }
  const { model, label } = resolveTierModel(input.registry, input.role, input.defaultModel, input.modelOverride);
  if (!model) {
    throw new Error("Select a Pi model before invoking quick_review");
  }
  const { blocks, filesRead, skippedFiles } = await loadBoundedWorkspaceFiles(input.cwd, input.files ?? []);
  const promptParts = [
    ROLE_INSTRUCTIONS[input.role],
    "",
    "=== QUESTION / REQUIREMENTS ===",
    input.question.slice(0, 6000),
  ];
  if (input.extraContext?.trim()) {
    promptParts.push("", "=== EXTRA CONTEXT ===", input.extraContext.trim().slice(0, 16_000));
  }
  if (blocks.length > 0) {
    promptParts.push("", ...blocks);
  }
  const reasoning = input.reasoning ?? (input.role === "investigate" ? "low" : "medium");
  const stream = input.registry.streamSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: promptParts.join("\n") }],
          timestamp: Date.now(),
        },
      ],
    },
    { signal: input.signal, reasoning },
  );
  const message = await stream.result();
  const text = (message?.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n")
    .trim();
  return {
    role: input.role,
    text: text || "(no output returned)",
    filesRead,
    skippedFiles,
    modelUsed: label,
  };
}
