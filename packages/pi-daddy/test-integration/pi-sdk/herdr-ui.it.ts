/** Real Pi TUI display, blocked input and cancellation on an independently owned Herdr server. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { runHerdrOwned } from "../../src/executors/herdr-owned.ts";
import { runCapturedExecution } from "../../src/executors/captured-execution.ts";
import { FINAL, MODEL, PROVIDER } from "./scripted-provider.ts";
import { UI_TASK, UI_CONTEXT, UI_PROGRESS, UI_RESULT, UI_THINKING, UI_DETAIL } from "./ui-extension.ts";

const piCli =
  process.env.PI_DADDY_IT_PI_CLI ??
  fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let count = 0; count < 300; count++) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("real Pi TUI fixture readiness deadline");
}
const jsonFile = (path: string) =>
  readFile(path, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
export function registerHerdrPiUiTests(target: string) {
  const exec = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile("herdr", ["--session", target!, ...args], { timeout: 10000 }, (error, stdout, stderr) =>
        resolve({ code: error ? 1 : 0, stdout, stderr }),
      );
    });
  for (const mode of ["success", "cancel", "launcher loss"] as const)
    test(
      `actual Pi TUI ${mode === "success" ? "shows task and tools while input stays view-only" : mode + " reaps tools"}`,
      {
        skip: !target && "set PI_DADDY_IT_HERDR_SESSION to a separately owned test server",
      },
      async () => {
        const cancel = mode === "cancel";
        const root = await mkdtemp(join(tmpdir(), "pi-owned-tui-"));
        const agent = join(root, "agent");
        await mkdir(agent);
        await writeFile(
          join(agent, "settings.json"),
          JSON.stringify({
            defaultProjectTrust: "always",
            enableAnalytics: false,
            enableInstallTelemetry: false,
            hideThinkingBlock: false,
            compaction: { enabled: false },
            retry: { enabled: false },
            cacheWarming: "off",
          }),
        );
        const sessionPath = join(root, "session.jsonl");
        const shellSentinel = join(root, "startup-shell-sentinel");
        const controller = new AbortController();
        let paneId: string | undefined, tabId: string | undefined, helperPid: number | undefined;
        const running = runCapturedExecution(
          {
            executionId: "actual-pi-tui",
            terminalUi: true,
            onOwnership: (identity) => {
              helperPid = identity.helperPid;
            },
            sessionPath,
            cwd: root,
            command: process.execPath,
            args: [
              piCli,
              "--session",
              sessionPath,
              "--no-extensions",
              "-e",
              fileURLToPath(new URL("./ui-extension.ts", import.meta.url)),
              "--no-mcp",
              "--no-skills",
              "--no-prompt-templates",
              "--tools",
              "fixture_visible",
              "--provider",
              PROVIDER,
              "--model",
              MODEL,
              "--append-system-prompt",
              UI_CONTEXT,
              UI_TASK,
            ],
            env: {
              PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
              HOME: root,
              PI_CODING_AGENT_DIR: agent,
              PI_OFFLINE: "1",
              P01_UI_ROOT: root,
              TERM: "xterm-256color",
            },
            signal: controller.signal,
            timeoutMs: 30000,
            killGraceMs: 100,
          },
          (request) =>
            runHerdrOwned(request, {
              exec,
              keepPane: true,
              displayName: "review",
              onPane: (pane, tab) => {
                paneId = pane;
                tabId = tab;
              },
            }),
        );
        let finished: Awaited<typeof running> | undefined;
        void running.then((result) => {
          finished = result;
        });
        try {
          await eventually(() =>
            readFile(join(root, "initializing"), "utf8")
              .then(() => true)
              .catch((error) => {
                if (finished) throw Error("Pi exited during initialization: " + JSON.stringify(finished));
                if (error.code === "ENOENT") return undefined;
                throw error;
              }),
          );
          assert.ok(paneId);
          for (const args of [
            ["pane", "send-text", paneId, `!printf startup > '${shellSentinel}'`],
            ["pane", "send-keys", paneId, "enter"],
            ["pane", "send-text", paneId, "UNAUTHORIZED STARTUP TASK"],
            ["pane", "send-keys", paneId, "enter", "ctrl+c", "esc"],
          ]) {
            const sent = await exec(args);
            assert.equal(sent.code, 0, sent.stderr);
          }
          await writeFile(join(root, "startup-release"), "");
          const held = await eventually(() => {
            if (finished) throw Error("Pi exited before tool readiness: " + JSON.stringify(finished));
            return jsonFile(join(root, "tool-ready.json"));
          });
          assert.ok(paneId && tabId);
          assert.deepEqual(await jsonFile(join(root, "tui.json")), {
            mode: "tui",
            stdin: true,
            stdout: true,
            stderr: true,
            cwd: root,
            pid: held.workers[0].pid,
          });
          const active = await eventually(async () => {
            const reply = await exec(["agent", "list"]);
            assert.equal(reply.code, 0, reply.stderr);
            const entry = JSON.parse(reply.stdout).result.agents.find((item: any) => item.pane_id === paneId);
            return entry?.agent_status === "working" && entry.title === "review" ? entry : undefined;
          });
          assert.equal(active.agent, "pi");
          assert.equal(active.cwd, root);
          assert.equal(active.tab_id, tabId);
          assert.equal(active.display_agent, "Pi / review");
          const readPane = async () => {
            const result = await exec(["pane", "read", paneId!, "--raw"]);
            assert.equal(result.code, 0, result.stderr);
            return result.stdout;
          };
          const visible = await eventually(async () => {
            const text = await readPane();
            return text.includes(UI_PROGRESS) ? text : undefined;
          });
          assert.ok(visible.includes("Inspect terminal fixture alpha"), visible);
          assert.ok(visible.includes("fixture_visible"), visible);
          assert.ok(!visible.includes(UI_THINKING), "synthetic thinking is hidden during work");
          assert.ok(!visible.includes(UI_DETAIL), "tool detail initially collapsed");
          const initial = (await readFile(join(root, "requests.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.equal(initial.length, 1);
          assert.ok(
            JSON.stringify(initial[0].context).includes(JSON.stringify(UI_TASK).slice(1, -1)),
            "exact task reaches provider",
          );
          assert.ok(
            JSON.stringify(initial[0].context).includes(JSON.stringify(UI_CONTEXT).slice(1, -1)),
            "exact context reaches provider",
          );
          if (cancel) controller.abort();
          else if (mode === "launcher loss") {
            assert.ok(helperPid);
            const status = await readFile(`/proc/${helperPid}/status`, "utf8");
            const launcherPid = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
            assert.ok(Number.isSafeInteger(launcherPid) && launcherPid > 1);
            const command = (await readFile(`/proc/${launcherPid}/cmdline`, "utf8")).split("\0");
            assert.ok(
              command.some((arg) => arg.endsWith("/dist/executors/herdr-launcher.js")),
              "kill only this owned Pi launcher",
            );
            process.kill(launcherPid, "SIGKILL");
          } else {
            for (const args of [
              ["pane", "send-text", paneId!, "UNAUTHORIZED EXTRA TASK"],
              ["pane", "send-keys", paneId!, "enter", "ctrl+c", "esc", "ctrl+o"],
            ]) {
              const sent = await exec(args);
              assert.equal(sent.code, 0, sent.stderr);
            }
            await eventually(async () => ((await readPane()).includes(UI_DETAIL) ? true : undefined));
            assert.equal((await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n").length, 1);
            await writeFile(join(root, "release"), "");
          }
          const result = await running;
          assert.equal(result.cleanup.state, "settled", JSON.stringify(result));
          if (result.cleanup.state !== "settled") throw Error("native settlement required");
          assert.equal(result.cleanup.receipt.reapedAll, true);
          assert.equal(result.cleanup.identity.workerPid, held.workers[0].pid);
          assert.equal(result.aborted, cancel);
          await assert.rejects(
            readFile(shellSentinel),
            { code: "ENOENT" },
            "startup input must never execute shell commands",
          );
          if (mode !== "success") assert.equal(result.final.state, "unavailable");
          else {
            assert.equal(result.code, 0, JSON.stringify(result));
            assert.equal(result.final.state, "complete", JSON.stringify(result));
            assert.equal(result.text, FINAL);
            const retained = await readPane();
            assert.ok(retained.includes(UI_RESULT), "real tool result remains in retained terminal");
            assert.ok(!retained.includes(UI_THINKING), "synthetic thinking stays hidden in retained terminal");
            const requests = (await readFile(join(root, "requests.jsonl"), "utf8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            assert.equal(requests.length, 2, "typing must not enqueue another model turn");
            const session = await readFile(sessionPath, "utf8");
            assert.ok(session.includes(UI_THINKING), "display filtering preserves original session content");
            assert.ok(!session.includes("UNAUTHORIZED EXTRA TASK"), "typing must not enter persisted session");
            assert.ok(
              !session.includes("UNAUTHORIZED STARTUP TASK"),
              "startup typing must not enter persisted session",
            );
          }
          for (const worker of [
            ...held.workers,
            { pid: result.cleanup.identity.helperPid, start: result.cleanup.identity.helperStartTicks },
          ]) {
            const stat = await readFile(`/proc/${worker.pid}/stat`, "utf8").catch((error) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
            assert.ok(
              !stat || stat.split(") ")[1].split(" ")[19] !== worker.start,
              "owned Pi/tool descendant must be gone",
            );
          }
          if (mode !== "launcher loss")
            await eventually(async () => {
              const result = await exec(["pane", "get", paneId!]);
              assert.equal(result.code, 0, result.stderr);
              const pane = JSON.parse(result.stdout).result.pane;
              assert.equal(pane.pane_id, paneId);
              return pane.terminal_title === "Task settled" ? true : undefined;
            });
          const status = await exec(["status", "server", "--json"]);
          assert.equal(status.code, 0, status.stderr);
          const serverVersion = JSON.parse(status.stdout).version;
          assert.equal(typeof serverVersion, "string");
          await eventually(async () => {
            const reply = await exec(["agent", "list"]);
            assert.equal(reply.code, 0, reply.stderr);
            const entry = JSON.parse(reply.stdout).result.agents.find((item: any) => item.pane_id === paneId);
            if (!entry) return true;
            if (entry.agent_status !== "unknown") return undefined;
            // Herdr can retain a cached process classification after our exact source is released.
            assert.equal(entry.agent, "pi");
            assert.equal(entry.pane_id, paneId);
            assert.equal(entry.tab_id, tabId);
            assert.equal(entry.cwd, root);
            assert.equal(entry.title, undefined);
            assert.equal(entry.display_agent, undefined);
            assert.equal(entry.agent_session, undefined);
            assert.notEqual(entry.screen_detection_skipped, true, "detector must not report lifecycle suppression");
            const processes = await exec(["pane", "process-info", "--pane", paneId!]);
            assert.equal(processes.code, 0, processes.stderr);
            const info = JSON.parse(processes.stdout).result.process_info;
            assert.equal(info.pane_id, paneId);
            assert.equal(info.foreground_process_group_id, info.shell_pid);
            assert.equal(info.foreground_processes.length, 1);
            const foreground = info.foreground_processes[0];
            assert.equal(foreground.pid, info.shell_pid);
            assert.equal(foreground.name, "bash");
            assert.deepEqual(foreground.argv, ["/bin/bash"]);
            assert.equal(foreground.cwd, root);
            console.error(
              "DISPLAY_CACHE_OBSERVATION " +
                JSON.stringify({
                  serverVersion,
                  mode,
                  paneId,
                  agent: entry.agent,
                  state: entry.agent_status,
                  metadataAbsent: true,
                  ownedIdentitiesAbsent: true,
                  foreground: "/bin/bash",
                }),
            );
            return true;
          });
          assert.equal((await exec(["tab", "get", tabId])).code, 0, "settled terminal stays available for inspection");
        } catch (error) {
          if (paneId) {
            const screen = await exec(["pane", "read", paneId, "--raw"]);
            console.error("Failed synthetic Pi TUI screen:", screen.stdout.slice(-6000), screen.stderr);
            for (const args of [
              ["agent", "list"],
              ["pane", "process-info", "--pane", paneId],
            ]) {
              const detail = await exec(args);
              console.error("Failed synthetic Pi observation:", args.join(" "), detail.stdout, detail.stderr);
            }
          }
          throw error;
        } finally {
          controller.abort();
          const outcome = await running;
          if (!paneId) console.error("Pi TUI launch outcome:", JSON.stringify(outcome));
          if (tabId) await exec(["tab", "close", tabId]);
          await rm(root, { recursive: true, force: true });
        }
      },
    );
}
