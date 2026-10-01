import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { startSupervisedCache } from "../src/executors/cache-supervisor.ts";

const marker = process.argv[2];
const phase = process.argv[3];
const owner = await readCacheOwner(process.pid);
const handle = await startSupervisedCache({
  owner,
  entry: new URL("./cache-supervision-fixture.ts", import.meta.url),
  args: [marker, process.argv[5] ?? ""],
  ...(process.argv[4] ? { bwrap: process.argv[4] } : {}),
  onSpawn: () => {
    process.stdout.write(`${JSON.stringify({ phase: "spawned" })}\n`);
    if (phase === "startup") process.kill(process.pid, "SIGKILL");
  },
});
process.stdout.write(`${JSON.stringify({ phase: "ready", wrapperPid: handle.process.pid })}\n`);
process.on("SIGTERM", () => void handle.stop().then(() => process.exit(0)));
setInterval(() => {}, 1000);
