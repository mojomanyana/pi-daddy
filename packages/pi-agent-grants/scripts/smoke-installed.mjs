#!/usr/bin/env node
/**
 * G9 — prove the package works AS INSTALLED, not just as a working tree.
 *
 * Review finding B-I12: `exports` pointed at `./src/*.ts`, and Node refuses to strip types for anything
 * under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Every consumer import therefore
 * threw, while every in-repo test passed — which is exactly the gap a packaging test exists to close.
 *
 * Packs a tarball, installs it into a scratch project, and imports it the way a consumer would.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkgDir = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "grants-smoke-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });

try {
  const packed = run("npm", ["pack", "--pack-destination", work], pkgDir).trim().split("\n").pop();
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
  run("npm", ["i", "--no-audit", "--no-fund", join(work, packed)], work);

  writeFileSync(
    join(work, "probe.mjs"),
    [
      `import { resolve, assertNarrowing } from "pi-agent-grants";`,
      `import { planSpawn } from "pi-agent-grants/spawn";`,
      `import { runChild } from "pi-agent-grants/run-child";`,
      // Exercise it, don't just import it: a module that loads but throws on use is not "working".
      `const r = resolve({ requested: ["tool:read"], parentGrant: ["tool:read", "tool:write"] });`,
      `assertNarrowing(r);`,
      `const plan = planSpawn({ effective: r.effective, prompt: "t" });`,
      `if (!plan.args.includes("--tools")) throw new Error("planSpawn produced no allowlist");`,
      `if (typeof runChild !== "function") throw new Error("run-child export missing");`,
      `console.log("SMOKE_OK");`,
    ].join("\n"),
  );

  const out = run("node", ["probe.mjs"], work).trim();
  if (!out.includes("SMOKE_OK")) throw new Error(`unexpected output: ${out}`);
  console.log("smoke: installed package imports and runs — OK");
} catch (error) {
  console.error("smoke FAILED:\n", error.stdout ?? "", error.stderr ?? error.message ?? error);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
