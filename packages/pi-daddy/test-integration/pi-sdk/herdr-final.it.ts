/** Actual Pi CLI + packaged owner + persisted final, entirely model-free. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { runHerdrOwned } from "../../src/executors/herdr-owned.ts";
import { runCapturedExecution } from "../../src/executors/captured-execution.ts";
import { FINAL, MODEL, PROVIDER } from "./scripted-provider.ts";
const target = process.env.PI_DADDY_IT_HERDR_SESSION;
const configuredPiCli = process.env.PI_DADDY_IT_PI_CLI;
if (configuredPiCli !== undefined) assert.ok(isAbsolute(configuredPiCli), "PI_DADDY_IT_PI_CLI must be absolute");
const piCli =
  configuredPiCli ?? fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const exec = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile("herdr", ["--session", target!, ...args], { timeout: 10000 }, (error, stdout, stderr) =>
      resolve({ code: error ? 1 : 0, stdout, stderr }),
    );
  });
for (const scenario of ["success", "nested", "retry", "error", "stop-then-error"])
  test(
    `actual Herdr Pi TUI current final: ${scenario}`,
    { skip: !target && "set PI_DADDY_IT_HERDR_SESSION to a separately owned test server" },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-captured-final-"));
      try {
        const agent = join(root, "agent");
        await mkdir(agent);
        await writeFile(
          join(agent, "settings.json"),
          JSON.stringify({
            defaultProjectTrust: "always",
            enableAnalytics: false,
            enableInstallTelemetry: false,
            retry: { enabled: scenario === "retry", maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
            compaction: { enabled: false },
            cacheWarming: "off",
          }),
        );
        const path = join(root, "session.jsonl");
        const output = await runCapturedExecution(
          {
            executionId: "exec-final-" + scenario,
            terminalUi: true,
            sessionPath: path,
            cwd: root,
            command: process.execPath,
            args: [
              piCli,
              "--session",
              path,
              "--no-extensions",
              "-e",
              fileURLToPath(new URL("./cli-extension.ts", import.meta.url)),
              "--no-mcp",
              "--no-skills",
              "--no-prompt-templates",
              "--tools",
              "fixture_outer,fixture_inner",
              "--provider",
              PROVIDER,
              "--model",
              MODEL,
              "--thinking",
              "high",
              "local final fixture",
            ],
            env: {
              PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
              HOME: root,
              PI_CODING_AGENT_DIR: agent,
              PI_OFFLINE: "1",
              P01_SCENARIO: scenario,
              P01_TOOL_MARKER: join(root, "nested-tool.txt"),
              NO_COLOR: "1",
              TERM: "xterm-256color",
            },
            timeoutMs: 10000,
            killGraceMs: 100,
          },
          (request) => runHerdrOwned(request, { exec }),
        );
        assert.equal(output.code, 0, JSON.stringify(output));
        assert.equal(output.cleanup.state, "settled");
        if (scenario === "nested")
          assert.equal(await readFile(join(root, "nested-tool.txt"), "utf8"), "outer\ninner\n");
        if (["success", "nested", "retry"].includes(scenario)) {
          assert.equal(output.final.state, "complete", JSON.stringify(output));
          assert.equal(output.text, FINAL);
        } else {
          assert.equal(output.final.state, "unavailable");
          assert.notEqual(output.text, FINAL);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
