#!/usr/bin/env node
/**
 * Live-model acceptance & baseline-vs-candidate comparison benchmark.
 * Uses ONE configured provider (`google/gemini-flash-latest`, --thinking low) in disposable
 * Pi 1.6.1 profiles with Fireworks/Copilot/OpenAI/Anthropic credentials explicitly stripped.
 *
 * Covers:
 * - Task 1: Released vs candidate simple edit + nested-workspace scoped review
 * - Task 2a: Direct investigation vs explicitly requested `investigate` specialist (tool-integration)
 * - Task 2b: Explicitly prompted changed-skill sessions in Standard & Ambitious (tool-integration)
 * - Task 2c: Ordinary unprompted skill-edit sessions in Standard & Ambitious (behavioral selection)
 * - Task 3a: Direct CapacityAllocator + single-provider Pi wave (Fanout 8 vs 24; not Daddy delegate_all)
 * - Task 3b: Explicitly requested Daddy/Principal reviewer delegation in Standard & Ambitious (tool-integration)
 * - Task 4: Delegated `scout-public` reported separately for Direct HTTPS and Docker modes, using
 *           structured evidence strictly from the matching `scout_research` invocation.
 *
 * Exclusions via `--only` are reported as `skipped` (never invented passes/scores), and
 * `selectedChecksPassed` is distinguished from `fullSuitePassed`.
 * Exits nonzero (1) whenever any executed required assertion fails.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  computeObservedPeakActiveFromLedger,
  evaluateOrdinarySkillEdit,
  evaluateScoutAcceptance,
  makeSkippedTask,
  summarizeAcceptance,
} from "./benchmark-live-lib.ts";

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
  return i !== -1 && process.argv[i + 1] ? new Set(process.argv[i + 1].split(",").map((s) => s.trim())) : null;
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
            toolCalls.push({
              tool: ev.toolName,
              toolCallId: ev.toolCallId,
              parentCallId: ev.parentCallId ?? ev.parentToolCallId,
              executionId: ev.executionId,
              parentExecutionId: ev.parentExecutionId,
              args: ev.args,
            });
          }
          if (ev.type === "tool_execution_end" && ev.toolName) {
            const text = (ev.result?.content ?? [])
              .filter((c) => c?.type === "text" && typeof c.text === "string")
              .map((c) => c.text)
              .join("\n");
            toolResults.push({
              tool: ev.toolName,
              toolCallId: ev.toolCallId,
              parentCallId:
                ev.parentCallId ??
                ev.parentToolCallId ??
                ev.result?.details?.parentCallId ??
                ev.result?.details?.parentToolCallId,
              executionId: ev.executionId ?? ev.result?.details?.executionId,
              parentExecutionId: ev.parentExecutionId ?? ev.result?.details?.parentExecutionId,
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

function initFixtureGit(dir) {
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "bench@local"]);
  git(["config", "user.name", "Bench"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
}

function makeSimpleEditFixture() {
  const repo = scratch("live-edit-");
  mkdirSync(join(repo, "nested"), { recursive: true });
  mkdirSync(join(repo, "sibling"), { recursive: true });
  writeFileSync(join(repo, "nested", "math.mjs"), "export function double(n) { return n + 1; }\n");
  writeFileSync(join(repo, "sibling", "noise.mjs"), "export const noise = 1;\n");
  initFixtureGit(repo);
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
  initFixtureGit(dir);
  return dir;
}

function makeSeededReviewFixture() {
  const dir = scratch("live-review-fixture-");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "auth.ts"),
    [
      "export function isAuthorized(header: string | undefined, expected: string): boolean {",
      "  if (!header) return true; // BUG 1: empty/missing Authorization header bypasses auth",
      "  return header === expected;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "query.ts"),
    [
      "export function buildUserQuery(userId: string): string {",
      '  return "SELECT * FROM users WHERE id = \'" + userId + "\'"; // BUG 2: SQL injection',
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "cache.ts"),
    [
      "const entries = new Map<string, string>();",
      "export function cachePut(key: string, payload: string): void {",
      "  entries.set(key, payload); // BUG 3: unbounded Map growth with no eviction/size cap",
      "}",
      "export function cacheGet(key: string): string | undefined { return entries.get(key); }",
      "",
    ].join("\n"),
  );
  initFixtureGit(dir);
  return dir;
}

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
  initFixtureGit(dir);
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

function extractHarnessObservation(out) {
  const harnessCalls = out.toolCalls.filter((c) => c.tool === "skill_check_run");
  const harnessResults = out.toolResults.filter((r) => r.tool === "skill_check_run");
  const scenariosActuallyRun = [
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
  const selectedScenariosPerCall = harnessCalls.map((c) =>
    Array.isArray(c.args?.scenarios) ? c.args.scenarios : "unspecified/all",
  );
  const selectedCoverageScopes = harnessCalls.map((c) => c.args?.coverageScope ?? "default");
  const coverageLabels = harnessResults.map((r) => r.details?.coverage?.label).filter(Boolean);
  const verdicts = harnessResults.flatMap((r) =>
    Array.isArray(r.details?.scenarios) ? r.details.scenarios.map((s) => ({ id: s.id, verdict: s.verdict })) : [],
  );
  return {
    skillCheckInvoked: harnessCalls.length > 0,
    callCount: harnessCalls.length,
    selectedScenariosPerCall,
    selectedCoverageScopes,
    scenariosActuallyRun,
    coverageLabels,
    verdicts,
  };
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

  const acceptanceAssertions = [];
  const pushAssertion = (id, required, executed, passed, detail) => {
    acceptanceAssertions.push({
      id,
      required,
      status: !executed ? "skipped" : passed ? "passed" : "failed",
      passed: !executed ? null : Boolean(passed),
      detail: !executed ? `Skipped (${detail || "excluded by --only"})` : detail,
    });
  };

  // -------------------------------------------------------------------------
  // 1. Live Simple Edit: Released vs Candidate
  // -------------------------------------------------------------------------
  let task1Report;
  if (want("1")) {
    progress("task1 simple-edit starting...");
    const editPrompt = "Fix double(n) in math.mjs so it returns n * 2 instead of n + 1. Keep it direct and concise.";
    const fixBase = makeSimpleEditFixture();
    const resEditBase = await runPiJson({ cwd: fixBase.nested, profileDir: releasedProfile, prompt: editPrompt });
    const editBaseCorrect = /return\s+n\s*\*\s*2/.test(readFileSync(join(fixBase.nested, "math.mjs"), "utf8"));
    const baseReviewDiff = execFileSync("git", ["diff", "--no-color", "HEAD"], {
      cwd: fixBase.nested,
      encoding: "utf8",
    });

    const fixCand = makeSimpleEditFixture();
    const resEditCand = await runPiJson({ cwd: fixCand.nested, profileDir: candidateProfile, prompt: editPrompt });
    const editCandCorrect = /return\s+n\s*\*\s*2/.test(readFileSync(join(fixCand.nested, "math.mjs"), "utf8"));
    const candScope = resolveReviewScope(fixCand.nested, editPrompt);
    const candReviewDiff = await collectReviewDiff(fixCand.nested, candScope);
    progress(`task1 done base=${resEditBase.elapsedMs}ms cand=${resEditCand.elapsedMs}ms`);

    const candPassed =
      resEditCand.ok &&
      editCandCorrect &&
      !resEditCand.toolCalls.some((c) => c.tool.startsWith("delegate")) &&
      !candReviewDiff.includes("noise = 999");
    task1Report = {
      status: "executed",
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
        ok: candPassed,
        directNoDelegation: !resEditCand.toolCalls.some((c) => c.tool.startsWith("delegate")),
        unrelatedSiblingLeakedIntoReview: candReviewDiff.includes("noise = 999"),
        elapsedMs: resEditCand.elapsedMs,
        modelCalls: resEditCand.modelCalls,
        tokens: resEditCand.tokens,
        toolsUsed: resEditCand.toolCalls.map((c) => c.tool),
      },
    };
    pushAssertion(
      "task1.simpleEdit.candidate",
      true,
      true,
      candPassed,
      "Candidate simple edit finishes directly without sibling diff leakage",
    );
  } else {
    task1Report = makeSkippedTask();
    pushAssertion("task1.simpleEdit.candidate", true, false, null, "excluded by --only");
  }

  // -------------------------------------------------------------------------
  // 2a. Direct Investigation vs Explicitly Requested `investigate` Specialist (tool-integration)
  // -------------------------------------------------------------------------
  const citesPath = (txt) =>
    /entry\.ts/.test(txt) && /router\.ts/.test(txt) && /auth\.ts/.test(txt) && /verifyToken/.test(txt);
  let task2aReport;
  if (want("2a")) {
    progress("task2a investigation starting...");
    const invDir = makeInvestigateFixture();
    const invDirect = await runPiJson({
      cwd: invDir,
      profileDir: candidateProfile,
      prompt:
        "Without delegating, trace handle() from src/entry.ts to the final token check and cite exact file names and symbols.",
    });
    const invLedger = join(scratch("live-inv-ledger-"), "grants.jsonl");
    const invSpecialist = await runPiJson({
      cwd: invDir,
      profileDir: candidateProfile,
      extraEnv: { PI_DADDY_AUTO_MODE: "1", PI_DADDY_LEDGER: invLedger },
      prompt:
        'Use delegate({ agent: "investigate", task: "Trace handle() from src/entry.ts to the final token check with exact file and symbol references." }) and return its result.',
    });
    const invLifecycle = computeObservedPeakActiveFromLedger(invLedger);
    progress(`task2a done direct=${invDirect.elapsedMs}ms specialist=${invSpecialist.elapsedMs}ms`);
    const specPassed =
      invSpecialist.ok &&
      invSpecialist.toolCalls.some((c) => c.tool === "delegate" && c.args?.agent === "investigate") &&
      citesPath(invSpecialist.finalText);
    task2aReport = {
      status: "executed",
      category: "tool-integration",
      explicitlyPrompted: true,
      direct: {
        ok: invDirect.ok && citesPath(invDirect.finalText),
        citedFullCallPath: citesPath(invDirect.finalText),
        elapsedMs: invDirect.elapsedMs,
        modelCalls: invDirect.modelCalls,
        tokens: invDirect.tokens,
        toolsUsed: invDirect.toolCalls.map((c) => c.tool),
      },
      explicitlyRequestedInvestigateSpecialist: {
        ok: specPassed,
        delegatedInvestigate: invSpecialist.toolCalls.some(
          (c) => c.tool === "delegate" && c.args?.agent === "investigate",
        ),
        requestedChildren: invSpecialist.toolCalls.filter((c) => c.tool === "delegate").length,
        observedPeakActiveChildren: invLifecycle.observedPeakActiveChildren,
        citedFullCallPath: citesPath(invSpecialist.finalText),
        elapsedMs: invSpecialist.elapsedMs,
        modelCalls: invSpecialist.modelCalls,
        tokens: invSpecialist.tokens,
        toolsUsed: invSpecialist.toolCalls.map((c) => c.tool),
      },
    };
    pushAssertion(
      "task2a.investigate.toolIntegration",
      true,
      true,
      specPassed,
      "Explicitly requested Daddy/Principal investigate delegation traces full call path",
    );
  } else {
    task2aReport = makeSkippedTask();
    pushAssertion("task2a.investigate.toolIntegration", true, false, null, "excluded by --only");
  }

  // -------------------------------------------------------------------------
  // 2b. Explicitly Prompted Changed-Skill Sessions (tool-integration, Standard & Ambitious)
  // -------------------------------------------------------------------------
  let task2bReport;
  if (want("2b")) {
    const runExplicitSkillSession = async (mode) => {
      progress(`task2b explicit changed-skill tool-integration (${mode}) starting...`);
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
      const obs = extractHarnessObservation(out);
      progress(`task2b (${mode}) done ok=${out.ok} scenarios=[${obs.scenariosActuallyRun.join(",")}]`);
      return {
        status: "executed",
        category: "tool-integration",
        explicitlyPrompted: true,
        mode,
        ok: out.ok && obs.skillCheckInvoked && obs.scenariosActuallyRun.length > 0,
        ...obs,
        elapsedMs: out.elapsedMs,
        modelCalls: out.modelCalls,
        tokens: out.tokens,
        toolsUsed: out.toolCalls.map((c) => c.tool),
        stderr: out.stderr,
      };
    };
    const std = await runExplicitSkillSession("standard");
    const amb = await runExplicitSkillSession("ambitious");
    task2bReport = {
      status: "executed",
      category: "tool-integration",
      explicitlyPrompted: true,
      standard: std,
      ambitious: amb,
    };
    pushAssertion(
      "task2b.changedSkill.toolIntegration.standard",
      true,
      true,
      std.ok,
      `Explicit Standard skill_check_run ran [${std.scenariosActuallyRun.join(", ")}]`,
    );
    pushAssertion(
      "task2b.changedSkill.toolIntegration.ambitious",
      true,
      true,
      amb.ok && amb.scenariosActuallyRun.length >= 2,
      `Explicit Ambitious skill_check_run ran [${amb.scenariosActuallyRun.join(", ")}]`,
    );
  } else {
    task2bReport = makeSkippedTask();
    pushAssertion("task2b.changedSkill.toolIntegration.standard", true, false, null, "excluded by --only");
    pushAssertion("task2b.changedSkill.toolIntegration.ambitious", true, false, null, "excluded by --only");
  }

  // -------------------------------------------------------------------------
  // 2c. Ordinary Unprompted Skill-Edit Sessions (behavioral selection, Standard & Ambitious)
  // Leaves Harness command, scenario IDs, and coverage choice completely to Pi.
  // -------------------------------------------------------------------------
  let task2cReport;
  if (want("2c")) {
    const runOrdinarySkillEdit = async (mode) => {
      progress(`task2c ordinary unprompted skill-edit (${mode}) starting...`);
      const skillDir = makeChangedSkillFixture();
      const sessionFile = createModeSessionFile(skillDir, mode);
      const before = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      const out = await runPiJson({
        cwd: skillDir,
        profileDir: candidateProfile,
        sessionFile,
        extraEnv: { PI_DADDY_AUTO_MODE: "1" },
        prompt:
          "Update SKILL.md to clarify that release tags must always use a lowercase leading `v` (never uppercase `V`). Follow your normal workflow for modifying a skill.",
        timeoutMs: 180_000,
      });
      const after = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      const evalResult = evaluateOrdinarySkillEdit({
        processOk: out.ok,
        beforeText: before,
        afterText: after,
        fixtureDir: skillDir,
        toolCalls: out.toolCalls,
        toolResults: out.toolResults,
        requiredScenarioId: "tag-prefix",
      });
      const obs = extractHarnessObservation(out);
      progress(
        `task2c (${mode}) done ok=${evalResult.ok} edited=${evalResult.skillEdited} harnessInvoked=${evalResult.harnessInvoked} requiredPassed=${evalResult.requiredScenarioPassed} scenarios=[${evalResult.scenariosActuallyRun.join(",")}] extra=[${evalResult.extraScenariosRun.join(",")}]`,
      );
      return {
        status: "executed",
        category: "behavioral-selection",
        explicitlyPrompted: false,
        mode,
        ok: evalResult.ok,
        skillEdited: evalResult.skillEdited,
        harnessInvoked: evalResult.harnessInvoked,
        requiredScenarioPassed: evalResult.requiredScenarioPassed,
        requiredScenario: evalResult.requiredScenario,
        scenariosActuallyRun: evalResult.scenariosActuallyRun,
        extraScenariosRun: evalResult.extraScenariosRun,
        verdicts: evalResult.verdicts,
        failureReasons: evalResult.failureReasons,
        ...obs,
        elapsedMs: out.elapsedMs,
        modelCalls: out.modelCalls,
        tokens: out.tokens,
        toolsUsed: out.toolCalls.map((c) => c.tool),
        stderr: out.stderr,
      };
    };
    const std = await runOrdinarySkillEdit("standard");
    const amb = await runOrdinarySkillEdit("ambitious");
    task2cReport = {
      status: "executed",
      category: "behavioral-selection",
      explicitlyPrompted: false,
      note: "Ordinary skill-edit prompt that omits skill_check_run, scenario IDs, and coverageScope; reports exact observed selection per mode.",
      standard: std,
      ambitious: amb,
    };
    pushAssertion(
      "task2c.ordinarySkillEdit.standard",
      true,
      true,
      std.ok,
      std.ok
        ? `Standard ordinary skill edit succeeded with required scenario "${std.requiredScenario}" PASS (scenarios=[${std.scenariosActuallyRun.join(", ")}], extra=[${std.extraScenariosRun.join(", ")}])`
        : `Standard ordinary skill edit failed: ${std.failureReasons?.join("; ") || "behavioral check not satisfied"}`,
    );
    pushAssertion(
      "task2c.ordinarySkillEdit.ambitious",
      true,
      true,
      amb.ok,
      amb.ok
        ? `Ambitious ordinary skill edit succeeded with required scenario "${amb.requiredScenario}" PASS (scenarios=[${amb.scenariosActuallyRun.join(", ")}], extra=[${amb.extraScenariosRun.join(", ")}])`
        : `Ambitious ordinary skill edit failed: ${amb.failureReasons?.join("; ") || "behavioral check not satisfied"}`,
    );
  } else {
    task2cReport = makeSkippedTask();
    pushAssertion("task2c.ordinarySkillEdit.standard", true, false, null, "excluded by --only");
    pushAssertion("task2c.ordinarySkillEdit.ambitious", true, false, null, "excluded by --only");
  }

  // -------------------------------------------------------------------------
  // 3a. Direct CapacityAllocator + Single-Provider Pi Wave (accurately labeled)
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

  let task3aReport;
  if (want("3a")) {
    progress("task3a allocator/provider wave starting...");
    const runAllocatorProviderWave = async (fanoutLimit) => {
      const allocator = createCapacityAllocator(fanoutLimit);
      let active = 0;
      let observedPeakActive = 0;
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
          if (active > observedPeakActive) observedPeakActive = active;
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
        requestedChildren: waveTargets.length,
        succeeded: outcomes.filter((o) => o.ok).length,
        findingsReturned: outcomes.filter((o) => o.finalText.length > 0).length,
        elapsedMs: Math.round(performance.now() - t0),
        totalModelCalls: outcomes.reduce((s, o) => s + o.modelCalls, 0),
        totalTokens: outcomes.reduce((s, o) => s + o.tokens.total, 0),
        observedPeakActiveChildren: observedPeakActive,
        totalWaitForCapacityMs: Math.round(totalWaitMs),
        avgWaitPerTaskMs: Math.round(totalWaitMs / waveTargets.length),
      };
    };
    const f8 = await runAllocatorProviderWave(8);
    const f24 = await runAllocatorProviderWave(24);
    progress(`task3a done f8=${f8.elapsedMs}ms f24=${f24.elapsedMs}ms`);
    const waveOk =
      f8.succeeded === waveTargets.length && f24.succeeded === waveTargets.length && f24.totalWaitForCapacityMs === 0;
    task3aReport = {
      status: "executed",
      category: "allocator-provider-concurrency",
      note: "Measures direct CapacityAllocator concurrency + single-provider Pi execution (NOT Daddy delegate_all).",
      fanout8_standard: f8,
      fanout24_ambitious: f24,
    };
    pushAssertion(
      "task3a.allocatorWave.fanout8and24",
      true,
      true,
      waveOk,
      "Direct allocator/provider wave succeeds 10/10 in both fanout 8 and 24 with 0ms wait at 24",
    );
  } else {
    task3aReport = makeSkippedTask();
    pushAssertion("task3a.allocatorWave.fanout8and24", true, false, null, "excluded by --only");
  }

  // -------------------------------------------------------------------------
  // 3b. Explicitly Requested Daddy/Principal Reviewer Delegation (tool-integration, both modes)
  // -------------------------------------------------------------------------
  let task3bReport;
  if (want("3b")) {
    progress("task3b explicitly requested Daddy/Principal reviewer delegation starting...");
    const runExplicitReviewerDelegation = async (mode) => {
      const reviewDir = makeSeededReviewFixture();
      const sessionFile = createModeSessionFile(reviewDir, mode);
      const ledgerPath = join(scratch(`live-rev-ledger-${mode}-`), "grants.jsonl");
      const prompt =
        mode === "standard"
          ? 'Review only (do not edit files). Use delegate({ agent: "review", task: "Review src/auth.ts, src/query.ts, and src/cache.ts and list every concrete bug with exact filename and defect." }) and summarize all findings.'
          : 'Review only (do not edit files). Use delegate_all with two parallel Principal specialists: child 1 agent="review-security" reviewing src/auth.ts and src/query.ts for security bugs, and child 2 agent="review-perf" reviewing src/cache.ts for memory/performance bugs. Once delegate_all returns, immediately summarize every concrete finding with exact filenames.';
      const out = await runPiJson({
        cwd: reviewDir,
        profileDir: candidateProfile,
        sessionFile,
        extraEnv: { PI_DADDY_AUTO_MODE: "1", PI_DADDY_LEDGER: ledgerPath },
        prompt,
        timeoutMs: 180_000,
      });
      const delegatedCalls = out.toolCalls.filter((c) => c.tool === "delegate" || c.tool === "delegate_all");
      const delegateResults = out.toolResults.filter((r) => r.tool === "delegate" || r.tool === "delegate_all");
      const requestedChildren = delegatedCalls.reduce(
        (sum, c) => sum + (c.tool === "delegate_all" && Array.isArray(c.args?.children) ? c.args.children.length : 1),
        0,
      );
      const lifecycle = computeObservedPeakActiveFromLedger(ledgerPath);
      const combinedText = [out.finalText, ...delegateResults.map((r) => r.text)].join("\n");
      const scored = scoreSeededReviewFindings(combinedText);
      return {
        status: "executed",
        category: "tool-integration",
        explicitlyRequestedReviewers: true,
        label: "Explicitly requested Daddy/Principal reviewer delegation",
        mode,
        ok: out.ok && delegatedCalls.length > 0 && scored.score === scored.total,
        delegatedViaDaddy: delegatedCalls.length > 0,
        delegationToolsUsed: delegatedCalls.map((c) => c.tool),
        delegatedAgents: delegatedCalls.flatMap((c) =>
          c.tool === "delegate_all" && Array.isArray(c.args?.children)
            ? c.args.children.map((ch) => ch.agent)
            : [c.args?.agent],
        ),
        requestedChildren,
        observedPeakActiveChildren: lifecycle.observedPeakActiveChildren,
        observedLifecycleEvents: lifecycle.lifecycleEventCount,
        expectedFindingsScore: `${scored.score}/${scored.total}`,
        findingsMatched: scored.matched,
        elapsedMs: out.elapsedMs,
        modelCalls: out.modelCalls,
        tokens: out.tokens,
        stderr: out.stderr,
      };
    };
    const std = await runExplicitReviewerDelegation("standard");
    const amb = await runExplicitReviewerDelegation("ambitious");
    progress(
      `task3b done std=${std.expectedFindingsScore} (peak=${std.observedPeakActiveChildren}) amb=${amb.expectedFindingsScore} (peak=${amb.observedPeakActiveChildren})`,
    );
    task3bReport = {
      status: "executed",
      category: "tool-integration",
      explicitlyRequestedReviewers: true,
      standard: std,
      ambitious: amb,
    };
    pushAssertion(
      "task3b.explicitReviewerDelegation.standard",
      true,
      true,
      std.ok,
      `Explicitly requested Standard review scored ${std.expectedFindingsScore} (observedPeak=${std.observedPeakActiveChildren})`,
    );
    pushAssertion(
      "task3b.explicitReviewerDelegation.ambitious",
      true,
      true,
      amb.ok,
      `Explicitly requested Ambitious review scored ${amb.expectedFindingsScore} (observedPeak=${amb.observedPeakActiveChildren})`,
    );
  } else {
    task3bReport = makeSkippedTask();
    pushAssertion("task3b.explicitReviewerDelegation.standard", true, false, null, "excluded by --only");
    pushAssertion("task3b.explicitReviewerDelegation.ambitious", true, false, null, "excluded by --only");
  }

  // -------------------------------------------------------------------------
  // 4. Delegated `scout-public` (Direct HTTPS & Docker reported separately,
  //    evaluated strictly from matching `scout_research` structured details)
  // -------------------------------------------------------------------------
  let task4Report;
  if (want("4")) {
    progress("task4 delegated scout-public starting...");
    const runDelegatedScout = async (modeName, profileDir, taskPrompt) => {
      const scoutDir = scratch(`live-scout-${modeName}-`);
      const ledgerPath = join(scratch(`live-scout-ledger-${modeName}-`), "grants.jsonl");
      const out = await runPiJson({
        cwd: scoutDir,
        profileDir,
        extraEnv: { PI_DADDY_AUTO_MODE: "1", PI_DADDY_LEDGER: ledgerPath },
        prompt: taskPrompt,
        timeoutMs: 120_000,
      });
      const evaluation = evaluateScoutAcceptance({
        mode: modeName,
        processOk: out.ok,
        toolCalls: out.toolCalls,
        toolResults: out.toolResults,
      });
      const lifecycle = computeObservedPeakActiveFromLedger(ledgerPath);
      return {
        status: "executed",
        mode: modeName,
        ...evaluation,
        observedPeakActiveChildren: lifecycle.observedPeakActiveChildren,
        elapsedMs: out.elapsedMs,
        modelCalls: out.modelCalls,
        tokens: out.tokens,
        toolsUsed: out.toolCalls.map((c) => c.tool),
        excerpt: out.finalText.slice(0, 350),
        stderr: out.stderr,
      };
    };

    const scoutDirectHttps = await runDelegatedScout(
      "direct-https",
      candidateProfile,
      'Delegate to scout-public using delegate({ agent: "scout-public", task: "Check Node.js 24 LTS release status using sourceUrls: [\'https://nodejs.org/en/about/previous-releases\']." }) and summarize the result.',
    );
    progress(
      `task4 direct-https done ok=${scoutDirectHttps.ok} matchingScout=${scoutDirectHttps.matchingScoutInvocation} briefRef=${scoutDirectHttps.validBriefReference} cleanup=${scoutDirectHttps.cleanupEvidenceValid}`,
    );

    const dockerAvailable = isDockerDaemonRunning();
    let scoutDocker;
    if (dockerAvailable) {
      scoutDocker = await runDelegatedScout(
        "docker",
        candidateDockerProfile,
        'Delegate to scout-public using delegate({ agent: "scout-public", task: "Verify Node.js 24 LTS release status using sourceUrls: [\'https://nodejs.org/en/about/previous-releases\']." }) and summarize the result.',
      );
      pushAssertion(
        "task4.scout.docker",
        REQUIRE_DOCKER,
        true,
        scoutDocker.ok,
        scoutDocker.ok
          ? "Matching scout_research invocation proved Docker runtime.cleanup.confirmed=true and valid briefReference"
          : `Docker acceptance failed: ${scoutDocker.failureReasons.join("; ")}`,
      );
    } else if (REQUIRE_DOCKER) {
      scoutDocker = {
        mode: "docker",
        status: "blocked",
        blocked: true,
        executed: false,
        ok: false,
        blocker:
          "Docker Desktop Linux engine daemon is not running on this host (`docker info` unavailable) while --require-docker was specified.",
      };
      acceptanceAssertions.push({
        id: "task4.scout.docker",
        required: true,
        status: "blocked",
        passed: false,
        detail: scoutDocker.blocker,
      });
    } else {
      scoutDocker = {
        mode: "docker",
        status: "pending-docker-unavailable",
        blocked: false,
        executed: false,
        ok: null,
        blocker: "Docker Desktop Linux engine daemon is not running on this host (`docker info` unavailable).",
      };
      pushAssertion("task4.scout.docker", false, false, null, scoutDocker.blocker);
    }

    task4Report = {
      status: "executed",
      directHttpsMode: scoutDirectHttps,
      dockerMode: scoutDocker,
    };
    pushAssertion(
      "task4.scout.directHttps",
      true,
      true,
      scoutDirectHttps.ok,
      scoutDirectHttps.ok
        ? "Matching scout_research invocation proved direct-urls mode, workerStarted=false, cleanup=not-started, and valid briefReference"
        : `Direct HTTPS acceptance failed: ${scoutDirectHttps.failureReasons.join("; ")}`,
    );
  } else {
    task4Report = makeSkippedTask();
    pushAssertion("task4.scout.directHttps", true, false, null, "excluded by --only");
    pushAssertion("task4.scout.docker", REQUIRE_DOCKER, false, null, "excluded by --only");
  }

  const summary = summarizeAcceptance(acceptanceAssertions);
  const report = {
    kind: "live-provider-acceptance-comparison",
    model: MODEL,
    thinking: THINKING,
    singleProviderOnly: PROVIDER,
    fireworksOrCopilotCredentials: false,
    filter: ONLY_ARG ? [...ONLY_ARG] : null,
    samples: 1,
    selectedChecksPassed: summary.selectedChecksPassed,
    fullSuitePassed: summary.fullSuitePassed,
    skippedCheckIds: summary.skippedCheckIds,
    acceptanceAssertions,
    task1_simpleEdit: task1Report,
    task2a_investigationToolIntegration: task2aReport,
    task2b_changedSkillToolIntegration: task2bReport,
    task2c_ordinarySkillEditSelection: task2cReport,
    task3a_allocatorProviderWave: task3aReport,
    task3b_explicitlyRequestedReviewerDelegation: task3bReport,
    task4_scoutDelegation: task4Report,
  };

  const outIdx = process.argv.indexOf("--out");
  if (outIdx !== -1 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
  if (!summary.selectedChecksPassed) {
    console.error(
      "ACCEPTANCE ASSERTIONS FAILED:",
      summary.failedRequired.map((f) => `${f.id}: ${f.detail}`).join("; "),
    );
    process.exitCode = 1;
  }
} finally {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}
