/** Actual native Pi inventory; exits at session_start, before any provider request. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planDelegation } from "../../src/kernel/delegate.ts";
import { shouldSeekApproval } from "../../src/kernel/approval.ts";
import { selectedDefinitions } from "../../src/kernel/selected-definitions.ts";

test("native Pi origins admit builtins and Daddy tools, preserve selected prompts, and refuse parent-only providers", async () => {
  const root = mkdtempSync(join(tmpdir(), "daddy-tool-delivery-"));
  try {
    const agent = join(root, "agent");
    mkdirSync(agent);
    writeFileSync(join(agent, "auth.json"), "{}");
    writeFileSync(
      join(agent, "settings.json"),
      JSON.stringify({
        defaultProjectTrust: "always",
        enableAnalytics: false,
        enableInstallTelemetry: false,
        retry: { enabled: false },
        cacheWarming: "off",
      }),
    );
    const capture = join(root, "capture.ts"),
      provider = join(root, "fixture.ts"),
      observed = join(root, "observed.json");
    writeFileSync(
      capture,
      `import {writeFileSync} from 'node:fs'; export default function(pi) {
      globalThis.fetch=()=>{throw Error('network forbidden in inventory control')};
      pi.on('before_provider_request',()=>{throw Error('provider requests forbidden in inventory control')});
      pi.on('session_start',(_event,ctx)=>{writeFileSync(process.env.DADDY_TOOL_CAPTURE,JSON.stringify({
        tools:pi.getAllTools().map(t=>({name:t.name,sourceInfo:t.sourceInfo})),active:pi.getActiveTools(),systemPrompt:ctx.getSystemPrompt()
      }));process.exit(0)});
    }`,
    );
    writeFileSync(
      provider,
      `export default function(pi){for(const name of ['fixture_remote','not_granted'])
      pi.registerTool({name,label:name,description:'Local inventory only; no worker or network',
      parameters:{type:'object',properties:{}},execute:async()=>{throw Error('fixture tool must never run')}});}`,
    );
    const cli =
      process.env.DADDY_TEST_PI_CLI ??
      fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    const extensionPath = fileURLToPath(new URL("../../extensions/grants.ts", import.meta.url));
    const governed = ["delegate", "delegate_all", "delegate_chain", "delegate_describe"];
    const ownGrant = ["read", "write", "fixture_remote", ...governed].map((name) => `tool:${name}`);
    const captureInventory = (args: string[], env: Record<string, string> = {}) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 20000,
        maxBuffer: 128 * 1024,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: root,
          PI_CODING_AGENT_DIR: agent,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          NO_COLOR: "1",
          DADDY_TOOL_CAPTURE: observed,
          PI_DADDY_HERDR: "0",
          PI_DADDY_AUTO_MODE: "0",
          PI_DADDY_ACTIVITY_TIMELINE: "off",
          PI_DADDY_GRANT: ownGrant.join(","),
          ...env,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(readFileSync(observed, "utf8"));
    };
    const parent = captureInventory([
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "-e",
      provider,
      "-e",
      extensionPath,
      "-e",
      capture,
      "--tools",
      ["read", "write", "fixture_remote", ...governed].join(","),
      " Inventory only",
    ]);
    assert.ok(parent.active.includes("fixture_remote"));
    assert.ok(!parent.active.includes("not_granted"));
    for (const name of governed) {
      assert.ok(parent.active.includes(name), `${name} registered by actual Daddy`);
      assert.equal(parent.tools.find((tool: { name: string }) => tool.name === name)?.sourceInfo.path, extensionPath);
    }
    const context = {
      ownGrant,
      depth: 0,
      maxDepth: 1,
      extensionPath,
      gated: ["tool:write"],
      childToolSources: parent.tools,
    };
    const unavailable = planDelegation({ task: "unavailable", tools: ["write", "fixture_remote"] }, context);
    assert.equal(unavailable.refusal?.details?.kind, "child-tool-unavailable");
    assert.equal(shouldSeekApproval(unavailable.result), false);
    assert.deepEqual(unavailable.args, []);
    const allowed = planDelegation({ task: "inventory only", tools: ["read"] }, context);
    assert.equal(allowed.ok, true, allowed.reason);
    const args = [...allowed.args];
    args.splice(args.length - 1, 0, "-e", capture);
    const child = captureInventory(args, allowed.env);
    assert.deepEqual(child.active, ["read"]);
    assert.deepEqual(
      child.tools.map((tool: { name: string }) => tool.name),
      ["read"],
    );
    assert.equal(child.tools[0].sourceInfo.path, "builtin:read");
    const roleDir = join(root, "native-role");
    mkdirSync(roleDir);
    const rolePath = join(roleDir, "SKILL.md");
    const body = "NATIVE-AUTHORED-INSTRUCTIONS: keep this exact selected role body.";
    writeFileSync(
      rolePath,
      `---\nname: native-role\ndescription: native prompt control\nallowed-tools: read, ${governed.join(", ")}\n---\n${body}`,
    );
    const { definitions } = await selectedDefinitions([
      { source: "skill", name: "skill:native-role", sourceInfo: { path: rolePath } },
    ]);
    const role = planDelegation(
      { agent: "native-role", task: "inventory only" },
      {
        ...context,
        ownGrant: [...ownGrant, "agent:native-role"],
        definitions,
      },
    );
    assert.equal(role.ok, true, role.reason);
    const roleArgs = [...role.args];
    roleArgs.splice(roleArgs.length - 1, 0, "-e", capture);
    const delegated = captureInventory(roleArgs, role.env);
    assert.deepEqual([...delegated.active].sort(), ["read", ...governed].sort());
    assert.ok(delegated.systemPrompt.includes(body), "native CLI preserves the authored body beside resource context");
    assert.ok(delegated.systemPrompt.includes("Selected definition resource locations (pi-daddy, version 1)"));
    assert.ok(delegated.systemPrompt.includes(JSON.stringify(definitions.get("native-role")!.selectedResources)));
    assert.ok(!delegated.active.includes("fixture_remote"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
