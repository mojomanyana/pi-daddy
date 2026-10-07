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
  // Pi's managed npm installs omit host peers. The CLI must carry its own runtime dependencies.
  run("npm", ["i", "--legacy-peer-deps", "--no-audit", "--no-fund", join(work, packed)], work);
  if (existsSync(join(work, "node_modules/pi-daddy/dist/kernel/run-child-test-control.js"))) {
    throw new Error("test-only run-child control leaked into the installed package");
  }

  // Native leaf must ship and work WITHOUT installing/granting capabilities to npm content.
  const leaseRoot = join(work, "node_modules", "pi-daddy", "dist", "executors", "native");
  const leaseManifest = JSON.parse(readFileSync(join(leaseRoot, "cache-lease.json"), "utf8"));
  if (process.platform === "linux" && process.arch === "x64") {
    if (!leaseManifest.available || leaseManifest.arch !== process.arch || leaseManifest.protocol !== 2)
      throw new Error("installed native lease manifest is missing or incompatible");
    writeFileSync(join(work, "lease-probe.mjs"), [
      'import assert from "node:assert/strict";',
      'import {open,writeFile} from "node:fs/promises";',
      'import {startCacheLeaseBridge} from "./node_modules/pi-daddy/dist/executors/cache-lease-bridge.js";',
      'import {readCacheOwner} from "./node_modules/pi-daddy/dist/kernel/cache-owner.js";',
      'await writeFile("lease-input","stable");const fd=await open("lease-input","r");',
      'const owner=await readCacheOwner(process.pid);',
      'const bridge=await startCacheLeaseBridge({binary:' + JSON.stringify(join(leaseRoot, "cache-lease-v2")) +
        ',binarySha256:' + JSON.stringify(leaseManifest.sha256) + ',owner,peer:owner,onLoss:()=>{}});',
      'try{assert.equal(bridge.privileged,false);const held=await bridge.acquire(fd.fd,await fd.stat({bigint:true}));',
      'if(!held.ok)assert.fail(held.reason);assert.equal(await held.lease.check(),true);await held.lease.release();}',
      'finally{await bridge.stop();await fd.close();}',
    ].join("\n"));
    run("node", ["lease-probe.mjs"], work);
  } else if (leaseManifest.available || !leaseManifest.reason) {
    throw new Error("unsupported native lease platform was not explicitly recorded");
  }

  const inodeManifest = JSON.parse(readFileSync(join(leaseRoot, "cache-inode.json"), "utf8"));
  if (process.platform === "linux" && process.arch === "x64") {
    if (!inodeManifest.available || inodeManifest.arch !== process.arch || inodeManifest.protocol !== 1)
      throw new Error("installed native inode manifest is missing or incompatible");
    writeFileSync(join(work, "inode-probe.mjs"), [
      'import assert from "node:assert/strict";',
      'import {open,writeFile,chmod} from "node:fs/promises";',
      'import {startInodeObserver} from "./node_modules/pi-daddy/dist/executors/cache-inode-observer.js";',
      'import {readCacheOwner} from "./node_modules/pi-daddy/dist/kernel/cache-owner.js";',
      'await writeFile("inode-input","stable");const fd=await open("inode-input","r");',
      'const observer=await startInodeObserver({binary:' + JSON.stringify(join(leaseRoot, "cache-inode-v1")) +
        ',sha256:' + JSON.stringify(inodeManifest.sha256) + ',owner:await readCacheOwner(process.pid),objects:[{fd:fd.fd,info:await fd.stat({bigint:true})}]});',
      'try{const ticket=observer.ticket([0]);await observer.drain();assert.equal(observer.observationsUnchanged(ticket),true);',
      'await chmod("inode-input",0o640);await observer.drain();assert.equal(observer.observationsUnchanged(ticket),false);}',
      'finally{await observer.stop();await fd.close();}',
    ].join("\n"));
    run("node", ["inode-probe.mjs"], work);
    writeFileSync(join(work, "inode-symlink-probe.mjs"), [
      'import assert from "node:assert/strict";',
      'import {constants} from "node:fs";',
      'import {open,symlink,link,lutimes} from "node:fs/promises";',
      'import {startInodeObserver} from "./node_modules/pi-daddy/dist/executors/cache-inode-observer.js";',
      'import {readCacheOwner,cacheProcessTerminated} from "./node_modules/pi-daddy/dist/kernel/cache-owner.js";',
      'await symlink("missing-target","inode-link");await link("inode-link","inode-alias");',
      'const fd=await open("inode-link",0x200000|constants.O_NOFOLLOW);',
      'const observer=await startInodeObserver({binary:' + JSON.stringify(join(leaseRoot, "cache-inode-v1")) +
        ',sha256:' + JSON.stringify(inodeManifest.sha256) + ',owner:await readCacheOwner(process.pid),objects:[{fd:fd.fd,info:await fd.stat({bigint:true})}]});',
      'const owner=await readCacheOwner(observer.pid);',
      'try{assert.equal(observer.manifest()[0].kind,"symlink");const ticket=observer.ticket([0]);',
      'await lutimes("inode-alias",new Date(1000),new Date(2000));await observer.drain();',
      'assert.equal(observer.observationsUnchanged(ticket),false);}',
      'finally{await observer.stop();assert.equal(await cacheProcessTerminated(owner),true);await fd.close();}',
    ].join("\n"));
    run("node", ["inode-symlink-probe.mjs"], work);
  } else if (inodeManifest.available || !inodeManifest.reason) {
    throw new Error("unsupported native inode platform was not explicitly recorded");
  }

  const heldLinkManifest = JSON.parse(readFileSync(join(leaseRoot, "cache-held-symlink.json"), "utf8"));
  if (process.platform === "linux" && process.arch === "x64") {
    if (!heldLinkManifest.available || heldLinkManifest.protocol !== 1 || heldLinkManifest.arch !== process.arch)
      throw new Error("installed native held symlink manifest is missing or incompatible");
    writeFileSync(join(work, "held-link-probe.mjs"), [
      'import assert from "node:assert/strict";',
      'import {constants} from "node:fs";',
      'import {open,symlink} from "node:fs/promises";',
      'import {readHeldSymlink} from "./node_modules/pi-daddy/dist/executors/cache-held-symlink.js";',
      'await symlink("target","held-link");const fd=await open("held-link",0x200000|constants.O_NOFOLLOW);',
      'try{const st=await fd.stat({bigint:true});const target=await readHeldSymlink({binary:' +
        JSON.stringify(join(leaseRoot, "cache-held-symlink-v1")) + ',sha256:' + JSON.stringify(heldLinkManifest.sha256) +
        ',input:{fd:fd.fd,dev:st.dev,ino:st.ino},maxTargetBytes:64});assert.equal(target.toString(),"target");}',
      'finally{await fd.close();}',
    ].join("\n"));
    run("node", ["held-link-probe.mjs"], work);
  } else if (heldLinkManifest.available || !heldLinkManifest.reason) {
    throw new Error("unsupported held symlink platform was not explicitly recorded");
  }

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

  // A fresh configured project must also work without an explicitly installed SDK peer.
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

  console.log("smoke: installed package imports, dashboard, plugin, and `pi-daddy init` — OK");
} catch (error) {
  console.error("smoke FAILED:\n", error.stdout ?? "", error.stderr ?? error.message ?? error);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
