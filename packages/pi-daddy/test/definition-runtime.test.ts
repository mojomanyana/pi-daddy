import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  definitionRuntimeSettingsFrom,
  resolveDefinitionRuntime,
  type DefinitionRuntimeSettings,
} from "../extensions/definition-runtime.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

const settings: DefinitionRuntimeSettings = {
  defaults: { model: "global/model", thinking: "low" },
  definitions: new Map([["review", { model: "definition/model", thinking: "medium" }]]),
};

test("definition runtime selection follows explicit, session, definition, global, then pi order", () => {
  const session: DefinitionRuntimeSettings["definitions"] = new Map([
    ["review", { model: "session/model", thinking: "high" }],
  ]);
  const input = { definition: "review", session, settings, piModel: "pi/model" };
  assert.deepEqual(resolveDefinitionRuntime({ ...input, explicit: { model: "explicit/model", thinking: "xhigh" } }), {
    model: "explicit/model",
    modelSource: "explicit",
    thinking: "xhigh",
    thinkingSource: "explicit",
  });
  assert.deepEqual(resolveDefinitionRuntime({ ...input, explicit: {} }), {
    model: "session/model",
    modelSource: "session",
    thinking: "high",
    thinkingSource: "session",
  });
  assert.deepEqual(resolveDefinitionRuntime({ ...input, session: new Map(), explicit: {} }), {
    model: "definition/model",
    modelSource: "definition",
    thinking: "medium",
    thinkingSource: "definition",
  });
  assert.deepEqual(resolveDefinitionRuntime({ ...input, definition: "build", session: new Map(), explicit: {} }), {
    model: "global/model",
    modelSource: "global",
    thinking: "low",
    thinkingSource: "global",
  });
  assert.deepEqual(
    resolveDefinitionRuntime({
      definition: "build",
      session: new Map(),
      settings: { defaults: {}, definitions: new Map() },
      piModel: "pi/model",
      explicit: {},
    }),
    { model: "pi/model", modelSource: "pi", thinking: undefined, thinkingSource: "pi" },
  );
});

test("advisor effort sits below explicit and session and above definition", () => {
  const session: DefinitionRuntimeSettings["definitions"] = new Map([["review", { thinking: "high" }]]);
  const base = { definition: "review", settings, piModel: "pi/model" };
  assert.equal(
    resolveDefinitionRuntime({ ...base, session, explicit: {}, advisorThinking: "xhigh" }).thinkingSource,
    "session",
  );
  assert.equal(
    resolveDefinitionRuntime({ ...base, session: new Map(), explicit: { thinking: "off" }, advisorThinking: "xhigh" })
      .thinkingSource,
    "explicit",
  );
  assert.deepEqual(resolveDefinitionRuntime({ ...base, session: new Map(), explicit: {}, advisorThinking: "xhigh" }), {
    model: "definition/model",
    modelSource: "definition",
    thinking: "xhigh",
    thinkingSource: "advisor",
  });
});

test("settings parse per-definition and global model/thinking values", () => {
  assert.deepEqual(
    definitionRuntimeSettingsFrom({
      defaults: { model: "openai-codex:gpt-5.6-sol", thinking: "low" },
      definitions: [
        { name: "review", declares: [], spawnable: true, model: "anthropic:claude-opus-4-6", thinking: "high" },
      ],
    }),
    {
      defaults: { model: "openai-codex/gpt-5.6-sol", thinking: "low" },
      definitions: new Map([["review", { model: "anthropic/claude-opus-4-6", thinking: "high" }]]),
    },
  );
});

test("a session loads committed definition runtime settings and starts with no overrides", async () => {
  const cwd = await tempDir("definition-runtime-session-");
  await mkdir(join(cwd, ".pi", "pi-daddy"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "pi-daddy", "settings.json"),
    JSON.stringify({ defaults: { thinking: "low" }, definitions: [{ name: "review", model: "p:m" }] }),
  );
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    const session = createGrantsSession(undefined);
    assert.deepEqual(session.definitionRuntimeSettings.defaults, { thinking: "low" });
    assert.deepEqual(session.definitionRuntimeSettings.definitions.get("review"), { model: "p/m" });
    assert.equal(session.definitionRuntimeOverrides.size, 0);
  } finally {
    process.chdir(previous);
  }
});
