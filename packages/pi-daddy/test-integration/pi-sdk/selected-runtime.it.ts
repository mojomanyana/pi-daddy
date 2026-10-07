import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import grants from "../../extensions/grants.ts";
import { createFixture } from "./fixture-harness.ts";
import { textStep, toolStep } from "./scripted-provider.ts";
const principal = process.env.PRINCIPAL_CANDIDATE;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture() {
  if (!principal) throw Error("PRINCIPAL_CANDIDATE must name the reviewed generated candidate");
  const env = { PI_DADDY_GRANT: "tool:delegate,agent:build,tool:read", PI_DADDY_HERDR: "0" };
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let nextTool = "delegate_describe",
    args: Record<string, unknown> = { agent: "build" };
  const f = await createFixture({
    prepare: async (root) => {
      for (const sub of ["build", "agents"]) await mkdir(join(root, sub));
      for (const path of ["package.json", "principal-agents.json", "build/SKILL.md", "agents/principal-build.md"])
        await copyFile(join(principal, path), join(root, path));
    },
    extension: (root) => (pi) => {
      grants(pi);
      pi.on("resources_discover", () => ({ skillPaths: [join(root, "build")] }));
    },
    next: (_r, i) => (i % 2 === 0 ? toolStep(nextTool, args, `call-${i}`) : textStep()),
  });
  return {
    ...f,
    setTool: (name: string, values: Record<string, unknown>) => {
      nextTool = name;
      args = values;
    },
    close: async () => {
      await f.close();
      for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    },
  };
}
test("actual runtime describes selected generated body, holds snapshot, and refuses a stale id after reload", async () => {
  const f = await fixture();
  try {
    await f.session.prompt("describe generated build");
    const end = () => f.events.filter((e) => e.type === "tool_execution_end").at(-1);
    assert.equal(end().isError, false, JSON.stringify(end()));
    const id = end().result.details.definitionId;
    assert.deepEqual(end().result.details.binding, { package: "principal-pi-skills", phase: "build" });
    const body = (await readFile(join(f.root, "agents/principal-build.md"), "utf8")).replace(
      /^---\r?\n[\s\S]*?\r?\n---\r?\n?/,
      "",
    );
    assert.equal(end().result.details.bodySha256, hash(body));
    const path = join(f.root, "agents/principal-build.md");
    await writeFile(path, (await readFile(path, "utf8")) + "changed");
    await f.session.prompt("same snapshot");
    assert.equal(end().result.details.definitionId, id);
    await f.session.reload();
    f.setTool("delegate", { agent: "build", definitionId: id, task: "must not launch" });
    await f.session.prompt("old id refused");
    assert.equal(end().isError, true);
    assert.match(JSON.stringify(end()), /snapshot changed|unavailable/);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
