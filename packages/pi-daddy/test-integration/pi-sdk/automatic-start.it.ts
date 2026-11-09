import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import grants from "../../extensions/grants.ts";
import { createGrantsSession, type GrantsSession } from "../../extensions/session.ts";
import { closeSessionAutoMode } from "../../extensions/session-auto-mode.ts";
import { ensureDashboardSessionServer } from "../../extensions/dashboard-session-server.ts";
import { grantStorePath, projectLedgerPath } from "../../src/governance/grant-store.ts";
import { projectSettingsPath } from "../../src/kernel/project-paths.ts";
import { GRANT_ENV_KEYS } from "../../src/kernel/propagation.ts";
import { createFixture } from "./fixture-harness.ts";

test("interactive Pi starts selected agents and their existing permission gates without a setup command", async () => {
  const keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR", "PI_DADDY_HERDR", "PI_DADDY_ACTIVITY_TIMELINE", "HERDR_ENV"];
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
        pi.on("resources_discover", () => ({ skillPaths: [join(root, "contributed", "later")] }));
      },
    });
    assert.equal(current?.grantSource, "default");
    assert.equal(current.governed, true);
    assert.equal(current.mayDelegate, true);
    assert.equal(current.definitions.has("review"), true, "installed role is present before any turn or slash command");
    assert.ok(current.gated.includes("tool:bash"));
    assert.equal(current.sessionApprovals.size, 0);
    assert.equal(fixture.requests.length, 0);
    for (const path of [
      grantStorePath(fixture.root),
      projectSettingsPath(fixture.root),
      projectLedgerPath(fixture.root),
    ])
      await assert.rejects(access(path), { code: "ENOENT" });
    await fixture.session.prompt("use the synthetic scripted provider");
    assert.ok(current.definitions.has("later"), "late-contributed skill is captured before the first task");
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
