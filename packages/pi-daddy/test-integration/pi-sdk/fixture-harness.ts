/** Real SDK harness. Owns only disposable directories and in-memory auth/settings/session. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MODEL, PROVIDER, providerConfig, textStep } from "./scripted-provider.ts";
import type { Request, Step } from "./scripted-provider.ts";

type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

export function assertVersion(expected = "1.0.4") {
  for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai"]) {
    const packagePath = join(fileURLToPath(import.meta.resolve(`@earendil-works/${name}`)), "../../package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    if (pkg.version !== expected) throw new Error(`Expected ${name}@${expected}; found ${pkg.version}`);
  }
}

export async function createFixture(
  options: {
    sdkVersion?: "1.0.4" | "1.1.0";
    extension?: (root: string) => ExtensionFactory;
    next?: (request: Request, index: number) => Step;
    settings?: Partial<Settings> | ((root: string) => Partial<Settings>);
    prepare?: (root: string) => Promise<void>;
  } = {},
) {
  assertVersion(options.sdkVersion);
  const root = await mkdtemp(join(tmpdir(), "pi-p01-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await options.prepare?.(root);
  const requests: Request[] = [];
  const errors: unknown[] = [];
  const settingsManager = SettingsManager.inMemory(
    {
      defaultProvider: PROVIDER,
      defaultModel: MODEL,
      defaultThinkingLevel: "high",
      enableAnalytics: false,
      enableInstallTelemetry: false,
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      ...(typeof options.settings === "function" ? options.settings(root) : options.settings),
    },
    { projectTrusted: true },
  );
  const credentialCalls: string[] = [];
  const runtime = await ModelRuntime.create({
    credentials: {
      async read() {
        credentialCalls.push("read");
        return undefined;
      },
      async list() {
        credentialCalls.push("list");
        return [];
      },
      async modify(_id, fn) {
        credentialCalls.push("modify");
        return fn(undefined);
      },
      async delete() {
        credentialCalls.push("delete");
      },
    },
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const extensionFactories: ExtensionFactory[] = [
    (pi) => {
      pi.registerProvider(
        PROVIDER,
        providerConfig((request) => {
          requests.push(request);
          return options.next?.(request, requests.length - 1) ?? textStep();
        }),
      );
    },
  ];
  if (options.extension) extensionFactories.push(options.extension(root));
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    extensionFactories,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const manager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    noTools: "builtin",
    thinkingLevel: "high",
  });
  const events: any[] = [];
  session.subscribe((event) => events.push(structuredClone(event)));
  await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
  await session.setModel(runtime.getModel(PROVIDER, MODEL)!);
  session.setThinkingLevel("high");
  return {
    root,
    session,
    manager,
    runtime,
    credentialCalls,
    requests,
    events,
    errors,
    loader,
    async close() {
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
