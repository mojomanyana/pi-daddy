/** Isolated fixture only: never target an active Pi process. */
import { spawn } from "node:child_process";

export async function startCacheProcess(args: string[]): Promise<void> {
  const [marker] = args;
  if (args[1] === "log-entry") process.stdout.write("entry-loaded\n");
  const grandchild = "setInterval(() => {}, 1000)";
  const child = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, ${JSON.stringify(marker)}],
      { detached: true, stdio: 'ignore' });
    grandchild.on('error', error => { console.error(error); process.exit(1); });
    console.log('descendants-ready');
    setInterval(() => {}, 1000);
  `;
  await new Promise<void>((resolve, reject) => {
    const tree = spawn(process.execPath, ["-e", child, marker], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    tree.once("error", reject);
    tree.stderr.on("data", (data) => process.stderr.write(data));
    tree.stdout.once("data", () => resolve());
    tree.once("exit", (code) => reject(new Error(`fixture child exited before readiness: ${code}`)));
  });
  setInterval(() => {}, 1000);
  if (args[1] === "output-after-ready") setTimeout(() => process.stdout.write(Buffer.alloc(700000, 0xff)), 50);
  if (args[1] === "oversized-startup") process.stdout.write(Buffer.alloc(70000, 0x78));
  if (args[1] === "stderr-startup")
    await new Promise<void>((resolve, reject) => {
      process.stderr.write(Buffer.alloc(70000, 0x79), (error) => (error ? reject(error) : resolve()));
    });
  if (args[1] === "mixed-startup") {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(Buffer.alloc(35000, 0x78), (error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      process.stderr.write(Buffer.alloc(35000, 0x79), (error) => (error ? reject(error) : resolve()));
    });
  }
}
