import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { textStep, toolStep } from "./scripted-provider.ts";
import { createFixture } from "./fixture-harness.ts";

async function skill(root: string, relative: string, name: string, body = "generation-one") {
  const file = join(root, relative, "SKILL.md");
  await mkdir(join(root, relative), { recursive: true });
  await writeFile(file, `---\nname: ${name}\ndescription: Fixture ${name}\n---\n${body}\n`);
  return file;
}

// Breaks if getCommands stops exposing selected skill identity or discovery/reload ordering changes.
test("first-request selected skills include discovered definitions and exclude disabled paths; reload invalidates old contexts", async () => {
  const starts: string[][] = [];
  const snapshots: any[] = [];
  const old: any[] = [];
  let generation = 0;
  const fixture = await createFixture({
    settings: (root) => ({ enableSkillCommands: false, skills: ["-" + join(root, "agent/skills/disabled")] }),
    next: (_request, index) => (index % 2 === 0 ? toolStep("selected_definition", {}) : textStep()),
    prepare: async (root) => {
      await skill(root, "agent/skills/selected", "selected");
      await skill(root, "agent/skills/disabled", "disabled");
      await skill(root, "generated/contributed", "contributed");
    },
    extension: (root) => (pi) => {
      const currentGeneration = ++generation;
      let snapshot: any;
      pi.registerTool({
        name: "selected_definition",
        label: "selected definition",
        description: "execute a selected immutable definition",
        parameters: Type.Object({}),
        async execute() {
          const selected = snapshot.find((item: any) => item.name === "skill:contributed");
          return {
            content: [{ type: "text", text: selected.body }],
            details: { sha256: selected.sha256, generation: selected.generation },
          };
        },
      });
      pi.on("session_start", (_e, ctx) => {
        old.push({ pi, ctx });
        starts.push(
          pi
            .getCommands()
            .filter((c) => c.source === "skill")
            .map((c) => c.name),
        );
      });
      pi.on("resources_discover", () => ({ skillPaths: [join(root, "generated/contributed")] }));
      pi.on("before_agent_start", () => {
        snapshot ??= pi
          .getCommands()
          .filter((c) => c.source === "skill")
          .map((c) => {
            const bytes = readFileSync(c.sourceInfo!.path);
            return Object.freeze({
              name: c.name,
              path: c.sourceInfo!.path,
              body: bytes.toString("utf8"),
              sha256: createHash("sha256").update(bytes).digest("hex"),
              generation: currentGeneration,
            });
          });
        snapshots.push(snapshot);
      });
    },
  });
  try {
    assert.deepEqual(starts[0], ["skill:selected"]);
    await fixture.session.prompt("snapshot one");
    assert.deepEqual(snapshots[0].map((s: any) => s.name).sort(), ["skill:contributed", "skill:selected"]);
    assert.equal(
      snapshots[0].find((s: any) => s.name === "skill:contributed").path,
      join(fixture.root, "generated/contributed/SKILL.md"),
    );
    await skill(fixture.root, "generated/contributed", "contributed", "generation-two");
    await fixture.session.prompt("same generation");
    assert.equal(snapshots[0], snapshots[1]);
    await fixture.session.reload();
    assert.throws(() => old[0].ctx.getSystemPrompt(), /stale/);
    assert.throws(() => old[0].pi.getCommands(), /stale/);
    await fixture.session.prompt("new generation");
    assert.notEqual(
      snapshots[0].find((s: any) => s.name === "skill:contributed").sha256,
      snapshots[2].find((s: any) => s.name === "skill:contributed").sha256,
    );
    assert.equal(snapshots[2][0].generation, 2);
    const executions = fixture.events.filter(
      (e) => e.type === "tool_execution_end" && e.toolName === "selected_definition",
    );
    assert.equal(executions.length, 3);
    assert.deepEqual(
      executions.map((e) => e.result.details.generation),
      [1, 1, 2],
    );
    assert.equal(executions[0].result.content[0].text, executions[1].result.content[0].text);
    assert.notEqual(executions[1].result.content[0].text, executions[2].result.content[0].text);
    assert.ok(snapshots.every((items) => !items.some((s: any) => s.name === "skill:disabled")));
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

// Breaks if local status access resolves credentials or conflates absent provider identity.
test("configured-auth status is passive metadata with separate provider identity", async () => {
  let statuses: any;
  const fixture = await createFixture({
    extension: () => (pi) => {
      pi.on("before_agent_start", (_e, ctx) => {
        const before = [...fixture.credentialCalls];
        statuses = {
          configured: ctx.modelRegistry.getProviderAuthStatus("p01-scripted"),
          missing: ctx.modelRegistry.getProviderAuthStatus("p01-does-not-exist"),
          missingProvider: ctx.modelRegistry.getProvider("p01-does-not-exist"),
          knownProvider: ctx.modelRegistry.getProvider("anthropic")?.id,
          hasConfigured: ctx.modelRegistry.hasConfiguredAuth(ctx.model!),
          error: ctx.modelRegistry.getError(),
        };
        assert.deepEqual(fixture.credentialCalls, before);
      });
    },
  });
  try {
    await fixture.session.prompt("auth metadata");
    assert.equal(statuses.configured.configured, true);
    assert.deepEqual(statuses.missing, { configured: false });
    assert.equal(statuses.missingProvider, undefined);
    assert.equal(statuses.knownProvider, "anthropic");
    assert.equal(statuses.hasConfigured, true);
    assert.equal(statuses.error, undefined);
    assert.equal(fixture.requests.length, 1);
  } finally {
    await fixture.close();
  }
});
