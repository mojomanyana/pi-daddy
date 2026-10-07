/** Trusted qualification entry. No host privilege: namespace caps apply only to newly created private views. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export async function startCacheProcess([binary, mode, ...fault]: string[]) {
  setInterval(() => {}, 1000);
  if (fault[0] === "startup-hang") await new Promise<void>(() => {});
  createInterface({ input: process.stdin }).once("line", (command) => {
    if (command !== "GO") {
      process.stdout.write(JSON.stringify({ error: "mount fixture invalid start command" }) + "\n");
      return;
    }
    const child = spawn(
      "/usr/bin/unshare",
      ["--user", "--map-root-user", "--mount", "--propagation", "private", binary, mode, ...fault],
      {
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.on("error", (error) =>
      process.stdout.write(JSON.stringify({ error: `private mount fixture spawn: ${error.message}` }) + "\n"),
    );
    child.on("exit", (code, signal) =>
      process.stdout.write(JSON.stringify({ error: `private mount fixture exited: ${code ?? signal}` }) + "\n"),
    );
  });
}
