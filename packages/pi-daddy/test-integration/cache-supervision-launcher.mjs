// Test-only deterministic pre-Bubblewrap boundary. The root dies before this launcher releases
// namespace setup, so Bubblewrap observes a reparented process and cannot replace the owner check.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.PI_DADDY_IT_CACHE_LAUNCHER_DIR;
if (!root) throw new Error("missing test launcher directory");
await writeFile(join(root, "waiting"), "ready");
while (!existsSync(join(root, "release"))) await new Promise((resolve) => setTimeout(resolve, 10));
const child = spawn("/usr/bin/bwrap", process.argv.slice(2), { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (bytes) => appendFileSync(join(root, "stdout"), bytes));
child.stderr.on("data", (bytes) => appendFileSync(join(root, "stderr"), bytes));
child.once("error", (error) => { throw error; });
child.once("exit", async (code, signal) => {
  await writeFile(join(root, "finished"), JSON.stringify({ code, signal }));
});
