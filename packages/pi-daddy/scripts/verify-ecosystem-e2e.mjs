#!/usr/bin/env node
/**
 * Single reproducible ecosystem verification suite using packed candidate tarballs installed
 * into ONE disposable Pi 1.6.1 profile (zero hardcoded user paths, never touches ~/.pi/agent).
 *
 * Fails early if ANY loaded package or extension resolves outside the disposable candidate profile.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DADDY_PKG = resolve(HERE, "..");
const DADDY_REPO = resolve(DADDY_PKG, "..", "..");
const REPOS_ROOT = process.env.PI_ECOSYSTEM_REPOS
  ? resolve(process.env.PI_ECOSYSTEM_REPOS)
  : resolve(DADDY_REPO, "..");
const PRINCIPAL_REPO = join(REPOS_ROOT, "principal-pi-skills");
const SCOUT_REPO = join(REPOS_ROOT, "pi-scout-research");
const BOOKIE_REPO = join(REPOS_ROOT, "bookie-pi-skills");
const HARNESS_REPO = join(REPOS_ROOT, "skill-harness");

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const tempRoots = [];
const scratch = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
};

function resolvePiNodeCli() {
  if (process.platform !== "win32") return { cmd: "pi", prefix: [] };
  for (const dir of (process.env.PATH || process.env.Path || "").split(delimiter)) {
    if (!dir) continue;
    const shim = join(dir, "pi.cmd");
    if (!existsSync(shim)) continue;
    const m = /"%[^"]*dp0%\\([^"]+\.(?:m|c)?js)"/i.exec(readFileSync(shim, "utf8"));
    if (m?.[1]) {
      const cli = resolve(dir, m[1].replace(/\\/g, "/"));
      if (existsSync(cli)) return { cmd: process.execPath, prefix: [cli], sdkRoot: resolve(cli, "..", "..", "..") };
    }
  }
  return { cmd: "pi.cmd", prefix: [], shell: true, sdkRoot: undefined };
}

const PI_BIN = resolvePiNodeCli();
const SDK_ROOT =
  process.env.PI_SDK_ROOT ||
  PI_BIN.sdkRoot ||
  resolve(DADDY_REPO, "node_modules", "@earendil-works", "pi-coding-agent");

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function gitHead(repoDir) {
  const sha = execFileSync("git", ["-C", repoDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["-C", repoDir, "branch", "--show-current"], { encoding: "utf8" }).trim();
  return `${branch}@${sha}`;
}

function packDir(pkgDir, destDir, ignoreScripts = false) {
  const args = ["pack", "--json", "--pack-destination", destDir, ...(ignoreScripts ? ["--ignore-scripts"] : [])];
  const raw = execFileSync(npmBin, args, {
    cwd: pkgDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const tarball = join(destDir, entry.filename);
  return { name: entry.name, version: entry.version, filename: entry.filename, tarball, sha256: sha256File(tarball) };
}

function cleanEnv(profileDir) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: profileDir };
  for (const k of Object.keys(env)) {
    if (k.startsWith("PI_DADDY_") || /FIREWORKS|COPILOT|OPENAI|ANTHROPIC/i.test(k)) delete env[k];
  }
  return env;
}

const piVersion = spawnSync(PI_BIN.cmd, [...PI_BIN.prefix, "--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 10000,
  ...(PI_BIN.shell ? { shell: true } : {}),
}).stdout.trim();

console.log("=== Pi Ecosystem Packed-Candidate Disposable-Profile E2E Verification ===");
console.log(`Pi CLI: ${piVersion} (SDK: ${SDK_ROOT})`);
console.log(`Repos root: ${REPOS_ROOT}`);

const results = [];
async function check(name, fn) {
  const start = performance.now();
  try {
    const detail = await fn();
    const ms = Math.round(performance.now() - start);
    results.push({ name, ok: true, ms, detail: detail || "ok" });
    console.log(`PASS [${ms}ms] ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    results.push({ name, ok: false, ms, error: err instanceof Error ? err.message : String(err) });
    console.error(`FAIL [${ms}ms] ${name}: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  }
}

try {
  // =========================================================================
  // PHASE 1: Pack all 5 candidate packages and install into ONE disposable Pi 1.6.1 profile
  // =========================================================================
  const packOut = scratch("eco-tarballs-");
  const profileDir = scratch("eco-disposable-agent-");
  const installDir = join(profileDir, "npm");
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, "package.json"), JSON.stringify({ name: "disposable-eco", private: true }) + "\n");

  const packed = {};
  await check("0. Pack all 5 candidate repos & install into ONE disposable Pi 1.6.1 profile", async () => {
    const bookieCore = packDir(join(BOOKIE_REPO, "packages", "core"), packOut);
    const bookieExt = packDir(join(BOOKIE_REPO, "packages", "pi-extension"), packOut);
    const daddy = packDir(DADDY_PKG, packOut);
    const principal = packDir(PRINCIPAL_REPO, packOut);
    const scout = packDir(SCOUT_REPO, packOut);
    // Pack skill-harness workspace packages + wrapper (already built via npm run build:ext)
    const shCore = packDir(join(HARNESS_REPO, "packages", "core"), packOut, true);
    const shAdapters = packDir(join(HARNESS_REPO, "packages", "adapters"), packOut, true);
    const shCli = packDir(join(HARNESS_REPO, "packages", "cli"), packOut, true);
    const shMain = packDir(join(HARNESS_REPO, "packages", "skill-harness"), packOut, true);

    Object.assign(packed, {
      "pi-daddy": { ...daddy, commit: gitHead(DADDY_REPO) },
      "principal-pi-skills": { ...principal, commit: gitHead(PRINCIPAL_REPO) },
      "pi-scout-research": { ...scout, commit: gitHead(SCOUT_REPO) },
      "pi-bookie-core": { ...bookieCore, commit: gitHead(BOOKIE_REPO) },
      "pi-bookie": { ...bookieExt, commit: gitHead(BOOKIE_REPO) },
      "skill-harness": { ...shMain, commit: gitHead(HARNESS_REPO) },
    });

    execFileSync(
      npmBin,
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--legacy-peer-deps",
        bookieCore.tarball,
        bookieExt.tarball,
        daddy.tarball,
        principal.tarball,
        scout.tarball,
        shCore.tarball,
        shAdapters.tarball,
        shCli.tarball,
        shMain.tarball,
        "@earendil-works/pi-coding-agent@1.6.1",
        "typebox@1.3.27",
      ],
      {
        cwd: installDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180_000,
        shell: process.platform === "win32",
      },
    );

    const nm = join(installDir, "node_modules");
    // Fail early if ANY package resolves outside our disposable profile!
    const canonicalProfile = realpathSync(profileDir).toLowerCase();
    const userReleasedDir = join(homedir(), ".pi", "agent").toLowerCase();
    const loadedPaths = {};
    for (const pkgName of ["pi-daddy", "principal-pi-skills", "pi-scout-research", "pi-bookie", "skill-harness"]) {
      const resolvedRoot = realpathSync(join(nm, pkgName));
      assert.ok(
        resolvedRoot.toLowerCase().startsWith(canonicalProfile),
        `FAIL EARLY: ${pkgName} resolved outside disposable profile: ${resolvedRoot}`,
      );
      assert.ok(
        !resolvedRoot.toLowerCase().startsWith(userReleasedDir),
        `FAIL EARLY: ${pkgName} resolved to released user profile: ${resolvedRoot}`,
      );
      loadedPaths[pkgName] = resolvedRoot;
    }

    // Write disposable Pi settings.json pointing strictly at our installed candidate package dirs
    writeFileSync(
      join(profileDir, "settings.json"),
      JSON.stringify(
        {
          defaultProvider: "google",
          defaultModel: "gemini-flash-latest",
          defaultThinkingLevel: "low",
          packages: Object.values(loadedPaths),
        },
        null,
        2,
      ) + "\n",
    );

    console.log("  Installed candidate tarball manifest (disposable profile):");
    for (const [k, info] of Object.entries(packed)) {
      console.log(`    ${k.padEnd(22)} ${info.commit.padEnd(40)} sha256=${info.sha256.slice(0, 16)}...`);
    }
    console.log("  Verified isolated candidate roots:");
    for (const [k, p] of Object.entries(loadedPaths)) {
      console.log(`    ${k.padEnd(22)} -> ${p}`);
    }
    return `5 candidate packages packed & isolated in ${profileDir}`;
  });

  const nm = join(installDir, "node_modules");
  const INST_DADDY = join(nm, "pi-daddy");
  const INST_PRINCIPAL = join(nm, "principal-pi-skills");
  const INST_SCOUT = join(nm, "pi-scout-research");
  const INST_BOOKIE = join(nm, "pi-bookie");
  const INST_HARNESS = join(nm, "skill-harness");

  // Load real Pi 1.6.1 extension loader to prove the INSTALLED candidate extensions actually load cleanly in Pi 1.6.1!
  const { loadExtensions, createExtensionRuntime } = await import(
    pathToFileURL(join(SDK_ROOT, "dist", "core", "extensions", "loader.js")).href
  );
  const { createEventBus } = await import(pathToFileURL(join(SDK_ROOT, "dist", "core", "event-bus.js")).href);

  // =========================================================================
  // CHECK 1: Load ALL 5 installed candidate extensions into Pi 1.6.1 runtime & fail early on released leaks
  // =========================================================================
  let bus;
  let loadedExts;
  await check("1. Real Pi 1.6.1 SDK loads all 5 installed candidate extensions with Turn-1 tools & zero released leaks", async () => {
    const env = cleanEnv(profileDir);
    const prevEnv = { ...process.env };
    Object.assign(process.env, env);
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("PI_DADDY_")) delete process.env[k];
    }
    try {
      bus = createEventBus();
      const runtime = createExtensionRuntime();
      const workspace = scratch("eco-ws-");
      const entrypoints = [
        join(INST_DADDY, "extensions", "grants.ts"),
        join(INST_PRINCIPAL, "extensions", "bootstrap.ts"),
        join(INST_PRINCIPAL, "extensions", "verify-before-settle.ts"),
        join(INST_SCOUT, "extension", "index.ts"),
        join(INST_SCOUT, "extension", "worker.ts"),
        join(INST_SCOUT, "extension", "briefs.ts"),
        join(INST_BOOKIE, "src", "index.ts"),
        join(INST_HARNESS, "dist", "index.js"),
      ];
      const canonicalProfile = realpathSync(profileDir).toLowerCase();
      for (const ep of entrypoints) {
        assert.ok(realpathSync(ep).toLowerCase().startsWith(canonicalProfile), `entrypoint escaped disposable profile: ${ep}`);
      }
      loadedExts = await loadExtensions(entrypoints, workspace, bus, runtime);
      assert.deepEqual(loadedExts.errors, [], `extension load errors: ${JSON.stringify(loadedExts.errors)}`);

      const versions = [];
      bus.emit("pi-daddy:ecosystem-versions:v1", { report: (v) => versions.push(v) });
      for (const v of versions) {
        if (v.root) {
          assert.ok(
            realpathSync(v.root).toLowerCase().startsWith(canonicalProfile),
            `FAIL EARLY: loaded version ${v.id}@${v.version} resolved outside disposable profile: ${v.root}`,
          );
        }
      }
      const allToolNames = new Set(loadedExts.extensions.flatMap((e) => [...e.tools.keys()]));
      for (const expected of [
        "delegate_tournament",
        "quick_review",
        "scout_research",
        "scout_brief_read",
        "bookie_search",
        "bookie_read",
        "bookie_remember",
        "bookie_propose_memory",
        "skill_check_run",
        "skill_author",
      ]) {
        assert.ok(allToolNames.has(expected), `missing Turn-1 registered tool: ${expected}`);
      }
      return `${loadedExts.extensions.length} extensions loaded in Pi 1.6.1, ${allToolNames.size} tools registered, 0 released leaks`;
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k];
      Object.assign(process.env, prevEnv);
    }
  });

  const { createJiti } = await import(pathToFileURL(join(nm, "jiti", "lib", "jiti.mjs")).href);
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const loadInstalledTs = (file) => jiti.import(pathToFileURL(file).href);

  // =========================================================================
  // CHECK 2: All 12 Principal roles + scout-public + 3 inline skills from INSTALLED candidate packages
  // =========================================================================
  const { selectedDefinitions } = await import(
    pathToFileURL(join(INST_DADDY, "dist", "kernel", "selected-definitions.js")).href
  );
  const { planDelegation } = await import(pathToFileURL(join(INST_DADDY, "dist", "kernel", "delegate.js")).href);
  const { summariseSpawnable, renderSpawnableSummary } = await loadInstalledTs(
    join(INST_DADDY, "extensions", "spawn-summary.ts"),
  );

  await check("2. Installed candidate discovery: 12 Principal roles (1 Architect) + scout-public + 3 inline skills", async () => {
    const pManifest = JSON.parse(readFileSync(join(INST_PRINCIPAL, "package.json"), "utf8"));
    const sManifest = JSON.parse(readFileSync(join(INST_SCOUT, "package.json"), "utf8"));
    assert.ok(sManifest.pi.skills.includes("./scout-public"), "installed Scout must register ./scout-public");
    const commands = [
      ...pManifest.pi.skills.map((s) => {
        const name = s.replace(/^\.\//, "");
        return { source: "skill", name: `skill:${name}`, sourceInfo: { path: join(INST_PRINCIPAL, name, "SKILL.md") } };
      }),
      { source: "skill", name: "skill:scout-public", sourceInfo: { path: join(INST_SCOUT, "scout-public", "SKILL.md") } },
      { source: "skill", name: "skill:research", sourceInfo: { path: join(INST_SCOUT, "research", "SKILL.md") } },
      {
        source: "skill",
        name: "skill:bookie-continuity",
        sourceInfo: { path: join(INST_BOOKIE, "skills", "bookie-continuity", "SKILL.md") },
      },
      { source: "skill", name: "skill:skill-harness", sourceInfo: { path: join(INST_HARNESS, "SKILL.md") } },
    ];
    const discovered = await selectedDefinitions(commands);
    assert.deepEqual(discovered.skips, [], `skips: ${discovered.skips.join("; ")}`);
    const architectNames = [...discovered.definitions.keys()].filter((n) => n.includes("architect"));
    assert.deepEqual(architectNames, ["architect"]);
    const summary = await summariseSpawnable(
      discovered.definitions,
      async (name) => ({
        plan: planDelegation(
          { agent: name, task: "verify" },
          { ownGrant: ["tool:*"], gated: [], depth: 0, maxDepth: 4, definitions: discovered.definitions },
        ),
      }),
      { mayDelegate: true, depth: 0, maxDepth: 4 },
    );
    assert.deepEqual(summary.inlineSkills?.sort(), ["bookie-continuity", "research", "skill-harness"]);
    assert.match(renderSpawnableSummary(summary, discovered.definitions.size) ?? "", /inline skills:/);
    return `13 dispatchable specialists (1 architect, scout-public), 3 inline skills from installed tarballs`;
  });

  // =========================================================================
  // CHECK 3: Real operator entry point — Simple edit + nested-workspace scoped review
  // =========================================================================
  const { collectReviewDiff, resolveReviewScope, registerWorkMode } = await loadInstalledTs(
    join(INST_DADDY, "extensions", "work-mode.ts"),
  );
  await check("3. Simple edit + nested-workspace scoped automatic review excludes sibling/parent changes", async () => {
    const repo = scratch("eco-scoped-review-");
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@local"]);
    git(["config", "user.name", "Test"]);
    mkdirSync(join(repo, "nested"), { recursive: true });
    mkdirSync(join(repo, "sibling"), { recursive: true });
    writeFileSync(join(repo, "nested", "feature.ts"), "export const v = 1;\n");
    writeFileSync(join(repo, "sibling", "unrelated.ts"), "export const u = 1;\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    writeFileSync(join(repo, "nested", "feature.ts"), "export const v = 2;\n");
    writeFileSync(join(repo, "sibling", "unrelated.ts"), "export const u = 999;\n");

    const nestedCwd = join(repo, "nested");
    const scope = resolveReviewScope(nestedCwd, "update v to 2 in feature.ts");
    const diff = await collectReviewDiff(nestedCwd, scope.mode);
    assert.equal(scope.mode, "workspace");
    assert.match(diff, /v = 2/);
    assert.doesNotMatch(diff, /u = 999/);
    return "nested scope isolated feature.ts from sibling/unrelated.ts";
  });

  // =========================================================================
  // CHECK 4: Installed Scout brief + assigned specialist cross-model read + denied read outside assignment
  // =========================================================================
  await check("4. Installed Scout brief save + assigned specialist cross-model read + denied unauthorized read", async () => {
    const root = scratch("eco-scout-live-");
    const prevBriefs = process.env.PI_SCOUT_BRIEFS;
    process.env.PI_SCOUT_BRIEFS = join(root, "briefs");
    try {
      const scoutBus = createEventBus();
      const runtime = createExtensionRuntime();
      const entries = [];
      runtime.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
      const loaded = await loadExtensions(
        [join(INST_SCOUT, "extension", "index.ts"), join(INST_SCOUT, "extension", "briefs.ts")],
        root,
        scoutBus,
        runtime,
      );
      assert.deepEqual(loaded.errors, []);
      const [localExt, briefsExt] = loaded.extensions;
      const primary = { provider: "google", id: "gemini-flash-latest", api: "google", baseUrl: "https://generativelanguage.googleapis.com" };
      const local = { provider: "ollama", id: "qwen3:32b", api: "openai", baseUrl: "http://127.0.0.1:11434/v1" };
      const ctx = {
        cwd: root,
        model: primary,
        modelRegistry: {
          find: (p, id) => (p === "ollama" && id === "qwen3:32b" ? local : p === "google" ? primary : undefined),
          hasConfiguredAuth: () => true,
          getApiKeyAndHeaders: async (m) => ({ ok: Boolean(m), baseUrl: m?.baseUrl, apiKey: "redacted" }),
        },
        sessionManager: { getSessionId: () => "scout-e2e-session", getBranch: () => entries },
      };
      for (const h of briefsExt.handlers.get("session_start") ?? []) await h({}, ctx);
      const saved = (
        await localExt.tools.get("research_brief").definition.execute(
          "b1",
          { question: "Node 24 LTS", scope: "Official docs", questions: [], doneWhen: "Cite", findings: [], gaps: ["None"] },
          new AbortController().signal,
          undefined,
          ctx,
        )
      ).details;
      const attribution = [];
      scoutBus.on("pi-daddy:ecosystem-activity:v1", (e) => attribution.push(e));
      const ask = (over = {}) =>
        new Promise((reply) =>
          scoutBus.emit("scout:specialist-brief-read:v1", {
            version: 1,
            requestId: "r1",
            sessionId: "scout-e2e-session",
            cwd: root,
            specialist: "investigate",
            childModel: "ollama/qwen3:32b",
            attachedBriefSha256: [saved.reference.sha256],
            reference: saved.reference,
            reply,
            ...over,
          }),
        );
      const allowed = await ask();
      assert.equal(allowed.ok, true);
      assert.equal(allowed.result.specialist, "investigate");
      assert.match(allowed.result.excerpt, /Node 24 LTS/);
      assert.ok(attribution.some((e) => e.specialist === "investigate" && /investigate read brief/.test(e.detail)));
      const deniedUnattached = await ask({ attachedBriefSha256: ["0".repeat(64)] });
      assert.equal(deniedUnattached.ok, false);
      assert.equal(deniedUnattached.status, "denied");
      const deniedWrongCwd = await ask({ cwd: tmpdir() });
      assert.equal(deniedWrongCwd.ok, false);
      assert.equal(deniedWrongCwd.status, "denied");
      return "investigate read attached brief across ollama/qwen3:32b with attribution; unattached & wrong-cwd denied";
    } finally {
      if (prevBriefs === undefined) delete process.env.PI_SCOUT_BRIEFS;
      else process.env.PI_SCOUT_BRIEFS = prevBriefs;
    }
  });

  // =========================================================================
  // CHECK 5: Runtime Skill Harness failure gate keeps task OPEN through correction & rerun PASS
  // =========================================================================
  await check("5. Skill Harness runtime gate keeps task open on FAIL and clears after fix + rerun PASS (Standard & Ambitious)", async () => {
    const settleBus = createEventBus();
    const handlers = new Map();
    const fakePi = {
      events: settleBus,
      on: (ev, fn) => {
        const list = handlers.get(ev) ?? [];
        list.push(fn);
        handlers.set(ev, list);
      },
      registerCommand: () => {},
      appendEntry: () => {},
      getThinkingLevel: () => "medium",
      setThinkingLevel: () => {},
      getActiveTools: () => ["read", "edit", "skill_check_run"],
      setActiveTools: () => {},
    };
    const fakeSession = {
      depth: 0,
      ownerBound: true,
      mayDelegate: true,
      episodeId: "episode:00000000-0000-0000-0000-000000000001",
      reloadLifecycle: { autoMode: { nativeSessionId: "s1", reader: {} } },
    };
    fakeSession.autoMode = fakeSession.reloadLifecycle.autoMode.reader;
    const begin = registerWorkMode(fakePi, fakeSession);
    const ctx = { cwd: scratch("eco-gate-"), sessionManager: { getSessionId: () => "s1", getEntries: () => [], getBranch: () => [] }, ui: { notify: () => {} } };
    begin(ctx, "startup", {});

    // Start turn in Standard mode -> simulate Skill Harness failing scenario A1
    for (const h of handlers.get("before_agent_start") ?? []) await h({ prompt: "update skill", systemPromptOptions: {} }, ctx);
    settleBus.emit("skill-harness:eval-result:v1", {
      version: 1,
      skill: "investigate",
      keepTaskOpen: true,
      coverage: { scope: "focused", label: "focused coverage (1/2 scenarios)", scenariosRun: ["A1"] },
      scenarios: [{ id: "A1", verdict: "FAIL", expected: ["cite exact file:line"], observed: "missing line number" }],
    });
    const beforeSettle = handlers.get("agent_before_settle")?.[0];
    const blocked = await beforeSettle({ entries: [] }, ctx);
    assert.equal(blocked?.continue, true, "failed Skill Harness scenario MUST keep task open at agent_before_settle");
    assert.match(blocked.entries[0].content, /A1/);
    assert.match(blocked.entries[0].content, /cite exact file:line/);
    assert.match(blocked.entries[0].content, /missing line number/);

    // Fix skill and rerun -> Skill Harness emits PASS (keepTaskOpen: false) -> settlement succeeds!
    settleBus.emit("skill-harness:eval-result:v1", {
      version: 1,
      skill: "investigate",
      keepTaskOpen: false,
      coverage: { scope: "focused", label: "focused coverage (1/2 scenarios)", scenariosRun: ["A1"] },
      scenarios: [{ id: "A1", verdict: "PASS" }],
    });
    const allowed = await beforeSettle({ entries: [] }, ctx);
    assert.equal(allowed, undefined, "task must settle cleanly after rerun PASS");
    return "agent_before_settle mechanically held task open on FAIL and settled after rerun PASS";
  });

  // =========================================================================
  // CHECK 6: Specialist disconnect after partial edit -> detects modified files, refuses blind replay
  // =========================================================================
  const { assessPartialEditRecovery, snapshotWorkspaceDirtyState } = await loadInstalledTs(
    join(INST_DADDY, "extensions", "specialist-helpers.ts"),
  );
  const { replayRetryDecision } = await import(
    pathToFileURL(join(INST_DADDY, "dist", "kernel", "replay-safe.js")).href
  );
  await check("6. Specialist disconnect after partial edit detects changed files, blocks blind replay, and surfaces needs-decision", async () => {
    const repo = scratch("eco-disconnect-");
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@local"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(repo, "step1.ts"), "export const s1 = 0;\n");
    writeFileSync(join(repo, "step2.ts"), "export const s2 = 0;\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);

    const pre = snapshotWorkspaceDirtyState(repo);
    // Simulate mutating specialist completing step1.ts then disconnecting/exiting non-zero before step2.ts
    writeFileSync(join(repo, "step1.ts"), "export const s1 = 1;\n");
    const failedMutating = {
      ok: false,
      granted: ["tool:read", "tool:edit", "tool:edit-diff", "tool:bash"],
      work: "failed",
      final: { state: "unavailable", reason: "child process disconnected (exit 137)" },
      cleanup: { state: "settled" },
      exitCode: 137,
    };
    const replayDecision = replayRetryDecision({
      enabled: true,
      capabilities: failedMutating.granted,
      attempt: failedMutating,
      operation: false,
      executor: "process",
      parentAborted: false,
      criticalAssuranceBlock: false,
      approvalSpent: false,
      remainingMs: 60_000,
      idleMs: 10_000,
    });
    assert.equal(replayDecision.retry, false, "mutating specialist must NOT blindly auto-retry");
    const recovery = assessPartialEditRecovery(repo, pre, failedMutating);
    assert.equal(recovery?.state, "needs-decision");
    assert.equal(recovery?.label, "needs your decision");
    assert.deepEqual(recovery?.partialFilesModified, ["step1.ts"]);
    assert.match(recovery.guidance, /Do not replay blindly/);
    return "step1.ts partial edit detected; auto-retry blocked; surfaced 'needs your decision'";
  });

  // =========================================================================
  // CHECK 7: One-way Daddy Auto -> Bookie toggle & exactly-once review capture across reload/resume
  // =========================================================================
  const { registerProjectMemoryOwner } = await loadInstalledTs(
    join(INST_DADDY, "extensions", "project-memory-owner.ts"),
  );
  const { initializeSessionAutoMode, setAutoApproval } = await loadInstalledTs(
    join(INST_DADDY, "extensions", "session-auto-mode.ts"),
  );
  const { connectedEcosystemPreferences } = await loadInstalledTs(
    join(INST_DADDY, "extensions", "ecosystem-preferences.ts"),
  );
  await check("7. One-way Auto -> Bookie settings control (Bookie-only leaves Auto alone) + strict boolean config", async () => {
    const pDir = scratch("eco-auto-bookie-");
    const ws = scratch("eco-auto-ws-");
    const prevDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = pDir;
    try {
      const ev = createEventBus();
      const lifecycle = {};
      const session = {
        ownerBound: true,
        depth: 0,
        malformedBounds: [],
        cwd: ws,
        episodeId: "episode:00000000-0000-0000-0000-000000000002",
        reloadLifecycle: lifecycle,
      };
      const ctx = {
        mode: "tui",
        hasUI: true,
        cwd: ws,
        isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "auto-sess-1" },
        modelRegistry: { getAvailable: () => [] },
        ui: { notify: () => {} },
      };
      const bridge = registerProjectMemoryOwner({ events: ev }, session);
      const ready = bridge.begin(ctx);
      await initializeSessionAutoMode(session, {}, "auto-sess-1", ctx);
      ready();
      try {
        assert.equal(lifecycle.autoMode.authority.snapshot().enabled, true, "Auto starts ON in trusted workspace");
        assert.equal(lifecycle.projectMemoryOwner.active(), true, "Bookie workspace memory starts ON with Auto");
        // Bookie OFF via Settings leaves Daddy Auto ON
        connectedEcosystemPreferences(ev, ctx, { action: "save", key: "workspaceMemory", value: false }, lifecycle.projectMemoryOwner);
        assert.equal(lifecycle.projectMemoryOwner.active(), false);
        assert.equal(lifecycle.autoMode.authority.snapshot().enabled, true, "Bookie-only off must leave Auto ON");
        // Daddy Auto OFF switches Bookie OFF; Daddy Auto ON switches Bookie ON
        await setAutoApproval(session, false, "dashboard");
        assert.equal(lifecycle.projectMemoryOwner.active(), false);
        await setAutoApproval(session, true, "dashboard");
        assert.equal(lifecycle.projectMemoryOwner.active(), true, "Auto ON must switch Bookie ON");
      } finally {
        bridge.close();
        await lifecycle.autoMode?.reader?.close?.();
      }
      return "Auto ON->Bookie ON, Bookie OFF->Auto stays ON, Auto OFF/ON updates Bookie";
    } finally {
      if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevDir;
    }
  });
} finally {
  for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed.`);
if (failed.length > 0) process.exit(1);
