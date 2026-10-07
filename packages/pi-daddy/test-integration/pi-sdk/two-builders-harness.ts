/** Disposable real SDK/CLI pilot support; never changes the host's repository/configuration. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, copyFile, writeFile, chmod, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import grants from "../../extensions/grants.ts";
import { createFixture } from "./fixture-harness.ts";
import { textStep, toolStep } from "./scripted-provider.ts";

export const principal = process.env.PRINCIPAL_CANDIDATE ?? process.env.PRINCIPAL_PACKAGE_ROOT;
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const check = (cwd: string, ...tests: string[]) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--test", ...tests], { cwd, encoding: "utf8", env });
};
export async function pilot() {
  if (!principal) throw Error("PRINCIPAL_CANDIDATE is required");
  const original = { ...process.env };
  for (const key of Object.keys(process.env)) if (/^PI_(DADDY|GRANTS)_/.test(key)) delete process.env[key];
  Object.assign(process.env, {
    PI_DADDY_GRANT: "tool:*,agent:*,workspace:*",
    PI_DADDY_GATED: "",
    PI_DADDY_HERDR: "0",
    PI_DADDY_FANOUT: "2",
  });
  let command = { name: "delegate_describe", args: { agent: "build" } as unknown };
  let issued = false,
    base = "",
    repo = "",
    jobs = "",
    launches = "",
    runner = "";
  const f = await createFixture({
    prepare: async (root) => {
      repo = join(root, "repo");
      jobs = join(root, "jobs");
      launches = join(root, "launches.jsonl");
      runner = join(root, "runner.mjs");
      for (const dir of [
        repo,
        jobs,
        join(root, "agents"),
        join(root, "build"),
        join(root, "bin"),
        join(root, "child-agent"),
        join(root, "native-results"),
      ])
        await mkdir(dir);
      git(repo, "init", "-q", "-b", "codex/pilot-integration");
      git(repo, "config", "user.name", "Pilot Fixture");
      git(repo, "config", "user.email", "pilot@example.invalid");
      await writeFile(join(repo, "producer.cjs"), "exports.payload=()=>({count:2});\n");
      await writeFile(join(repo, "consumer.cjs"), "exports.render=x=>x.count+1;\n");
      await writeFile(
        join(repo, "merged.test.cjs"),
        "const assert=require('node:assert/strict');assert.equal(require('./consumer.cjs').render(require('./producer.cjs').payload()),3);\n",
      );
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "pilot base");
      base = git(repo, "rev-parse", "HEAD");
      for (const id of ["a", "b"]) {
        git(repo, "worktree", "add", "-q", "-b", `codex/pilot-${id}`, join(root, id), base);
        await writeFile(join(root, id, "operator-note.txt"), "untracked baseline; preserve verbatim\n");
      }
      const registry = join(root, "registry.json");
      await writeFile(
        registry,
        JSON.stringify({ version: 1, workspaces: { a: { path: join(root, "a") }, b: { path: join(root, "b") } } }),
      );
      Object.assign(process.env, {
        PI_DADDY_WORKSPACE_REGISTRY: registry,
        PI_DADDY_WORKSPACE_LEASE_DIR: join(root, "leases"),
        P14_JOBS: jobs,
        P14_RUNNER: runner,
        P14_LAUNCHES: launches,
      });
      for (const file of ["package.json", "principal-agents.json"])
        await copyFile(join(principal!, file), join(root, file));
      await copyFile(join(principal!, "build", "SKILL.md"), join(root, "build", "SKILL.md"));
      await copyFile(join(principal!, "agents", "principal-build.md"), join(root, "agents", "principal-build.md"));
      const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
      const extension = fileURLToPath(new URL("./two-builders-extension.ts", import.meta.url));
      const executable = join(root, "bin", "pi");
      await writeFile(
        executable,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} -e ${quote(extension)} "$@"\n`,
      );
      await chmod(executable, 0o700);
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
      const progress = fileURLToPath(new URL(`file://${join(principal!, "scripts/progress-artifacts.mjs")}`));
      await writeFile(
        runner,
        `
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {execFileSync,spawnSync} from 'node:child_process';
import {createRun,saveReport} from ${JSON.stringify(new URL(`file://${progress}`).href)};
const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
const job=JSON.parse(readFileSync(process.argv[2],'utf8'));if(job.fail)throw Error('intentional sibling failure');
const run=(args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
for(const [name,body]of Object.entries(job.tests))writeFileSync(name,body);
const before=spawnSync(process.execPath,['--test',...Object.keys(job.tests)],{encoding:'utf8',env:childEnv});assert.notEqual(before.status,0,'new test must fail before implementation');
for(const [name,body]of Object.entries(job.files))writeFileSync(name,body);
const after=spawnSync(process.execPath,['--test',...Object.keys(job.tests)],{encoding:'utf8',env:childEnv});assert.equal(after.status,0,after.stdout+after.stderr);
const paths=[...Object.keys(job.files),...Object.keys(job.tests)];run(['add','--',...paths]);run(['commit','-qm','pilot '+job.id]);const candidate=run(['rev-parse','HEAD']);
const report=saveReport(createRun(process.cwd(),'pilot',candidate),'build.md','# Full build report\\nCandidate: '+candidate+'\\nBase: '+job.base+'\\nScope: '+paths.join(', ')+'\\nDependency: '+job.dependency+'\\nTests failed before and passed after implementation.\\n'+after.stdout+'\\nCaveat: scripted process pilot; no model-quality claim.\\n');
const final='Next: review\\nChanged paths: '+paths.join(', ')+'\\nFindings applied: none\\nTests: node --test '+Object.keys(job.tests).join(' ')+' passed\\nReport: '+report.path;
writeFileSync(job.result,JSON.stringify({candidate,report,final,tests:Object.keys(job.tests)}));console.log(final);
`,
      );
    },
    extension: (root) => (pi) => {
      grants(pi);
      pi.on("resources_discover", () => ({ skillPaths: [join(root, "build")] }));
    },
    next: () => {
      if (issued) return textStep("coordinator complete");
      issued = true;
      return toolStep(command.name, command.args, "pilot-parent");
    },
  });
  let callIndex = 0;
  async function call(name: string, args: unknown) {
    command = { name, args };
    issued = false;
    await f.session.prompt("Run the configured model-free pilot step");
    const end = f.events.filter((e) => e.type === "tool_execution_end").at(-1);
    assert.ok(end);
    await writeFile(join(f.root, "native-results", `${++callIndex}-${name}.json`), JSON.stringify(end, null, 2) + "\n");
    return end;
  }
  const described = await call("delegate_describe", { agent: "build" });
  assert.equal(described.isError, false, JSON.stringify(described));
  const definitionId = described.result.details.definitionId;
  async function job(
    id: "a" | "b",
    suffix: string,
    files: Record<string, string>,
    tests: Record<string, string>,
    fail = false,
    dependency = "independent",
  ) {
    const value = {
      id: suffix,
      files,
      tests,
      fail,
      dependency,
      base: git(join(f.root, id), "rev-parse", "HEAD"),
      result: join(jobs, suffix + "-result.json"),
    };
    const jobRecord = join(jobs, suffix + "-job.json");
    await writeFile(jobRecord, JSON.stringify(value));
    await writeFile(join(jobs, id + ".json"), JSON.stringify(value));
    return {
      declaration: {
        workspace: id,
        base: value.base,
        scope: [...Object.keys(files), ...Object.keys(tests)],
        dependency,
        jobRecord,
        resultRecord: value.result,
        reportDestination: `${join(f.root, id)}/.principal/reports/pilot-*/<candidate-sha256-prefix>/build.md`,
        reportDiscovery: "The predeclared result record retains the exact full report path and SHA-256 after commit.",
      },
      spec: {
        agent: "build",
        definitionId,
        task: `Implement pilot ${suffix}; scope ${Object.keys(files).join(", ")}; ${dependency}`,
        workspace: { workspace_id: id, access: "write" },
      },
      result: async () => JSON.parse(await readFile(value.result, "utf8")),
    };
  }
  const count = async () =>
    (await readFile(launches, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
  const progress = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [join(principal!, "scripts/progress-artifacts.mjs"), ...args], {
        cwd: repo,
        encoding: "utf8",
      }),
    );
  return {
    ...f,
    base,
    repo,
    nativeResults: join(f.root, "native-results"),
    job,
    call,
    count,
    progress,
    async finish(ok: boolean) {
      f.session.dispose();
      if (ok && !process.env.P14_EVIDENCE_DIR) await f.close();
      else process.stderr.write(`P14 retained ${ok ? "verified" : "failed"} fixture: ${f.root}\n`);
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
    },
  };
}
