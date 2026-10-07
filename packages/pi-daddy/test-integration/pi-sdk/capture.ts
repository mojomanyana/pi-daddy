/** Capture real stable CLI JSONL, replacing only its disposable working-directory field. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersion } from "./fixture-harness.ts";
import { MODEL, PROVIDER } from "./scripted-provider.ts";

export async function runScenario(scenario: string) {
  assertVersion();
  const root = await mkdtemp(join(tmpdir(), "pi-p01-cli-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      enableAnalytics: false,
      enableInstallTelemetry: false,
      cacheWarming: "off",
      defaultProjectTrust: "always",
      compaction: { enabled: false },
      retry: { enabled: scenario === "retry", maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 10 },
    }),
  );
  const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const extension = fileURLToPath(new URL("./cli-extension.ts", import.meta.url));
  const args = [
    cli,
    "--no-session",
    "--no-extensions",
    "-e",
    extension,
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--tools",
    "fixture_outer,fixture_inner",
    "--mode",
    "json",
    "--provider",
    PROVIDER,
    "--model",
    MODEL,
    "--thinking",
    "high",
    "P01 local protocol fixture",
  ];
  try {
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: root,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          P01_SCENARIO: scenario,
          NO_COLOR: "1",
          TERM: "dumb",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`CLI fixture timeout: ${scenario}`));
      }, 15000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    });
    const events = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(events[0]?.type, "session");
    // Preserve the JSON stream byte-for-byte except this known generated path and installed package prefix; these private paths are irrelevant.
    const jsonl = result.stdout.replaceAll(root, "$FIXTURE_CWD").replaceAll(dirname(dirname(cli)), "$PI_PACKAGE");
    return { ...result, events, jsonl, sha256: createHash("sha256").update(jsonl).digest("hex") };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const destination = fileURLToPath(new URL("./fixtures/", import.meta.url));
  await mkdir(destination, { recursive: true });
  const records = [];
  for (const scenario of ["success", "error", "nested", "retry", "stop-then-error"]) {
    const result = await runScenario(scenario);
    await writeFile(join(destination, `${scenario}.jsonl`), result.jsonl);
    records.push({
      scenario,
      producer: "@earendil-works/pi-coding-agent@1.0.4",
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      exitCode: result.code,
      stderr: result.stderr,
      sha256: result.sha256,
      events: result.events.map((event) => event.type),
    });
  }
  await writeFile(
    join(destination, "provenance.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        command: "node capture.ts",
        normalization:
          "Generated cwd and installed package path prefixes replaced with $FIXTURE_CWD; LF records and string content preserved.",
        scenarios: records,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(records, null, 2));
}
