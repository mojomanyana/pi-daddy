import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
import { saveGrant } from "../src/governance/grant-store.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/**
 * The two reads that discover what exists must say when they drop something.
 *
 * **Every assertion here was written because review proved the wiring severable with the suite green.** The
 * bound on `SKILL.md` shipped with a `skipped` callback no production caller passed, so an oversized
 * definition still vanished with nothing said — worse than the `catch { continue }` it replaced, because
 * the bound is NEW behaviour and a definition that loaded yesterday can be absent today. The registry
 * refusal reached `/grants` but not session start, which is where every comparable notice lives and the
 * only surface an operator sees without asking. Three separate reviewers reported the same shape: a
 * mechanism test that exercises a callback nobody supplies.
 *
 * So these drive the REAL `session_start` hook end to end and read what an operator would read.
 *
 * **The production changes that break them:** dropping the callback at `loadProjectDefinitions`, dropping
 * either `ctx.ui.notify` from `reportSessionStart`, dropping `registryPath` from `buildCatalog`'s call, or
 * severing `registryRefusal` anywhere between the reader and the banner.
 */

const KEYS = [
  ...GRANT_ENV_KEYS,
  "PI_CODING_AGENT_DIR",
  "PI_DADDY_HERDR",
  "PI_DADDY_WORKSPACE_REGISTRY",
  "PI_DADDY_WORKSPACE_PIN",
] as const;

async function sessionStartNotices(cwd: string, agentDir: string): Promise<string> {
  const hooks = new Map<string, any>();
  const api = {
    on: (name: string, handler: any) => hooks.set(name, handler),
    registerTool: () => {},
    registerCommand: () => {},
    getAllTools: () => [{ name: "read" }, { name: "delegate" }],
    getActiveTools: () => ["read"],
    setActiveTools: () => {},
  };
  grantsExtension(api as never);
  const notices: string[] = [];
  await hooks.get("session_start")(
    {},
    {
      cwd,
      mode: "json",
      sessionManager: {},
      ui: { notify: (message: string) => notices.push(message), select: async () => undefined },
      modelRegistry: { find: () => undefined },
    },
  );
  return notices.join("\n");
}

async function withEnv(fn: (cwd: string, agentDir: string) => Promise<void>): Promise<void> {
  const cwd = await tempDir("grants-loud-discovery-");
  const agentDir = await tempDir("grants-loud-discovery-agent-");
  const originalCwd = process.cwd();
  const original = new Map(KEYS.map((key) => [key, process.env[key]]));
  try {
    process.chdir(cwd);
    for (const key of KEYS) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_DADDY_HERDR = "0";
    await saveGrant(cwd, ["tool:read", "tool:delegate"]);
    await fn(cwd, agentDir);
  } finally {
    process.chdir(originalCwd);
    for (const key of KEYS) {
      const value = original.get(key);
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    }
  }
}

test("an oversized SKILL.md is named at session start, not discovered later as `unknown agent`", async () => {
  await withEnv(async (cwd) => {
    const dir = join(cwd, ".pi", "skills", "huge");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: huge\ndescription: an oversized definition\nallowed-tools: Read\n---\n${"z".repeat(1 << 21)}`,
    );
    const notices = await sessionStartNotices(cwd, "");
    assert.match(notices, /a definition was not loaded/, "session start must say a definition was dropped");
    assert.match(notices, /huge/, "and name which one");
    assert.match(notices, /over the 1048576 limit/, "and say the bound it broke, not just that it failed");
  });
});

test("an unreadable workspace registry is named at session start, not only inside /grants", async () => {
  await withEnv(async (cwd) => {
    const path = join(cwd, "registry.json");
    await writeFile(path, JSON.stringify({ version: 1, workspaces: { prod: { path: "not/absolute" } } }));
    process.env.PI_DADDY_WORKSPACE_REGISTRY = path;
    const notices = await sessionStartNotices(cwd, "");
    assert.match(notices, /workspace registry unreadable/, "the operator must not have to run /grants to learn this");
    assert.match(notices, /absolute path/, "and the reason must survive to the banner");
  });
});

test("a clean project says neither thing", async () => {
  await withEnv(async (cwd) => {
    const notices = await sessionStartNotices(cwd, "");
    assert.doesNotMatch(notices, /a definition was not loaded/);
    assert.doesNotMatch(notices, /workspace registry unreadable/);
  });
});
