// Model-free real Pi SDK reload-isolation probe. Run with PI_DADDY_SDK_NODE_MODULES set to the matching SDK tree.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fixture = process.env.PI_DADDY_SDK_NODE_MODULES;
if (!fixture) throw new Error("set PI_DADDY_SDK_NODE_MODULES to the matching SDK node_modules directory");
const sdk = await import(pathToFileURL(join(fixture, "@earendil-works/pi-coding-agent/dist/index.js")).href);
const ai = await import(pathToFileURL(join(fixture, "@earendil-works/pi-ai/dist/index.js")).href);
const grants = (await import(pathToFileURL(join(process.cwd(), "extensions/grants.ts")).href)).default;
const root = await mkdtemp(join(tmpdir(), "pi-daddy-sdk-reload-"));
const keys = ["PI_GRANTS_GRANT", "PI_GRANTS_DEPTH", "PI_GRANTS_MAX_DEPTH", "PI_GRANTS_APPROVED", "PI_GRANTS_HERDR"];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const ui = notices => ({
  notify: message => notices.push(message), select: async () => undefined, confirm: async () => false, input: async () => undefined,
  onTerminalInput: () => () => {}, setStatus() {}, setWorkingMessage() {}, setWorkingVisible() {}, setWorkingIndicator() {},
  setHiddenThinkingLabel() {}, setWidget() {}, setFooter() {}, setHeader() {}, setTitle() {}, custom: async () => undefined,
  pasteToEditor() {}, setEditorText() {}, getEditorText: () => "", editor: async () => undefined, addAutocompleteProvider() {},
  setEditorComponent() {}, theme: {}, getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: false }),
  getToolsExpanded: () => false, setToolsExpanded() {},
});
const modelRuntime = await sdk.ModelRuntime.create({
  credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(), modelsPath: null,
  allowModelNetwork: false, refreshOnCreate: false,
});
async function make(name, grant, maxDepth) {
  Object.assign(process.env, { PI_GRANTS_GRANT: grant, PI_GRANTS_DEPTH: "0", PI_GRANTS_MAX_DEPTH: maxDepth, PI_GRANTS_HERDR: "0" });
  const cwd = join(root, name), agentDir = join(cwd, "agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } });
  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings, systemPromptOverride: () => "",
    agentsFilesOverride: () => ({ agentsFiles: [], diagnostics: [] }), skillsOverride: () => ({ skills: [], diagnostics: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }), extensionFactories: [{ name, factory: grants }],
  });
  await loader.reload();
  const made = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd), settingsManager: settings, modelRuntime });
  const notices = [];
  await made.session.bindExtensions({ mode: "print", uiContext: ui(notices) });
  return { ...made, notices };
}
try {
  for (const key of keys) delete process.env[key];
  const a = await make("A", "tool:read", "1");
  assert(a.notices.some(message => message.includes("depth 0/1")), "A session_start must report its root");
  const b = await make("B", "tool:read,tool:bash,tool:delegate", "2");
  assert(b.notices.some(message => message.includes("depth 0/2")), "B session_start must report its distinct root");

  for (let reload = 1; reload <= 2; reload++) {
    a.notices.length = 0;
    await a.session.reload();
    assert(a.notices.some(message => message.includes("depth 0/1, holding [tool:read]")), `A reload ${reload} must retain A's root depth and grant`);
    assert.equal(a.session.getActiveToolNames().includes("delegate"), false, `A reload ${reload} must not activate B's delegation authority`);
    assert.equal(process.env.PI_GRANTS_GRANT, "tool:read", `A reload ${reload} must publish only A's child grant`);
    assert.equal(process.env.PI_GRANTS_DEPTH, "1", `A reload ${reload} must publish A's child depth`);
    assert.equal(process.env.PI_GRANTS_MAX_DEPTH, "1", `A reload ${reload} must publish A's child limit`);
  }
  console.log("SDK_RELOAD_ISOLATION_OK", JSON.stringify({ sdk: (await import(pathToFileURL(join(fixture, "@earendil-works/pi-coding-agent/package.json")).href, { with: { type: "json" } })).default.version, reloads: 2, providerRequests: 0 }));
  a.session.dispose();
  b.session.dispose();
} finally {
  for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
  await rm(root, { recursive: true, force: true });
}
