/**
 * Process-tree activity: the signal that is live while a tool call runs.
 *
 * pi appends to its session file only when a message or a tool result ends (`agent-session.js`, on `message_end`),
 * and writes nothing before the first assistant message completes. A child running one twenty-minute `bash` call
 * is therefore silent on stdout AND on its session file for the whole call, which is exactly the case the
 * inactivity deadline must not mistake for a hang (review of PR 3e, finding 1). What is live during a tool call is
 * the work itself: the CPU time consumed by the child and its descendants, and the set of descendants that exist.
 *
 * Linux only, read from `/proc`. Elsewhere the probe returns `undefined`, which the runner treats as "no signal",
 * and the session file and stdout remain the activity sources. A child that consumes no CPU, spawns nothing and
 * writes nothing for the whole bound (a `sleep`, or a wait on a remote that never answers) is stopped as idle; that
 * is the intended meaning of the bound.
 */
import { readdir, readFile } from "node:fs/promises";

/** utime + stime ticks and the descendant pids of `rootPid`, as one marker; `undefined` when unreadable. */
export async function processTreeActivity(rootPid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return undefined;
  }
  const parentOf = new Map<number, number>();
  const ticksOf = new Map<number, number>();
  await Promise.all(
    entries
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          const stat = await readFile(`/proc/${name}/stat`, "utf8");
          // `pid (comm) state ppid ...`; comm may contain spaces or parentheses, so split after the last `)`.
          const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const pid = Number(name);
          parentOf.set(pid, Number(rest[1]));
          ticksOf.set(pid, Number(rest[11]) + Number(rest[12]));
        } catch {
          /* the process ended between readdir and read */
        }
      }),
  );
  if (!ticksOf.has(rootPid)) return undefined;
  const tree = new Set<number>([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parentOf) if (tree.has(ppid) && !tree.has(pid)) (tree.add(pid), (grew = true));
  }
  let ticks = 0;
  for (const pid of tree) ticks += ticksOf.get(pid) ?? 0;
  return `${ticks}:${[...tree].sort((a, b) => a - b).join(",")}`;
}
