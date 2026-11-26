// Run in the disposable CI profile with the separately installed Pi CLI on PATH.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import release from "../src/products/ecosystem-release.json" with { type: "json" };

const profile = process.env.PI_CODING_AGENT_DIR;
const cli = process.env.DADDY_TEST_PI_CLI;
assert.ok(profile && cli, "Set an empty PI_CODING_AGENT_DIR and DADDY_TEST_PI_CLI");
const settings = join(profile, "settings.json");
assert.ok(!existsSync(settings), "This check needs an empty profile");
mkdirSync(profile, { recursive: true });
const managed = join(profile, "npm");
const modules = join(managed, "node_modules");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const daddy = join(modules, "pi-daddy");
const version = () => json(join(daddy, "package.json")).version;
const setup = () => execFileSync(process.execPath, [join(daddy, "dist/cli.js"), "setup"], { stdio: "inherit" });
const pi = (...args) => execFileSync(process.execPath, [cli, ...args], { stdio: "inherit" });
const expected = release.normalCliInstalls.map((name) => "npm:" + name).sort();
const sources = () => json(settings).packages.map((p) => typeof p === "string" ? p : p.source).sort();
const filters = { extensions: ["extensions/grants.ts"] };

pi("install", "npm:pi-daddy");
const current = version();
setup();
assert.deepEqual(sources(), expected);
const config = json(settings);
config.packages = release.normalCliInstalls.map((name) => {
  const installed = json(join(modules, name, "package.json")).version;
  const source = "npm:" + name + "@" + installed;
  return name === "pi-daddy" ? { source, ...filters } : source;
});
writeFileSync(settings, JSON.stringify(config));
setup();
assert.deepEqual(sources(), expected);
assert.deepEqual(json(settings).packages.find((p) => p.source === "npm:pi-daddy"), { source: "npm:pi-daddy", ...filters });

// Restore older bytes without changing Pi's managed source. A no-op update cannot pass.
const previous = "1.1.1";
assert.notEqual(current, previous);
execFileSync("npm", ["install", "--no-audit", "--no-fund", "pi-daddy@" + previous], {
  cwd: managed, stdio: "inherit", shell: process.platform === "win32",
});
assert.equal(version(), previous);
pi("update", "--extensions");
assert.equal(version(), current);
assert.deepEqual(sources(), expected);

process.env.PI_OFFLINE = "1";
const sdkUrl = pathToFileURL(resolve(dirname(cli), "../index.js")).href;
const sdk = await import(sdkUrl);
const client = new sdk.RpcClient({ cliPath: cli, args: ["--offline", "--no-session", "--no-approve"] });
const notices = [];
client.onEvent((event) => {
  if (event.type === "extension_ui_request" && event.method === "notify") notices.push(event.message);
});
try {
  await client.start();
  const commands = async () => (await client.getCommands()).map((c) => c.name);
  assert.ok((await commands()).includes("bookie-task"));
  const first = (await client.getState()).sessionId;
  await client.newSession();
  const next = (await client.getState()).sessionId;
  assert.ok(first && next && first !== next);
  assert.ok((await commands()).includes("bookie-task"));
  assert.equal(await client.prompt("/bookie-distill"), "handled");
  assert.ok(notices.some((n) => n.includes("active managed project memory session") || n.includes("No managed Bookie vault")));
  assert.equal(await client.prompt("/dashboard"), "handled");
  const message = notices.find((n) => n.includes("Browser: "));
  assert.ok(message, "Dashboard command must return its URL");
  const url = new URL(message.match(/Browser: (\S+)/)[1]);
  url.pathname = "/api/state";
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok);
  assert.equal((await response.json()).sessionId, next);
  await client.prompt("/dashboard stop");
} finally {
  await client.stop();
}

const { session } = await sdk.createAgentSession({ agentDir: profile, sessionManager: sdk.SessionManager.inMemory() });
try {
  await session.bindExtensions({ mode: "rpc" });
  assert.ok(session.getAllTools().some((tool) => tool.name === "research_sources"), "Scout tools must load");
  const runner = session.extensionRunner;
  await runner.emit({ type: "tool_execution_start", toolName: "edit", toolCallId: "edit", args: { path: "fixture.ts" } });
  await runner.emit({ type: "tool_execution_end", toolName: "edit", toolCallId: "edit", result: { content: [] }, isError: false });
  const settlement = await runner.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, () => ({
    contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true,
  }));
  assert.ok(settlement.entries.some((entry) => entry.customType === "principal-verify-before-settle"));

} finally {
  session.dispose();
}
// Exercise Bookie's installed receipt lifecycle with synthetic data and its real reset callback.
const bookieHooks = new Map();
// A standalone Node import needs the Pi SDK alias that the extension loader supplies in the real session above.
const sdkAlias = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "@earendil-works/pi-coding-agent" ? sdkUrl : specifier, context);
  },
});
let createBookieContextFilter;
try {
  ({ createBookieContextFilter } = await import(pathToFileURL(join(modules, "pi-bookie/dist/context-filter.js")).href));
} finally {
  sdkAlias.deregister();
}
const filter = createBookieContextFilter({ on: (event, handler) => bookieHooks.set(event, handler) });
const content = [{ type: "text", text: "bundle fixture receipt" }];
const message = { role: "toolResult", toolCallId: "fixture", toolName: "bookie_read", content };
filter.remember("fixture", { content }, async () => {});
const replay = async () => (await bookieHooks.get("context")({ messages: [message] })).messages[0].content;
assert.deepEqual(await replay(), content);
await bookieHooks.get("session_start")();
assert.match((await replay())[0].text, /reference-only/);

const { resolveHarnessCliCommand } = await import(pathToFileURL(join(daddy, "dist/products/session-harvest.js")).href);
const harness = resolveHarnessCliCommand({ PATH: "", PI_CODING_AGENT_DIR: profile });
assert.ok(harness, "The installed Daddy must discover Harness with no global CLI");
execFileSync(harness.cmd, [...harness.argsPrefix, "--help"], { stdio: "pipe" });
console.log("Clean install, migration, update, dashboard and companion checks passed.");
