/**
 * Review scope resolution and diff collection:
 * - Ordinary requests stay confined to the nested workspace directory (`cwd`), even when
 *   task prose mentions paths to other repositories as context.
 * - Explicit whole-repo requests widen to the enclosing repo.
 * - Explicit multi-repo review requests (or explicit `explicitRoots`) resolve a concrete list
 *   of Git repository roots, display selected roots before review, and collect diffs ONLY from
 *   those roots (excluding any unrelated repositories).
 * - Untracked-file reads use the bounded, no-follow reader and enforce strict scope confinement,
 *   rejecting symlinks and path swaps between inspection and read.
 */
import { execFile, execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { readBoundedTextSync, type SyncReadPorts } from "../src/kernel/bounded-read-sync.ts";
import { isUnderPiProjectDir } from "../src/kernel/project-paths.ts";

const execFileAsync = promisify(execFile);

const WHOLE_REPO_REQUEST_RE = /\b(whole\s+repo|entire\s+repo|full\s+repo)\b/i;

/**
 * Multi-repo widening requires explicit review/audit intent targeting multiple repositories,
 * never mere mention of two repository paths inside an ordinary task prompt.
 */
const EXPLICIT_MULTI_REPO_REVIEW_PATTERNS: readonly RegExp[] = [
  /\bmulti-repo\s+(?:review|audit|check|diff)\b/i,
  /\b(?:review|audit)\s+(?:changes\s+|diffs?\s+)?across\b/i,
  /\b(?:review|audit)\b[^.\n]{0,80}\b(?:multi-repo|multiple\s+repos?(?:itories)?|both\s+repos?(?:itories)?|selected\s+repos?(?:itories)?)\b/i,
  /\b(?:review|audit)\s+(?:these|both|the\s+selected)?\s*repos?(?:itories)?\b/i,
];
const hasExplicitMultiRepoReviewIntent = (prompt: string) =>
  EXPLICIT_MULTI_REPO_REVIEW_PATTERNS.some((re) => re.test(prompt));

const MAX_UNTRACKED_FILE_BYTES = 32 * 1024;

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
  // 2. Match explicit repository folder names under cwd or dirname(cwd) when explicitly named in the review prompt.
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
  return candidates;
}

function splitPromptClauses(prompt: string): string[] {
  return prompt
    .split(
      /(?:[\r\n]+|;+|(?<=[.!?])\s+|,\s*(?=(?:but\s+)?(?:exclude|excluding|except|ignore|skip|do\s+not|don't|without|context\b|for\s+context|as\s+context)))/i,
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

const EXCLUSION_PATTERNS = [
  /\b(?:exclude|excluding|except(?:\s+for)?|ignore|ignoring)\b/i,
  /\b(?:skip(?:ping)?|leave\s+out|leaving\s+out|omit|omitting|without)\b/i,
  /\b(?:leave|left)\b[^.;\n]{0,40}\bout\b/i,
  /\b(?:do\s+not|don't)\s+(?:review|include|diff)\b/i,
];

function isExclusionClause(clause: string): boolean {
  return EXCLUSION_PATTERNS.some((re) => re.test(clause));
}

function isAffirmativeReviewSelectionClause(clause: string): boolean {
  return hasExplicitMultiRepoReviewIntent(clause) && !isExclusionClause(clause);
}

function resolveAffirmativePromptRoots(cwd: string, prompt: string): string[] {
  const clauses = splitPromptClauses(prompt);
  const excludedRoots = new Set<string>();
  const affirmativeCandidates: string[] = [];

  for (const clause of clauses) {
    if (isExclusionClause(clause)) {
      const candidates = extractPromptRepoCandidates(cwd, clause);
      for (const root of dedupeGitRoots(cwd, candidates)) {
        excludedRoots.add(root);
      }
    }
    if (isAffirmativeReviewSelectionClause(clause)) {
      const candidates = extractPromptRepoCandidates(cwd, clause);
      affirmativeCandidates.push(...candidates);
    }
  }

  const candidateRoots = dedupeGitRoots(cwd, affirmativeCandidates);
  return candidateRoots.filter((root) => !excludedRoots.has(root));
}

/**
 * Resolve the concrete review scope:
 * - Explicit `explicitRoots` -> `multi-repo` confined to those Git roots.
 * - Explicit multi-repo review request naming concrete repositories -> `multi-repo` confined to those roots.
 * - Explicit whole-repo phrasing -> `whole-repo`.
 * - Ordinary request (even if it mentions other repo paths as context) -> `workspace` confined to `cwd`.
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

  const cwdRoot = canonicalGitRoot(cwd);
  if (hasExplicitMultiRepoReviewIntent(prompt)) {
    const promptRoots = resolveAffirmativePromptRoots(cwd, prompt);
    if (promptRoots.length >= 2 || (promptRoots.length === 1 && promptRoots[0] !== cwdRoot)) {
      return {
        mode: "multi-repo",
        cwd,
        roots: promptRoots,
        label: `multi-repo (${promptRoots.length} roots: ${promptRoots.join(", ")})`,
      };
    }
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

function isStrictlyInside(canonicalRoot: string, candidateCanonical: string): boolean {
  const rel = relative(canonicalRoot, candidateCanonical);
  return Boolean(
    rel &&
    rel !== ".." &&
    !rel.startsWith("../") &&
    !rel.startsWith("..\\") &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel),
  );
}

/**
 * Bounded, no-follow, scope-confined reader for an untracked file under `scopeRoot`.
 * Rejects symlinks (both intermediate directory components and final leaf), enforces
 * byte bounds via `readBoundedTextSync`, and pins `(dev, ino)` across open/read so a
 * path swap between inspection and read cannot exfiltrate files outside `scopeRoot`.
 */
export function readConfinedUntrackedFile(
  scopeRoot: string,
  rel: string,
  maxBytes: number,
  io?: Partial<SyncReadPorts>,
): string | undefined {
  if (!rel || rel.includes("\0") || isAbsolute(rel) || isUnderPiProjectDir(rel)) return undefined;
  const segments = rel.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) return undefined;

  try {
    const canonicalRoot = realpathSync(scopeRoot);
    // Reject any symlink along the path inside scopeRoot (intermediate dirs and final leaf).
    let cur = canonicalRoot;
    let leafStat: ReturnType<typeof lstatSync> | undefined;
    for (let i = 0; i < segments.length; i++) {
      cur = join(cur, segments[i]!);
      const st = lstatSync(cur, { bigint: true });
      if (st.isSymbolicLink()) return undefined;
      if (i < segments.length - 1) {
        if (!st.isDirectory()) return undefined;
      } else {
        leafStat = st;
      }
    }
    if (!leafStat || !leafStat.isFile() || leafStat.size === 0n || leafStat.size > BigInt(MAX_UNTRACKED_FILE_BYTES)) {
      return undefined;
    }
    const realLeaf = realpathSync(cur);
    if (!isStrictlyInside(canonicalRoot, realLeaf)) return undefined;

    const baseStat = io?.stat ?? fstatSync;
    const pinnedIo: SyncReadPorts = {
      open: io?.open ?? openSync,
      close: io?.close ?? closeSync,
      read: io?.read ?? readSync,
      realpath: io?.realpath ?? realpathSync,
      stat: ((fd: number, opts?: Parameters<typeof fstatSync>[1]) => {
        const big = fstatSync(fd, { bigint: true });
        if (!big.isFile() || big.dev !== leafStat!.dev || big.ino !== leafStat!.ino) {
          throw new Error("untracked file changed between inspection and open");
        }
        return baseStat(fd, opts as never);
      }) as typeof fstatSync,
    };
    const res = readBoundedTextSync(cur, { maxBytes, prefix: true, confinedRoot: canonicalRoot }, pinnedIo);
    // Post-read check catches path replacement with a symlink/external target during the read.
    const postStat = lstatSync(cur, { bigint: true });
    if (
      postStat.isSymbolicLink() ||
      !postStat.isFile() ||
      postStat.dev !== leafStat.dev ||
      postStat.ino !== leafStat.ino
    ) {
      return undefined;
    }
    if (!isStrictlyInside(canonicalRoot, realpathSync(cur))) return undefined;
    if (res.text.includes("\0")) return undefined;
    return res.text;
  } catch {
    return undefined;
  }
}

async function collectSingleRootDiff(cwd: string, scopeMode: "workspace" | "whole-repo"): Promise<string> {
  const parts: string[] = [];
  let diff = "";
  const pathspec = scopeMode === "workspace" ? ["--", "."] : [];
  const effectiveRoot = scopeMode === "whole-repo" ? (canonicalGitRoot(cwd) ?? cwd) : cwd;
  try {
    const out = await execFileAsync("git", ["diff", "--no-color", "HEAD", ...pathspec], {
      cwd: effectiveRoot,
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    diff = out.stdout.trim();
  } catch {
    try {
      const out = await execFileAsync("git", ["diff", "--no-color", "--cached", ...pathspec], {
        cwd: effectiveRoot,
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
      cwd: effectiveRoot,
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
      const remaining = 12_000 - extraBytes;
      const snippet = readConfinedUntrackedFile(effectiveRoot, rel, remaining);
      if (!snippet) continue;
      extraBytes += Buffer.byteLength(snippet, "utf8");
      parts.push(`--- /dev/null\n+++ b/${rel}\n${snippet}`);
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
