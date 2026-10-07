/** UNTESTED (per request): deferred, opt-in model-free SDK QA/measurement deliverable. Not run by build/test.
 * Uses actual SDK tool wrappers and private supervised command trees, never fake profiles/roles/native options.
 * Usage: node scripts/cache-sdk-basic-qa.ts <absolute supported SDK entry> <absolute Watchman executable> [samples]
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createExecutionCacheExtension, type CacheHistory, type CacheSessionControls } from "../dist/index.js";
const [sdkPath, watchmanPath, count = "10"] = process.argv.slice(2);
const samples = Number(count);
if (
  !sdkPath ||
  !watchmanPath ||
  !isAbsolute(sdkPath) ||
  !isAbsolute(watchmanPath) ||
  !Number.isSafeInteger(samples) ||
  samples < 2 ||
  samples > 100
)
  throw Error(
    "explicit absolute supported SDK/Watchman paths and 2..100 samples required; no installation or activation is performed",
  );
const sdkEntry = pathToFileURL(sdkPath).href;
const sdk = await import(sdkEntry);
const cwd = await mkdtemp(join(tmpdir(), "pi-daddy-cache-sdk-qa-"));
const member = join(cwd, "member");
const payload = Buffer.alloc(1024 * 1024, 97);
const manifest = `${createHash("sha256").update(payload).digest("hex")}  member\n`;
let control: CacheSessionControls | undefined,
  session: any,
  stopped = false;
const history: CacheHistory[] = [],
  diagnostics: string[] = [];
const command = "LC_ALL=C exec /usr/bin/gnusha256sum --strict -c fixture.sha256";
const env = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
try {
  await writeFile(member, payload);
  await writeFile(join(cwd, "fixture.sha256"), manifest);
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [] });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      createExecutionCacheExtension({
        cwd,
        installedEntry: new URL(sdkEntry),
        enabled: false,
        nativeOptions: {
          shellPath: "/bin/bash",
          exposeSessionEnvironment: false,
          spawnHook: (input) => ({ command: input.command, cwd: input.cwd, env }),
        },
        manifests: ["fixture.sha256"],
        watchman: { ownedExecutable: watchmanPath },
        onDiagnostic: (message) => {
          diagnostics.push(message);
          if (diagnostics.length > 128) diagnostics.shift();
        },
        onControl: (owner) => {
          control = owner;
        },
        onHistory: (event) => {
          history.push(event);
          if (history.length > 256) history.shift();
        },
      }),
    ],
  });
  await resourceLoader.reload();
  ({ session } = await sdk.createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  }));
  await session.bindExtensions({});
  session.setActiveTools(["bash"]);
  if (!control) throw Error(`supported native product did not bind: ${diagnostics.join("; ")}`);
  const owner: CacheSessionControls = control;
  const tool = session.agent.state.tools.find((item: any) => item.name === "bash");
  if (!tool) throw Error("actual SDK active Bash tool unavailable");
  async function invoke(text = command, expectFailure = false) {
    const id = randomUUID(),
      begin = performance.now();
    let result: any, error: unknown;
    try {
      result = await tool.execute(id, { command: text, timeout: 30 }, new AbortController().signal);
    } catch (failure) {
      error = failure;
    }
    const elapsedMs = performance.now() - begin;
    const event = history.find((row) => row.toolCallId === id);
    assert.ok(event, "actual visible invocation must emit additive history");
    if (!expectFailure && error !== undefined) throw error;
    if (expectFailure) {
      assert.ok(
        event.exitCode !== null && event.exitCode !== 0,
        "boundary failure must retain observed nonzero command exit",
      );
      assert.equal(event.published, false, "failed checksum validation must never publish");
    } else {
      const output = result.structuredContent?.output ?? result.content[0]?.text;
      assert.match(output, /member: OK/, "real GNU checksum result, not a synthetic cache result");
    }
    return { event, elapsedMs };
  }
  const baseline: number[] = [];
  for (let index = 0; index < samples; index++) baseline.push((await invoke()).elapsedMs);
  assert.equal(owner.status().launches, 0, "disabled optimization must not launch supervised cached commands");
  await owner.enable();
  let cold;
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = await invoke();
    if (candidate.event.decision === "execute" && candidate.event.published) {
      cold = candidate;
      break;
    }
  }
  assert.ok(cold, `no admitted published execution after observer initialization: ${diagnostics.join("; ")}`);
  const warm: number[] = [],
    beforeWarm = owner.status().launches;
  for (let index = 0; index < samples; index++) {
    const observed = await invoke();
    warm.push(observed.elapsedMs);
    assert.equal(observed.event.decision, "reuse");
    assert.equal(observed.event.originalExecutionId, cold.event.executionId);
  }
  assert.equal(owner.status().launches, beforeWarm, "warm replay must not start another underlying command");
  await writeFile(member, "changed input");
  const failed = await invoke(command, true);
  assert.notEqual(failed.event.decision, "reuse", "changed dependency must not replay the old successful result");
  await writeFile(member, payload);
  owner.clear();
  const beforeBatch = owner.status().launches;
  const batch = await Promise.all([invoke(), invoke()]);
  assert.equal(
    owner.status().launches - beforeBatch,
    1,
    "equivalent requests must share exactly one real underlying execution",
  );
  assert.equal(batch[0].event.executionId, batch[1].event.executionId);
  owner.forceNext();
  const beforeForce = owner.status().launches;
  assert.equal((await invoke()).event.decision, "execute");
  assert.equal(owner.status().launches - beforeForce, 1);
  const summary = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      n: sorted.length,
      p50Ms: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxMs: sorted.at(-1),
    };
  };
  await owner.shutdown();
  stopped = true;
  console.log(
    JSON.stringify(
      {
        observationsOnly: true,
        basicCases: ["ordinary", "execute", "reuse", "changed-failure", "share", "force", "shutdown"],
        baseline: summary(baseline),
        coldMs: cold.elapsedMs,
        warm: summary(warm),
        status: owner.status(),
        diagnostics,
      },
      null,
      2,
    ),
  );
} finally {
  if (control && !stopped) {
    try {
      await control.shutdown();
      stopped = true;
    } catch (error) {
      console.error("SDK QA original-resource cleanup unresolved; retaining private fixture", cwd, error);
    }
  }
  session?.dispose();
  if (stopped) await rm(cwd, { recursive: true });
  else console.error("SDK QA fixture retained; no physical cleanup certification", cwd);
}
