// Offline real-Pi regression: PI_DADDY_SDK_NODE_MODULES selects an independently installed SDK.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerActivityTimeline } from "../extensions/activity-timeline.ts";
import {
  parseActivityTimeline,
  defaultActivityTimelinePath,
  activityTaskKey,
  detailForTimeline,
} from "../src/products/activity-timeline.ts";

const modules = process.env.PI_DADDY_SDK_NODE_MODULES;
if (!modules) throw Error("Set PI_DADDY_SDK_NODE_MODULES to a Pi 1.1 SDK node_modules directory");
const sdk = await import(pathToFileURL(join(modules, "@earendil-works/pi-coding-agent/dist/index.js")));
const ai = await import(pathToFileURL(join(modules, "@earendil-works/pi-ai/dist/index.js")));
const root = await mkdtemp(join(tmpdir(), "daddy-activity-sdk-"));
const agentDir = join(root, "agent");
await mkdir(agentDir, { mode: 0o700 });
const keys = [
  "PI_DADDY_ACTIVITY_ROOT",
  "PI_DADDY_ACTIVITY_TASK",
  "PI_DADDY_ACTIVITY_PATH",
  "PI_DADDY_ACTIVITY_TIMELINE",
  "PI_DADDY_ACTIVITY_CONTENT",
];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
for (const key of keys) delete process.env[key];
let session;
let calls = 0;
let entered;
const model = {
  id: "scripted",
  name: "scripted",
  api: "openai-completions",
  provider: "activity-fixture",
  baseUrl: "http://fixture.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const streamSimple = (_model, context, options) => {
  calls++;
  const text = context.messages
    .findLast((message) => message.role === "user")
    .content.map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  const stream = ai.createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: `answer:${text}` }],
    usage,
    timestamp: Date.now(),
    stopReason: "stop",
  };
  if (text.includes("cancel")) {
    options.signal.addEventListener(
      "abort",
      () => {
        message.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end();
      },
      { once: true },
    );
    entered();
  } else
    setImmediate(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
  return stream;
};
try {
  const settings = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
  });
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsStore: new ai.InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        registerActivityTimeline(pi, { activityRootId: "scripted-root" }, false);
        pi.registerProvider(model.provider, {
          baseUrl: model.baseUrl,
          api: model.api,
          apiKey: "fixture-only",
          models: [model],
          streamSimple,
        });
      },
      (pi) =>
        pi.on("message_end", (event) => {
          const message = event.message;
          if (!["user", "assistant"].includes(message.role)) return;
          return {
            message: {
              ...message,
              content: message.content.map((part) =>
                part.type === "text" ? { ...part, text: `${part.text}|finalized` } : part,
              ),
            },
          };
        }),
    ],
  });
  await loader.reload();
  const made = await sdk.createAgentSession({
    cwd: root,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: sdk.SessionManager.inMemory(root),
    tools: [],
  });
  session = made.session;
  await session.bindExtensions({ mode: "print" });
  await session.prompt("first");
  await session.prompt("second");
  const began = new Promise((resolveStarted) => {
    entered = resolveStarted;
  });
  const cancelled = session.prompt("cancel");
  await began;
  await session.abort();
  await cancelled;
  const path = defaultActivityTimelinePath(root);
  const timeline = parseActivityTimeline(await readFile(path, "utf8"));
  assert.equal(timeline.tasks.length, 3);
  const details = [];
  for (const task of timeline.tasks) {
    const key = activityTaskKey(task.rootId, task.id);
    details.push({
      prompt: (await detailForTimeline(path, key, "prompt")).text,
      final: (await detailForTimeline(path, key, "final")).text,
      status: task.status,
    });
  }
  assert.deepEqual(details, [
    { prompt: "first|finalized", final: "answer:first|finalized|finalized", status: "finished" },
    { prompt: "second|finalized", final: "answer:second|finalized|finalized", status: "finished" },
    { prompt: "cancel|finalized", final: "answer:cancel|finalized|finalized", status: "cancelled" },
  ]);
  console.log(
    "ACTIVITY_SDK_OK",
    JSON.stringify({
      sdk: (
        await import(pathToFileURL(join(modules, "@earendil-works/pi-coding-agent/package.json")), {
          with: { type: "json" },
        })
      ).default.version,
      scriptedResponses: calls,
      externalProviderCalls: 0,
      details,
    }),
  );
} finally {
  session?.dispose();
  for (const key of keys) saved[key] === undefined ? delete process.env[key] : (process.env[key] = saved[key]);
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "/daddy-activity-sdk-"));
  await rm(root, { recursive: true, force: true });
}
