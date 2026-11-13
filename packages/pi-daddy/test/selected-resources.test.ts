import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { selectedDefinitions } from "../src/kernel/selected-definitions.ts";
import { planDelegation } from "../src/kernel/delegate.ts";
import { selectedResourcePrompt } from "../src/kernel/selected-resources.ts";
import { assertDefinitionIdentity, registerDefinitionDescribe } from "../extensions/definition-describe.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

test("selected inline locations describe and reach the child separately from the exact body without new grants", async () => {
  const root = await tempDir("definition-locations-");
  const directory = join(root, "review-local");
  await mkdir(directory);
  const path = join(directory, "SKILL.md");
  const bytes =
    "---\nname: review-local\ndescription: review\nallowed-tools: read\n---\nUse ./reference.md when needed.";
  await writeFile(path, bytes);
  const { definitions } = await selectedDefinitions([
    { source: "skill", name: "skill:review-local", sourceInfo: { path } },
  ]);
  const d = definitions.get("review-local")!;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(d.selectedResources, {
    version: 1,
    selectedSkill: { path, sha256 },
    definition: { path, sha256 },
    resourceDirectory: directory,
  });
  const context = { ownGrant: ["agent:review-local", "tool:read"], definitions, depth: 0, maxDepth: 2, gated: [] };
  const plan = planDelegation({ agent: "review-local", task: "Review" }, context);
  assert.equal(plan.ok, true);
  const appended = plan.args.flatMap((arg, index) => (arg === "--append-system-prompt" ? [plan.args[index + 1]] : []));
  assert.deepEqual(appended, [d.body, selectedResourcePrompt(d.selectedResources)]);
  assert.deepEqual(plan.effective, ["tool:read"]);
  assert.ok(plan.args.includes("--no-skills"));
  assert.ok(!plan.args.includes("--skill"));
  assert.equal(plan.definitionDigest?.sha256, createHash("sha256").update(d.body).digest("hex"));
  let tool: any;
  const session = { ownGrant: context.ownGrant, definitions, ownerBound: true, mayDelegate: true };
  registerDefinitionDescribe(
    {
      registerTool: (value: unknown) => {
        tool = value;
      },
    } as never,
    session as never,
  );
  const described = await tool.execute("describe", { agent: "review-local" });
  assert.deepEqual(described.details.selectedResources, d.selectedResources);
  assert.equal(JSON.parse(described.content[0].text).definitionId, d.definitionId);
  assertDefinitionIdentity(session as never, { agent: "review-local", definitionId: d.definitionId });
  assert.throws(
    () => assertDefinitionIdentity(session as never, { agent: "review-local", definitionId: "stale" }),
    /snapshot/,
  );
  await writeFile(path, bytes.replace("reference.md", "changed.md"));
  assert.equal(
    plan.args.includes(selectedResourcePrompt(d.selectedResources)!),
    true,
    "selected snapshot is not re-read during dispatch",
  );
  const changed = await selectedDefinitions([{ source: "skill", name: "skill:review-local", sourceInfo: { path } }]);
  assert.notEqual(changed.definitions.get("review-local")?.definitionId, d.definitionId);
});

test("tools-only and legacy unselected definitions do not invent resource locations", () => {
  const plan = planDelegation(
    { tools: ["read"], task: "read" },
    { ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [] },
  );
  assert.equal(plan.ok, true);
  assert.ok(!plan.args.includes("--append-system-prompt"));
  assert.equal(selectedResourcePrompt(undefined), undefined);
});
