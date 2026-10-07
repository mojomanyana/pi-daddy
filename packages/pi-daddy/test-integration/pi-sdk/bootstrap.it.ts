import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { createFixture } from "./fixture-harness.ts";
import { textStep, toolStep } from "./scripted-provider.ts";

// Opt-in real package source: never hardcode a developer checkout or download a package.
const principalRoot = process.env.PRINCIPAL_PACKAGE_ROOT;
const options = { skip: principalRoot ? false : "set PRINCIPAL_PACKAGE_ROOT to the actual Principal candidate" };
const packageRoot = (root: string) => join(root, "agent/skills/principal");
const count = (messages: unknown[]) =>
  messages.filter((message) => {
    const text = JSON.stringify(message);
    return text.includes("<IMPORTANT>") && text.includes("principal-pi-skills bootstrap");
  }).length;
async function fixture({ disabled = false, missing = false, tools = false } = {}) {
  return createFixture({
    settings: (root) => ({
      enableSkillCommands: false,
      skills: disabled ? ["-" + join(packageRoot(root), "plan")] : [],
    }),
    prepare: async (root) => {
      const destination = packageRoot(root);
      for (const directory of ["extensions", "bootstrap", "plan"])
        await mkdir(join(destination, directory), { recursive: true });
      for (const relative of [
        "extensions/bootstrap.ts",
        "plan/SKILL.md",
        ...(missing ? [] : ["bootstrap/BOOTSTRAP.md"]),
      ]) {
        await copyFile(join(principalRoot!, relative), join(destination, relative));
      }
    },
    next: (_request, index) => (tools && index === 0 ? toolStep("bootstrap_probe", {}) : textStep()),
    extension: (root) => async (pi) => {
      const extension = await import(pathToFileURL(join(packageRoot(root), "extensions/bootstrap.ts")).href);
      extension.default(pi);
      if (tools)
        pi.registerTool({
          name: "bootstrap_probe",
          label: "bootstrap probe",
          description: "model-free tool iteration",
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: "probe complete" }], details: {} };
          },
        });
    },
  });
}

test(
  "real Principal bootstrap reaches both ordinary requests and tool continuation without durable insertion",
  options,
  async () => {
    const f = await fixture({ tools: true });
    try {
      await f.session.prompt("quoted principal-pi-skills bootstrap is user content");
      await f.session.prompt("second ordinary request");
      assert.equal(f.requests.length, 3);
      for (const request of f.requests) assert.equal(count(request.context.messages), 1);
      assert.ok(!JSON.stringify(f.manager.getBranch()).includes("<IMPORTANT>"));
      assert.equal(
        f.events.filter((event) => event.type === "tool_execution_end" && event.toolName === "bootstrap_probe").length,
        1,
      );
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);

test("real resource disabling does not revive Principal bootstrap", options, async () => {
  const f = await fixture({ disabled: true });
  try {
    await f.session.prompt("disabled package skill");
    assert.equal(count(f.requests[0].context.messages), 0);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("real SDK reload replaces the Principal registration content cache", options, async () => {
  const f = await fixture();
  try {
    await f.session.prompt("generation one");
    const path = join(packageRoot(f.root), "bootstrap/BOOTSTRAP.md");
    await writeFile(path, readFileSync(path, "utf8") + "\nRELOADED_FIXTURE_CONTENT\n");
    await f.session.prompt("same generation");
    assert.equal(count(f.requests[1].context.messages), 1);
    assert.ok(!JSON.stringify(f.requests[1].context.messages).includes("RELOADED_FIXTURE_CONTENT"));
    await f.session.reload();
    await f.session.prompt("reloaded generation");
    assert.equal(count(f.requests[2].context.messages), 1);
    assert.ok(JSON.stringify(f.requests[2].context.messages).includes("RELOADED_FIXTURE_CONTENT"));
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("real bootstrap read failure stays inactive until a deliberate SDK reload", options, async () => {
  const f = await fixture({ missing: true });
  try {
    await f.session.prompt("missing bootstrap");
    assert.equal(count(f.requests[0].context.messages), 0);
    await copyFile(join(principalRoot!, "bootstrap/BOOTSTRAP.md"), join(packageRoot(f.root), "bootstrap/BOOTSTRAP.md"));
    await f.session.prompt("no implicit retry");
    assert.equal(count(f.requests[1].context.messages), 0);
    await f.session.reload();
    await f.session.prompt("explicit retry");
    assert.equal(count(f.requests[2].context.messages), 1);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
test("real compacted context keeps the summary before Principal routing after refresh", options, async () => {
  const f = await fixture();
  try {
    await f.session.prompt("before compaction");
    f.manager.appendCompaction("COMPACTION_FIXTURE_SUMMARY quoting principal-pi-skills bootstrap", null, 100);
    f.session.refreshContext();
    await f.session.prompt("resume compacted branch");
    const messages = f.requests.at(-1)!.context.messages;
    const summaryIndex = messages.findIndex((message) =>
      JSON.stringify(message).includes("COMPACTION_FIXTURE_SUMMARY"),
    );
    const routingIndex = messages.findIndex((message) => count([message]) === 1);
    assert.equal(messages[0].role, "system");
    assert.equal(summaryIndex, 1);
    assert.equal(routingIndex, 2);
    assert.equal(count(messages), 1);
    assert.ok(!JSON.stringify(f.manager.getBranch()).includes("<IMPORTANT>"));
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
