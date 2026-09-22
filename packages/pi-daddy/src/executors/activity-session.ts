/**
 * The activity session: a pi session file every governed child writes to, so its parent can tell working from hung.
 *
 * PR 3e (ADR-0038 note). A `pi --print` child gives its parent nothing on stdout until it exits, so a wall clock
 * cannot tell a build from a hang. pi's SessionManager appends one line to its session file for every message and
 * tool result as they happen (read from pi's `session-manager.js`: `appendFileSync` per entry), so the file's size
 * and mtime are a progress signal that costs the child nothing and needs no output-format change. When the plan
 * already carries `--session` (native-session retention), that file is the probe; otherwise a private temporary
 * file is allocated for the run and removed afterwards.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ActivitySession {
  /** The child argv, with `--session <file>` in place of `--no-session` when a file was allocated here. */
  readonly args: string[];
  /** The session file being watched. */
  readonly path: string;
  /** A marker that changes whenever pi appended to the file; `undefined` until the file exists. */
  probe(): Promise<string | undefined>;
  /** Remove the temporary file, if this run allocated one. Never removes a retention target. */
  dispose(): Promise<void>;
}

/** The newest session file pi wrote into a directory we own, as a size:mtime marker. */
function probeDirectory(directory: string) {
  return async (): Promise<string | undefined> => {
    try {
      const { readdir, stat } = await import("node:fs/promises");
      const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
      if (names.length === 0) return undefined;
      const marks = await Promise.all(
        names.map(async (name) => {
          const s = await stat(join(directory, name));
          return `${name}:${s.size}:${s.mtimeMs}`;
        }),
      );
      return marks.sort().join("|");
    } catch {
      return undefined;
    }
  };
}

export async function activitySessionFor(planArgs: string[], executionId: string): Promise<ActivitySession> {
  // A forked child (ADR-0078) has no `--session`, and adding one would make pi refuse the spawn outright: it
  // rejects `--fork` beside `--session` or `--no-session`. The fork writes exactly one session into a directory
  // that is ours, so the probe watches the directory and the argv is left exactly as planned.
  const fork = planArgs.indexOf("--fork");
  if (fork >= 0) {
    const dir = planArgs[planArgs.indexOf("--session-dir") + 1];
    return { args: planArgs, path: dir, probe: probeDirectory(dir), dispose: async () => undefined };
  }
  const flag = planArgs.indexOf("--session");
  const probeFor = (path: string) => async () => {
    try {
      const s = await stat(path);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return undefined;
    }
  };
  if (flag >= 0 && planArgs[flag + 1]) {
    const path = planArgs[flag + 1];
    return { args: planArgs, path, probe: probeFor(path), dispose: async () => undefined };
  }
  // Private to this uid (mkdtemp is 0o700) and named by the execution so a leaked directory is attributable.
  const directory = await mkdtemp(join(tmpdir(), `pi-daddy-${executionId.replace(/[^a-zA-Z0-9_-]/g, "_")}-`));
  const path = join(directory, "session.jsonl");
  const noSession = planArgs.indexOf("--no-session");
  const args =
    noSession >= 0
      ? [...planArgs.slice(0, noSession), "--session", path, ...planArgs.slice(noSession + 1)]
      : [...planArgs.slice(0, -1), "--session", path, planArgs[planArgs.length - 1]];
  return {
    args,
    path,
    probe: probeFor(path),
    dispose: () => rm(directory, { recursive: true, force: true }).catch(() => undefined),
  };
}
