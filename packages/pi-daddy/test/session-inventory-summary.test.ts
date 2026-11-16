import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { planWithApprovals } from "../extensions/run-delegation.ts";
import { reportSelectedDefinitions } from "../extensions/session-report.ts";
import { toolSources } from "./tool-sources-fixture.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

// Drive the real session hooks, discovery, catalog and enforcing planner. Only Pi's event API is inert;
// no child is launched, no model is called and no external package has to be installed.
async function fixture() {
  const cwd = await tempDir("inventory-summary-project-");
  const agentDir = await tempDir("inventory-summary-agent-");
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_DADDY_")) delete process.env[key];
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_DADDY_HERDR: "0",
    PI_DADDY_AUTO: "0",
    PI_DADDY_GRANT: "agent:*,tool:delegate,tool:read,tool:write,tool:scout_research",
    PI_DADDY_GATED: "tool:write",
  });
  for (const [name, tools] of [
    ["reader", "Read"],
    ["writer", "Write"],
    ["scout-public", "scout_research"],
  ]) {
    const dir = join(cwd, ".pi", "skills", name!);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name}\nallowed-tools: ${tools}\n---\nDo the task.\n`,
    );
  }
  const notices: string[] = [];
  const hooks = new Map<string, Function>();
  let exposure = "deferred";
  let present = true;
  let sessionId = "first";
  const active = new Set(["read", "write", "delegate"]);
  const session = createGrantsSession(undefined);
  const api = {
    on: (name: string, fn: Function) => hooks.set(name, fn),
    registerTool: () => {},
    registerCommand: () => {},
    getAllTools: () =>
      toolSources(["read", "write", "delegate", ...(present ? ["scout_research"] : [])]).map((tool) => ({
        ...tool,
        exposure: tool.name === "scout_research" ? exposure : "direct",
      })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active.clear();
      names.forEach((name) => active.add(name));
    },
  };
  grantsExtension(api as never, session);
  const ctx = {
    cwd,
    mode: "json",
    hasUI: false,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (text: string) => notices.push(text), select: async () => undefined },
    modelRegistry: { find: () => undefined },
  };
  const request = () => hooks.get("before_provider_request")!({ payload: { tools: [{ name: "read" }] } }, ctx);
  return {
    session,
    notices,
    request,
    report: () => reportSelectedDefinitions(session, ctx),
    async start(id = "first") {
      sessionId = id;
      notices.length = 0;
      await hooks.get("session_start")!({ reason: id === "first" ? "startup" : "new" }, ctx);
    },
    inventory(next: string | null) {
      present = next !== null;
      exposure = next ?? "deferred";
    },
    async dispose() {
      await hooks.get("session_shutdown")?.({}, ctx);
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    },
  };
}

test("startup and /new settle callable parent Scout without claiming it is a child provider", async () => {
  const f = await fixture();
  try {
    for (const id of ["first", "second"]) {
      await f.start(id);
      assert.equal(f.session.observed, false, "a new owner must not inherit a settled inventory");
      const initial = f.notices.join("\n");
      assert.match(initial, /checking available tools: scout-public/);
      assert.doesNotMatch(initial, /scout-public \(unknown capability|uninstalled package/);
      assert.match(initial, /writer \(needs your approval for tool:write\)/, "real permission gates remain visible");
      f.notices.length = 0;
      await f.request();
      assert.ok(
        f.session.catalog.has("tool:scout_research"),
        "deferred parent tool is catalogued even when absent from payload",
      );
      const settled = f.notices.join("\n");
      assert.match(settled, /scout-public \(use the parent Pi session; child tools unavailable: scout_research\)/);
      assert.doesNotMatch(settled, /checking available tools|uninstalled package/);
      const { plan } = await planWithApprovals(f.session, { task: "Research", agent: "scout-public" }, {}, null);
      assert.equal(plan.ok, false);
      assert.equal(plan.refusal?.details?.kind, "child-tool-unavailable");
      f.notices.length = 0;
      await f.request();
      assert.equal(f.notices.length, 0, "repeat provider calls do not repeat inventory announcements");
    }
  } finally {
    await f.dispose();
  }
});

for (const outcome of ["summary", "warning"] as const) {
  test(`a ${outcome} waiting on discovery cannot notify a replacement owner`, async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let pending: Promise<void> | undefined;
    try {
      await f.start();
      const original = f.session.delegationContext;
      let first = true;
      f.session.delegationContext = async (...args) => {
        const context = await original(...args);
        if (first) {
          first = false;
          entered();
          await held;
          if (outcome === "warning") throw new Error("old owner discovery unavailable");
        }
        return context;
      };
      pending = f.report();
      await waiting;
      // The lifecycle replacement is the owner boundary used by /new. Keep the real asynchronous
      // reporting/planning path suspended across it; neither a stale success nor catch warning may leak.
      f.session.reloadLifecycle = { ...f.session.reloadLifecycle, root: { ...f.session.reloadLifecycle.root } };
      f.notices.length = 0;
      release();
      await pending;
      assert.deepEqual(f.notices, []);
      await f.report();
      assert.ok(f.notices.length > 0, "the current owner can still report its own inventory");
    } finally {
      release();
      await pending;
      await f.dispose();
    }
  });
}

test("absent, hidden and inactive direct Scout tools remain unavailable after native observation", async () => {
  const f = await fixture();
  try {
    for (const exposure of [null, "hidden", "direct"]) {
      f.inventory(exposure);
      await f.start(`new-${exposure}`);
      f.notices.length = 0;
      await f.request();
      assert.ok(!f.session.catalog.has("tool:scout_research"));
      assert.ok(!f.session.ownGrant.includes("tool:scout_research"));
      assert.match(f.notices.join("\n"), /scout-public \(unknown capability: tool:scout_research/);
      assert.doesNotMatch(f.notices.join("\n"), /checking available tools|use the parent Pi session/);
    }
  } finally {
    await f.dispose();
  }
});
