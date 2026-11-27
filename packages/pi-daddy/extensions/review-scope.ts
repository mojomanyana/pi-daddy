/**
 * Review scope resolution and diff collection:
 * - Ordinary requests stay confined to the nested workspace directory (`cwd`).
 * - Explicit whole-repo requests widen to the enclosing repo.
 * - Explicit multi-repo requests resolve a concrete list of Git repository roots,
 *   display the selected roots before review, and collect diffs ONLY from those roots
 *   (excluding any unrelated repositories).
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isUnderPiProjectDir } from "../src/kernel/project-paths.ts";

const execFileAsync = promisify(execFile);

const WHOLE_REPO_REQUEST_RE = /\b(whole\s+repo|entire\s+repo|full\s+repo)\b/i;
const MULTI_REPO_REQUEST_RE =
  /\b(multi-repo|multiple\s+repos?|across\s+(?:these|the|selected)?\s*repos?|repos?(?:itories)?)\b/i;

export interface ReviewScope {
  readonly mode: "workspace" | "whole-repo" | "multi-repo";
  readonly cwd: string;
  readonly roots: readonly string[];
  readonly label: string;
}

function canonicalGitRoot(dir: string): string | undefined {
  try {
    if (!existsSync(dir)) return undefined;
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return undefined;
    return realpathSync(out);
  } catch {
    return undefined;
  }
}

function dedupeGitRoots(cwd: string, candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const raw of candidates) {
    const trimmed = raw.trim().replace(/^["'`]|["'`.,;:)]$/g, "");
    if (!trimmed) continue;
    const abs = resolve(cwd, trimmed);
    const root = canonicalGitRoot(abs);
    if (root && !seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

function extractPromptRepoCandidates(cwd: string, prompt: string): string[] {
  const candidates: string[] = [];
  // 1. Explicit path-like tokens (POSIX absolute, Windows drive, or relative ./ / ../)
  const pathTokenRe =
    /(?:["'`])((?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^"'`\r\n]+)(?:["'`])|(?:^|[\s,(])((?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^\s,);:]+)/g;
  for (const match of prompt.matchAll(pathTokenRe)) {
    const token = match[1] ?? match[2];
    if (token) candidates.push(token);
  }
  // 2. When prompt asks for a multi-repo review, match explicit repo folder names under cwd or dirname(cwd).
  if (MULTI_REPO_REQUEST_RE.test(prompt)) {
    for (const parent of new Set([cwd, dirname(cwd)])) {
      try {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const mentionRe = new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "i");
          if (mentionRe.test(prompt)) candidates.push(join(parent, entry.name));
        }
      } catch {
        /* Ignore unreadable parent directory. */
      }
    }
  }
  return candidates;
}

/**
 * Resolve the concrete review scope:
 * - Explicit `explicitRoots` (or concrete named repo roots in the prompt) -> `multi-repo` confined to those roots.
 * - Explicit whole-repo phrasing without concrete multi-repo roots -> `whole-repo`.
 * - Ordinary request -> `workspace` confined to `cwd`.
 */
export function resolveReviewScope(cwd: string, prompt: string, explicitRoots?: readonly string[]): ReviewScope {
  if (explicitRoots && explicitRoots.length > 0) {
    const roots = dedupeGitRoots(cwd, explicitRoots);
    if (roots.length > 0) {
      return {
        mode: "multi-repo",
        cwd,
        roots,
        label: `multi-repo (${roots.length} roots: ${roots.join(", ")})`,
      };
    }
  }

  const promptRoots = dedupeGitRoots(cwd, extractPromptRepoCandidates(cwd, prompt));
  const cwdRoot = canonicalGitRoot(cwd);
  if (
    promptRoots.length >= 2 ||
    (promptRoots.length === 1 && MULTI_REPO_REQUEST_RE.test(prompt) && promptRoots[0] !== cwdRoot)
  ) {
    return {
      mode: "multi-repo",
      cwd,
      roots: promptRoots,
      label: `multi-repo (${promptRoots.length} roots: ${promptRoots.join(", ")})`,
    };
  }

  if (WHOLE_REPO_REQUEST_RE.test(prompt)) {
    return {
      mode: "whole-repo",
      cwd,
      roots: [cwdRoot ?? cwd],
      label: `whole-repo (widened by request from ${cwd})`,
    };
  }

  return { mode: "workspace", cwd, roots: [cwd], label: `workspace (${cwd})` };
}

/** Format a clear operator-visible summary of the selected review root(s) shown before review begins. */
export function formatReviewScopeBanner(scope: ReviewScope): string {
  if (scope.mode === "multi-repo") {
    return [
      `Review scope: multi-repo (${scope.roots.length} selected repository roots):`,
      ...scope.roots.map((root) => `  - ${root}`),
    ].join("\n");
  }
  return `Review scope: ${scope.label}`;
}

async function collectSingleRootDiff(cwd: string, scopeMode: "workspace" | "whole-repo"): Promise<string> {
  const parts: string[] = [];
  let diff = "";
  const pathspec = scopeMode === "workspace" ? ["--", "."] : [];
  try {
    const out = await execFileAsync("git", ["diff", "--no-color", "HEAD", ...pathspec], {
      cwd,
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    diff = out.stdout.trim();
  } catch {
    try {
      const out = await execFileAsync("git", ["diff", "--no-color", "--cached", ...pathspec], {
        cwd,
        timeout: 5000,
        maxBuffer: 256 * 1024,
      });
      diff = out.stdout.trim();
    } catch {
      diff = "";
    }
  }
  if (diff) parts.push(diff);

  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", ...pathspec], {
      cwd,
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const untracked = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith(".") && !s.startsWith("../") && !s.endsWith(".log") && !isUnderPiProjectDir(s))
      .slice(0, 12);
    let extraBytes = 0;
    for (const rel of untracked) {
      if (extraBytes >= 12_000) break;
      try {
        const full = join(cwd, rel);
        const info = await stat(full);
        if (!info.isFile() || info.size === 0 || info.size > 32 * 1024) continue;
        const raw = await readFile(full, "utf8");
        if (raw.includes("\0")) continue;
        const snippet = raw.slice(0, Math.min(raw.length, 12_000 - extraBytes));
        extraBytes += snippet.length;
        parts.push(`--- /dev/null\n+++ b/${rel}\n${snippet}`);
      } catch {
        /* Skip unreadable untracked file. */
      }
    }
  } catch {
    /* Non-git workspace or git unavailable. */
  }
  return parts.join("\n\n").trim();
}

export async function collectReviewDiff(
  cwd: string,
  scopeOrMode: "workspace" | "whole-repo" | ReviewScope = "workspace",
): Promise<string> {
  if (typeof scopeOrMode === "string") {
    return collectSingleRootDiff(cwd, scopeOrMode);
  }
  if (scopeOrMode.mode === "multi-repo") {
    const sections: string[] = [];
    for (const root of scopeOrMode.roots) {
      const rootDiff = await collectSingleRootDiff(root, "whole-repo");
      if (rootDiff) sections.push(`=== REPOSITORY: ${root} ===\n${rootDiff}`);
    }
    return sections.join("\n\n").trim();
  }
  return collectSingleRootDiff(scopeOrMode.cwd, scopeOrMode.mode);
}
