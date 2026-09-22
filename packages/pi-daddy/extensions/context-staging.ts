/**
 * Stage what a granted handoff hands over (ADR-0078).
 *
 * The kernel decides WHETHER context crosses and in which mode; this decides what the bytes are, because building
 * them means reading files and the parent's own session and the kernel does no I/O. It is called only after the
 * mode has survived the ceiling, the parent's grant and the gate, so a refused handoff reads nothing.
 *
 * **What authorises the read.** `context:files` is the authorisation, not `tool:read`: an operator who grants a
 * definition the right to receive file contents has said so explicitly, in the grant, where a reviewer sees it.
 * Paths are still confined to the session's working directory, because they are MODEL-supplied and the fence must
 * not become a way to read `/etc` without holding a tool that can. That confinement is a bound on the parameter,
 * not a claim of containment: the parent process can already read whatever its own grant allows.
 *
 * **What is not staged.** A mode whose input cannot be read — a missing file, an unreadable session — yields a
 * section saying so rather than silence. A handoff that quietly carried less than it promised would be R-03's
 * shape, a missing result indistinguishable from an empty one, and the child would have no way to know.
 */
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  fenceContext,
  selectPrunedTurns,
  type ContextRequest,
  type ContextSection,
  type PrunableTurn,
} from "../src/kernel/context-handoff.ts";

/** The parent's session, as much of it as staging needs. Satisfied by pi's `ReadonlySessionManager`. */
export interface ParentSession {
  getSessionFile(): string | undefined;
  getEntries(): Array<{ id: string; type: string }>;
}

export interface StagingInput {
  cwd: string;
  /** Where a forked session is written. One directory per fork, private to this uid. */
  forkRoot: string;
  parentSession?: ParentSession;
}

export interface StagedHandoff {
  contextPrompt?: string;
  forkFrom?: { sessionPath: string; sessionDir: string; sessionId: string };
  /**
   * Why nothing could be staged. Returned rather than thrown: `planDelegation` is pure and no caller expects it to
   * throw, so a throw here escaped as a raw error with no ledger record, or as `APPROVAL_FLOW_FAILED` after the
   * human had already said yes — measured in review.
   */
  refusal?: string;
  /** Remove anything this staging created. A fork writes a copy of the parent's session and must not outlive it. */
  dispose?: () => void;
  /** For the ledger: what actually crossed, never what was asked for. Absent when nothing was staged. */
  record?: {
    mode: string;
    sections: number;
    bytes: number;
    truncatedBytes: number;
    keptTurns?: number;
    droppedTurns?: number;
    rule?: string;
  };
}

/** 64 KiB per file before the fence's own budget sees it, so one large file cannot starve the others. */
const MAX_FILE_BYTES = 64 * 1024;

export function createHandoffStager(input: StagingInput) {
  return (granted: ContextRequest): StagedHandoff => {
    if (granted.mode === "fork") return stageFork(input);
    const sections: ContextSection[] = [];
    let keptTurns: number | undefined;
    let droppedTurns: number | undefined;
    let rule: string | undefined;

    if (granted.mode === "summary")
      sections.push({ label: "what your parent says you need to know", body: granted.summary ?? "" });
    if (granted.mode === "files" || granted.mode === "pruned")
      for (const path of granted.files ?? []) sections.push(readSection(input.cwd, path));
    if (granted.mode === "pruned") {
      const selection = selectPrunedTurns(parentTurns(input.parentSession), {
        ...(granted.turns !== undefined ? { turns: granted.turns } : {}),
        ...(granted.files !== undefined ? { files: granted.files } : {}),
      });
      keptTurns = selection.kept.length;
      droppedTurns = selection.droppedCount;
      rule = selection.rule;
      for (const turn of selection.kept) sections.push({ label: `parent turn ${turn.id}`, body: turn.text });
      if (selection.kept.length === 0)
        sections.push({ label: "parent turns", body: "(no turn of your parent's session matched the selection)" });
    }

    const fenced = fenceContext(sections);
    return {
      contextPrompt: fenced.text,
      record: {
        mode: granted.mode,
        sections: sections.length,
        bytes: Buffer.byteLength(fenced.text),
        truncatedBytes: fenced.truncatedBytes,
        ...(keptTurns !== undefined ? { keptTurns, droppedTurns, rule } : {}),
      },
    };
  };
}

/**
 * A fork replaces the session file the inactivity deadline would otherwise watch, because pi refuses `--fork`
 * beside `--session`. The directory is ours and holds exactly one session, so the activity probe watches the
 * directory instead of a fixed path — pi names the file `<timestamp>_<id>.jsonl` and only the id half is ours.
 */
function stageFork(input: StagingInput): StagedHandoff {
  const sessionPath = input.parentSession?.getSessionFile();
  if (!sessionPath)
    // Not a silent downgrade to `none`: the parent asked for its whole session to cross and it has none to give.
    return { refusal: "context: fork needs the parent's session file, and this session is not persisted" };
  const sessionId = randomUUID();
  const sessionDir = resolve(input.forkRoot, `fork-${sessionId}`);
  try {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { refusal: `context: fork could not allocate ${sessionDir} (${String(error)})` };
  }
  // The ledger records the SIZE of what crossed, because a fork is the largest handoff there is and recording it
  // as zero bytes would make the audit trail understate exactly the mode that deserves the most scrutiny.
  let bytes = 0;
  let entries = 0;
  try {
    bytes = statSync(sessionPath).size;
    entries = input.parentSession?.getEntries().length ?? 0;
  } catch {
    /* an unreadable parent session is still a fork pi will attempt; the record says 0 rather than guessing */
  }
  return {
    forkFrom: { sessionPath, sessionDir, sessionId },
    dispose: () => rmSync(sessionDir, { recursive: true, force: true }),
    record: { mode: "fork", sections: 1, bytes, truncatedBytes: 0, keptTurns: entries, droppedTurns: 0 },
  };
}

/** Read one named file, confined to the working directory, saying so in the fence when it cannot be read. */
function readSection(cwd: string, path: string): ContextSection {
  const refuse = (why: string) => ({ label: path, body: `(refused: ${why})` });
  if (isAbsolute(path)) return refuse("an absolute path");
  let absolute: string;
  let root: string;
  try {
    // `realpath`, not `resolve`: `resolve`/`relative` are LEXICAL, so a symlink inside the working directory
    // pointing anywhere at all passed the check — measured in review with `cwd/link.txt -> /tmp/outside.txt`,
    // whose contents duly appeared inside the fence. A repository full of `node_modules/.bin` symlinks makes that
    // the ordinary case rather than a contrived one.
    root = realpathSync(resolve(cwd));
    absolute = realpathSync(resolve(cwd, path));
  } catch (error) {
    return { label: path, body: `(could not be read: ${error instanceof Error ? error.message : String(error)})` };
  }
  const within = relative(root, absolute);
  if (within.startsWith("..") || within === "" || isAbsolute(within))
    return refuse("outside this session's working directory");
  try {
    const stats = statSync(absolute);
    // A FIFO satisfies `statSync` and then never returns from a read, which would block the whole pi session with
    // no watchdog — and the path is model-supplied, so it is reachable rather than theoretical.
    if (!stats.isFile()) return refuse("not a regular file");
    const note = stats.size > MAX_FILE_BYTES ? ` (first ${MAX_FILE_BYTES} of ${stats.size} bytes)` : "";
    return { label: `${path}${note}`, body: readBounded(absolute, MAX_FILE_BYTES) };
  } catch (error) {
    return { label: path, body: `(could not be read: ${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * Read at most `budget` BYTES, without pulling the rest of the file into the parent first.
 *
 * `readFileSync(...).slice(budget)` reads the whole file and then slices by UTF-16 code units, so a large file in
 * the repository stalled the parent and the "(first N of M bytes)" label was wrong for any multi-byte content.
 */
function readBounded(path: string, budget: number): string {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(budget);
    const read = readSync(handle, buffer, 0, budget, 0);
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, read)).replace(/\uFFFD+$/, "");
  } finally {
    closeSync(handle);
  }
}

/** The parent's message turns, reduced to what the selection rule needs. Never pi's own types past this point. */
function parentTurns(session?: ParentSession): PrunableTurn[] {
  if (!session) return [];
  try {
    return session
      .getEntries()
      .filter((entry) => entry.type === "message")
      .map((entry) => ({ id: entry.id, text: JSON.stringify((entry as { message?: unknown }).message ?? entry) }));
  } catch {
    return [];
  }
}
