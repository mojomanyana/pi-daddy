import assert from "node:assert/strict";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { PROJECT_MEMORY_OWNER_EVENT, type ProjectMemoryOwner } from "../../extensions/project-memory-owner.ts";
import {
  DASHBOARD_SOURCE_EVENT,
  type DashboardSourceRegistrationReply,
} from "../../src/kernel/dashboard-observation.ts";
import { dashboardSessionRequest } from "../../src/products/dashboard-session-client.ts";
import { renderDashboardScreen, dashboardScreenState } from "../../src/products/dashboard-screen.ts";
import grants from "../../extensions/grants.ts";
import { createGrantsSession, type GrantsSession } from "../../extensions/session.ts";
import { closeSessionAutoMode, setAutoApproval } from "../../extensions/session-auto-mode.ts";
import { ensureDashboardSessionServer } from "../../extensions/dashboard-session-server.ts";
import { grantStorePath, projectLedgerPath } from "../../src/governance/grant-store.ts";
import { projectSettingsPath } from "../../src/kernel/project-paths.ts";
import { GRANT_ENV_KEYS } from "../../src/kernel/propagation.ts";
import { createFixture } from "./fixture-harness.ts";

for (const contribute of [true, false]) {
  test(`interactive startup revalidates selected agents before dispatch ${contribute ? "with late contributions" : "even with identical selected paths"}`, async () => {
    const keys = [
      ...GRANT_ENV_KEYS,
      "PI_CODING_AGENT_DIR",
      "PI_DADDY_HERDR",
      "PI_DADDY_ACTIVITY_TIMELINE",
      "HERDR_ENV",
    ];
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    let current: GrantsSession | undefined;
    let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
    try {
      for (const key of keys) delete process.env[key];
      process.env.PI_DADDY_HERDR = "0";
      process.env.PI_DADDY_ACTIVITY_TIMELINE = "off";
      fixture = await createFixture({
        mode: "tui",
        prepare: async (root) => {
          process.env.PI_CODING_AGENT_DIR = join(root, "agent");
          for (const [where, name] of [
            ["agent/skills", "review"],
            ["agent/skills", "withdrawn"],
            ["contributed", "later"],
          ]) {
            const path = join(root, where, name, "SKILL.md");
            await mkdir(dirname(path), { recursive: true });
            await writeFile(
              path,
              `---\nname: ${name}\ndescription: Fixture\nallowed-tools: Bash\n---\nCheck local facts.\n`,
            );
          }
        },
        extension: (root) => (pi) => {
          current = createGrantsSession(undefined);
          grants(pi, current);
          if (contribute) pi.on("resources_discover", () => ({ skillPaths: [join(root, "contributed", "later")] }));
        },
      });
      assert.equal(current?.grantSource, "default");
      assert.equal(current.governed, true);
      assert.equal(current.mayDelegate, true);
      assert.equal(
        current.definitions.has("review"),
        true,
        "installed role is present before any turn or slash command",
      );
      assert.ok(current.gated.includes("tool:bash"));
      const preview = current.definitions.get("review");
      assert.equal(preview?.allowedTools, "Bash");
      assert.ok(current.definitions.has("withdrawn"));
      assert.equal(current.sessionApprovals.size, 0);
      assert.equal(fixture.requests.length, 0);
      for (const path of [
        grantStorePath(fixture.root),
        projectSettingsPath(fixture.root),
        projectLedgerPath(fixture.root),
      ])
        await assert.rejects(access(path), { code: "ENOENT" });
      const selectedSkills = join(fixture.root, "agent", "skills");
      await writeFile(
        join(selectedSkills, "review", "SKILL.md"),
        "---\nname: review\ndescription: Narrowed fixture\nallowed-tools: Read\n---\nOnly read supplied files.\n",
      );
      await unlink(join(selectedSkills, "withdrawn", "SKILL.md"));
      await fixture.session.prompt("use the synthetic scripted provider");
      assert.equal(current.definitions.has("later"), contribute);
      const bound = current.definitions.get("review");
      assert.equal(bound?.allowedTools, "Read");
      assert.notEqual(bound?.definitionId, preview?.definitionId);
      assert.equal(current.definitions.has("withdrawn"), false);
      assert.equal(current.sessionApprovals.size, 0);
      assert.deepEqual(fixture.errors, []);
    } finally {
      if (current) {
        await (await ensureDashboardSessionServer(current)).close();
        await closeSessionAutoMode(current);
      }
      await fixture?.close();
      for (const [key, value] of saved) value === undefined ? delete process.env[key] : (process.env[key] = value);
    }
  });
}

test("interactive trusted parent offers workspace memory and the connected dashboard renders the provider's readiness", async () => {
  const keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR", "PI_DADDY_HERDR", "PI_DADDY_ACTIVITY_TIMELINE", "HERDR_ENV"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  let current: GrantsSession | undefined;
  let emit: ExtensionAPI["events"]["emit"] | undefined;
  let owner: ProjectMemoryOwner | undefined;
  try {
    for (const key of keys) delete process.env[key];
    process.env.PI_DADDY_AUTO_MODE = "1";
    process.env.PI_DADDY_HERDR = "0";
    process.env.PI_DADDY_ACTIVITY_TIMELINE = "off";
    fixture = await createFixture({
      mode: "tui",
      prepare: async (root) => {
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
      },
      extension: () => (pi) => {
        current = createGrantsSession(undefined);
        grants(pi, current);
        pi.events.on(PROJECT_MEMORY_OWNER_EVENT, (value) => {
          owner = value as ProjectMemoryOwner;
        });
        emit = pi.events.emit.bind(pi.events);
      },
    });
    assert.ok(current && emit);
    assert.equal(owner, undefined, "a TUI label without an actual UI must not confer automatic memory");
    await fixture.session.bindExtensions({ mode: "tui", uiContext: { notify() {} } as unknown as ExtensionUIContext });
    const live = owner as ProjectMemoryOwner | undefined;
    assert.ok(live && live.isCurrent());
    assert.equal(live.sessionId, fixture.manager.getSessionId());
    assert.equal(live.cwd, fixture.root);
    const item = { id: "project-memory", kind: "work", state: "observed", label: "Current workspace memory" } as const;
    let registered = false;
    emit(DASHBOARD_SOURCE_EVENT, {
      version: 1,
      sessionId: live.sessionId,
      cwd: live.cwd,
      producer: "bookie-memory",
      producerVersion: "fixture",
      reply(result: DashboardSourceRegistrationReply) {
        assert.ok(result.ok);
        registered = result.publish({ sequence: 0, items: [item] });
      },
    });
    assert.ok(registered);
    const endpoint = await ensureDashboardSessionServer(current);
    const snapshot = await dashboardSessionRequest(endpoint.socketPath, endpoint.token, { action: "get" });
    const frame = renderDashboardScreen({
      width: 86,
      height: 36,
      connected: true,
      session: snapshot,
      items: [],
      screen: { ...dashboardScreenState(), destination: "now" },
    });
    assert.match(frame, /Bookie memory · Ready in this folder/);
    await setAutoApproval(current, false, "dashboard");
    assert.equal(live.isCurrent(), false);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.requests.length, 0);
  } finally {
    if (current) {
      await (await ensureDashboardSessionServer(current)).close();
      await closeSessionAutoMode(current);
    }
    await fixture?.close();
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});

test("Pi /new in the same folder gets a fresh root, dashboard and Bookie owner", async () => {
  const keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR", "PI_DADDY_HERDR", "PI_DADDY_ACTIVITY_TIMELINE", "HERDR_ENV"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const sessions: GrantsSession[] = [];
  const leases: ProjectMemoryOwner[] = [];
  let host: AgentSessionRuntime | undefined;
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    for (const key of keys) delete process.env[key];
    process.env.PI_DADDY_HERDR = "0";
    process.env.PI_DADDY_ACTIVITY_TIMELINE = "off";
    process.env.PI_DADDY_FANOUT = "3";
    const offline = (fixture = await createFixture());
    const cwd = offline.root,
      agentDir = join(cwd, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const uiContext = { notify() {} } as unknown as ExtensionUIContext;
    host = await createAgentSessionRuntime(
      async ({ sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          modelRuntime: offline.runtime,
          settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
          resourceLoaderOptions: {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
              (pi) => {
                const session = createGrantsSession(undefined);
                sessions.push(session);
                grants(pi, session);
                pi.events.on(PROJECT_MEMORY_OWNER_EVENT, (value) => leases.push(value as ProjectMemoryOwner));
              },
            ],
          },
        });
        const result = await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: offline.session.model,
        });
        return { ...result, services, diagnostics: [] };
      },
      { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")) },
    );
    host.setRebindSession((session) => session.bindExtensions({ mode: "tui", uiContext }));
    await host.session.bindExtensions({ mode: "tui", uiContext });
    await host.session.prompt("/grants auto on");
    const first = sessions[0]!;
    const previousLease = leases.at(-1);
    assert.ok(previousLease && previousLease.isCurrent());
    const old = await ensureDashboardSessionServer(first);
    assert.equal((await dashboardSessionRequest(old.socketPath, old.token, { action: "get" })).auto.enabled, true);

    assert.deepEqual(await host.newSession(), { cancelled: false });
    assert.equal(previousLease.isCurrent(), false);
    const fresh = sessions[1]!;
    assert.equal(fresh.depth, 0, "the replacement chat is a parent in the same folder");
    assert.equal(fresh.capacity.total, 3);
    assert.notEqual(fresh.episodeId, first.episodeId);
    assert.notEqual(fresh.capacity, first.capacity);
    const endpoint = await ensureDashboardSessionServer(fresh);
    assert.notEqual(endpoint.socketPath, old.socketPath);
    await assert.rejects(dashboardSessionRequest(old.socketPath, old.token, { action: "get" }));
    const snapshot = await dashboardSessionRequest(endpoint.socketPath, endpoint.token, { action: "get" });
    assert.equal(snapshot.observation?.sessionId, host.session.sessionManager.getSessionId());
    assert.deepEqual(snapshot.auto, { enabled: false, source: "default" });
    await host.session.prompt("/grants auto on");
    assert.equal(leases.at(-1)?.sessionId, host.session.sessionManager.getSessionId());
    assert.ok(leases.at(-1)?.isCurrent());
    assert.equal(offline.requests.length, 0);
  } finally {
    await host?.dispose();
    for (const session of sessions) await (await ensureDashboardSessionServer(session)).close();
    await fixture?.close();
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});
