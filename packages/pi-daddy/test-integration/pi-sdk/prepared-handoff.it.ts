/** Real Pi tools and a scripted local child: prepared identity survives argument correction and reuse. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, copyFile, writeFile, chmod, readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import grants from "../../extensions/grants.ts";
import { createFixture } from "./fixture-harness.ts";
import { textStep, toolStep } from "./scripted-provider.ts";

const principal = process.env.PRINCIPAL_CANDIDATE;
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";

test("prepared handoff corrects inputs, executes once and retains the same native operation", async () => {
  if (!principal) throw Error("PRINCIPAL_CANDIDATE is required");
  const workflow = (await import(pathToFileURL(join(principal, "extensions/workflow.ts")).href)).default;
  const keys = ["PI_DADDY_GRANT", "PI_DADDY_GATED", "PI_CODING_AGENT_DIR", "PI_DADDY_LEDGER", "PATH"];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, {
      PI_DADDY_GRANT: "tool:*,agent:*,context:files",
      PI_DADDY_GATED: "",
    });
    delete process.env.PI_DADDY_LEDGER;
    let nextCall = { name: "principal_workflow", args: { action: "snapshot" } as Record<string, unknown> };
    const sdkPath = join(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), "../../package.json");
    const sdkVersion = JSON.parse(await readFile(sdkPath, "utf8")).version;
    const f = await createFixture({
      sdkVersion,
      prepare: async (root) => {
        for (const directory of ["agents", "build", "bin", "child-agent"]) await mkdir(join(root, directory));
        for (const path of ["package.json", "principal-agents.json", "build/SKILL.md", "agents/principal-build.md"])
          await copyFile(join(principal, path), join(root, path));
        execFileSync("git", ["init", "-q", root]);
        await writeFile(
          join(root, ".git/info/exclude"),
          "/.principal/\n/.pi/\n/agent/\n/child-agent/\n/bin/\n/agents/\n/build/\n/package.json\n/principal-agents.json\n",
        );
        execFileSync("git", [
          "-C",
          root,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          "empty fixture baseline",
          "--allow-empty",
        ]);
        const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
        const extension = fileURLToPath(new URL("./native-phase-extension.ts", import.meta.url));
        const launcher = join(root, "bin", "pi");
        await writeFile(
          launcher,
          `#!/bin/sh\nprintf 'launch\\n' >> ${quote(join(root, "bin/launches"))}\nexec ${quote(process.execPath)} ${quote(cli)} -e ${quote(extension)} "$@"\n`,
        );
        await chmod(launcher, 0o700);
        process.env.PATH = `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`;
        process.env.PI_CODING_AGENT_DIR = join(root, "child-agent");
        await writeFile(
          join(root, "child-agent/settings.json"),
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
        workflow(pi);
        pi.on("resources_discover", () => ({ skillPaths: [join(root, "build")] }));
      },
      next: (_request, index) =>
        index % 2 ? textStep("fixture turn ended") : toolStep(nextCall.name, nextCall.args, `fixture-${index}`),
    });
    const invoke = async (name: string, args: Record<string, unknown>) => {
      nextCall = { name, args };
      await f.session.prompt("Execute the next deterministic fixture step.");
      const end = f.events.filter((event) => event.type === "tool_execution_end").at(-1);
      assert.equal(end?.toolName, name);
      return end;
    };
    const success = async (name: string, args: Record<string, unknown>) => {
      const end = await invoke(name, args);
      assert.equal(end.isError, false, JSON.stringify(end));
      return end.result.details;
    };
    const launches = async () => {
      try {
        return (await readFile(join(f.root, "bin/launches"), "utf8")).trim().split("\n").length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    };
    try {
      const snapshot = await success("principal_workflow", { action: "snapshot" });
      const prepared = await success("principal_workflow", {
        action: "prepare",
        task: "workshop-desk",
        step: "stage1",
        phase: "build",
        expectedCandidate: snapshot.candidate,
      });
      const described = await success("delegate_describe", { agent: prepared.delegationArguments.agent });
      assert.equal(described.binding.package, "principal-pi-skills");
      assert.equal(described.binding.phase, prepared.phase);
      // Either released ID helpers or newer task/step selectors must resolve the same prepared operation.
      const preparedStatus = await success("principal_workflow", prepared.statusArguments);
      assert.equal(preparedStatus.operation_id, prepared.operation_id);
      assert.equal(prepared.delegationArguments.operation_id, prepared.operation_id);
      const dispatch = {
        ...prepared.delegationArguments,
        ...described.delegationArguments,
        task: "Return the fixture's selected phase and runtime observations; no file edits or other tool calls.",
        thinking: "high",
      };
      const { agent: _agent, ...missingAgent } = dispatch;
      const refused = await invoke("delegate", missingAgent);
      assert.equal(refused.isError, true);
      assert.match(JSON.stringify(refused.result), /Missing delegation agent/);
      assert.match(JSON.stringify(refused.result), /This call stopped before operation admission/);
      assert.equal(await launches(), 0);
      const malformed = await invoke("principal_workflow", { action: "status", operationId: "workshop-desk-stage1" });
      assert.equal(malformed.isError, true);
      assert.equal(malformed.result.details.code, "OPERATION_ID_INVALID");
      const recovered = await success("principal_workflow", {
        action: "status",
        task: "workshop-desk",
        step: "stage1",
        attempt: 1,
      });
      assert.equal(recovered.operation_id, prepared.operation_id);
      assert.equal(recovered.state, "prepared");
      const result = await success("delegate", dispatch);
      assert.equal(result.final.state, "complete");
      assert.equal(result.cleanup.state, "settled");
      assert.equal(result.operation.operationId, prepared.operation_id);
      const child = JSON.parse(result.final.text);
      assert.equal(child.bodySha256, described.bodySha256);
      assert.equal(child.bodyObserved, true);
      assert.equal(await launches(), 1);
      const repeated = await success("delegate", dispatch);
      assert.equal(repeated.operation.reused, true);
      assert.equal(repeated.operation.executionId, result.operation.executionId);
      assert.equal(await launches(), 1);
      const complete = await success("principal_workflow", {
        ...prepared.statusArguments,
        action: "complete",
        disposition: "unverified",
      });
      assert.equal(complete.operation_id, prepared.operation_id);
      assert.equal(complete.resultRetained, true);
      assert.equal(complete.completionValid, true);
      assert.equal(complete.approval, false);
      const status = await success("principal_workflow", prepared.statusArguments);
      assert.equal(status.operation_id, prepared.operation_id);
      assert.equal(status.report.sha256, result.final.sha256);
      assert.equal((await readdir(join(f.root, ".principal/workflow"))).length, 1);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  } finally {
    for (const [key, value] of Object.entries(before))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});
