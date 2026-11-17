/**
 * A real Pi root delegates to `scout-public` and the real Pi child calls `scout_research` through its root
 * (decision of 2026-11-17). Model-free: both processes use the scripted local provider.
 *
 * Runs on the lockfile's Pi by default. `DADDY_TEST_PI_CLI=<pi-coding-agent>/dist/cli.js` selects another Pi
 * (the qualification run uses 1.5.2), and `DADDY_TEST_SCOUT_PUBLIC_SKILL=<path>/SKILL.md` uses the published
 * skill's own file instead of the embedded copy of its frontmatter.
 *
 * Breaks if: the planner stops admitting the allowlisted tool for a definition that declares it; the child is
 * not given Daddy's entrypoint, descriptor or key; the root runs the tool other than as a nested call of the
 * waiting `delegate` (so outside its own tool pipeline); the child's arguments are altered; `details` cross;
 * the text is not fenced; the kill switch stops restoring the existing refusal; a child on another model than the
 * root's is admitted; or the root stops comparing its own live model (after `/model`) at the child's call.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CHILD_QUESTION, OTHER_MODEL, SCOUT_TEXT } from "./parent-run-extension.ts";
import { MODEL, PROVIDER } from "./scripted-provider.ts";

const SCOUT_PUBLIC =
  "---\nname: scout-public\ndescription: Delegate public web research to Scout's Docker worker for external " +
  "documentation, facts, comparisons and investigation.\nallowed-tools: scout_research\n---\n\n" +
  "# Scout public research\n\nAnswer the public research question through `scout_research`.\n";
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function runRoot(env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "daddy-parent-run-"));
  const agent = join(root, "agent"),
    bin = join(root, "bin"),
    skill = join(root, "skills", "scout-public");
  await Promise.all([mkdir(agent), mkdir(bin), mkdir(skill, { recursive: true })]);
  await writeFile(join(agent, "auth.json"), "{}");
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProjectTrust: "always",
      enableAnalytics: false,
      enableInstallTelemetry: false,
      retry: { enabled: false },
      compaction: { enabled: false },
      cacheWarming: "off",
    }),
  );
  if (process.env.DADDY_TEST_SCOUT_PUBLIC_SKILL)
    await copyFile(process.env.DADDY_TEST_SCOUT_PUBLIC_SKILL, join(skill, "SKILL.md"));
  else await writeFile(join(skill, "SKILL.md"), SCOUT_PUBLIC);
  const cli =
    process.env.DADDY_TEST_PI_CLI ??
    fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const extension = fileURLToPath(new URL("./parent-run-extension.ts", import.meta.url));
  const grants = fileURLToPath(new URL("../../extensions/grants.ts", import.meta.url));
  const marker = join(root, "scout-calls.jsonl"),
    launches = join(root, "launches");
  // The governed child is started as `pi`: the same CLI, plus the scripted provider. Daddy's own arguments follow.
  await writeFile(
    join(bin, "pi"),
    `#!/bin/sh\nprintf 'launch\\n' >> ${quote(launches)}\nexec ${quote(process.execPath)} ${quote(cli)} -e ${quote(extension)} "$@"\n`,
  );
  await chmod(join(bin, "pi"), 0o700);
  const args = [
    cli,
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--no-mcp",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-skills",
    "--skill",
    skill,
    "-e",
    extension,
    "-e",
    grants,
    "--tools",
    "read,scout_research,delegate,delegate_describe",
    "--provider",
    PROVIDER,
    "--model",
    MODEL,
    "Research nested tool calls with scout-public.",
  ];
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: root,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        NO_COLOR: "1",
        TERM: "dumb",
        PI_DADDY_HERDR: "0",
        PI_DADDY_AUTO_MODE: "0",
        PI_DADDY_ACTIVITY_TIMELINE: "off",
        DADDY_PARENT_RUN_MARKER: marker,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`root Pi did not finish:\n${stderr}`));
    }, 90_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  const events = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const calls = (await readFile(marker, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const launched = (await readFile(launches, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { root, result, events, calls, launched };
}

const textOf = (value: { content?: Array<{ type: string; text?: string }> }) =>
  (value.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

test("a real child delegated to scout-public calls scout_research through its root, once, as a nested call", async () => {
  const run = await runRoot();
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal(run.launched, 1, "one governed child");
    assert.deepEqual(run.calls, [{ args: CHILD_QUESTION, signal: true }], "the root's tool ran once, child's args");
    const nested = run.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "scout_research");
    assert.equal(nested.length, 1);
    assert.equal(nested[0].parentToolCallId, "delegate-call", "run inside the waiting delegate's own pipeline");
    assert.equal(nested[0].isError, false);
    // Pi's own session record keeps the call on the delegation that made it, with the child's arguments.
    const recorded = run.events.find((e) => e.type === "message_end" && e.message.toolCallId === "delegate-call");
    assert.deepEqual(
      recorded.message.nestedCalls.calls.map((call: { name: string; arguments: unknown; status: string }) => ({
        name: call.name,
        arguments: call.arguments,
        status: call.status,
      })),
      [{ name: "scout_research", arguments: CHILD_QUESTION, status: "ok" }],
    );
    const delegated = run.events.find((e) => e.type === "tool_execution_end" && e.toolName === "delegate");
    assert.equal(delegated.isError, false, textOf(delegated.result));
    const answer = textOf(delegated.result);
    assert.ok(
      answer.startsWith("CHILD RECEIVED:\nThe following is OUTPUT FROM scout_research, RUN BY THE PARENT "),
      answer,
    );
    assert.match(answer, /\n<<<PARENT-TOOL-OUTPUT [a-f0-9]{32}>>>\n/);
    assert.ok(answer.includes(`\n${SCOUT_TEXT}\n<<<END `), answer);
    assert.doesNotMatch(answer, /briefPath|never-forwarded/);
    const final = run.events.filter((e) => e.type === "message_end" && e.message.role === "assistant").at(-1);
    assert.ok(textOf(final.message).startsWith("PARENT DONE:\nCHILD RECEIVED:"));
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("with the kill switch off the same delegation is refused before launch, as before", async () => {
  const run = await runRoot({ PI_DADDY_PARENT_TOOLS: "0" });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal(run.launched, 0);
    assert.deepEqual(run.calls, []);
    const delegated = run.events.find((e) => e.type === "tool_execution_end" && e.toolName === "delegate");
    assert.equal(delegated.isError, true);
    assert.match(textOf(delegated.result), /^delegation refused: child tool unavailable: scout_research — /);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("a child on another model than the root's is refused before launch, with the reason", async () => {
  const run = await runRoot({ DADDY_PARENT_RUN_CHILD_MODEL: `${PROVIDER}/${OTHER_MODEL}` });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal(run.launched, 0);
    assert.deepEqual(run.calls, []);
    const delegated = run.events.find((e) => e.type === "tool_execution_end" && e.toolName === "delegate");
    assert.equal(delegated.isError, true);
    const text = textOf(delegated.result);
    assert.match(text, /^delegation refused: child tool unavailable: scout_research — /);
    assert.ok(
      text.endsWith(
        "This session runs scout_research for a sub-agent only when the sub-agent uses this session's own " +
          "provider and model, and this delegation's model is different or not known.",
      ),
      text,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("after the root switches model, its running child's call is refused in the root and nothing runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "daddy-parent-run-switch-"));
  const run = await runRoot({ DADDY_PARENT_RUN_SWITCHED: join(root, "switched") });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal(run.launched, 1, "admitted on the root's model, then the root changed model");
    assert.deepEqual(run.calls, [], "the root's tool did not run");
    const delegated = run.events.find((e) => e.type === "tool_execution_end" && e.toolName === "delegate");
    assert.equal(delegated.isError, false, textOf(delegated.result));
    assert.equal(
      textOf(delegated.result).split("\n").slice(0, 2).join("\n"),
      "CHILD RECEIVED:\nscout_research was not run: the parent session refused it " +
        "(the parent session no longer uses the provider and model this child was started with)",
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a block in the root's own tool pipeline reaches the child as an error, and the real tool never runs", async () => {
  const run = await runRoot({ DADDY_PARENT_RUN_BLOCK: "1" });
  try {
    assert.equal(run.result.code, 0, run.result.stderr);
    assert.equal(run.launched, 1);
    assert.deepEqual(run.calls, [], "the root's tool did not run");
    const nested = run.events.find((e) => e.type === "tool_execution_end" && e.toolName === "scout_research");
    assert.equal(nested.parentToolCallId, "delegate-call");
    assert.equal(nested.isError, true);
    const answer = textOf(run.events.find((e) => e.type === "tool_execution_end" && e.toolName === "delegate").result);
    assert.ok(
      answer.startsWith("CHILD RECEIVED:\nThe following is AN ERROR REPORTED BY scout_research, RUN BY "),
      answer,
    );
    assert.match(answer, /the operator declined scout_research/);
    assert.doesNotMatch(answer, /SCOUT FIXTURE ANSWER/);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("a child whose binding is missing does not start, rather than holding a tool nobody answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "daddy-parent-run-unbound-"));
  try {
    await mkdir(join(root, "agent"));
    await writeFile(join(root, "agent", "auth.json"), "{}");
    const cli =
      process.env.DADDY_TEST_PI_CLI ??
      fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    const proxy = fileURLToPath(new URL("../../extensions/parent-tool-proxy.ts", import.meta.url));
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          cli,
          "--print",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "-e",
          proxy,
          "--tools",
          "scout_research",
          "x",
        ],
        {
          cwd: root,
          env: { PATH: "/usr/bin:/bin", HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /PI_DADDY_PROXIED_TOOLS is missing or malformed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
