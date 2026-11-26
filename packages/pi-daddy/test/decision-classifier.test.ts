import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerWebDashboard } from "../extensions/web-dashboard.ts";
import { createClassifierSettings } from "../extensions/classifier-settings.ts";
import { registerClassifierShadow, shadowLog } from "../extensions/classifier-shadow.ts";
import type { GrantsSession } from "../extensions/session.ts";
import { readEcosystemConfig, saveEcosystemConfig } from "../src/kernel/ecosystem-config.ts";
import { classifyHarvestCandidate, createTurnHarvestTracker } from "../src/products/session-harvest.ts";
import { askClassifier } from "../src/products/decision-classifier.ts";
import { ecosystemPreferences } from "../extensions/ecosystem-preferences.ts";
import { editTerminalClassifier, editTerminalPreferences } from "../src/products/terminal-panel.ts";

function profile(t: TestContext) {
  const old = process.env.PI_CODING_AGENT_DIR;
  const key = process.env.OPENROUTER_API_KEY;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "decision-settings-"));
  const dir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
  });
}
const models = [
  { provider: "llama", id: "kev" },
  { provider: "other", id: "kev" },
];
test("terminal picker tests without saving and persists per-model settings through the dashboard controller", async (t) => {
  profile(t);
  const ctx = {
    modelRegistry: {
      getAvailableOfType: async () => models,
      getModelOfType: () => models[0],
      classify: async () => ({
        model: "kev",
        provider: "llama",
        stopReason: "stop",
        answers: { save: { type: "bool", probability: 0.61 } },
      }),
    },
  } as unknown as ExtensionContext;
  const settings = createClassifierSettings(
    () => ctx,
    () => true,
  );
  const prompts: string[] = [];
  const edit = (...answers: string[]) =>
    editTerminalClassifier(settings.action, async (label) => {
      prompts.push(label);
      assert.ok(answers.length);
      return answers.shift()!;
    });
  assert.match(await edit("1", "0.61", "suggest", "n", "test"), /probability 0.61, save/);
  assert.equal(readEcosystemConfig()?.harvest, undefined);
  assert.match(await edit("1", "0.61", "suggest", "y", "save"), /comparisons on/);
  assert.equal(settings.shadowModel(), "llama/kev");
  await edit("2", "0.9", "off", "n", "save");
  assert.deepEqual(readEcosystemConfig()?.harvest?.thresholds, { "llama/kev": 0.61, "other/kev": 0.9 });
  assert.equal(await edit("1", "", "", "", ""), "Cancelled.");
  assert.ok(prompts.includes("Save threshold, 0 to 1 [0.61]"));
  assert.equal(readEcosystemConfig()?.harvest?.classifier, "other/kev");
  await assert.rejects(edit("1", "1.1"), /threshold/);
  await edit("0", "0", "suggest", "save");
  assert.equal(readEcosystemConfig()?.harvest?.minConfidence, 0);
  assert.equal(readEcosystemConfig()?.harvest?.classifier, undefined);
});
test("an unavailable saved classifier explains reconnection before the terminal offers a test", async (t) => {
  profile(t);
  const model = "openrouter/typesafe/jev-1.14";
  saveEcosystemConfig({ harvest: { classifier: model, mode: "suggest" } });
  let connected = false;
  const ctx = {
    modelRegistry: {
      getAvailableOfType: async () => (connected ? [{ provider: "openrouter", id: "typesafe/jev-1.14" }] : []),
    },
  } as unknown as ExtensionContext;
  const settings = createClassifierSettings(
    () => ctx,
    () => true,
  );
  const prompts: string[] = [];
  const edit = (...answers: string[]) =>
    editTerminalClassifier(settings.action, async (label) => {
      prompts.push(label);
      assert.ok(answers.length);
      return answers.shift()!;
    });
  assert.match(await edit("1", ""), /\/login openrouter/);
  assert.match(prompts[0], /saved, unavailable/);
  assert.equal(prompts.length, 2);
  assert.equal(readEcosystemConfig()?.harvest?.mode, "suggest");
  await assert.rejects(settings.action({ action: "test", model, threshold: 0.53 }), /\/login openrouter/);
  await edit("1", "off");
  assert.equal(readEcosystemConfig()?.harvest?.mode, "off");
  connected = true;
  prompts.length = 0;
  await edit("");
  assert.match(prompts[0], /jev-1\.14 \(current\)/);
  assert.doesNotMatch(prompts[0], /unavailable|\/login/);
});
test("root picker remembers thresholds by full ID and applies the same boundary in test and harvest", async (t) => {
  profile(t);
  let value = 0.51;
  let digest = "";
  const ctx = {
    modelRegistry: {
      getAvailableOfType: async () => models,
      getModelOfType: (_: string, p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
      classify: async (m: (typeof models)[number], request: { state: { turn: string } }) => {
        digest = request.state.turn;
        return {
          provider: m.provider,
          model: m.id,
          stopReason: "stop",
          answers: { save: { type: "bool", probability: value } },
        };
      },
    },
  } as unknown as ExtensionContext;
  const ui = createClassifierSettings(
    () => ctx,
    () => true,
  );
  await ui.action({ action: "list" });
  const selection = { action: "save", model: "llama/kev", mode: "suggest", threshold: 0.51, shadow: false };
  await ui.action(selection);
  await ui.action({ ...selection, model: "other/kev", threshold: 0.67 });
  await ui.action(selection);
  assert.deepEqual(readEcosystemConfig()?.harvest?.thresholds, { "llama/kev": 0.51, "other/kev": 0.67 });
  assert.ok("save" in (await ui.action({ ...selection, action: "test" })));
  const tracker = createTurnHarvestTracker();
  tracker.reset("Check a packaged release with API_KEY=private-text");
  tracker.markReviewBlocker("entry point missing");
  const input = {
    signals: tracker.snapshot(),
    minConfidence: 0.51,
    classifier: { model: "llama/kev", registry: ctx.modelRegistry },
  };
  assert.equal((await classifyHarvestCandidate(input)).harvest, true);
  assert.ok(!digest.includes("private-text"));
  value = 0.509;
  assert.equal((await classifyHarvestCandidate(input)).harvest, false);
  value = NaN;
  await assert.rejects(classifyHarvestCandidate(input), /probability/);
  await assert.rejects(ui.action({ ...selection, threshold: 1.1 }), /Threshold/);
  await assert.rejects(
    classifyHarvestCandidate({ ...input, classifier: { ...input.classifier, model: "offline/kev" } }),
    /unavailable/,
  );
  await assert.rejects(
    createClassifierSettings(
      () => ctx,
      () => false,
    ).action({ action: "list" }),
    /root/,
  );
});

test("OpenRouter direct uses its decisions endpoint and validates the returned answer type", async (t) => {
  profile(t);
  process.env.OPENROUTER_API_KEY = "synthetic-fixture";
  let sent;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
    sent = JSON.parse(String(options.body));
    return Response.json({ model: "snapshot", answers: { route: { type: "choice", choice: "c1" } } });
  });
  const out = await askClassifier(
    {} as ExtensionContext["modelRegistry"],
    "openrouter-direct/typesafe/jev-1.14",
    { request: "synthetic" },
    { type: "choice", instructions: "choose", criteria: { c1: "verify" } },
    AbortSignal.timeout(1000),
  );
  assert.equal(out.value, "c1");
  assert.deepEqual(sent, {
    model: "typesafe/jev-1.14",
    state: { request: "synthetic" },
    questions: { route: { type: "choice", instructions: "choose", criteria: { c1: "verify" } } },
  });
});

test("shadow joins actual, blinded prediction and tool completion without invoking the recommended tool", async (t) => {
  profile(t);
  saveEcosystemConfig({ harvest: { classifier: "llama/kev" } });
  let enabled = false,
    calls = 0;
  const hooks: Record<string, (ev: unknown, ctx: unknown) => unknown> = {};
  const pi = {
    on: (name: string, fn: (typeof hooks)[string]) => {
      hooks[name] = fn;
    },
    getActiveTools: () => ["read", "edit"],
    getAllTools: () => ["read", "edit", "other"].map((name) => ({ name, description: name })),
  };
  const ctx = {
    sessionManager: { getSessionId: () => "sess" },
    modelRegistry: {
      getModelOfType: () => models[0],
      classify: async (
        _: unknown,
        input: { state: Record<string, unknown>; questions: { route: { criteria: Record<string, string> } } },
      ) => {
        calls++;
        assert.deepEqual(input.state, { request: "Fix the date parser.", previousTools: [] });
        assert.equal(
          Object.values(input.questions.route.criteria).some((v) => v.includes("other")),
          false,
        );
        return { stopReason: "stop", answers: { route: { type: "choice", choice: "c0" } } };
      },
    },
  };
  registerClassifierShadow(pi as unknown as ExtensionAPI, { depth: 0 } as GrantsSession, () =>
    enabled ? "llama/kev" : undefined,
  );
  const ev = { toolName: "read", toolCallId: "call1", args: {} };
  hooks.before_agent_start({ prompt: "Fix the date parser." }, ctx);
  hooks.tool_execution_start(ev, ctx);
  assert.equal(calls, 0);
  enabled = true;
  hooks.before_agent_start({ prompt: "Fix the date parser." }, ctx);
  assert.equal(hooks.tool_execution_start(ev, ctx), undefined);
  hooks.tool_execution_end({ ...ev, isError: false }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  const lines = readFileSync(shadowLog(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(lines.every((r) => r.toolCallId === "call1" && r.sessionId === "sess"));
  assert.equal(lines.find((r) => r.event === "prediction").predicted, "edit");
  assert.equal(lines.find((r) => r.event === "selection").actual, "read");
  assert.equal(lines.find((r) => r.event === "tool-ended").toolError, false);
  assert.equal(calls, 1);
});
test("specialist comparison considers only granted Principal definitions and survives provider failure", async (t) => {
  profile(t);
  saveEcosystemConfig({ harvest: { classifier: "llama/kev" } });
  const hooks: Record<string, (ev: unknown, ctx: unknown) => unknown> = {};
  const pi = {
    on: (name: string, fn: (typeof hooks)[string]) => {
      hooks[name] = fn;
    },
    getActiveTools: () => ["delegate"],
    getAllTools: () => [{ name: "delegate", description: "delegate" }],
  };
  const names = ["build", "review", "other", "foreign"];
  const session = {
    depth: 0,
    ownGrant: ["agent:build", "agent:review", "agent:foreign"],
    definitions: new Map(
      names.map((name) => [
        name,
        { name, description: name, binding: { package: name === "foreign" ? "other" : "principal-pi-skills" } },
      ]),
    ),
  };
  let options: Record<string, string> = {};
  const ctx = {
    sessionManager: { getSessionId: () => "test" },
    modelRegistry: {
      getModelOfType: () => models[0],
      classify: async (_: unknown, q: { questions: { route: { criteria: Record<string, string> } } }) => {
        options = q.questions.route.criteria;
        throw Error("offline fixture");
      },
    },
  };
  registerClassifierShadow(pi as unknown as ExtensionAPI, session as unknown as GrantsSession, () => "llama/kev");
  hooks.before_agent_start({ prompt: "Review the patch before release." }, ctx);
  const ev = { toolName: "delegate", toolCallId: "d1", args: { agent: "review" } };
  assert.equal(hooks.tool_execution_start(ev, ctx), undefined);
  hooks.tool_execution_end({ ...ev, isError: false }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(Object.keys(options), ["c0", "c1", "abstain"]);
  const rows = readFileSync(shadowLog(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(rows[0].candidates, ["build", "review"]);
  assert.equal(rows[0].actual, "review");
  assert.ok(rows.some((r) => r.event === "prediction-unavailable"));
  assert.ok(rows.some((r) => r.event === "tool-ended" && !r.toolError));
});

test("terminal saves the same Scout preference the browser reads, and rejects disconnected models", async (t) => {
  profile(t);
  const ctx = { model: models[0], modelRegistry: { getAvailable: () => models } } as unknown as ExtensionContext;
  const request = async (input: Record<string, unknown>) => ecosystemPreferences(ctx, input, true);
  const answers = ["1", "3"];
  await editTerminalPreferences(request, async () => answers.shift()!);
  const list = ecosystemPreferences(ctx, { action: "list" }, true);
  assert.equal(list.values?.scoutModel, "other/kev");
  assert.throws(
    () => ecosystemPreferences(ctx, { action: "save", key: "scoutModel", value: "fireworks/missing" }, true),
    /available/,
  );
  assert.throws(
    () => ecosystemPreferences(ctx, { action: "save", key: "scoutModel", value: "session" }, false),
    /Scout settings update/,
  );
  ecosystemPreferences(ctx, { action: "save", key: "autoRecall", value: false }, true);
  ecosystemPreferences(ctx, { action: "save", key: "scoutModel", value: "session" }, true);
  assert.equal(ecosystemPreferences(ctx, { action: "list" }, true).values?.autoRecall, false);
});

test("fresh interactive start repairs unreachable tiers with one choice and preserves connected tiers", async (t) => {
  profile(t);
  for (const key of ["PI_ECO_MODEL_FAST", "PI_ECO_MODEL_WORK", "PI_ECO_MODEL_STRONG", "PI_DADDY_DASHBOARD"]) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const { saveEcosystemConfig } = await import("../src/kernel/ecosystem-config.ts");
  saveEcosystemConfig({ models: { fast: "fireworks/missing", strong: "fireworks/other", work: "other/kev" } });
  const handlers = new Map<string, Function>();
  const pi = {
    on: (name: string, handler: Function) => {
      handlers.set(name, handler);
    },
    events: { on() {} },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  registerWebDashboard(pi, { depth: 0 } as GrantsSession);
  let prompts = 0;
  const ctx = {
    hasUI: true,
    model: models[1],
    modelRegistry: { getAvailable: () => models },
    ui: {
      select: async (label: string, options: string[]) => {
        prompts++;
        assert.match(label, /fireworks/);
        assert(!options.some((v) => v.includes("fireworks")));
        return options[0];
      },
    },
  };
  await handlers.get("session_start")!({}, ctx);
  assert.deepEqual(readEcosystemConfig()?.models, { fast: "session", strong: "session", work: "other/kev" });
  await handlers.get("session_start")!({}, ctx);
  assert.equal(prompts, 1);
});
