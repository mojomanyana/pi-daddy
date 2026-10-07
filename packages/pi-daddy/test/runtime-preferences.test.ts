import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDefinitionRuntime, authoredRuntimePreferences } from "../extensions/definition-runtime.ts";
import { runtimePairUnavailable } from "../src/kernel/model-preflight.ts";
import { parseSkillDefinition } from "../src/kernel/definitions.ts";
const rows = [
  { model: "first/model", thinking: "high" },
  { model: "second/model", thinking: "low" },
];
const base = {
  definition: "build",
  explicit: {},
  session: new Map(),
  settings: { defaults: {}, definitions: new Map() },
  piModel: "current/model",
  piThinking: "medium",
  authoredPreferences: rows,
};

test("whole needed preference list validates before selecting even a usable first row", () => {
  let probes = 0;
  assert.throws(
    () =>
      resolveDefinitionRuntime({
        ...base,
        authoredPreferences: [...rows, { model: "bad", thinking: "low" }],
        unavailable: () => {
          probes++;
          return undefined;
        },
      }),
    /runtime-preferences/,
  );
  assert.equal(probes, 0);
});
test("a fully fixed pair bypasses unused malformed preferences only", () => {
  const selected = resolveDefinitionRuntime({
    ...base,
    explicit: { model: "fixed/model", thinking: "off" },
    authoredPreferences: "malformed",
  });
  assert.equal(selected.model, "fixed/model");
  assert.equal(selected.thinking, "off");
  assert.equal(selected.modelSource, "explicit");
  assert.equal(selected.thinkingSource, "explicit");
  assert.throws(
    () => resolveDefinitionRuntime({ ...base, explicit: { model: "bad", thinking: "off" } }),
    /provider\/model/,
  );
});
test("partial overrides filter intact rows rather than cross-product values", () => {
  const selected = resolveDefinitionRuntime({ ...base, explicit: { thinking: "low" } });
  assert.equal(selected.model, "second/model");
  assert.equal(selected.thinking, "low");
  assert.equal(selected.modelSource, "authored");
  assert.equal(selected.thinkingSource, "explicit");
});
test("normal fallback fills unresolved fields without replacing an explicit winner", () => {
  const selected = resolveDefinitionRuntime({ ...base, explicit: { model: "fixed/model" } });
  assert.equal(selected.model, "fixed/model");
  assert.equal(selected.thinking, "medium");
  assert.equal(selected.modelSource, "explicit");
  assert.equal(selected.thinkingSource, "pi");
});
test("known unavailable preferences fall through in order before launch only", () => {
  const checked: string[] = [];
  const selected = resolveDefinitionRuntime({
    ...base,
    unavailable: ({ model }) => {
      checked.push(model!);
      return model === "first/model" ? "not registered" : undefined;
    },
  });
  assert.deepEqual(checked, ["first/model", "second/model"]);
  assert.equal(selected.model, "second/model");
});
test("explicit unsupported pair refuses instead of clamping or selecting a different row", () => {
  assert.throws(
    () =>
      resolveDefinitionRuntime({
        ...base,
        explicit: { model: "fixed/model", thinking: "max" },
        unavailable: () => "unsupported pair",
      }),
    /unsupported pair/,
  );
});
test("authored choices outrank ordinary defaults while project fields outrank authored rows", () => {
  const settings = { defaults: { model: "default/model", thinking: "off" as const }, definitions: new Map() };
  assert.equal(resolveDefinitionRuntime({ ...base, settings }).model, "first/model");
  settings.definitions.set("build", { model: "second/model" });
  const chosen = resolveDefinitionRuntime({ ...base, settings });
  assert.equal(chosen.modelSource, "definition");
  assert.equal(chosen.thinkingSource, "authored");
});
test("frontmatter retains ordered JSON without validating unused preferences early", () => {
  const parsed = parseSkillDefinition(
    "/skills/build/SKILL.md",
    `---\nname: build\ndescription: Build\nallowed-tools: read\nruntime-preferences: '${JSON.stringify(rows)}'\n---\nBody`,
  )!;
  assert.deepEqual(authoredRuntimePreferences(parsed.runtimePreferences), rows);
  assert.throws(() => authoredRuntimePreferences('[{"model":"p/m","thinking":"high","extra":true}]'), /exact/);
});
test("preflight reads only the exact model and passive auth state", () => {
  const checked: string[] = [];
  const registry = {
    find: (provider: string, id: string) => {
      checked.push(`${provider}/${id}`);
      return { reasoning: true, thinkingLevelMap: { max: null } };
    },
    getProviderAuthStatus: () => ({ configured: false }),
    getAll: () => assert.fail("no catalog scan"),
    getApiKey: () => assert.fail("no credential resolution"),
  };
  assert.equal(runtimePairUnavailable({ model: "custom/keyless", thinking: "high" }, registry), undefined);
  assert.match(runtimePairUnavailable({ model: "custom/keyless", thinking: "max" }, registry)!, /does not support/);
  assert.deepEqual(checked, ["custom/keyless", "custom/keyless"]);
  assert.equal(runtimePairUnavailable({ model: "p/m" }, { find: () => undefined }, true), undefined);
  assert.match(runtimePairUnavailable({ model: "p/m" }, { find: () => undefined })!, /session catalogue/);
});
