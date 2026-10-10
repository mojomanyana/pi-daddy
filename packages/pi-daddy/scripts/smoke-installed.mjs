#!/usr/bin/env node
/**
 * G9 — prove the package works AS INSTALLED, not just as a working tree.
 *
 * Review finding B-I12: `exports` pointed at `./src/*.ts`, and Node refuses to strip types for anything
 * under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Every consumer import therefore
 * threw, while every in-repo test passed — which is exactly the gap a packaging test exists to close.
 *
 * Packs a tarball, installs it into a scratch project, and imports it the way a consumer would.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { runDiagnosticSmoke } from "./smoke-diagnostics.mjs";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkgDir = new URL("..", import.meta.url).pathname;
const packageVersion = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const work = mkdtempSync(join(tmpdir(), "grants-smoke-"));
const managed = mkdtempSync(join(tmpdir(), "grants-managed-smoke-"));
let completed = false;
// **`PI_CODING_AGENT_DIR` is pinned into the scratch dir, and that is not tidiness.** `init` searches pi's
// own install root as well as the project's (R-75), so without this the probe reads whatever the developer
// happens to have installed machine-wide and asserts against it. It broke the moment discovery was widened:
// the fixture expected one skill and found this machine's `principal-pi-skills` too. R-40's lesson, third
// occurrence — a test that reads real user state is not a test.
// Always `work`, never the `cwd` of the individual call: one invocation runs `npm pack` in the REPO, and
// deriving the agent dir from its cwd would point this at a path inside the checkout.
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, PI_CODING_AGENT_DIR: join(work, ".agent-home") },
  });

try {
  const packed = run("npm", ["pack", "--pack-destination", work], pkgDir).trim().split("\n").pop();
  console.log(runDiagnosticSmoke(join(work, packed)));
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
  // This standalone host prefix carries the exact qualified Pi and TypeBox versions used by the loader probe
  // and by the ordinary library/CLI checks below. The separate managed prefix intentionally carries neither.
  run("npm", [
    "i",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
    join(work, packed),
    "@earendil-works/pi-coding-agent@1.0.4",
    "typebox@1.1.38",
  ], work);
  if (existsSync(join(work, "node_modules/pi-daddy/dist/kernel/run-child-test-control.js"))) {
    throw new Error("test-only run-child control leaked into the installed package");
  }

  writeFileSync(join(managed, "package.json"), JSON.stringify({ name: "managed-smoke", private: true }));
  run("npm", ["i", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", join(work, packed)], managed);
  const managedPackage = join(managed, "node_modules", "pi-daddy");
  for (const hostPackage of [
    join(managed, "node_modules", "@earendil-works", "pi-coding-agent"),
    join(managed, "node_modules", "typebox"),
  ])
    if (existsSync(hostPackage)) throw new Error(`managed pi-daddy unexpectedly installed host peer: ${hostPackage}`);

  const managedBin = join(managed, "node_modules", ".bin", "pi-daddy");
  if (!run(managedBin, ["--help"], managed).includes("pi-daddy — capability governance"))
    throw new Error("managed no-peer CLI help failed");
  if (run(managedBin, ["--version"], managed).trim() !== packageVersion)
    throw new Error("managed no-peer CLI version failed");
  run("git", ["init"], managed);
  run("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--allow-empty", "-m", "fixture"], managed);
  const managedReport = JSON.parse(run(managedBin, ["report", "--json"], managed));
  if (!Array.isArray(managedReport.rows)) throw new Error("managed no-peer report did not return episode JSON");
  const managedInit = spawnSync(managedBin, ["init"], {
    cwd: managed,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: join(managed, ".agent-home") },
  });
  if (managedInit.status !== 1 || !managedInit.stderr.includes("Start Pi in the target project and run /grants init"))
    throw new Error(`managed no-peer init did not give the Pi-host remedy:
${managedInit.stderr}`);

  const agentDir = join(work, ".agent-home");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProjectTrust: "always",
      enableAnalytics: false,
      enableInstallTelemetry: false,
      packages: [managedPackage],
    }),
  );
  writeFileSync(
    join(work, "loader-probe.mjs"),
    [
      `import assert from "node:assert/strict";`,
      `import { readFileSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";`,
      `const cwd = process.cwd();`,
      `const agentDir = join(cwd, ".agent-home");`,
      `const packageRoot = ${JSON.stringify(managedPackage)};`,
      `const load = async () => {`,
      `  const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });`,
      `  await loader.reload();`,
      `  return loader.getExtensions();`,
      `};`,
      `const loaded = await load();`,
      `assert.deepEqual(loaded.errors, [], "installed grants extension must load without errors");`,
      `assert.deepEqual(loaded.warnings, [], "installed grants extension must load without package warnings");`,
      `assert.equal(loaded.extensions.length, 1, "managed package must register exactly its declared extension");`,
      `const extension = loaded.extensions[0];`,
      `assert.deepEqual([...extension.tools.keys()], ["activity_lifecycle"]);`,
      `assert.deepEqual([...extension.commands.keys()], ["grants"]);`,
      `const manifestPath = join(packageRoot, "package.json");`,
      `const original = readFileSync(manifestPath, "utf8");`,
      `const manifest = JSON.parse(original);`,
      `manifest.dependencies = { typebox: "*" };`,
      `writeFileSync(manifestPath, JSON.stringify(manifest));`,
      `try {`,
      `  const rejected = await load();`,
      `  assert.equal(rejected.warnings.length, 1, "negative control must trigger Pi's host-package diagnostic");`,
      `  assert.match(rejected.warnings[0].warning, /not dependencies: typebox/);`,
      `} finally { writeFileSync(manifestPath, original); }`,
      `console.log("LOADER_SMOKE_OK");`,
    ].join("\n"),
  );
  const loaderOut = run("node", ["loader-probe.mjs"], work);
  if (!loaderOut.includes("LOADER_SMOKE_OK")) throw new Error(`unexpected loader output: ${loaderOut}`);

  writeFileSync(
    join(work, "probe.mjs"),
    [
      `import { readFileSync } from "node:fs";`,
      `import { resolve, assertNarrowing } from "pi-daddy";`,
      `import { planSpawn } from "pi-daddy";`,
      `import { runChild } from "pi-daddy";`,
      // The subpaths added in 0.7.0. A smoke test exists to catch a broken `exports` map, so every new
      // module belongs here — 0.7.0 deleted two subpaths and added four, and a stale map fails only on a
      // consumer's machine.
      `import { parseSkillDefinition, ceilingForDefinition } from "pi-daddy";`,
      `import { splitBudget, childSpawnId } from "pi-daddy";`,
      `import { splitSystemPrompt } from "pi-daddy";`,
      `import { PI_BUILTIN_TOOLS, WILDCARD } from "pi-daddy";`,
      `import { planInit, withPlaceholder } from "pi-daddy";`,
      `import { discoverSkillPackages } from "pi-daddy";`,
      `import { digestTask, buildApprovalBinding } from "pi-daddy";`,
      `import { refusal, GovernanceRefusal } from "pi-daddy";`,
      `import { defaultWorkspaceLeaseDir } from "pi-daddy";`,
      `import { parseDashboardLedger } from "pi-daddy";`,
      `import { renderDashboard } from "pi-daddy";`,
      `import ledgerV3Schema from "pi-daddy/contracts/ledger-record/v1/governance-event.schema.json" with { type: "json" };`,
      `import v3CapabilityFixture from "pi-daddy/contracts/ledger-record/v1/fixtures/capability-decision.json" with { type: "json" };`,
      `import v3LeaseFixture from "pi-daddy/contracts/ledger-record/v1/fixtures/workspace-lease.json" with { type: "json" };`,
      `import v3LifecycleFixture from "pi-daddy/contracts/ledger-record/v1/fixtures/child-lifecycle.json" with { type: "json" };`,
      `import recordSchema from "pi-daddy/contracts/ledger-record/v1/record.schema.json" with { type: "json" };`,
      // Exercise it, don't just import it: a module that loads but throws on use is not "working".
      `const r = resolve({ requested: ["tool:read"], parentGrant: ["tool:read", "tool:write"] });`,
      `assertNarrowing(r);`,
      `const plan = planSpawn({ effective: r.effective, prompt: "t" });`,
      `if (!plan.args.includes("--tools")) throw new Error("planSpawn produced no allowlist");`,
      `if (typeof runChild !== "function") throw new Error("run-child export missing");`,
      // Same rule for the 0.7.0 modules: exercised, not merely imported.
      `const def = parseSkillDefinition("/s/review/SKILL.md", "---\\nname: review\\ndescription: d\\nallowed-tools: Read Grep\\n---\\nbody");`,
      `if (def?.name !== "review") throw new Error("definition parse failed");`,
      `const ceiling = ceilingForDefinition(def);`,
      `if (ceiling.capabilities.join(",") !== "tool:grep,tool:read") throw new Error("ceiling wrong: " + ceiling.capabilities);`,
      `if (!splitBudget(8, 2).ok || childSpawnId("d0", 0) !== "d0.1") throw new Error("fanout export broken");`,
      `if (splitSystemPrompt(["--append-system-prompt", "x", "--append-system-prompt", "y"]).systemPrompts.join() !== "x,y") throw new Error("run-herdr export broken");`,
      `if (!PI_BUILTIN_TOOLS.includes("read") || WILDCARD !== "tool:*") throw new Error("pi-tools export broken");`,
      `if (withPlaceholder("---\\nname: x\\ndescription: d\\n---\\nb", false).includes("\\nallowed-tools:")) throw new Error("init invented a ceiling");`,
      `const pkgs = await discoverSkillPackages(process.cwd());`,
      `if (planInit(pkgs, process.cwd()).grant.join() !== "agent:review,tool:delegate,tool:grep,tool:read") throw new Error("init grant wrong: " + planInit(pkgs, process.cwd()).grant);`,
      `const binding = buildApprovalBinding({task:"t",requested:["tool:read"],effective:["tool:read"],parentId:"d0"});`,
      `if (binding.task_sha256 !== digestTask("t")) throw new Error("correlation export broken");`,
      `if (new GovernanceRefusal(refusal("GATED_UNAPPROVED", "no")).code !== "GATED_UNAPPROVED") throw new Error("refusal export broken");`,
      `if (!defaultWorkspaceLeaseDir({PI_CODING_AGENT_DIR: process.cwd()}).includes("workspace-leases")) throw new Error("workspace export broken");`,
      `if (ledgerV3Schema.$id !== "https://github.com/mojomanyana/pi-daddy/contracts/ledger-record/v1/governance-event.schema.json") throw new Error("ledger v3 schema export broken");`,
      `if ([v3CapabilityFixture, v3LeaseFixture, v3LifecycleFixture].map((event) => event.event).join() !== "capability_decision,workspace_lease,child_lifecycle") throw new Error("ledger v3 fixture exports broken");`,
      // The reader takes record envelopes (ADR-0076 PR 3d); the published fixture ledger is the real chained file.
      `const ledgerText = readFileSync(new URL(import.meta.resolve("pi-daddy/contracts/ledger-record/v1/fixtures/ledger-record.jsonl")), "utf8");`,
      `const dashboard = parseDashboardLedger(ledgerText, { now: new Date("2026-08-20T12:00:02Z") });`,
      `if (!renderDashboard(dashboard, { color: false }).includes("build")) throw new Error("dashboard exports broken");`,
      `if (recordSchema.$id !== "https://github.com/mojomanyana/pi-daddy/contracts/ledger-record/v1/record.schema.json") throw new Error("record schema export broken");`,
      `console.log("SMOKE_OK");`,
    ].join("\n"),
  );

  // A skill package the way `principal-pi-skills` ships one — declared in `pi.skills`, measured at 2.3.1.
  // Both the library entry points above and the `pi-daddy` BIN below are exercised against it: `bin` is
  // packaging, and packaging is exactly what this script exists to catch (a missing `dist/cli.js`, a
  // `files` array that drops it, a lost shebang) — none of which any in-repo test can see.
  const skillPkg = join(work, "node_modules", "fake-skills");
  mkdirSync(join(skillPkg, "review"), { recursive: true });
  writeFileSync(join(skillPkg, "package.json"), JSON.stringify({ name: "fake-skills", version: "1.0.0", pi: { skills: ["./review"] } }));
  const skillSource = "---\nname: review\ndescription: Reports findings; never edits.\nallowed-tools: Read, Grep\n---\nReview it.\n";
  writeFileSync(join(skillPkg, "review", "SKILL.md"), skillSource);

  const out = run("node", ["probe.mjs"], work).trim();
  if (!out.includes("SMOKE_OK")) throw new Error(`unexpected output: ${out}`);

  const initOut = run(join(work, "node_modules", ".bin", "pi-daddy"), ["init"], work);
  if (!initOut.includes("found fake-skills@1.0.0")) throw new Error(`init did not find the package:\n${initOut}`);
  const settings = JSON.parse(readFileSync(join(work, ".pi", "pi-daddy", "settings.json"), "utf8"));
  if (settings.version !== 1 || settings.ledger !== "grants.jsonl" || !Array.isArray(settings.grant)) {
    throw new Error(`init did not record its project settings:\n${JSON.stringify(settings)}`);
  }

  // VERBATIM means byte-for-byte, so compare the whole file. The first version asserted that
  // `allowed-tools: Read, Grep` was PRESENT, which survives a mutation that injects the six-line commented
  // placeholder into a declared skill — an assertion whose message named a production change it could not
  // detect. Rule 7 applies to smoke assertions too.
  const copied = readFileSync(join(work, ".pi", "skills", "review", "SKILL.md"), "utf8");
  if (copied !== skillSource) throw new Error(`init did not copy the declaration verbatim:\n${copied}`);

  // A fresh configured project also resolves an enabled skill package without copying it.
  const configuredProject = join(work, "configured-project");
  mkdirSync(join(configuredProject, ".pi"), { recursive: true });
  writeFileSync(join(configuredProject, ".pi", "settings.json"), JSON.stringify({ packages: [skillPkg] }));
  const configuredOut = run(join(work, "node_modules", ".bin", "pi-daddy"), ["init"], configuredProject);
  if (!configuredOut.includes("enabled in Pi; no copy") || existsSync(join(configuredProject, ".pi", "skills"))) {
    throw new Error("configured installed CLI setup did not reference skills in place");
  }
  writeFileSync(join(work, "configured-probe.mjs"), [
    'import assert from "node:assert/strict";',
    'import { loadDefinitions } from "pi-daddy";',
    'import { buildCatalog } from "pi-daddy";',
    'const definitions = await loadDefinitions(process.cwd());',
    'assert.equal(definitions.get("review")?.source, ' + JSON.stringify(join(skillPkg, "review", "SKILL.md")) + ');',
    'const catalog = await buildCatalog({ cwd: process.cwd(), observedTools: null });',
    'assert(catalog.has("agent:review") && catalog.has("skill:review"));',
  ].join("\n"));
  run("node", [join(work, "configured-probe.mjs")], configuredProject);

  const dashboardOut = execFileSync(
    join(work, "node_modules", ".bin", "pi-daddy-dashboard"),
    ["--once", "--no-color"],
    {
      cwd: work,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(work, ".agent-home"),
        PI_DADDY_LEDGER: join(work, "grants.jsonl"),
        PI_DADDY_ACTIVITY_TIMELINE: join(work, "activity.jsonl"),
      },
    },
  );
  if (!dashboardOut.includes("No governed executions recorded yet")) {
    throw new Error(`installed dashboard bin did not run:\n${dashboardOut}`);
  }
  const pluginManifest = readFileSync(
    join(work, "node_modules", "pi-daddy", "herdr-plugin", "herdr-plugin.toml"),
    "utf8",
  );
  if (!pluginManifest.includes('id = "pi-daddy.dashboard"') || !pluginManifest.includes("dist/products/dashboard-cli.js")) {
    throw new Error("installed package dropped or changed the bundled Herdr plugin");
  }

  // Exercise the SHIPPED native helper and compiled final verifier against the SHIPPED exact Pi dependency.
  // Fixture extension remains outside node_modules; all production imports below come from the installed tarball.
  for (const fixture of ["scripted-provider.ts", "cli-extension.ts"])
    copyFileSync(join(pkgDir, "test-integration", "pi-sdk", fixture), join(work, fixture));
  mkdirSync(join(work, ".capture-agent"));
  writeFileSync(join(work, ".capture-agent", "settings.json"), JSON.stringify({
    defaultProjectTrust:"always",enableAnalytics:false,enableInstallTelemetry:false,compaction:{enabled:false},retry:{enabled:false},cacheWarming:"off"
  }));
  writeFileSync(join(work,"captured-probe.mjs"),[
    'import assert from "node:assert/strict";',
    'import {join} from "node:path";',
    'import {fileURLToPath} from "node:url";',
    'import {readFileSync} from "node:fs";',
    'import {runCapturedExecution} from "./node_modules/pi-daddy/dist/executors/captured-execution.js";',
    'import {FINAL,MODEL,PROVIDER} from "./scripted-provider.ts";',
    'const cwd=process.cwd(),sessionPath=join(cwd,"captured-session.jsonl");',
    'const cli=fileURLToPath(new URL("./cli.js",import.meta.resolve("@earendil-works/pi-coding-agent")));',
    'assert.equal(JSON.parse(readFileSync(new URL("../package.json",new URL("./",import.meta.resolve("@earendil-works/pi-coding-agent"))))).version,"1.0.4");',
    'const result=await runCapturedExecution({command:process.execPath,args:[cli,"--session",sessionPath,"--no-extensions","-e",join(cwd,"cli-extension.ts"),"--no-skills","--no-mcp","--offline","--provider",PROVIDER,"--model",MODEL,"--thinking","high","installed fixture"],',
    'executionId:"installed-captured-fixture",cwd,sessionPath,env:{...process.env,PI_CODING_AGENT_DIR:join(cwd,".capture-agent"),P01_SCENARIO:"success"},timeoutMs:10000});',
    'assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.cleanup.state,"settled");',
    'assert.equal(result.final.state,"complete",JSON.stringify(result));assert.equal(result.text,FINAL);',
    'console.log("CAPTURED_INSTALLED_OK");',
  ].join("\n"));
  const capturedOut=run("node",["captured-probe.mjs"],work);
  if(!capturedOut.includes("CAPTURED_INSTALLED_OK"))throw Error("installed captured worker/final verification failed");
  completed = true;
  console.log("smoke: installed imports, dashboard, init, native helper and exact Pi captured final — OK");
} catch (error) {
  console.error("smoke FAILED:\n", error.stdout ?? "", error.stderr ?? error.message ?? error);
  process.exitCode = 1;
} finally {
  if (completed) {
    rmSync(work, { recursive: true, force: true });
    rmSync(managed, { recursive: true, force: true });
  } else console.error(`smoke evidence retained at ${work} and ${managed}`);
}
