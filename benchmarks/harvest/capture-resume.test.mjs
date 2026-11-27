import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("pilot resume retains the selected Daddy and clears a superseded Bookie scope listener once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-trust-capture-"));
  const cwd = join(root, "project"),
    profile = join(root, "profile");
  const config = join(cwd, ".pi");
  const installed = fileURLToPath(new URL("../../packages/pi-daddy", import.meta.url));
  const channel = "pi-daddy:operation-artifacts:v1",
    bus = createEventBus();
  const priorProfile = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  let session;
  try {
    await mkdir(config, { recursive: true });
    await mkdir(profile);
    const legacy = join(root, "legacy-bookie");
    await mkdir(legacy);
    await writeFile(
      join(legacy, "package.json"),
      JSON.stringify({ name: "fixture-bookie", pi: { extensions: ["./scope.mjs"] } }),
    );
    const scopeChannel = "pi.task-history.v1.scope";
    await writeFile(
      join(legacy, "scope.mjs"),
      `export default pi => pi.events.on("${scopeChannel}", r => r.unavailable());`,
    );
    await writeFile(join(profile, "settings.json"), JSON.stringify({ packages: [installed, legacy] }));
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({
        packages: [
          { source: installed, extensions: [] },
          { source: legacy, extensions: [] },
        ],
        extensions: ["./producer.mjs"],
      }),
    );
    // Stand in for the replacement producer so the result is deterministic on every OS.
    await writeFile(
      join(config, "producer.mjs"),
      `export default pi => {
      pi.on("session_start", (_,ctx) => pi.events.on("${scopeChannel}", r => {
        if (r.sessionId === ctx.sessionManager.getSessionId()) r.accept(); else r.unavailable();
      }));
      pi.on("session_start", (_,ctx) => pi.events.on("${channel}", r => {
        if (r.sessionId === ctx.sessionManager.getSessionId()) r.reply({ok:true});
      }));
    }`,
    );
    const settingsManager = SettingsManager.create(cwd, profile, { projectTrusted: false });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: profile,
      settingsManager,
      eventBus: bus,
      additionalExtensionPaths: [fileURLToPath(new URL("./pilot-status.mjs", import.meta.url))],
    });
    await loader.reload({
      resolveProjectTrust: async ({ extensionsResult }) => {
        assert.ok(extensionsResult.extensions.some((e) => e.commands.has("grants")));
        return true;
      },
    });
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.ok(!loader.getExtensions().extensions.some((e) => e.commands.has("grants")));
    const id = randomUUID(),
      timestamp = new Date().toISOString(),
      path = join(root, "review.jsonl");
    await writeFile(
      path,
      [
        { type: "session", id, version: 3, cwd, timestamp },
        {
          type: "message",
          id: "0123abcd",
          parentId: null,
          timestamp,
          message: { role: "user", content: "saved review", timestamp: Date.now() },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const manager = SessionManager.open(path);
    assert.equal(manager.getSessionId(), id);
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    ({ session } = await createAgentSession({
      cwd,
      agentDir: profile,
      resourceLoader: loader,
      settingsManager,
      modelRuntime,
      sessionManager: manager,
    }));
    let reloads = 0;
    await session.bindExtensions({
      mode: "json",
      commandContextActions: {
        reload: async () => {
          reloads++;
          await session.reload();
        },
      },
    });
    const owner = { cwd: await realpath(cwd), sessionId: id };
    const replies = () => {
      const out = [];
      bus.emit(channel, {
        version: 1,
        requestId: randomUUID(),
        ...owner,
        action: "read",
        reference: { owner },
        reply: (r) => out.push(r.ok ? "read" : r.code),
      });
      return out;
    };
    const resumed = replies();
    const scopes = () => {
      const answers = [];
      bus.emit(scopeChannel, {
        version: 1,
        ...owner,
        accept: () => answers.push("selected"),
        unavailable: () => answers.push("unavailable"),
      });
      return answers.sort();
    };
    assert.deepEqual(scopes(), ["selected", "unavailable"]);
    await session.prompt("/pilot-activate");
    assert.deepEqual(scopes(), ["selected"]);
    await session.prompt("/pilot-activate");
    assert.equal(reloads, 1);
    assert.equal(session.sessionManager.getSessionId(), id);
    assert.deepEqual(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.id),
      ["0123abcd"],
    );
    assert.deepEqual(replies(), ["read"], "in-place reload retains the selected producer");
    assert.deepEqual(resumed, ["read"], "only the selected producer may reply on initial resume");
  } finally {
    session?.dispose();
    if (priorProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorProfile;
    await rm(root, { recursive: true, force: true });
  }
});
