/** Trusted qualification entry. Supervisor namespace owns BOTH watcher and adversarial mmap writer. */
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { WatchmanTracker } from "../src/executors/cache-watchman.ts";

const writerCode = `import os,sys,mmap
fd=os.open(sys.argv[1],os.O_RDWR)
region=mmap.mmap(fd,8,flags=mmap.MAP_SHARED,prot=mmap.PROT_READ|mmap.PROT_WRITE)
region[:]=b'initial!'
print('ready',flush=True)
try:
 for line in sys.stdin:
  if line.strip()=='changed': region[:]=b'changed!'
  elif line.strip()=='initial': region[:]=b'initial!'
  else: raise RuntimeError('bad fixture request')
  print('written',flush=True)
finally:
 region.close();os.close(fd)
`;

export async function startCacheProcess(args: string[]): Promise<void> {
  setInterval(() => {}, 1000);
  setImmediate(() => {
    void qualify(args).then(
      (evidence) => process.stdout.write(`${JSON.stringify(evidence)}\n`),
      (error: unknown) => process.stdout.write(`${JSON.stringify({ error: String(error) })}\n`),
    );
  });
}

async function qualify([dir, binary]: string[]) {
  const root = join(dir, "workspace"),
    path = join(root, "input");
  const writer = spawn("python3", ["-c", writerCode, path], { stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = "";
  writer.on("error", (error) => {
    diagnostics += error.message;
  });
  writer.stderr.on("data", (bytes) => {
    diagnostics += bytes;
  });
  const lines = createInterface({ input: writer.stdout });
  const next = () =>
    new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`mmap fixture failed: ${diagnostics}`)), 2000);
      lines.once("line", (line) => {
        clearTimeout(timeout);
        resolve(line);
      });
    });
  if ((await next()) !== "ready") throw new Error("mmap writer did not become ready");
  const socket = join(dir, "sock");
  const service = spawn(
    binary,
    [
      "--foreground",
      "--no-save-state",
      "--sockname",
      socket,
      "--logfile",
      join(dir, "log"),
      "--statefile",
      join(dir, "state"),
      "--pidfile",
      join(dir, "pid"),
    ],
    { stdio: "ignore" },
  );
  service.on("error", (error) => {
    diagnostics += error.message;
  });
  const losses: string[] = [];
  const tracker = await WatchmanTracker.connect({
    root,
    socketPath: socket,
    onUncertain: (reason) => losses.push(reason),
  });
  try {
    const before = await readFile(path, "utf8"),
      metadata = await stat(path, { bigint: true }),
      warm = await tracker.barrier();
    let reply = next();
    writer.stdin.write("changed\n");
    if ((await reply) !== "written") throw new Error("writer failed");
    const during = await readFile(path, "utf8"),
      changed = await tracker.barrier();
    reply = next();
    writer.stdin.write("initial\n");
    if ((await reply) !== "written") throw new Error("writer failed");
    const after = await readFile(path, "utf8"),
      finalMetadata = await stat(path, { bigint: true }),
      restored = await tracker.barrier();
    return {
      before,
      during,
      after,
      warm,
      changed,
      restored,
      losses: [...losses],
      mtimeUnchanged: metadata.mtimeNs === finalMetadata.mtimeNs,
      ctimeUnchanged: metadata.ctimeNs === finalMetadata.ctimeNs,
    };
  } finally {
    tracker.close();
  }
  // No child kill/exit claim here: namespace PID1 teardown is the one bounded lifecycle owner.
}
