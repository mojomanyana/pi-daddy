/** Trusted package-selected namespace PID1 worker. No request is executable before supervisor readiness.
 * Exact shell/cwd/env/command arrives over private inherited stdin, never secret-bearing argv.
 * This owns one command tree; the parent stops the namespace before accepting exit/publication.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readlink } from "node:fs/promises";
import { readCacheOwner } from "../kernel/cache-owner.ts";
import { frozenPersonalInvocation, type PersonalCacheInvocation } from "../kernel/cache-personal-invocation.ts";

export async function startCacheProcess(): Promise<void> {
  if (process.platform !== "linux" || process.pid !== 1)
    throw Error("personal Bash worker needs supervised namespace PID1");
  const hostProc = "/run/pi-daddy-cache-host-proc";
  const identity = await readCacheOwner(Number(await readlink(hostProc + "/self")), hostProc);
  process.stdout.write(JSON.stringify({ type: "owner", owner: identity }) + "\n");
  let input = Buffer.alloc(0),
    admitted = false;
  const deadline = setTimeout(() => {
    frame({ type: "fault", reason: "personal Bash worker input exceeded3000ms" });
    process.exit(78);
  }, 3000);
  function frame(value: unknown) {
    process.stdout.write(JSON.stringify(value) + "\n");
  }
  process.stdin.on("data", (bytes: Buffer) => {
    if (admitted || input.length + bytes.length > 1200000) {
      frame({ type: "fault", reason: "personal Bash worker input invalid or oversized" });
      process.exit(78);
    }
    input = Buffer.concat([input, bytes]);
    const end = input.indexOf(10);
    if (end < 0) return;
    if (end !== input.length - 1) {
      frame({ type: "fault", reason: "personal Bash worker trailing input" });
      process.exit(78);
    }
    let invocation: Readonly<PersonalCacheInvocation>;
    try {
      invocation = frozenPersonalInvocation(
        JSON.parse(input.subarray(0, end).toString("utf8")) as PersonalCacheInvocation,
      );
    } catch {
      frame({ type: "fault", reason: "personal Bash worker invocation malformed" });
      process.exit(78);
    }
    admitted = true;
    input = Buffer.alloc(0);
    clearTimeout(deadline);
    run(invocation!);
  });
  process.stdin.on("end", () => {
    if (!admitted) {
      frame({ type: "fault", reason: "personal Bash worker incomplete request" });
      process.exit(78);
    }
  });
  process.stdin.resume();
  function run(invocation: Readonly<PersonalCacheInvocation>) {
    const startedAt = new Date().toISOString();
    let child: ChildProcess,
      timedOut = false,
      failed = false;
    const emit = (channel: "stdout" | "stderr", bytes: Buffer) => {
      if (!process.stdout.write(JSON.stringify({ type: "data", channel, bytes: bytes.toString("base64") }) + "\n")) {
        child.stdout!.pause();
        child.stderr!.pause();
      }
    };
    process.stdout.on("drain", () => {
      child.stdout!.resume();
      child.stderr!.resume();
    });
    child = spawn(invocation.shell, ["-c", invocation.command], {
      cwd: invocation.cwd,
      env: { ...invocation.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const terminate = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            frame({ type: "fault", reason: "personal Bash group termination failed" });
            process.exit(78);
          }
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, invocation.timeoutMs);
    const runaway = setTimeout(() => {
      frame({ type: "fault", reason: "personal Bash command stream closure unresolved" });
      process.exit(78);
    }, invocation.timeoutMs + 1500);
    child.stdout!.on("data", (bytes: Buffer) => emit("stdout", bytes));
    child.stderr!.on("data", (bytes: Buffer) => emit("stderr", bytes));
    child.once("error", () => {
      failed = true;
      frame({ type: "fault", reason: "personal Bash spawn failed" });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(runaway);
      if (!failed)
        frame({ type: "exit", startedAt, endedAt: new Date().toISOString(), exitCode: code, signal, timedOut });
    });
  }
}
