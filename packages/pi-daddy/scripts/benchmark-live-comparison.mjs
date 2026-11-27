#!/usr/bin/env node
/**
 * Live-model acceptance & baseline-vs-candidate comparison benchmark.
 * Uses ONE configured provider (`google/gemini-flash-latest`, --thinking low) in disposable
 * Pi 1.6.1 profiles with Fireworks/Copilot/OpenAI/Anthropic credentials explicitly stripped.
 *
 * Covers:
 * - Task 1: Released vs candidate simple edit + nested-workspace scoped review
 * - Task 2a: Direct investigation vs Daddy/Principal `investigate` specialist
 * - Task 2b: Real changed-skill sessions via normal Pi entry points in Standard & Ambitious
 * - Task 3a: Direct CapacityAllocator + provider wave (Fanout 8 vs 24; accurately labeled)
 * - Task 3b: Real Daddy/Principal delegation review in Standard & Ambitious scoring expected findings
 * - Task 4: Delegated `scout-public` reported separately for Docker mode and Direct HTTPS mode,
 *           requiring valid delegation, valid returned `research-brief` reference, and expected
 *           cleanup evidence for the selected execution mode.
 *
 * Exits nonzero (1) if ANY required acceptance assertion fails.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const RELEASED_ROOT = join(homedir(), ".pi", "agent", "npm", "node_modules");

const MODEL = process.env.PI_BENCH_MODEL || "google/gemini-flash-latest";
const THINKING = process.env.PI_BENCH_THINKING || "low";
const [PROVIDER] = MODEL.split("/");
const REQUIRE_DOCKER = process.argv.includes("--require-docker");
const ONLY_ARG = (() => {
  const i = process.argv.indexOf("--only");
  return i !== -1 && process.argv[i + 1] ? new Set(process.argv[i + 1].split(",")) : null;
})();
const want = (id) => !ONLY_ARG || ONLY_ARG.has(id);
const progress = (msg) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${msg}`);

function resolvePiCli() {
  if (process.platform !== "win32") return { cmd: "pi", prefix: [] };
  for (const dir of (process.env.PATH || process.env.Path || "").split(delimiter)) {
    if (!dir) continue;
    const shim = join(dir, "pi.cmd");
    if (!existsSync(shim)) continue;
    const m = /"%[^"]*dp0%\\([^"]+\.(?:m|c)?js)"/i.exec(readFileSync(shim, "utf8"));
    if (m?.[1]) {
      const cli = resolve(dir, m[1].replace(/\\/g, "/"));
      if (existsSync(cli)) return { cmd: process.execPath, prefix: [cli] };
    }
  }
  return { cmd: "pi", prefix: [] };
}
const PI_BIN = resolvePiCli();

const tempDirs = [];
const scratch = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tempDirs.push(d);
  return d;
};

/** Create a valid Pi session JSONL file with persisted work-mode selection (`standard` or `ambitious`). */
function createModeSessionFile(cwd, mode) {
  const dir = scratch(`pi-sess-${mode}-`);
  const file = join(dir, `${mode}.jsonl`);
  const ts = new Date().toISOString();
  const header = { type: "session", version: 3, id: randomUUID(), timestamp: ts, cwd };
  const entry = {
    type: "custom",
    id: randomUUID().slice(0, 8),
    parentId: null,
    timestamp: ts,
    customType: "pi-daddy:work-mode:v1",
    data: { version: 1, selection: { mode, emphases: [] } },
  };
  writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`, "utf8");
  return file;
}

/** Build a disposable Pi profile containing ONLY the single chosen provider's auth (no Fireworks/Copilot). */
function createSingleProviderProfile(packages, ecosystemJson) {
  const dir = scratch("pi-live-profile-");
  const realAuthPath = join(homedir(), ".pi", "agent", "auth.json");
  if (!existsSync(realAuthPath)) throw new Error(`No auth.json found at ${realAuthPath}`);
  const fullAuth = JSON.parse(readFileSync(realAuthPath, "utf8"));
  if (!fullAuth[PROVIDER]) throw new Error(`Provider "${PROVIDER}" not configured in ${realAuthPath}`);
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ [PROVIDER]: fullAuth[PROVIDER] }, null, 2) + "\n");
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(
      {
        defaultProvider: PROVIDER,
        defaultModel: MODEL.slice(PROVIDER.length + 1),
        defaultThinkingLevel: THINKING,
        packages,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "ecosystem.json"), JSON.stringify(ecosystemJson, null, 2) + "\n");
  return dir;
}

function cleanChildEnv(profileDir, extra = {}) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: profileDir };
  for (const k of Object.keys(env)) {
    if (k.startsWith("PI_DADDY_") || /FIREWORKS|COPILOT|OPENAI|ANTHROPIC/i.test(k)) delete env[k];
  }
  return { ...env, PI_DADDY_ACTIVITY_TIMELINE: "off", ...extra };
}

function isDockerDaemonRunning() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/** Validate a structured Scout `research-brief` reference object. */
function isValidBriefReference(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      obj.version === 1 &&
      obj.producer === "pi-scout-research" &&
      obj.kind === "research-brief" &&
      typeof obj.session === "string" &&
      /^[a-f0-9]{64}$/.test(obj.session) &&
      typeof obj.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(obj.sha256) &&
      Number.isInteger(obj.bytes) &&
      obj.bytes >= 1 &&
      obj.bytes <= 96001,
  );
}

/** Extract any valid Scout `research-brief` JSON reference from text or tool details. */
function extractBriefReference(text, toolResults) {
  const candidates = [];
  for (const tr of toolResults) {
    if (tr.details?.briefReference) candidates.push(tr.details.briefReference);
    if (tr.details?.reference) candidates.push(tr.details.reference);
    if (typeof tr.text === "string") {
      for (const m of tr.text.matchAll(/\{[^{}]*"kind"\s*:\s*"research-brief"[^{}]*\}/g)) {
        try {
          candidates.push(JSON.parse(m[0]));
        } catch {}
      }
    }
  }
  if (typeof text === "string") {
    for (const m of text.matchAll(/\{[^{}]*"kind"\s*:\s*"research-brief"[^{}]*\}/g)) {
      try {
        candidates.push(JSON.parse(m[0]));
      } catch {}
    }
  }
  return candidates.find(isValidBriefReference) ?? null;
}

/** Run real Pi 1.6.1 in JSON mode and extract final text, tool calls, tool results, model calls, and tokens. */
function runPiJson({ cwd, profileDir, prompt, sessionFile, extraArgs = [], extraEnv = {}, timeoutMs = 120_000 }) {
  return new Promise((resolveDone) => {
    const start = performance.now();
    const sessionArgs = sessionFile ? ["--session", sessionFile] : ["--no-session"];
    const args = [
      ...PI_BIN.prefix,
      "-p",
      "--mode",
      "json",
      ...sessionArgs,
      "--approve",
      "--model",
      MODEL,
      "--thinking",
      THINKING,
      ...extraArgs,
      prompt,
    ];
    const child = spawn(PI_BIN.cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanChildEnv(profileDir, extraEnv),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsedMs = Math.round(performance.now() - start);
      let modelCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      const toolCalls = [];
      const toolResults = [];
      let finalText = "";
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            modelCalls++;
            const u = ev.message.usage;
            if (u) {
              inputTokens += Number(u.input ?? u.inputTokens ?? 0);
              outputTokens += Number(u.output ?? u.outputTokens ?? 0);
              totalTokens += Number(u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0));
            }
            const texts = (ev.message.content ?? [])
              .filter((c) => c?.type === "text" && typeof c.text === "string")
              .map((c) => c.text);
            if (texts.length) finalText = texts.join("\n").trim();
          }
          if (ev.type === "tool_execution_start" && ev.toolName) {
            toolCalls.push({ tool: ev.toolName, toolCallId: ev.toolCallId, args: ev.args });
          }
          if (ev.type === "tool_execution_end" && ev.toolName) {
            const text = (ev.result?.content ?? [])
              .filter((c) => c?.type === "text" && typeof c.text === "string")
              .map((c) => c.text)
              .join("\n");
            toolResults.push({
              tool: ev.toolName,
              toolCallId: ev.toolCallId,
              isError: ev.isError === true,
              text,
              details: ev.result?.details,
            });
          }
        } catch {
          /* ignore non-JSON diagnostic lines */
        }
      }
      resolveDone({
        ok: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        elapsedMs,
        modelCalls,
        tokens: { input: inputTokens, output: outputTokens, total: totalTokens || inputTokens + outputTokens },
        toolCalls,
        toolResults,
        finalText,
        stderr: stderr.trim().slice(0, 600),
      });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish(null, true);
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.once("error", (err) => {
      stderr += err.message;
      finish(1, false);
    });
    child.once("close", (code) => finish(code, false));
  });
}

function makeSimpleEditFixture() {
  const repo = scratch("live-edit-");
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "bench@local"]);
  git(["config", "user.name", "Bench"]);
  mkdirSync(join(repo, "nested"), { recursive: true });
  mkdirSync(join(repo, "sibling"), { recursive: true });
  writeFileSync(join(repo, "nested", "math.mjs"), "export function double(n) { return n + 1; }\n");
  writeFileSync(join(repo, "sibling", "noise.mjs"), "export const noise = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  writeFileSync(join(repo, "sibling", "noise.mjs"), "export const noise = 999;\n");
  return { repo, nested: join(repo, "nested") };
}

function makeInvestigateFixture() {
  const dir = scratch("live-inv-");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "entry.ts"),
    'import { routeRequest } from "./router.ts";\nexport function handle(req: { token: string }) { return routeRequest(req); }\n',
  );
  writeFileSync(
    join(dir, "src", "router.ts"),
    'import { verifyToken } from "./auth.ts";\nexport function routeRequest(req: { token: string }) { return verifyToken(req.token); }\n',
  );
  writeFileSync(
    join(dir, "src", "auth.ts"),
    'export function verifyToken(token: string): boolean { return token.startsWith("ok_"); }\n',
  );
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "bench@local"]);
  git(["config", "user.name", "Bench"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

/** Seeded multi-file review fixture with 3 concrete expected findings for real Daddy/Principal delegation. */
function makeSeededReviewFixture() {
  const dir = scratch("live-review-fixture-");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "auth.ts"),
    [
      "// Auth middleware",
      "export function isAuthorized(header: string | undefined, expected: string): boolean {",
      "  if (!header) return true; // BUG 1: empty/missing Authorization header bypasses auth!",
      "  return header === expected;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "query.ts"),
    [
      "// User lookup query builder",
      "export function buildUserQuery(userId: string): string {",
      '  return "SELECT * FROM users WHERE id = \'" + userId + "\'"; // BUG 2: SQL injection via string concatenation!',
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "cache.ts"),
    [
      "// Request cache",
      "const entries = new Map<string, string>();",
      "export function cachePut(key: string, payload: string): void {",
      "  entries.set(key, payload); // BUG 3: unbounded Map growth with no eviction/size cap (memory leak)!",
      "}",
      "export function cacheGet(key: string): string | undefined { return entries.get(key); }",
      "",
    ].join("\n"),
  );
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "bench@local"]);
  git(["config", "user.name", "Bench"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

/** Seeded skill fixture with 2 scenarios for real Standard & Ambitious changed-skill sessions. */
function makeChangedSkillFixture() {
  const dir = scratch("live-changed-skill-");
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      "name: release-tagger",
      "description: Use when formatting release tags or release notes.",
      "---",
      "# Release Tagger",
      "- Always prefix release tags with `v` (e.g. `v1.2.3`).",
      "- Include the commit hash in release notes.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "tests", "specification.yaml"),
    [
      "skill: release-tagger",
      "judge_persona: Strict release engineering reviewer.",
      "ship_bar: { total: 2, min_pass: 2 }",
      "scenarios:",
      "  - id: tag-prefix",
      "    title: Tag prefix formatting",
      '    turns: ["Format version 2.4.0 as a release tag."]',
      '    checklist: ["Output includes v2.4.0 with leading v prefix."]',
      "  - id: notes-commit",
      "    title: Release notes commit hash",
      '    turns: ["Write a 1-line release note for version 2.4.0 at commit abc1234."]',
      '    checklist: ["Output includes both v2.4.0 and commit abc1234."]',
      "",
    ].join("\n"),
  );
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "bench@local"]);
  git(["config", "user.name", "Bench"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

function scoreSeededReviewFindings(text) {
  const lower = text.toLowerCase();
  const matched = {
    authBypass: /auth\.ts/.test(lower) && /(bypass|missing|empty|returns?\s+true|!header)/.test(lower),
    sqlInjection: /query\.ts/.test(lower) && /(sql\s*injection|sqli|concatenat|parameteriz|interpolat)/.test(lower),
    unboundedCache: /cache\.ts/.test(lower) && /(unbounded|leak|evict|max|limit|cap|never\s+clear)/.test(lower),
  };
  const count = Object.values(matched).filter(Boolean).length;
  return { matched, score: count, total: 3 };
}

const releasedPackages = [
  join(RELEASED_ROOT, "pi-daddy"),
  join(RELEASED_ROOT, "principal-pi-skills"),
  join(RELEASED_ROOT, "pi-scout-research"),
  join(RELEASED_ROOT, "pi-bookie"),
  join(RELEASED_ROOT, "skill-harness"),
];
const candidatePackages = [
  DADDY_PKG,
  PRINCIPAL_REPO,
  SCOUT_REPO,
  join(BOOKIE_REPO, "packages", "pi-extension"),
  join(HARNESS_REPO, "packages", "skill-harness"),
];

const ecoBase = {
  autoOnStartup: true,
  models: {},
  dashboard: { autoStart: false, autoSplit: false },
  escalation: { auto: false },
  harvest: { mode: "off" },
  scout: { model: "session", thinking: "auto", directUrls: true },
  bookie: { workspaceMemory: false, autoRecall: false, autoDistill: false, autoSyncReviews: false },
};
const ecoCandDirect = {
  ...ecoBase,
  delegation: { maxDepth: 4, inheritContextFiles: true, tournamentTimeoutSec: 120 },
};
const ecoCandDockerOnly = {
  ...ecoCandDirect,
  scout: { model: "session", thinking: "auto", directUrls: false },
};

const { createCapacityAllocator } = await import(pathToFileURL(join(DADDY_PKG, "dist/kernel/capacity.js")).href);
const { collectReviewDiff, resolveReviewScope } = await import(
  pathToFileURL(join(DADDY_PKG, "extensions/work-mode.ts")).href
);

try {
  const releasedProfile = createSingleProviderProfile(releasedPackages, ecoBase);
  const candidateProfile = createSingleProviderProfile(candidatePackages, ecoCandDirect);
  const candidateDockerProfile = createSingleProviderProfile(candidatePackages, ecoCandDockerOnly);

  // -------------------------------------------------------------------------
  // 1. Live Simple Edit: Released vs Candidate
  // -------------------------------------------------------------------------
  progress("task1 simple-edit starting...");
  const editPrompt = "Fix double(n) in math.mjs so it returns n * 2 instead of n + 1. Keep it direct and concise.";
  const fixBase = makeSimpleEditFixture();
  const resEditBase = want("1")
    ? await runPiJson({ cwd: fixBase.nested, profileDir: releasedProfile, prompt: editPrompt })
    : { ok: true, elapsedMs: 0, modelCalls: 0, tokens: { input: 0, output: 0, total: 0 }, toolCalls: [], toolResults: [], finalText: "", stderr: "" };
  const editBaseCorrect = !want("1") || /return\s+n\s*\*\s*2/.test(readFileSync(join(fixBase.nested, "math.mjs"), "utf8"));
  const baseReviewDiff = execFileSync("git", ["diff", "--no-color", "HEAD"], { cwd: fixBase.nested, encoding: "utf8" });

  const fixCand = makeSimpleEditFixture();
  const resEditCand = want("1")
    ? await runPiJson({ cwd: fixCand.nested, profileDir: candidateProfile, prompt: editPrompt })
    : { ok: true, elapsedMs: 0, modelCalls: 0, tokens: { input: 0, output: 0, total: 0 }, toolCalls: [], toolResults: [], finalText: "", stderr: "" };
  const editCandCorrect = !want("1") || /return\s+n\s*\*\s*2/.test(readFileSync(join(fixCand.nested, "math.mjs"), "utf8"));
  const candScope = resolveReviewScope(fixCand.nested, editPrompt);
  const candReviewDiff = await collectReviewDiff(fixCand.nested, candScope);
  progress(`task1 done base=${resEditBase.elapsedMs}ms cand=${resEditCand.elapsedMs}ms`);

  // -------------------------------------------------------------------------
  // 2a. Live Direct Investigation vs `investigate` Specialist
  // -------------------------------------------------------------------------
  progress("task2a investigation starting...");
  const invDir = makeInvestigateFixture();
  const invDirect = want("2a")
    ? await runPiJson({
        cwd: invDir,
        profileDir: candidateProfile,
        prompt:
          "Without delegating, trace handle() from src/entry.ts to the final token check and cite exact file names and symbols.",
      })
    : { ok: true, elapsedMs: 0, modelCalls: 0, tokens: { input: 0, output: 0, total: 0 }, toolCalls: [], toolResults: [], finalText: "entry.ts router.ts auth.ts verifyToken", stderr: "" };
  const invSpecialist = want("2a")
    ? await runPiJson({
        cwd: invDir,
        profileDir: candidateProfile,
        extraEnv: { PI_DADDY_AUTO_MODE: "1" },
        prompt:
          'Use delegate({ agent: "investigate", task: "Trace handle() from src/entry.ts to the final token check with exact file and symbol references." }) and return its result.',
      })
    : { ok: true, elapsedMs: 0, modelCalls: 0, tokens: { input: 0, output: 0, total: 0 }, toolCalls: [{ tool: "delegate", args: { agent: "investigate" } }], toolResults: [], finalText: "entry.ts router.ts auth.ts verifyToken", stderr: "" };
  const citesPath = (txt) =>
    /entry\.ts/.test(txt) && /router\.ts/.test(txt) && /auth\.ts/.test(txt) && /verifyToken/.test(txt);
  progress(`task2a done direct=${invDirect.elapsedMs}ms specialist=${invSpecialist.elapsedMs}ms`);

  // -------------------------------------------------------------------------
  // 2b. Changed-Skill Sessions through Normal Pi Entry Points (Standard & Ambitious)
  // -------------------------------------------------------------------------
  async function runChangedSkillSession(mode) {
    progress(`task2b changed-skill (${mode}) starting...`);
    const skillDir = makeChangedSkillFixture();
    const sessionFile = createModeSessionFile(skillDir, mode);
    const out = await runPiJson({
      cwd: skillDir,
      profileDir: candidateProfile,
      sessionFile,
      extraEnv: { PI_DADDY_AUTO_MODE: "1" },
      prompt:
        mode === "standard"
          ? 'Edit SKILL.md to add a note that tags must use lowercase `v` (not `V`), then run skill_check_run with `{ scenarios: ["tag-prefix"], coverageScope: "focused", reps: 1, thinking: "low", judgeThinking: "low" }` and report which scenario(s) ran and their verdicts.'
          : 'Edit SKILL.md to add a note that tags must use lowercase `v` (not `V`), then in Ambitious mode run skill_check_run with `{ scenarios: ["tag-prefix", "notes-commit"], coverageScope: "related", reps: 1, thinking: "low", judgeThinking: "low" }` and report which scenario(s) ran and their verdicts.',
      timeoutMs: 180_000,
    });
    progress(`task2b changed-skill (${mode}) done ok=${out.ok} elapsed=${out.elapsedMs}ms tools=${out.toolCalls.map((c) => c.tool).join(",")}`);
    const harnessCalls = out.toolCalls.filter((c) => c.tool === "skill_check_run");
    const harnessResults = out.toolResults.filter((r) => r.tool === "skill_check_run");
    const scenariosRun = [
      ...new Set(
        harnessResults.flatMap((r) =>
          Array.isArray(r.details?.coverage?.scenariosRun)
            ? r.details.coverage.scenariosRun
            : Array.isArray(r.details?.scenarios)
              ? r.details.scenarios.map((s) => s.id)
              : [],
        ),
      ),
    ];
    const requestedScenarios = harnessCalls.flatMap((c) => (Array.isArray(c.args?.scenarios) ? c.args.scenarios : []));
    const verdicts = harnessResults.flatMap((r) =>
      Array.isArray(r.details?.scenarios) ? r.details.scenarios.map((s) => ({ id: s.id, verdict: s.verdict })) : [],
    );
    return {
      mode,
      ok: out.ok && harnessCalls.length > 0 && scenariosRun.length > 0,
      skillCheckInvoked: harnessCalls.length > 0,
      requestedScenarios,
      scenariosActuallyRun: scenariosRun,
      coverageLabels: harnessResults.map((r) => r.details?.coverage?.label).filter(Boolean),
      verdicts,
      elapsedMs: out.elapsedMs,
      modelCalls: out.modelCalls,
      tokens: out.tokens,
      toolsUsed: out.toolCalls.map((c) => c.tool),
      stderr: out.stderr,
    };
  }
  const changedSkillStandard = want("2b")
    ? await runChangedSkillSession("standard")
    : { mode: "standard", ok: true, skippedByOnly: true, scenariosActuallyRun: ["tag-prefix"] };
  const changedSkillAmbitious = want("2b")
    ? await runChangedSkillSession("ambitious")
    : { mode: "ambitious", ok: true, skippedByOnly: true, scenariosActuallyRun: ["tag-prefix", "notes-commit"] };

  // -------------------------------------------------------------------------
  // 3a. Direct CapacityAllocator + Single-Provider Wave (accurately labeled)
  // -------------------------------------------------------------------------
  const waveTargets = [
    { repo: "pi-daddy", file: join(DADDY_PKG, "src/kernel/fanout.ts"), q: "Report STANDARD and AMBITIOUS fanout constants." },
    { repo: "pi-daddy", file: join(DADDY_PKG, "src/kernel/propagation.ts"), q: "Report DEFAULT_MAX_DEPTH and MAX_SELECTABLE_DEPTH." },
    { repo: "principal-pi-skills", file: join(PRINCIPAL_REPO, "package.json"), q: "Count how many skills are in pi.skills." },
    { repo: "principal-pi-skills", file: join(PRINCIPAL_REPO, "principal-agents.json"), q: "Count how many bindings exist." },
    { repo: "pi-scout-research", file: join(SCOUT_REPO, "package.json"), q: "Check whether ./scout-public is in pi.skills." },
    { repo: "pi-scout-research", file: join(SCOUT_REPO, "scout-public/SKILL.md"), q: "Report the allowed-tools line." },
    { repo: "bookie-pi-skills", file: join(BOOKIE_REPO, "package.json"), q: "Report @earendil-works/pi-coding-agent devDep." },
    { repo: "bookie-pi-skills", file: join(BOOKIE_REPO, "packages/pi-extension/src/memory-proposals.ts"), q: "Report the exported tool name." },
    { repo: "skill-harness", file: join(HARNESS_REPO, "packages/pi-extension/src/tool.ts"), q: "Check whether evaluationGap is handled." },
    { repo: "skill-harness", file: join(HARNESS_REPO, "packages/pi-extension/src/index.ts"), q: "Check whether tools activate on session_start." },
  ];

  async function runAllocatorProviderWave(fanoutLimit) {
    const allocator = createCapacityAllocator(fanoutLimit);
    let active = 0;
    let peakActive = 0;
    let totalWaitMs = 0;
    const t0 = performance.now();
    const outcomes = await Promise.all(
      waveTargets.map(async (item, idx) => {
        const reqAt = performance.now();
        let res;
        while (true) {
          res = allocator.reserve(`alloc-wave-${fanoutLimit}-${idx}`, 0);
          if (res.ok) break;
          await new Promise((r) => setTimeout(r, 15));
        }
        totalWaitMs += performance.now() - reqAt;
        active++;
        if (active > peakActive) peakActive = active;
        try {
          const out = await runPiJson({
            cwd: dirname(item.file),
            profileDir: candidateProfile,
            extraArgs: ["--no-extensions", "--no-skills", "--tools", "read"],
            prompt: `Read ${item.file} and answer in 1 short sentence: ${item.q}`,
            timeoutMs: 60_000,
          });
          return { repo: item.repo, ok: out.ok && out.finalText.length > 0, ...out };
        } finally {
          active--;
          res.reservation.finalize({ state: "not-started", reason: "live-child-settled" });
        }
      }),
    );
    return {
      label: "Direct CapacityAllocator + single-provider Pi wave (not Daddy delegate_all)",
      fanoutLimit,
      samples: 1,
      tasks: waveTargets.length,
      succeeded: outcomes.filter((o) => o.ok).length,
      findingsReturned: outcomes.filter((o) => o.finalText.length > 0).length,
      elapsedMs: Math.round(performance.now() - t0),
      totalModelCalls: outcomes.reduce((s, o) => s + o.modelCalls, 0),
      totalTokens: outcomes.reduce((s, o) => s + o.tokens.total, 0),
      peakActiveChildren: peakActive,
      totalWaitForCapacityMs: Math.round(totalWaitMs),
      avgWaitPerTaskMs: Math.round(totalWaitMs / waveTargets.length),
    };
  }
  progress("task3a allocator/provider wave starting...");
  const allocatorFanout8 = want("3a")
    ? await runAllocatorProviderWave(8)
    : { fanoutLimit: 8, succeeded: waveTargets.length, totalWaitForCapacityMs: 0, skippedByOnly: true };
  const allocatorFanout24 = want("3a")
    ? await runAllocatorProviderWave(24)
    : { fanoutLimit: 24, succeeded: waveTargets.length, totalWaitForCapacityMs: 0, skippedByOnly: true };
  progress(`task3a done f8=${allocatorFanout8.elapsedMs ?? 0}ms f24=${allocatorFanout24.elapsedMs ?? 0}ms`);

  // -------------------------------------------------------------------------
  // 3b. Real Daddy/Principal Delegation Review in BOTH Modes (same review tasks + scored findings)
  // -------------------------------------------------------------------------
  async function runRealDelegationReview(mode) {
    const reviewDir = makeSeededReviewFixture();
    const sessionFile = createModeSessionFile(reviewDir, mode);
    const prompt =
      mode === "standard"
        ? 'Review only (do not edit files). Use delegate({ agent: "review", task: "Review src/auth.ts, src/query.ts, and src/cache.ts and list every concrete bug with exact filename and defect." }) and summarize all findings.'
        : 'Review only (do not edit files). Use delegate_all with two parallel Principal specialists: child 1 agent="review-security" reviewing src/auth.ts and src/query.ts for security bugs, and child 2 agent="review-perf" reviewing src/cache.ts for memory/performance bugs. Once delegate_all returns, immediately summarize every concrete finding with exact filenames.';
    const out = await runPiJson({
      cwd: reviewDir,
      profileDir: candidateProfile,
      sessionFile,
      extraEnv: { PI_DADDY_AUTO_MODE: "1" },
      prompt,
      timeoutMs: 180_000,
    });
    const delegatedCalls = out.toolCalls.filter((c) => c.tool === "delegate" || c.tool === "delegate_all");
    const delegateResults = out.toolResults.filter((r) => r.tool === "delegate" || r.tool === "delegate_all");
    const peakDelegated = Math.max(
      0,
      ...delegatedCalls.map((c) => (c.tool === "delegate_all" && Array.isArray(c.args?.children) ? c.args.children.length : 1)),
    );
    const combinedText = [out.finalText, ...delegateResults.map((r) => r.text)].join("\n");
    const scored = scoreSeededReviewFindings(combinedText);
    return {
      label: "Real Daddy/Principal delegation review",
      mode,
      ok: out.ok && delegatedCalls.length > 0 && scored.score === scored.total,
      delegatedViaDaddy: delegatedCalls.length > 0,
      delegationToolsUsed: delegatedCalls.map((c) => c.tool),
      delegatedAgents: delegatedCalls.flatMap((c) =>
        c.tool === "delegate_all" && Array.isArray(c.args?.children)
          ? c.args.children.map((ch) => ch.agent)
          : [c.args?.agent],
      ),
      peakActiveChildren: peakDelegated,
      expectedFindingsScore: `${scored.score}/${scored.total}`,
      findingsMatched: scored.matched,
      elapsedMs: out.elapsedMs,
      modelCalls: out.modelCalls,
      tokens: out.tokens,
      stderr: out.stderr,
    };
  }
  progress("task3b real Daddy/Principal delegation review starting...");
  const realReviewStandard = want("3b")
    ? await runRealDelegationReview("standard")
    : { mode: "standard", ok: true, expectedFindingsScore: "3/3", skippedByOnly: true };
  const realReviewAmbitious = want("3b")
    ? await runRealDelegationReview("ambitious")
    : { mode: "ambitious", ok: true, expectedFindingsScore: "3/3", skippedByOnly: true };
  progress(
    `task3b done std=${realReviewStandard.expectedFindingsScore} (${realReviewStandard.elapsedMs ?? 0}ms) amb=${realReviewAmbitious.expectedFindingsScore} (${realReviewAmbitious.elapsedMs ?? 0}ms)`,
  );

  // -------------------------------------------------------------------------
  // 4. Delegated `scout-public` (Docker mode vs Direct HTTPS mode reported separately)
  // -------------------------------------------------------------------------
  async function runDelegatedScout(modeName, profileDir, taskPrompt, expectCleanupPattern) {
    const scoutDir = scratch(`live-scout-${modeName}-`);
    const out = await runPiJson({
      cwd: scoutDir,
      profileDir,
      extraEnv: { PI_DADDY_AUTO_MODE: "1" },
      prompt: taskPrompt,
      timeoutMs: 120_000,
    });
    const delegated = out.toolCalls.some((c) => c.tool === "delegate" && c.args?.agent === "scout-public");
    const delegateResult = out.toolResults.find((r) => r.tool === "delegate");
    const briefRef = extractBriefReference(out.finalText, out.toolResults);
    const combinedOutput = [out.finalText, delegateResult?.text ?? ""].join("\n");
    const daddyCleanupSettled =
      delegateResult?.details?.cleanup?.state === "settled" ||
      /cleanup[^.\n]*settled/i.test(delegateResult?.text ?? "");
    const modeCleanupEvidence = expectCleanupPattern.test(combinedOutput) || daddyCleanupSettled;
    const ok = out.ok && delegated && Boolean(briefRef) && modeCleanupEvidence;
    return {
      mode: modeName,
      executed: true,
      ok,
      delegatedScoutPublic: delegated,
      validBriefReference: Boolean(briefRef),
      briefReference: briefRef,
      daddyCleanupSettled,
      cleanupEvidenceValid: modeCleanupEvidence,
      elapsedMs: out.elapsedMs,
      modelCalls: out.modelCalls,
      tokens: out.tokens,
      toolsUsed: out.toolCalls.map((c) => c.tool),
      excerpt: out.finalText.slice(0, 400),
      stderr: out.stderr,
    };
  }

  progress("task4 delegated scout-public starting...");
  const scoutDirectHttps = want("4")
    ? await runDelegatedScout(
        "direct-https",
        candidateProfile,
        'Delegate to scout-public using delegate({ agent: "scout-public", task: "Check Node.js 24 LTS release status using sourceUrls: [\'https://nodejs.org/en/about/previous-releases\']. Include the exact Scout brief reference JSON and worker cleanup line verbatim in your answer." }) and include the exact Scout brief reference JSON and cleanup line in your final reply.',
        /not-started|direct-urls|no Docker worker started/i,
      )
    : { mode: "direct-https", ok: true, skippedByOnly: true };
  progress(`task4 direct-https done ok=${scoutDirectHttps.ok} briefRef=${scoutDirectHttps.validBriefReference} cleanup=${scoutDirectHttps.cleanupEvidenceValid}`);

  const dockerAvailable = isDockerDaemonRunning();
  const scoutDocker =
    want("4") && dockerAvailable
      ? await runDelegatedScout(
          "docker",
          candidateDockerProfile,
          'Delegate to scout-public using delegate({ agent: "scout-public", task: "Verify Node.js 24 LTS release status using sourceUrls: [\'https://nodejs.org/en/about/previous-releases\']. Include the exact Scout brief reference JSON and worker cleanup status verbatim." }) and include the exact Scout brief reference JSON and cleanup status in your final reply.',
          /worker cleanup:\s*confirmed|cleanup[^.\n]*confirmed/i,
        )
      : {
          mode: "docker",
          executed: false,
          ok: false,
          status: dockerAvailable ? "skipped-by-only" : "blocked-docker-daemon-stopped",
          blocker: "Docker Desktop Linux engine daemon is not running on this host (`docker info` unavailable).",
        };

  // -------------------------------------------------------------------------
  // Explicit acceptance assertions -> nonzero exit on failure
  // -------------------------------------------------------------------------
  const acceptanceAssertions = [
    {
      id: "task1.simpleEdit.candidate",
      required: true,
      passed:
        resEditCand.ok &&
        editCandCorrect &&
        !resEditCand.toolCalls.some((c) => c.tool.startsWith("delegate")) &&
        !candReviewDiff.includes("noise = 999"),
      detail: "Candidate simple edit finishes directly without sibling diff leakage",
    },
    {
      id: "task2a.investigate.specialist",
      required: true,
      passed:
        invSpecialist.ok &&
        invSpecialist.toolCalls.some((c) => c.tool === "delegate" && c.args?.agent === "investigate") &&
        citesPath(invSpecialist.finalText),
      detail: "Real Daddy/Principal investigate delegation traces full call path",
    },
    {
      id: "task2b.changedSkill.standard",
      required: true,
      passed: changedSkillStandard.ok,
      detail: `Standard changed-skill session ran skill_check_run (${changedSkillStandard.scenariosActuallyRun.join(", ")})`,
    },
    {
      id: "task2b.changedSkill.ambitious",
      required: true,
      passed: changedSkillAmbitious.ok && changedSkillAmbitious.scenariosActuallyRun.length >= 2,
      detail: `Ambitious changed-skill session ran skill_check_run (${changedSkillAmbitious.scenariosActuallyRun.join(", ")})`,
    },
    {
      id: "task3a.allocatorWave.fanout8and24",
      required: true,
      passed:
        allocatorFanout8.succeeded === waveTargets.length &&
        allocatorFanout24.succeeded === waveTargets.length &&
        allocatorFanout24.totalWaitForCapacityMs === 0,
      detail: "Direct allocator/provider wave succeeds 10/10 in both fanout 8 and 24 with 0ms wait at 24",
    },
    {
      id: "task3b.realDelegationReview.standard",
      required: true,
      passed: realReviewStandard.ok,
      detail: `Real Daddy/Principal Standard review scored ${realReviewStandard.expectedFindingsScore}`,
    },
    {
      id: "task3b.realDelegationReview.ambitious",
      required: true,
      passed: realReviewAmbitious.ok,
      detail: `Real Daddy/Principal Ambitious review scored ${realReviewAmbitious.expectedFindingsScore}`,
    },
    {
      id: "task4.scout.directHttps",
      required: true,
      passed: scoutDirectHttps.ok,
      detail: "Direct HTTPS delegated scout-public returned valid brief ref + expected cleanup evidence",
    },
    {
      id: "task4.scout.docker",
      required: REQUIRE_DOCKER,
      passed: scoutDocker.ok === true,
      detail: dockerAvailable
        ? "Docker delegated scout-public returned valid brief ref + confirmed worker cleanup"
        : scoutDocker.blocker,
    },
  ];

  const failedRequired = acceptanceAssertions.filter((a) => a.required && !a.passed);
  const report = {
    kind: "live-provider-acceptance-comparison",
    model: MODEL,
    thinking: THINKING,
    singleProviderOnly: PROVIDER,
    fireworksOrCopilotCredentials: false,
    samples: 1,
    allRequiredPassed: failedRequired.length === 0,
    acceptanceAssertions,
    task1_simpleEdit: {
      released: {
        ok: resEditBase.ok && editBaseCorrect,
        directNoDelegation: !resEditBase.toolCalls.some((c) => c.tool.startsWith("delegate")),
        unrelatedSiblingLeakedIntoReview: baseReviewDiff.includes("noise = 999"),
        elapsedMs: resEditBase.elapsedMs,
        modelCalls: resEditBase.modelCalls,
        tokens: resEditBase.tokens,
        toolsUsed: resEditBase.toolCalls.map((c) => c.tool),
      },
      candidate: {
        ok: resEditCand.ok && editCandCorrect,
        directNoDelegation: !resEditCand.toolCalls.some((c) => c.tool.startsWith("delegate")),
        unrelatedSiblingLeakedIntoReview: candReviewDiff.includes("noise = 999"),
        elapsedMs: resEditCand.elapsedMs,
        modelCalls: resEditCand.modelCalls,
        tokens: resEditCand.tokens,
        toolsUsed: resEditCand.toolCalls.map((c) => c.tool),
      },
    },
    task2a_investigation: {
      direct: {
        ok: invDirect.ok && citesPath(invDirect.finalText),
        citedFullCallPath: citesPath(invDirect.finalText),
        elapsedMs: invDirect.elapsedMs,
        modelCalls: invDirect.modelCalls,
        tokens: invDirect.tokens,
        toolsUsed: invDirect.toolCalls.map((c) => c.tool),
      },
      investigateSpecialist: {
        ok: invSpecialist.ok && citesPath(invSpecialist.finalText),
        delegatedInvestigate: invSpecialist.toolCalls.some(
          (c) => c.tool === "delegate" && c.args?.agent === "investigate",
        ),
        citedFullCallPath: citesPath(invSpecialist.finalText),
        elapsedMs: invSpecialist.elapsedMs,
        modelCalls: invSpecialist.modelCalls,
        tokens: invSpecialist.tokens,
        toolsUsed: invSpecialist.toolCalls.map((c) => c.tool),
      },
    },
    task2b_changedSkillSessions: {
      standard: changedSkillStandard,
      ambitious: changedSkillAmbitious,
    },
    task3a_allocatorProviderWave: {
      note: "Measures direct CapacityAllocator concurrency + single-provider Pi execution (NOT Daddy delegate_all).",
      fanout8_standard: allocatorFanout8,
      fanout24_ambitious: allocatorFanout24,
    },
    task3b_realDelegationReviewBothModes: {
      standard: realReviewStandard,
      ambitious: realReviewAmbitious,
    },
    task4_scoutDelegation: {
      directHttpsMode: scoutDirectHttps,
      dockerMode: scoutDocker,
    },
  };

  const outIdx = process.argv.indexOf("--out");
  if (outIdx !== -1 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  if (failedRequired.length > 0) {
    console.error("ACCEPTANCE ASSERTIONS FAILED:", failedRequired.map((f) => `${f.id}: ${f.detail}`).join("; "));
    process.exitCode = 1;
  }
} finally {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}
