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

test("a Daddy copy used only during project trust cannot answer for the resumed session", async () => {
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
    await writeFile(join(profile, "settings.json"), JSON.stringify({ packages: [installed] }));
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify({
        packages: [{ source: installed, extensions: [] }],
        extensions: ["./producer.mjs"],
      }),
    );
    // Stand in for the replacement producer so the result is deterministic on every OS.
    await writeFile(
      join(config, "producer.mjs"),
      `export default pi => {
      pi.on("session_start", (_,ctx) => pi.events.on("${channel}", r => {
        if (r.sessionId === ctx.sessionManager.getSessionId()) r.reply({ok:true});
      }));
    }`,
    );
    const settingsManager = SettingsManager.create(cwd, profile, { projectTrusted: false });
    const loader = new DefaultResourceLoader({ cwd, agentDir: profile, settingsManager, eventBus: bus });
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
    await session.bindExtensions({ mode: "json" });
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
    await session.reload();
    assert.deepEqual(replies(), ["read"], "in-place reload retains the selected producer");
    assert.deepEqual(resumed, ["read"], "only the selected producer may reply on initial resume");
  } finally {
    session?.dispose();
    if (priorProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorProfile;
    await rm(root, { recursive: true, force: true });
  }
});
