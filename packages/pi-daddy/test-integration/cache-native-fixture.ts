/** Trusted native qualification entry only; never receives a model-supplied execution request. */
import { spawn } from "node:child_process";

export async function startCacheProcess(args: string[]): Promise<void> {
  const [binary, libraries, directory, program] = args;
  setInterval(() => {}, 1000);
  setImmediate(() => {
    const child = spawn(
      "/lib64/ld-linux-x86-64.so.2",
      [
        "--library-path",
        libraries,
        binary,
        "-ff",
        "-qq",
        "-yy",
        "-s",
        "4096",
        "-o",
        `${directory}/trace`,
        "--",
        process.execPath,
        program,
        directory,
      ],
      { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    child.once("error", (error) => process.stdout.write(`${JSON.stringify({ error: error.message })}\n`));
    child.once("close", (code, signal) =>
      process.stdout.write(`${JSON.stringify({ code, signal, stdout, stderr })}\n`),
    );
  });
}
