/** Real parent SDK → public native tool → helper → real child Pi → exact native final. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, copyFile, writeFile, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import grants from "../../extensions/grants.ts";
import { createFixture } from "./fixture-harness.ts";
import { MODEL, PROVIDER, textStep, toolStep } from "./scripted-provider.ts";
const principal = process.env.PRINCIPAL_CANDIDATE;
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
test("all five native Principal phases execute verified delegated bodies and exact runtime choices", async () => {
  if (!principal) throw Error("PRINCIPAL_CANDIDATE is required");
  const keys = ["PI_DADDY_GRANT", "PI_DADDY_GATED", "PI_DADDY_HERDR", "PI_CODING_AGENT_DIR", "PI_DADDY_LEDGER", "PATH"];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    PI_DADDY_GRANT: "tool:*,agent:*,context:files",
    PI_DADDY_GATED: "",
    PI_DADDY_HERDR: "0",
  });
  delete process.env.PI_DADDY_LEDGER;
  let phase = "plan",
    definitionId: string | undefined;
  const phases = ["plan", "build", "review", "debug", "investigate"];
  const f = await createFixture({
    prepare: async (root) => {
      await mkdir(join(root, "agents"));
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "child-agent"));
      for (const p of ["package.json", "principal-agents.json"]) await copyFile(join(principal, p), join(root, p));
      for (const name of phases) {
        await mkdir(join(root, name));
        await copyFile(join(principal, name, "SKILL.md"), join(root, name, "SKILL.md"));
        await copyFile(join(principal, "agents", `principal-${name}.md`), join(root, "agents", `principal-${name}.md`));
      }
      const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
      const extension = fileURLToPath(new URL("./native-phase-extension.ts", import.meta.url));
      const path = join(root, "bin", "pi");
      await writeFile(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} -e ${quote(extension)} "$@"\n`);
      await chmod(path, 0o700);
      process.env.PATH = `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`;
      process.env.PI_CODING_AGENT_DIR = join(root, "child-agent");
      await writeFile(
        join(root, "child-agent", "settings.json"),
        JSON.stringify({
          defaultProjectTrust: "always",
          enableAnalytics: false,
          enableInstallTelemetry: false,
          compaction: { enabled: false },
          retry: { enabled: false },
          cacheWarming: "off",
        }),
      );
    },
    extension: (root) => (pi) => {
      grants(pi);
      pi.on("resources_discover", () => ({ skillPaths: phases.map((p) => join(root, p)) }));
    },
    next: (_r, i) =>
      i % 2
        ? textStep()
        : definitionId
          ? toolStep(
              "delegate",
              { agent: phase, definitionId, task: "Verify this phase without executing tools", thinking: "high" },
              `phase-${i}`,
            )
          : toolStep("delegate_describe", { agent: phase }, `describe-${i}`),
  });
  try {
    for (const name of phases) {
      phase = name;
      definitionId = undefined;
      await f.session.prompt("describe");
      let end = f.events.filter((e) => e.type === "tool_execution_end").at(-1);
      assert.equal(end.isError, false, JSON.stringify(end));
      const described = end.result.details;
      definitionId = described.definitionId;
      await f.session.prompt("execute");
      end = f.events.filter((e) => e.type === "tool_execution_end").at(-1);
      assert.equal(end.isError, false, JSON.stringify(end));
      assert.equal(end.result.details.final.state, "complete");
      assert.equal(end.result.details.cleanup.state, "settled");
      const observed = JSON.parse(end.result.content[0].text);
      assert.equal(observed.bodySha256, described.bodySha256);
      assert.equal(observed.bodyObserved, true);
      assert.equal(observed.model, `${PROVIDER}/${MODEL}`);
      assert.equal(observed.thinking, "high");
      assert.equal(observed.noExtensions, true);
      assert.equal(observed.noSkills, true);
      assert.ok(!observed.tools.includes("delegate"));
      assert.ok(observed.tools.includes("read"));
    }
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});
