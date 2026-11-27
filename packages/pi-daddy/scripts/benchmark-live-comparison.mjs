#!/usr/bin/env node
/**
 * Live-model baseline vs candidate comparison & operator entry-point verification.
 * Uses ONE configured provider (`google/gemini-flash-latest`, --thinking low) in disposable
 * Pi 1.6.1 profiles with Fireworks/Copilot/OpenAI/Anthropic credentials explicitly stripped.
 *
 * Saves structured JSON report to --out <path> (or prints JSON to stdout).
 */
import { execFileSync, spawn } from "node:child_process";
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

/** Run real Pi 1.6.1 in JSON mode and extract exact final text, tool calls, model calls, and token usage. */
function runPiJson({ cwd, profileDir, prompt, extraArgs = [], extraEnv = {}, timeoutMs = 90_000 }) {
  return new Promise((resolveDone) => {
    const start = performance.now();
    const args = [
      ...PI_BIN.prefix,
      "-p",
      "--mode",
      "json",
      "--no-session",
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
            toolCalls.push({ tool: ev.toolName, args: ev.args });
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
  // Dirty sibling outside nested workspace
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
  return dir;
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
const ecoCand = {
  ...ecoBase,
  delegation: { maxDepth: 4, inheritContextFiles: true, tournamentTimeoutSec: 120 },
};

const { createCapacityAllocator } = await import(pathToFileURL(join(DADDY_PKG, "dist/kernel/capacity.js")).href);
const { collectReviewDiff, resolveReviewScope } = await import(
  pathToFileURL(join(DADDY_PKG, "extensions/work-mode.ts")).href
);

try {
  const releasedProfile = createSingleProviderProfile(releasedPackages, ecoBase);
  const candidateProfile = createSingleProviderProfile(candidatePackages, ecoCand);

  // -------------------------------------------------------------------------
  // 1. Live Simple Edit: Released vs Candidate
  // -------------------------------------------------------------------------
  const editPrompt = "Fix double(n) in math.mjs so it returns n * 2 instead of n + 1. Keep it direct and concise.";
  const fixBase = makeSimpleEditFixture();
  const resEditBase = await runPiJson({ cwd: fixBase.nested, profileDir: releasedProfile, prompt: editPrompt });
  const editBaseCorrect = /return\s+n\s*\*\s*2/.test(readFileSync(join(fixBase.nested, "math.mjs"), "utf8"));
  const baseReviewDiff = execFileSync("git", ["diff", "--no-color", "HEAD"], { cwd: fixBase.nested, encoding: "utf8" });

  const fixCand = makeSimpleEditFixture();
  const resEditCand = await runPiJson({ cwd: fixCand.nested, profileDir: candidateProfile, prompt: editPrompt });
  const editCandCorrect = /return\s+n\s*\*\s*2/.test(readFileSync(join(fixCand.nested, "math.mjs"), "utf8"));
  const candScope = resolveReviewScope(fixCand.nested, editPrompt);
  const candReviewDiff = await collectReviewDiff(fixCand.nested, candScope.mode);

  // -------------------------------------------------------------------------
  // 2. Live Direct Investigation vs `investigate` Specialist
  // -------------------------------------------------------------------------
  const invDir = makeInvestigateFixture();
  const invDirect = await runPiJson({
    cwd: invDir,
    profileDir: candidateProfile,
    prompt:
      "Without delegating, trace handle() from src/entry.ts to the final token check and cite exact file names and symbols.",
  });
  const invSpecialist = await runPiJson({
    cwd: invDir,
    profileDir: candidateProfile,
    extraEnv: { PI_DADDY_AUTO_MODE: "1" },
    prompt:
      'Use delegate({ agent: "investigate", task: "Trace handle() from src/entry.ts to the final token check with exact file and symbol references." }) and return its result.',
  });
  const citesPath = (txt) => /entry\.ts/.test(txt) && /router\.ts/.test(txt) && /auth\.ts/.test(txt) && /verifyToken/.test(txt);

  // -------------------------------------------------------------------------
  // 3. Live Candidate 5-Repo Cleanup Review at Fanout 8 vs Fanout 24 (10 live review children: 2 per repo)
  // -------------------------------------------------------------------------
  const reviewTargets = [
    { repo: "pi-daddy", file: join(DADDY_PKG, "src/kernel/fanout.ts"), q: "Report the exact STANDARD and AMBITIOUS fanout constants." },
    { repo: "pi-daddy", file: join(DADDY_PKG, "src/kernel/propagation.ts"), q: "Report DEFAULT_MAX_DEPTH and MAX_SELECTABLE_DEPTH." },
    { repo: "principal-pi-skills", file: join(PRINCIPAL_REPO, "package.json"), q: "Count how many skills are listed in pi.skills." },
    { repo: "principal-pi-skills", file: join(PRINCIPAL_REPO, "principal-agents.json"), q: "Count how many bindings are in principal-agents.json." },
    { repo: "pi-scout-research", file: join(SCOUT_REPO, "package.json"), q: "Check whether ./scout-public is listed in pi.skills." },
    { repo: "pi-scout-research", file: join(SCOUT_REPO, "scout-public/SKILL.md"), q: "Report the allowed-tools line of scout-public." },
    { repo: "bookie-pi-skills", file: join(BOOKIE_REPO, "package.json"), q: "Report the @earendil-works/pi-coding-agent devDependency version." },
    { repo: "bookie-pi-skills", file: join(BOOKIE_REPO, "packages/pi-extension/src/memory-proposals.ts"), q: "Report the tool name exported in memory-proposals.ts." },
    { repo: "skill-harness", file: join(HARNESS_REPO, "packages/pi-extension/src/tool.ts"), q: "Check whether evaluationGap is handled in tool.ts." },
    { repo: "skill-harness", file: join(HARNESS_REPO, "packages/pi-extension/src/index.ts"), q: "Check whether Harness tools activate on session_start." },
  ];

  async function runLiveFiveRepoWave(fanoutLimit) {
    const allocator = createCapacityAllocator(fanoutLimit);
    let active = 0;
    let peakActive = 0;
    let totalWaitMs = 0;
    const t0 = performance.now();
    const outcomes = await Promise.all(
      reviewTargets.map(async (item, idx) => {
        const reqAt = performance.now();
        let res;
        while (true) {
          res = allocator.reserve(`live-rev-${fanoutLimit}-${idx}`, 0);
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
      fanoutLimit,
      samples: 1,
      tasks: reviewTargets.length,
      succeeded: outcomes.filter((o) => o.ok).length,
      findingsReturned: outcomes.filter((o) => o.finalText.length > 0).length,
      elapsedMs: Math.round(performance.now() - t0),
      totalModelCalls: outcomes.reduce((s, o) => s + o.modelCalls, 0),
      totalTokens: outcomes.reduce((s, o) => s + o.tokens.total, 0),
      peakActiveChildren: peakActive,
      totalWaitForCapacityMs: Math.round(totalWaitMs),
      avgWaitPerTaskMs: Math.round(totalWaitMs / reviewTargets.length),
    };
  }

  const liveFanout8 = await runLiveFiveRepoWave(8);
  const liveFanout24 = await runLiveFiveRepoWave(24);

  // -------------------------------------------------------------------------
  // 4. Live Delegated `scout-public` Call (candidate profile + directUrls official HTTPS fallback)
  // -------------------------------------------------------------------------
  const scoutDir = scratch("live-scout-");
  const liveScoutDelegated = await runPiJson({
    cwd: scoutDir,
    profileDir: candidateProfile,
    extraEnv: { PI_DADDY_AUTO_MODE: "1" },
    prompt:
      'Delegate to scout-public using delegate({ agent: "scout-public", task: "Check Node.js 24 LTS release status using sourceUrls: [\'https://nodejs.org/en/about/previous-releases\']" }) and summarize the result.',
    timeoutMs: 90_000,
  });

  const report = {
    kind: "live-provider-comparison",
    model: MODEL,
    thinking: THINKING,
    singleProviderOnly: PROVIDER,
    fireworksOrCopilotCredentials: false,
    samples: 1,
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
    task2_investigation: {
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
        delegatedInvestigate: invSpecialist.toolCalls.some((c) => c.tool === "delegate" && c.args?.agent === "investigate"),
        citedFullCallPath: citesPath(invSpecialist.finalText),
        elapsedMs: invSpecialist.elapsedMs,
        modelCalls: invSpecialist.modelCalls,
        tokens: invSpecialist.tokens,
        toolsUsed: invSpecialist.toolCalls.map((c) => c.tool),
      },
    },
    task3_fiveRepoCleanupReview: {
      fanout8_standard: liveFanout8,
      fanout24_ambitious: liveFanout24,
    },
    task4_liveDelegatedScoutPublic: {
      ok: liveScoutDelegated.ok,
      delegatedScoutPublic: liveScoutDelegated.toolCalls.some(
        (c) => c.tool === "delegate" && c.args?.agent === "scout-public",
      ),
      elapsedMs: liveScoutDelegated.elapsedMs,
      modelCalls: liveScoutDelegated.modelCalls,
      tokens: liveScoutDelegated.tokens,
      toolsUsed: liveScoutDelegated.toolCalls.map((c) => c.tool),
      excerpt: liveScoutDelegated.finalText.slice(0, 400),
      stderr: liveScoutDelegated.stderr,
    },
  };

  const outIdx = process.argv.indexOf("--out");
  if (outIdx !== -1 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}
