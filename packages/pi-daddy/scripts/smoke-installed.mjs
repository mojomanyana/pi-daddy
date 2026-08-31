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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkgDir = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "grants-smoke-"));
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
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
  run("npm", ["i", "--no-audit", "--no-fund", join(work, packed)], work);
  if (existsSync(join(work, "node_modules/pi-daddy/dist/run-child-test-control.js"))) {
    throw new Error("test-only run-child control leaked into the installed package");
  }

  writeFileSync(
    join(work, "probe.mjs"),
    [
      `import { resolve, assertNarrowing } from "pi-daddy";`,
      `import { planSpawn } from "pi-daddy/spawn";`,
      `import { runChild } from "pi-daddy/run-child";`,
      // The subpaths added in 0.7.0. A smoke test exists to catch a broken `exports` map, so every new
      // module belongs here — 0.7.0 deleted two subpaths and added four, and a stale map fails only on a
      // consumer's machine.
      `import { parseSkillDefinition, ceilingForDefinition } from "pi-daddy/definitions";`,
      `import { splitBudget, childSpawnId } from "pi-daddy/fanout";`,
      `import { splitSystemPrompt } from "pi-daddy/run-herdr";`,
      `import { PI_BUILTIN_TOOLS, WILDCARD } from "pi-daddy/pi-tools";`,
      `import { planInit, withPlaceholder } from "pi-daddy/init";`,
      `import { discoverSkillPackages } from "pi-daddy/skill-packages";`,
      `import { digestTask, buildApprovalBinding } from "pi-daddy/correlation";`,
      `import { refusal, GovernanceRefusal } from "pi-daddy/refusals";`,
      `import { defaultWorkspaceLeaseDir } from "pi-daddy/workspace";`,
      `import { buildCheckEnvironment } from "pi-daddy/check-runner";`,
      `import { parseDashboardLedger } from "pi-daddy/dashboard-projection";`,
      `import { renderDashboard } from "pi-daddy/dashboard-render";`,
      `import ledgerV3Schema from "pi-daddy/contracts/ledger/v3/ledger-event.schema.json" with { type: "json" };`,
      `import v3CapabilityFixture from "pi-daddy/contracts/ledger/v3/fixtures/capability-decision.json" with { type: "json" };`,
      `import v3LeaseFixture from "pi-daddy/contracts/ledger/v3/fixtures/workspace-lease.json" with { type: "json" };`,
      `import v3LifecycleFixture from "pi-daddy/contracts/ledger/v3/fixtures/child-lifecycle.json" with { type: "json" };`,
      `import v3ReceiptFixture from "pi-daddy/contracts/ledger/v3/fixtures/check-receipt.json" with { type: "json" };`,
      `import v3WorkflowFixture from "pi-daddy/contracts/ledger/v3/fixtures/workflow-fact.json" with { type: "json" };`,
      `import ledgerV2Schema from "pi-daddy/contracts/ledger/v2/ledger-event.schema.json" with { type: "json" };`,
      `import capabilityFixture from "pi-daddy/contracts/ledger/v2/fixtures/capability-decision.json" with { type: "json" };`,
      `import leaseFixture from "pi-daddy/contracts/ledger/v2/fixtures/workspace-lease.json" with { type: "json" };`,
      `import lifecycleFixture from "pi-daddy/contracts/ledger/v2/fixtures/child-lifecycle.json" with { type: "json" };`,
      `import receiptFixture from "pi-daddy/contracts/ledger/v2/fixtures/check-receipt.json" with { type: "json" };`,
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
      `if (splitSystemPrompt(["--append-system-prompt", "x"]).systemPrompt !== "x") throw new Error("run-herdr export broken");`,
      `if (!PI_BUILTIN_TOOLS.includes("read") || WILDCARD !== "tool:*") throw new Error("pi-tools export broken");`,
      `if (withPlaceholder("---\\nname: x\\ndescription: d\\n---\\nb", false).includes("\\nallowed-tools:")) throw new Error("init invented a ceiling");`,
      `const pkgs = await discoverSkillPackages(process.cwd());`,
      `if (planInit(pkgs, process.cwd()).grant.join() !== "agent:review,tool:delegate,tool:grep,tool:read") throw new Error("init grant wrong: " + planInit(pkgs, process.cwd()).grant);`,
      `const binding = buildApprovalBinding({task:"t",requested:["tool:read"],effective:["tool:read"],parentId:"d0"});`,
      `if (binding.task_sha256 !== digestTask("t")) throw new Error("correlation export broken");`,
      `if (new GovernanceRefusal(refusal("GATED_UNAPPROVED", "no")).code !== "GATED_UNAPPROVED") throw new Error("refusal export broken");`,
      `if (!defaultWorkspaceLeaseDir({PI_CODING_AGENT_DIR: process.cwd()}).includes("workspace-leases")) throw new Error("workspace export broken");`,
      `if (buildCheckEnvironment({executable:process.execPath,argv:[],env:{SAFE:"yes",SECRET_TOKEN:"no"}}).SECRET_TOKEN) throw new Error("check env leaked");`,
      `if (ledgerV3Schema.$id !== "https://github.com/mojomanyana/pi-daddy/contracts/ledger/v3/ledger-event.schema.json") throw new Error("ledger v3 schema export broken");`,
      `if ([v3CapabilityFixture, v3LeaseFixture, v3LifecycleFixture, v3ReceiptFixture, v3WorkflowFixture].map((event) => event.event).join() !== "capability_decision,workspace_lease,child_lifecycle,check_receipt,workflow_fact") throw new Error("ledger v3 fixture exports broken");`,
      `const dashboard = parseDashboardLedger(JSON.stringify(v3CapabilityFixture) + "\\n", { now: new Date("2026-08-20T12:00:02Z") });`,
      `if (!renderDashboard(dashboard, { color: false }).includes("build")) throw new Error("dashboard exports broken");`,
      `if (ledgerV2Schema.$id !== "https://github.com/mojomanyana/pi-daddy/contracts/ledger/v2/ledger-event.schema.json") throw new Error("ledger v2 schema export broken");`,
      `if ([capabilityFixture, leaseFixture, lifecycleFixture, receiptFixture].map((event) => event.event).join() !== "capability_decision,workspace_lease,child_lifecycle,check_receipt") throw new Error("ledger v2 fixture exports broken");`,
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
  const grantEnv = readFileSync(join(work, ".pi", "grants.env"), "utf8");
  if (!grantEnv.includes('PI_GRANTS_GRANT="agent:review,tool:delegate,tool:grep,tool:read"')) {
    throw new Error(`init wrote the wrong grant:\n${grantEnv}`);
  }
  // VERBATIM means byte-for-byte, so compare the whole file. The first version asserted that
  // `allowed-tools: Read, Grep` was PRESENT, which survives a mutation that injects the six-line commented
  // placeholder into a declared skill — an assertion whose message named a production change it could not
  // detect. Rule 7 applies to smoke assertions too.
  const copied = readFileSync(join(work, ".pi", "skills", "review", "SKILL.md"), "utf8");
  if (copied !== skillSource) throw new Error(`init did not copy the declaration verbatim:\n${copied}`);

  const dashboardOut = run(
    join(work, "node_modules", ".bin", "pi-daddy-dashboard"),
    ["--once", "--no-color"],
    work,
  );
  if (!dashboardOut.includes("pi-daddy is missing or its ledger is inactive")) {
    throw new Error(`installed dashboard bin did not run:\n${dashboardOut}`);
  }
  const pluginManifest = readFileSync(
    join(work, "node_modules", "pi-daddy", "herdr-plugin", "herdr-plugin.toml"),
    "utf8",
  );
  if (!pluginManifest.includes('id = "pi-daddy.dashboard"') || !pluginManifest.includes("dist/dashboard-cli.js")) {
    throw new Error("installed package dropped or changed the bundled Herdr plugin");
  }

  console.log("smoke: installed package imports, dashboard, plugin, and `pi-daddy init` — OK");
} catch (error) {
  console.error("smoke FAILED:\n", error.stdout ?? "", error.stderr ?? error.message ?? error);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
