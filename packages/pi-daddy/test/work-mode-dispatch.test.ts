/** Inert Pi protocol fixtures only: observe real child argv/env and retry boundaries without providers. */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import grantsExtension from "../extensions/grants.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { runOneDelegation } from "../extensions/run-delegation.ts";
import { newDelegationOccurrence } from "../extensions/execution-occurrence.ts";
import { beginWorkModeRequest, finishWorkModeRequest, setWorkMode } from "../extensions/work-mode.ts";
import { ENV_WORK_MODE, type WorkModeSelection } from "../src/kernel/work-mode.ts";
import { GOVERNANCE_ENV_KEYS } from "../src/kernel/env-names.ts";
import { piFixtureScript } from "./pi-fixture.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { toolSources } from "./tool-sources-fixture.ts";

after(cleanupTempDirs);
interface Launch {
  task: string;
  mode?: string;
  prompts: string[];
}
const ambitious: WorkModeSelection = { mode: "ambitious", emphases: ["depth"] };
const standard: WorkModeSelection = { mode: "standard", emphases: [] };

test("dispatch captures before its first await, preserves one retry, and isolates the later Standard request", async () => {
  const directory = await tempDir("work-mode-dispatch-");
  const bin = join(directory, "bin");
  await mkdir(bin);
  const launchFile = join(directory, "launches");
  const releaseFile = join(directory, "release");
  const child = piFixtureScript(`
const fs = require("node:fs");
const log = ${JSON.stringify(launchFile)}, release = ${JSON.stringify(releaseFile)};
const task = process.argv.at(-1).trim();
const prompts = process.argv.flatMap((value,index) => value === "--append-system-prompt" ? [process.argv[index+1]] : []);
const first = !fs.existsSync(log);
fs.appendFileSync(log, JSON.stringify({task, prompts, mode:process.env.${ENV_WORK_MODE}}) + "\\n");
if (task === "retry the read" && first) setInterval(() => fs.existsSync(release) && process.exit(1), 10);
else process.stdout.write("read complete");
`);
  await writeFile(join(bin, "pi"), child);
  await chmod(join(bin, "pi"), 0o755);
  const keys = [...GOVERNANCE_ENV_KEYS, "PATH", "PI_CODING_AGENT_DIR"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const tools = new Map<string, any>();
  const hooks = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  let session: ReturnType<typeof createGrantsSession> | undefined;
  try {
    for (const key of keys) if (key !== "PATH") delete process.env[key];
    Object.assign(process.env, {
      PATH: `${bin}:${saved.get("PATH") ?? ""}`,
      PI_DADDY_HERDR: "0",
      PI_DADDY_GRANT: "tool:read,tool:delegate",
      PI_CODING_AGENT_DIR: directory,
    });
    session = createGrantsSession(fileURLToPath(new URL("../extensions/grants.ts", import.meta.url)));
    const ctx = {
      cwd: directory,
      hasUI: true,
      sessionManager: {
        getSessionId: () => "work-mode-fixture",
        getEntries: () => entries,
        getBranch: () => entries,
      },
      modelRegistry: { find: () => undefined },
      ui: { notify: () => {}, select: async () => undefined },
    };
    grantsExtension(
      {
        on: (name: string, handler: (event: any, ctx: any) => any) =>
          hooks.set(name, [...(hooks.get(name) ?? []), handler]),
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand: () => {},
        appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
        getAllTools: () => toolSources(),
        getActiveTools: () => ["read"],
        setActiveTools: () => {},
        getCommands: () => [],
      } as never,
      session,
    );
    for (const hook of hooks.get("session_start") ?? []) await hook({}, ctx);
    setWorkMode(session, ambitious, "session");
    beginWorkModeRequest(session);
    const call = (task: string) =>
      tools.get("delegate").execute(task, { task, tools: ["read"] }, undefined, undefined, ctx);
    const first = call("retry the read");
    const launches = async (): Promise<Launch[]> => {
      try {
        return (await readFile(launchFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    };
    const deadline = Date.now() + 5000;
    while ((await launches()).length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await launches()).length, 1, "the controlled child reached its execution boundary");
    finishWorkModeRequest(session);
    setWorkMode(session, standard, "session");
    beginWorkModeRequest(session);
    await writeFile(releaseFile, "release");
    const result = await first;
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.details.retry.attempts, 2);
    const retried = await launches();
    assert.equal(retried.length, 2);
    for (const launch of retried) {
      assert.deepEqual(JSON.parse(launch.mode!), ambitious);
      assert.equal(launch.prompts.filter((prompt) => prompt.includes("<pi-daddy-work-mode>")).length, 1);
    }
    process.env[ENV_WORK_MODE] = JSON.stringify(ambitious);
    const next = await call("next ordinary read");
    assert.equal(next.isError, false, JSON.stringify(next));
    const ordinary = (await launches()).at(-1)!;
    assert.equal(ordinary.mode, undefined, "Standard does not inherit ambient or prior-child mode");
    assert.equal(
      ordinary.prompts.some((prompt) => prompt.includes("<pi-daddy-work-mode>")),
      false,
    );
    finishWorkModeRequest(session);
    setWorkMode(session, ambitious, "session");
    beginWorkModeRequest(session);
    const captured = runOneDelegation(
      session,
      { task: "capture before awaiting admission", tools: ["read"] },
      newDelegationOccurrence(session, 0),
      undefined,
      ctx as never,
      undefined,
    );
    // Do not await even a microtask: the invocation must already have detached its own snapshot.
    finishWorkModeRequest(session);
    setWorkMode(session, standard, "session");
    beginWorkModeRequest(session);
    assert.equal((await captured).ok, true);
    assert.deepEqual(JSON.parse((await launches()).at(-1)!.mode!), ambitious);
    for (const hook of hooks.get("session_shutdown") ?? []) await hook({ reason: "exit" }, ctx);
  } finally {
    await writeFile(releaseFile, "release");
    if (session) await session.autoMode?.close();
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});
