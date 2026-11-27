import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAutoModeAuthority } from "../src/governance/auto-mode-policy.ts";
import { callParentTool } from "../src/governance/parent-tool-calls.ts";
import { ENV_EXECUTION_ID } from "../src/kernel/env-names.ts";
import { bindParentTools, openParentTools } from "../extensions/parent-tool-host.ts";
import { createGrantsSession } from "../extensions/session.ts";
import {
  registerWorkMode,
  resolveReviewScope,
  formatReviewScopeBanner,
  collectReviewDiff,
} from "../extensions/work-mode.ts";
import {
  registerProjectMemoryOwner,
  PROJECT_MEMORY_OWNER_REQUEST,
  type ProjectMemoryOwner,
} from "../extensions/project-memory-owner.ts";
import { planDelegation } from "../src/kernel/delegate.ts";
import { buildCatalog } from "../src/kernel/catalog.ts";

function makeTempDir(t: test.TestContext, prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function initGitRepo(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@local"]);
  git(["config", "user.name", "Test"]);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
}

test("Finding 1: parent/child proxy enforces assignment-scoped brief reads and never falls through", async (t) => {
  const cwd = makeTempDir(t, "daddy-brief-proxy-");
  const authority = await createAutoModeAuthority({ enabled: true, source: "default" });
  t.after(() => authority.close());

  const bus = new EventEmitter();
  const events = {
    on: (name: string, fn: (...a: any[]) => void) => {
      bus.on(name, fn);
      return () => bus.off(name, fn);
    },
    emit: (name: string, payload: unknown) => {
      bus.emit(name, payload);
    },
  };

  // Existing target brief on the active branch (isolated from assignment authority)
  const targetSha = "a".repeat(64);
  const otherSha = "b".repeat(64);
  const targetRef = {
    version: 1,
    producer: "pi-scout-research",
    kind: "research-brief",
    session: "c".repeat(64),
    sha256: targetSha,
    bytes: 64,
  };
  const seenScoutRequests: Array<Record<string, unknown>> = [];

  // Mirror Scout's fail-closed scout:specialist-brief-read:v1 contract with targetRef ALREADY on active branch.
  events.on("scout:specialist-brief-read:v1", (req: any) => {
    seenScoutRequests.push({
      specialist: req.specialist,
      childModel: req.childModel,
      attachedBriefSha256: req.attachedBriefSha256,
      sessionId: req.sessionId,
      cwd: req.cwd,
    });
    if (!Array.isArray(req.attachedBriefSha256)) {
      return req.reply({ ok: false, status: "denied", reason: "brief assignment evidence is absent" });
    }
    if (req.attachedBriefSha256.length === 0) {
      return req.reply({ ok: false, status: "denied", reason: "no briefs are attached to this specialist assignment" });
    }
    if (!req.attachedBriefSha256.includes(req.reference?.sha256)) {
      return req.reply({ ok: false, status: "denied", reason: "brief is not attached to this specialist assignment" });
    }
    return req.reply({
      ok: true,
      result: {
        ok: true,
        complete: true,
        excerpt: "Authorized cross-model brief content",
        specialist: req.specialist,
        usedBySpecialist: req.specialist,
      },
    });
  });

  const session = createGrantsSession(undefined);
  session.cwd = cwd;
  session.depth = 0;
  session.ownGrant = ["tool:scout_brief_read", "tool:bookie_propose_memory"];
  session.autoMode = authority;
  session.reloadLifecycle.autoMode = {
    authority,
    reader: authority,
    nativeSessionId: "sess-1",
    updates: Promise.resolve(),
  };

  const pi = {
    events,
    getActiveTools: () => ["scout_brief_read", "bookie_propose_memory"],
    getAllTools: () => [
      {
        name: "scout_brief_read",
        label: "Scout brief read",
        description: "Read saved brief",
        exposure: "direct",
        parameters: { type: "object" },
      },
      {
        name: "bookie_propose_memory",
        label: "Bookie propose memory",
        description: "Propose memory",
        exposure: "direct",
        parameters: { type: "object" },
      },
    ],
  };
  bindParentTools(pi as any, session);

  let hostBriefExecuteCalls = 0;
  const bookieArgsSeen: Array<Record<string, unknown>> = [];
  const host = {
    cwd,
    sessionManager: { getSessionId: () => "sess-1" },
    tools: [{ name: "scout_brief_read" }, { name: "bookie_propose_memory" }],
    model: { provider: "google", id: "gemini-flash-latest" },
    executeTool: async (name: string, args: unknown) => {
      if (name === "scout_brief_read") hostBriefExecuteCalls++;
      if (name === "bookie_propose_memory") bookieArgsSeen.push(args as Record<string, unknown>);
      return { isError: false, result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } };
    },
  };

  const runProxyCall = async (executionId: string, attachedBriefSha256: readonly string[] | undefined) => {
    const opened = openParentTools(
      session,
      {
        parentTools: ["scout_brief_read", "bookie_propose_memory"],
        parentToolModel: "ollama/qwen3:32b",
        effective: ["tool:scout_brief_read", "tool:bookie_propose_memory"],
        env: { [ENV_EXECUTION_ID]: executionId },
        specialist: "investigate",
        ...(attachedBriefSha256 !== undefined ? { attachedBriefSha256 } : {}),
      },
      executionId,
      host,
    );
    assert.ok(opened);
    try {
      const reply = await callParentTool(authority.reference, {
        executionId,
        key: opened.env.PI_DADDY_PROXIED_TOOLS_KEY,
        tool: "scout_brief_read",
        arguments: { reference: targetRef },
      });
      // Also verify bookie_propose_memory child call cannot smuggle coordinatorAccepted=true.
      if (executionId === "exec-authorized") {
        await callParentTool(authority.reference, {
          executionId,
          key: opened.env.PI_DADDY_PROXIED_TOOLS_KEY,
          tool: "bookie_propose_memory",
          arguments: {
            title: "T",
            summary: "S",
            kind: "finding",
            verified: true,
            source: "coordinator",
            coordinatorAccepted: true,
          },
        });
      }
      return reply;
    } finally {
      opened.close();
    }
  };

  // 1. Omitted attachedBriefSha256 -> fails closed before calling host.executeTool
  const omitted = await runProxyCall("exec-omitted", undefined);
  assert.equal(omitted.status, "result");
  assert.equal(omitted.isError, true);
  assert.match(omitted.text, /absent/i);

  // 2. Empty attachedBriefSha256: [] -> explicitly transmitted as [] and denied
  const empty = await runProxyCall("exec-empty", []);
  assert.equal(empty.status, "result");
  assert.equal(empty.isError, true);
  assert.match(empty.text, /no briefs are attached/i);
  assert.deepEqual(seenScoutRequests[0]?.attachedBriefSha256, []);

  // 3. Different attached brief -> denied even though targetRef is on active branch
  const different = await runProxyCall("exec-different", [otherSha]);
  assert.equal(different.status, "result");
  assert.equal(different.isError, true);
  assert.match(different.text, /not attached/i);

  // 4. Authorized cross-model read -> succeeds across ollama/qwen3:32b != google/gemini-flash-latest
  const authorized = await runProxyCall("exec-authorized", [targetSha]);
  assert.equal(authorized.status, "result");
  assert.equal(authorized.isError, false);
  assert.match(authorized.text, /Authorized cross-model brief content/);

  // Parent's unscoped host.executeTool("scout_brief_read") was NEVER called
  assert.equal(hostBriefExecuteCalls, 0);

  // Child-proxied bookie_propose_memory was pinned to source="specialist" and coordinatorAccepted=false
  assert.equal(bookieArgsSeen.length, 1);
  assert.equal(bookieArgsSeen[0]?.source, "specialist");
  assert.equal(bookieArgsSeen[0]?.coordinatorAccepted, false);
  assert.equal(bookieArgsSeen[0]?.specialist, "investigate");
});

test("Finding 2: Skill Harness gate tracks per (skill, scenario), bounds automatic retries, surfaces unresolved decision, and clears when matching scenario passes", async () => {
  const hooks = new Map<string, Array<(...args: any[]) => any>>();
  const bus = new EventEmitter();
  const notifications: Array<{ msg: string; level: string }> = [];
  const activities: any[] = [];
  bus.on("pi-daddy:ecosystem-activity:v1", (ev) => activities.push(ev));

  const pi = {
    on: (name: string, fn: (...args: any[]) => any) => {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    events: {
      on: (name: string, fn: (...args: any[]) => any) => {
        bus.on(name, fn);
        return () => bus.off(name, fn);
      },
      emit: (name: string, payload: unknown) => bus.emit(name, payload),
    },
    registerCommand() {},
    appendEntry() {},
  };

  const session = createGrantsSession(undefined);
  registerWorkMode(pi as any, session);
  const settleHandlers = hooks.get("agent_before_settle") ?? [];
  assert.ok(settleHandlers.length > 0);
  const runSettle = async () => {
    let out: any;
    for (const h of settleHandlers) {
      out = await h(
        { entries: [] },
        {
          cwd: process.cwd(),
          hasUI: true,
          ui: { notify: (msg: string, level: string) => notifications.push({ msg, level }) },
          model: { provider: "google", id: "gemini-flash-latest" },
          modelRegistry: { find: () => undefined },
        },
      );
    }
    return out;
  };

  // Step 1: Scenario A fails -> settle attempt 1 holds task open
  bus.emit("skill-harness:eval-result:v1", {
    version: 1,
    skill: "demo-skill",
    keepTaskOpen: true,
    coverage: { label: "focused coverage (1/2 scenarios)", scenariosRun: ["A"] },
    scenarios: [{ id: "A", verdict: "FAIL", expected: ["must cite file"], observed: "no citation" }],
  });
  const hold1 = await runSettle();
  assert.equal(hold1?.continue, true);
  assert.equal(hold1?.entries?.[0]?.customType, "pi-daddy-skill-harness-gate");
  assert.match(hold1.entries[0].content, /A:.*must cite file.*no citation/);

  // Step 2: Unrelated Scenario B passes -> Scenario A MUST STILL BLOCK!
  bus.emit("skill-harness:eval-result:v1", {
    version: 1,
    skill: "demo-skill",
    keepTaskOpen: false,
    coverage: { label: "focused coverage (1/2 scenarios)", scenariosRun: ["B"] },
    scenarios: [{ id: "B", verdict: "PASS" }],
  });
  const hold2 = await runSettle();
  assert.equal(hold2?.continue, true, "passing Scenario B must NOT clear failing Scenario A");
  assert.match(hold2.entries[0].content, /retry 2\/3/);
  assert.match(hold2.entries[0].content, /- A:/);

  // Step 3: Repeated settle attempt 3/3 still holds
  const hold3 = await runSettle();
  assert.equal(hold3?.continue, true);
  assert.match(hold3.entries[0].content, /retry 3\/3/);

  // Step 4: Settle attempt 4 exceeds retry bound -> surfaces explicit unresolved operator decision
  const unresolved = await runSettle();
  assert.equal(unresolved?.continue, false);
  assert.equal(unresolved?.entries?.[0]?.customType, "pi-daddy-skill-harness-unresolved");
  assert.equal(unresolved?.entries?.[0]?.display, true);
  assert.match(unresolved.entries[0].content, /operator decision required/i);
  assert.ok(notifications.some((n) => /unresolved failing evaluation/i.test(n.msg)));
  assert.ok(activities.some((a) => a.kind === "eval-unresolved-decision"));

  // Step 5: Finally Scenario A passes -> task can finish cleanly!
  bus.emit("skill-harness:eval-result:v1", {
    version: 1,
    skill: "demo-skill",
    keepTaskOpen: false,
    coverage: { label: "focused coverage (1/2 scenarios)", scenariosRun: ["A"] },
    scenarios: [{ id: "A", verdict: "PASS" }],
  });
  const cleared = await runSettle();
  assert.equal(cleared, undefined, "once matching Scenario A passes, task finishes cleanly");
});

test("Finding 3: ProjectMemoryOwner exposes live Daddy Auto authority independently of Bookie memory", async (t) => {
  const cwd = makeTempDir(t, "daddy-auto-lease-");
  const authority = await createAutoModeAuthority({ enabled: false, source: "default" });
  t.after(() => authority.close());

  const bus = new EventEmitter();
  const pi = {
    events: {
      on: (name: string, fn: (...a: any[]) => void) => {
        bus.on(name, fn);
        return () => bus.off(name, fn);
      },
      emit: (name: string, payload: unknown) => bus.emit(name, payload),
    },
  };

  const session = createGrantsSession(undefined);
  session.cwd = cwd;
  session.depth = 0;
  session.ownerBound = true;
  session.autoMode = authority;
  session.reloadLifecycle.autoMode = {
    authority,
    reader: authority,
    nativeSessionId: "sess-auto",
    updates: Promise.resolve(),
  };

  const controller = registerProjectMemoryOwner(pi as any, session);
  t.after(() => controller.close());

  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "sess-auto" },
  };
  const activate = controller.begin(ctx as any);
  // Bookie enabled explicitly while Daddy Auto is OFF
  session.reloadLifecycle.projectMemoryOwner!.setEnabled(true);
  activate();

  const requestLease = () => {
    let lease: ProjectMemoryOwner | undefined;
    bus.emit(PROJECT_MEMORY_OWNER_REQUEST, {
      version: 1,
      sessionId: "sess-auto",
      cwd,
      reply: (v: ProjectMemoryOwner) => {
        lease = v;
      },
    });
    return lease;
  };

  const lease = requestLease();
  assert.ok(lease, "Bookie workspace memory lease must be active");
  assert.equal(lease.isCurrent(), true);
  assert.equal(lease.isAutoEnabled(), false, "live Daddy Auto authority must report false while Auto is OFF");

  authority.set(true, "session");
  assert.equal(lease.isAutoEnabled(), true, "live Daddy Auto authority must reflect Auto ON immediately");

  authority.set(false, "session");
  assert.equal(lease.isCurrent(), true, "Bookie memory stays active when checked independently");
  assert.equal(lease.isAutoEnabled(), false, "live Daddy Auto authority must reflect Auto OFF immediately");
});

test("Finding 4: explicit multi-repo review selects and displays concrete roots while excluding unrelated repo and keeping nested scoping", async (t) => {
  const root = makeTempDir(t, "daddy-multi-repo-");
  const repoA = join(root, "repo-alpha");
  const repoB = join(root, "repo-beta");
  const repoC = join(root, "repo-gamma");

  initGitRepo(repoA, {
    "nested/feature.ts": "export const alpha = 1;\n",
    "sibling/other.ts": "export const siblingA = 1;\n",
  });
  initGitRepo(repoB, { "index.ts": "export const beta = 1;\n" });
  initGitRepo(repoC, { "unrelated.ts": "export const gamma = 1;\n" });

  // Relevant changes in repo-alpha and repo-beta, plus unrelated dirty change in repo-gamma
  writeFileSync(join(repoA, "nested/feature.ts"), "export const alpha = 2;\n", "utf8");
  writeFileSync(join(repoA, "sibling/other.ts"), "export const siblingA = 99;\n", "utf8");
  writeFileSync(join(repoB, "index.ts"), "export const beta = 2;\n", "utf8");
  writeFileSync(join(repoC, "unrelated.ts"), "export const gamma = 999;\n", "utf8");

  // 1. Explicit multi-repo review naming repo-alpha and repo-beta by concrete roots
  const multiScope = resolveReviewScope(root, "Perform a multi-repo review across repo-alpha and repo-beta");
  assert.equal(multiScope.mode, "multi-repo");
  assert.deepEqual(
    [...multiScope.roots].sort(),
    [realpathSync(repoA), realpathSync(repoB)].sort(),
    "only the two requested repo roots must be selected",
  );

  // Selected roots are displayed clearly before review and exclude repo-gamma
  const banner = formatReviewScopeBanner(multiScope);
  assert.match(banner, /repo-alpha/);
  assert.match(banner, /repo-beta/);
  assert.doesNotMatch(banner, /repo-gamma/);

  // Collected diff contains both selected repos and excludes the third unrelated repo
  const multiDiff = await collectReviewDiff(root, multiScope);
  assert.match(multiDiff, /alpha = 2/);
  assert.match(multiDiff, /beta = 2/);
  assert.doesNotMatch(multiDiff, /gamma = 999/, "unrelated 3rd repo must remain completely excluded");

  // 2. Explicit roots argument also works cleanly from inside repo-alpha
  const explicitScope = resolveReviewScope(repoA, "Review changes", [repoA, repoB]);
  assert.equal(explicitScope.mode, "multi-repo");
  assert.equal(explicitScope.roots.length, 2);
  const explicitDiff = await collectReviewDiff(repoA, explicitScope);
  assert.match(explicitDiff, /alpha = 2/);
  assert.match(explicitDiff, /beta = 2/);
  assert.doesNotMatch(explicitDiff, /gamma = 999/);

  // 3. Ordinary request inside nested workspace retains nested-workspace scoping
  const nestedDir = join(repoA, "nested");
  const ordinaryScope = resolveReviewScope(nestedDir, "Fix alpha constant and verify");
  assert.equal(ordinaryScope.mode, "workspace");
  const nestedDiff = await collectReviewDiff(nestedDir, ordinaryScope);
  assert.match(nestedDiff, /alpha = 2/);
  assert.doesNotMatch(nestedDiff, /siblingA = 99/, "sibling outside nested workspace must stay excluded");
  assert.doesNotMatch(nestedDiff, /beta = 2/);
  assert.doesNotMatch(nestedDiff, /gamma = 999/);
});

test("Finding 6 regression: named Principal roles attenuate absent optional runtime tools while mutating codemode and explicit tools stay strict", async () => {
  const readOnlyDef = {
    name: "review-security",
    description: "Security specialist",
    allowedTools: "read grep find ls codemode parallel",
    body: "Review code.",
    source: "/fake/principal-review-security.md",
  };
  const mutatingBadDef = {
    name: "unsafe-codemode-role",
    description: "Invalid mutating codemode",
    allowedTools: "read edit codemode",
    body: "Edit code.",
    source: "/fake/unsafe.md",
  };
  const defs = new Map([
    [readOnlyDef.name, readOnlyDef],
    [mutatingBadDef.name, mutatingBadDef],
  ]);
  const catalogWithoutOptional = await buildCatalog({
    cwd: process.cwd(),
    observedTools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
    snapshot: { skills: [], definitions: defs },
  });

  const okPlan = planDelegation(
    { agent: "review-security", task: "Audit auth.ts" },
    {
      ownGrant: ["tool:*", "agent:*"],
      gated: [],
      depth: 0,
      maxDepth: 4,
      definitions: defs,
      catalog: catalogWithoutOptional,
    },
  );
  assert.equal(okPlan.ok, true, okPlan.reason);
  assert.deepEqual(okPlan.effective, ["tool:find", "tool:grep", "tool:ls", "tool:parallel", "tool:read"]);

  const blockedMutating = planDelegation(
    { agent: "unsafe-codemode-role", task: "Edit" },
    {
      ownGrant: ["tool:*", "agent:*"],
      gated: [],
      depth: 0,
      maxDepth: 4,
      definitions: defs,
      catalog: catalogWithoutOptional,
    },
  );
  assert.equal(blockedMutating.ok, false);
  assert.match(blockedMutating.reason ?? "", /Codemode is permitted only/);

  const blockedExplicit = planDelegation(
    { tools: ["read", "codemode"], task: "Check" },
    { ownGrant: ["tool:*"], gated: [], depth: 0, maxDepth: 4, definitions: defs, catalog: catalogWithoutOptional },
  );
  assert.equal(blockedExplicit.ok, false);
  assert.match(blockedExplicit.reason ?? "", /unknown capability: tool:codemode/);
});
