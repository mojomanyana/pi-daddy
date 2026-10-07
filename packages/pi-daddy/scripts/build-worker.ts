/** Build-time only: production executes the reviewed packaged binary and never invokes a compiler. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("worker build requires qualified Linux x64");
const result = spawnSync(
  "cc",
  [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-static",
    "-s",
    "-o",
    "native/linux-x64/worker",
    "native/worker.c",
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.status !== 0) throw new Error("native worker compilation failed");
const target = root + "native/linux-x64/worker";
chmodSync(target, 0o755);
writeFileSync(target + ".sha256", createHash("sha256").update(readFileSync(target)).digest("hex") + "\n");
