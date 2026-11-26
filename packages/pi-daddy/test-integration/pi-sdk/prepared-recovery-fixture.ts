/** Disposable real Pi lifecycle with a copied Principal package and counted local children. */
import assert from "node:assert/strict";
import { cp, mkdir, writeFile, readFile, chmod, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import grants from "../../extensions/grants.ts";
import { GRANT_ENV_KEYS } from "../../src/kernel/propagation.ts";
import { createFixture } from "./fixture-harness.ts";
import { MODEL, PROVIDER, providerConfig, textStep, toolStep } from "./scripted-provider.ts";

const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const settings = {
  defaultProvider: PROVIDER,
  defaultModel: MODEL,
  defaultProjectTrust: "always" as const,
  enableAnalytics: false,
  enableInstallTelemetry: false,
  compaction: { enabled: false },
  retry: { enabled: false },
  cacheWarming: "off" as const,
};

export async function recoveryFixture(options: { childExtension?: string } = {}) {
  const principal = process.env.PRINCIPAL_CANDIDATE;
  assert.ok(principal, "PRINCIPAL_CANDIDATE is required");
  // Each fixture is a fresh process root; inherited child publication from another test is not its launch policy.
  const keys = [...new Set([...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR", "PI_DADDY_LEDGER", "PATH"])];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let base: Awaited<ReturnType<typeof createFixture>> | undefined;
  let host: AgentSessionRuntime | undefined;
  const restore = () => {
    for (const [key, value] of Object.entries(before))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
  };
  try {
    for (const key of GRANT_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, {
      PI_DADDY_GRANT: "tool:*,agent:*,context:files",
      PI_DADDY_GATED: "",
    });
    delete process.env.PI_DADDY_LEDGER;
    const sdkPath = join(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), "../../package.json");
    const sdkVersion = JSON.parse(await readFile(sdkPath, "utf8")).version;
    base = await createFixture({
      sdkVersion,
      prepare: async (root) => {
        await mkdir(join(root, ".fixture"));
        await cp(principal, join(root, ".fixture/principal"), {
          recursive: true,
          filter: (source) => ![".git", "node_modules", "dist"].includes(basename(source)),
        });
        await symlink(join(principal, "node_modules"), join(root, ".fixture/principal/node_modules"));
        for (const directory of ["bin", "child-agent"]) await mkdir(join(root, directory));
        execFileSync("git", ["init", "-q", root]);
        await writeFile(
          join(root, ".git/info/exclude"),
          "/.principal/\n/.pi/\n/.fixture/\n/agent/\n/child-agent/\n/bin/\n",
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
        const child = fileURLToPath(new URL(options.childExtension ?? "./native-phase-extension.ts", import.meta.url));
        await writeFile(
          join(root, "bin/pi"),
          `#!/bin/sh\nprintf 'launch\\n' >> ${quote(join(root, "bin/launches"))}\nexec ${quote(process.execPath)} ${quote(cli)} -e ${quote(child)} "$@"\n`,
        );
        await chmod(join(root, "bin/pi"), 0o700);
        process.env.PATH = `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`;
        process.env.PI_CODING_AGENT_DIR = join(root, "child-agent");
        await writeFile(join(root, "child-agent/settings.json"), JSON.stringify(settings));
      },
    });
    const offline = base;
    const cwd = base.root;
    const agentDir = join(cwd, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const packageRoot = join(cwd, ".fixture/principal");
    const workflow = (await import(pathToFileURL(join(packageRoot, "extensions/workflow.ts")).href)).default;
    let nextCall = { name: "principal_workflow", args: {} as Record<string, unknown> };
    let requestCount = 0;
    const events: any[] = [];
    const errors: unknown[] = [];
    host = await createAgentSessionRuntime(
      async ({ sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          modelRuntime: offline.runtime,
          settingsManager: SettingsManager.inMemory(settings, { projectTrusted: true }),
          resourceLoaderOptions: {
            noExtensions: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
              (pi) => {
                pi.registerProvider(
                  PROVIDER,
                  providerConfig(() =>
                    requestCount++ % 2
                      ? textStep("fixture turn ended")
                      : toolStep(nextCall.name, nextCall.args, `fixture-${requestCount}`),
                  ),
                );
                grants(pi);
                workflow(pi);
                pi.on("resources_discover", () => ({ skillPaths: [join(packageRoot, "build")] }));
              },
            ],
          },
        });
        const result = await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: offline.runtime.getModel(PROVIDER, MODEL)!,
        });
        result.session.subscribe((event) => events.push(structuredClone(event)));
        return { ...result, services, diagnostics: [] };
      },
      { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")) },
    );
    const uiContext = { notify() {} } as unknown as ExtensionUIContext;
    host.setRebindSession((session) =>
      session.bindExtensions({ mode: "tui", uiContext, onError: (error) => errors.push(error) }),
    );
    await host.session.bindExtensions({ mode: "tui", uiContext, onError: (error) => errors.push(error) });
    const activeHost = host;
    const invoke = async (name: string, args: Record<string, unknown>) => {
      nextCall = { name, args };
      await activeHost.session.prompt("Execute the next deterministic fixture step.");
      const end = events.filter((event) => event.type === "tool_execution_end").at(-1);
      assert.equal(end?.toolName, name);
      return end;
    };
    return {
      root: cwd,
      packageRoot,
      errors,
      host: activeHost,
      invoke,
      async success(name: string, args: Record<string, unknown>) {
        const end = await invoke(name, args);
        assert.equal(end.isError, false, JSON.stringify(end));
        return end.result.details;
      },
      async launches() {
        try {
          return (await readFile(join(cwd, "bin/launches"), "utf8")).trim().split("\n").length;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
          throw error;
        }
      },
      async close() {
        try {
          await activeHost.dispose();
        } finally {
          try {
            await offline.close();
          } finally {
            restore();
          }
        }
      },
    };
  } catch (error) {
    try {
      await host?.dispose();
    } finally {
      try {
        await base?.close();
      } finally {
        restore();
      }
    }
    throw error;
  }
}
