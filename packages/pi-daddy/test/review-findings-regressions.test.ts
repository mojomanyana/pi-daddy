import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { readConfinedUntrackedFile } from "../extensions/review-scope.ts";
import {
  registerProjectMemoryOwner,
  PROJECT_MEMORY_OWNER_REQUEST,
  type ProjectMemoryOwner,
} from "../extensions/project-memory-owner.ts";
import { planDelegation } from "../src/kernel/delegate.ts";
import { buildCatalog } from "../src/kernel/catalog.ts";
import {
  computeObservedPeakActiveFromLedger,
  evaluateOrdinarySkillEdit,
  evaluateScoutAcceptance,
  makeSkippedTask,
  summarizeAcceptance,
} from "../scripts/benchmark-live-lib.ts";

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

  // 1a. PAIRED TEST A: ordinary task prose mentioning the exact same two repo paths as context MUST stay in cwd
  const nestedDir = join(repoA, "nested");
  const contextProseScope = resolveReviewScope(
    nestedDir,
    `Fix the local alpha helper in feature.ts; see "${repoA}" and "${repoB}" for context on how they format exports.`,
  );
  assert.equal(contextProseScope.mode, "workspace", "ordinary task prose mentioning two repo paths must NOT widen");
  assert.equal(contextProseScope.cwd, nestedDir);
  const contextProseDiff = await collectReviewDiff(nestedDir, contextProseScope);
  assert.match(contextProseDiff, /alpha = 2/);
  assert.doesNotMatch(contextProseDiff, /siblingA = 99/, "sibling outside nested workspace must stay excluded");
  assert.doesNotMatch(contextProseDiff, /beta = 2/, "context-only second repo must NOT enter workspace review");
  assert.doesNotMatch(contextProseDiff, /gamma = 999/, "unrelated third repo must stay excluded");

  // 1b. PAIRED TEST B: explicit multi-repo review using the exact same two repo paths widens to BOTH and excludes repoC
  const explicitPromptMultiScope = resolveReviewScope(
    nestedDir,
    `Perform a multi-repo review across "${repoA}" and "${repoB}"`,
  );
  assert.equal(explicitPromptMultiScope.mode, "multi-repo");
  assert.deepEqual(
    [...explicitPromptMultiScope.roots].sort(),
    [realpathSync(repoA), realpathSync(repoB)].sort(),
    "explicit multi-repo review must select both requested repository roots",
  );
  const explicitPromptMultiDiff = await collectReviewDiff(nestedDir, explicitPromptMultiScope);
  assert.match(explicitPromptMultiDiff, /alpha = 2/);
  assert.match(explicitPromptMultiDiff, /beta = 2/);
  assert.doesNotMatch(explicitPromptMultiDiff, /gamma = 999/, "unrelated third repo must remain excluded");

  // 1c. Exact original regression: “Review across A and B. Leave C out of the review.”
  const leaveOutCScope = resolveReviewScope(
    nestedDir,
    `Review across "${repoA}" and "${repoB}". Leave "${repoC}" out of the review.`,
  );
  assert.equal(leaveOutCScope.mode, "multi-repo");
  assert.deepEqual(
    [...leaveOutCScope.roots].sort(),
    [realpathSync(repoA), realpathSync(repoB)].sort(),
    "review across A and B with 'Leave C out' must select only A and B",
  );
  const leaveOutCBanner = formatReviewScopeBanner(leaveOutCScope);
  assert.match(leaveOutCBanner, /repo-alpha/);
  assert.match(leaveOutCBanner, /repo-beta/);
  assert.doesNotMatch(leaveOutCBanner, /repo-gamma/, "excluded repo-gamma must not appear in review scope banner");

  const leaveOutCDiff = await collectReviewDiff(nestedDir, leaveOutCScope);
  assert.match(leaveOutCDiff, /alpha = 2/);
  assert.match(leaveOutCDiff, /beta = 2/);
  assert.doesNotMatch(leaveOutCDiff, /gamma = 999/, "excluded repo-gamma dirty change must not appear in diff");

  // 1d. Neutral follow-up sentence mentioning C must NOT widen scope to C
  const neutralFollowUpScope = resolveReviewScope(
    nestedDir,
    `Review across "${repoA}" and "${repoB}". Note that "${repoC}" was touched yesterday for deployment.`,
  );
  assert.equal(neutralFollowUpScope.mode, "multi-repo");
  assert.deepEqual(
    [...neutralFollowUpScope.roots].sort(),
    [realpathSync(repoA), realpathSync(repoB)].sort(),
    "neutral follow-up mentioning C must not add C to selected roots",
  );
  const neutralFollowUpBanner = formatReviewScopeBanner(neutralFollowUpScope);
  assert.match(neutralFollowUpBanner, /repo-alpha/);
  assert.match(neutralFollowUpBanner, /repo-beta/);
  assert.doesNotMatch(
    neutralFollowUpBanner,
    /repo-gamma/,
    "neutral follow-up mention must not appear in review scope banner",
  );

  const neutralFollowUpDiff = await collectReviewDiff(nestedDir, neutralFollowUpScope);
  assert.match(neutralFollowUpDiff, /alpha = 2/);
  assert.match(neutralFollowUpDiff, /beta = 2/);
  assert.doesNotMatch(neutralFollowUpDiff, /gamma = 999/, "neutral follow-up mention dirty change must not be in diff");

  // 1e. Explicit review with exclusion phrasing selects ONLY A and B
  const excludeCScope = resolveReviewScope(nestedDir, `review across "${repoA}" and "${repoB}"; exclude "${repoC}"`);
  assert.equal(excludeCScope.mode, "multi-repo");
  assert.deepEqual(
    [...excludeCScope.roots].sort(),
    [realpathSync(repoA), realpathSync(repoB)].sort(),
    "explicit review with exclusion must only select affirmatively requested roots",
  );
  const excludeCBanner = formatReviewScopeBanner(excludeCScope);
  assert.match(excludeCBanner, /repo-alpha/);
  assert.match(excludeCBanner, /repo-beta/);
  assert.doesNotMatch(excludeCBanner, /repo-gamma/, "excluded repo-gamma must not appear in review scope banner");

  const excludeCDiff = await collectReviewDiff(nestedDir, excludeCScope);
  assert.match(excludeCDiff, /alpha = 2/);
  assert.match(excludeCDiff, /beta = 2/);
  assert.doesNotMatch(excludeCDiff, /gamma = 999/, "excluded repo-gamma dirty change must not appear in diff");

  // 1f. Explicit multi-repo review naming repo-alpha and repo-beta by folder name from workspace parent
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
  const ordinaryScope = resolveReviewScope(nestedDir, "Fix alpha constant and verify");
  assert.equal(ordinaryScope.mode, "workspace");
  const nestedDiff = await collectReviewDiff(nestedDir, ordinaryScope);
  assert.match(nestedDiff, /alpha = 2/);
  assert.doesNotMatch(nestedDiff, /siblingA = 99/, "sibling outside nested workspace must stay excluded");
  assert.doesNotMatch(nestedDiff, /beta = 2/);
  assert.doesNotMatch(nestedDiff, /gamma = 999/);
});

test("Review pass 2: untracked-file reads stay inside review scope, reject symlinks & TOCTOU swaps, and still review regular untracked files", async (t) => {
  const root = makeTempDir(t, "daddy-untracked-scope-");
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  const externalFile = join(outside, "external-fixture.txt");
  writeFileSync(externalFile, "EXTERNAL_FIXTURE_MUST_NEVER_LEAK_918273\n", "utf8");

  initGitRepo(repo, { "nested/base.ts": "export const base = 1;\n" });
  const nestedDir = join(repo, "nested");

  // Regular in-scope untracked file -> MUST enter review diff
  writeFileSync(join(nestedDir, "new-helper.ts"), "export const regularUntrackedReviewed = true;\n", "utf8");

  // Untracked symlink to external fixture -> MUST NEVER enter review diff
  const linkPath = join(nestedDir, "external-link.txt");
  let symlinkCreated = false;
  try {
    symlinkSync(externalFile, linkPath, "file");
    symlinkCreated = true;
  } catch {
    // On native Windows without Developer Mode / SeCreateSymbolicLinkPrivilege, file symlinks throw EPERM.
    // Linux CI and macOS always execute the real symlink assertion; Windows still verifies direct symlink/TOCTOU guards below.
  }

  const scope = resolveReviewScope(nestedDir, "Review new helper changes");
  const diff = await collectReviewDiff(nestedDir, scope);
  assert.match(diff, /regularUntrackedReviewed = true/, "regular in-scope untracked file must be included in diff");
  assert.doesNotMatch(diff, /EXTERNAL_FIXTURE_MUST_NEVER_LEAK_918273/, "external symlink target must never leak");
  if (symlinkCreated) {
    assert.doesNotMatch(diff, /external-link\.txt/, "untracked symlink entry must be rejected");
    assert.equal(readConfinedUntrackedFile(nestedDir, "external-link.txt", 4096), undefined);
  }

  // TOCTOU swap between inspection and open: custom open swaps in the external file fd -> must be rejected!
  const swapped = readConfinedUntrackedFile(nestedDir, "new-helper.ts", 4096, {
    open: (_p, flags) => openSync(externalFile, flags),
  });
  assert.equal(swapped, undefined, "file swapped to external target between inspection and open must be rejected");

  // Direct regular file read succeeds cleanly
  const okRead = readConfinedUntrackedFile(nestedDir, "new-helper.ts", 4096);
  assert.match(okRead ?? "", /regularUntrackedReviewed = true/);
});

test("Review pass 3: Scout acceptance uses structured evidence from matching scout_research invocation and rejects Daddy-only settlement or prose", () => {
  const validRef = {
    version: 1,
    producer: "pi-scout-research",
    kind: "research-brief",
    session: "a".repeat(64),
    sha256: "b".repeat(64),
    bytes: 512,
  };
  const baseDelegateCalls = [
    { tool: "delegate", toolCallId: "del-1", args: { agent: "scout-public", task: "Check Node 24" } },
    {
      tool: "scout_research",
      toolCallId: "scout-1",
      parentCallId: "del-1",
      args: { question: "Node 24", scope: "Official" },
    },
  ];
  const settledDaddyDelegate = {
    tool: "delegate",
    toolCallId: "del-1",
    isError: false,
    text: "Scout worker cleanup: confirmed. Scout worker cleanup: not-started (direct-urls mode; no Docker worker started).",
    details: { cleanup: { state: "settled" } },
  };

  // NEGATIVE 1 (Direct HTTPS): Daddy settled + prose claims cleanup, but matching scout_research lacks cleanup object
  const missingDirectCleanup = evaluateScoutAcceptance({
    mode: "direct-https",
    processOk: true,
    toolCalls: baseDelegateCalls,
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        parentCallId: "del-1",
        isError: false,
        text: "Scout worker cleanup: not-started (direct-urls mode; no Docker worker started).",
        details: { mode: "direct-urls", briefReference: validRef },
      },
    ],
  });
  assert.equal(missingDirectCleanup.ok, false);
  assert.equal(missingDirectCleanup.daddyDelegationSettled, true);
  assert.equal(missingDirectCleanup.validBriefReference, true);
  assert.equal(missingDirectCleanup.cleanupEvidenceValid, false);

  // NEGATIVE 2 (Docker): Daddy settled + prose claims confirmed, but scout_research ran direct-urls or lacks runtime.cleanup.confirmed
  const dockerMissingCleanup = evaluateScoutAcceptance({
    mode: "docker",
    processOk: true,
    toolCalls: baseDelegateCalls,
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        parentCallId: "del-1",
        isError: false,
        text: "Scout worker cleanup: confirmed.",
        details: { briefReference: validRef, runtime: { cleanup: { confirmed: false } } },
      },
    ],
  });
  assert.equal(dockerMissingCleanup.ok, false);
  assert.equal(dockerMissingCleanup.cleanupEvidenceValid, false);

  const dockerWrongMode = evaluateScoutAcceptance({
    mode: "docker",
    processOk: true,
    toolCalls: baseDelegateCalls,
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        parentCallId: "del-1",
        isError: false,
        text: "Scout worker cleanup: confirmed.",
        details: {
          mode: "direct-urls",
          briefReference: validRef,
          cleanup: { state: "not-started", workerStarted: false },
        },
      },
    ],
  });
  assert.equal(dockerWrongMode.ok, false);
  assert.equal(dockerWrongMode.cleanupEvidenceValid, false);

  // NEGATIVE: valid Scout result from a DIFFERENT invocation (parentCallId points to del-2, not del-1)
  const differentInvocation = evaluateScoutAcceptance({
    mode: "direct-https",
    processOk: true,
    toolCalls: [
      { tool: "delegate", toolCallId: "del-1", args: { agent: "scout-public", task: "Check" } },
      { tool: "delegate", toolCallId: "del-2", args: { agent: "other-agent", task: "Other" } },
      { tool: "scout_research", toolCallId: "scout-1", parentCallId: "del-2", args: { question: "Node 24" } },
    ],
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        parentCallId: "del-2",
        isError: false,
        text: "ok",
        details: {
          mode: "direct-urls",
          cleanup: { state: "not-started", workerStarted: false, mode: "direct-urls" },
          briefReference: validRef,
        },
      },
    ],
  });
  assert.equal(differentInvocation.ok, false);
  assert.equal(differentInvocation.matchingScoutInvocation, false);

  // NEGATIVE: orphan result with no matching start in toolCalls
  const orphanResult = evaluateScoutAcceptance({
    mode: "direct-https",
    processOk: true,
    toolCalls: [{ tool: "delegate", toolCallId: "del-1", args: { agent: "scout-public", task: "Check" } }],
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-orphan",
        parentCallId: "del-1",
        isError: false,
        text: "ok",
        details: {
          mode: "direct-urls",
          cleanup: { state: "not-started", workerStarted: false, mode: "direct-urls" },
          briefReference: validRef,
        },
      },
    ],
  });
  assert.equal(orphanResult.ok, false);
  assert.equal(orphanResult.matchingScoutInvocation, false);

  // NEGATIVE: Docker with missing affirmative worker execution evidence
  const dockerMissingExecution = evaluateScoutAcceptance({
    mode: "docker",
    processOk: true,
    toolCalls: baseDelegateCalls,
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        parentCallId: "del-1",
        isError: false,
        text: "ok",
        details: {
          mode: "docker",
          briefReference: validRef,
          runtime: { cleanup: { confirmed: true } },
        },
      },
    ],
  });
  assert.equal(dockerMissingExecution.ok, false);
  assert.equal(dockerMissingExecution.cleanupEvidenceValid, false);

  // NEGATIVE 3: Daddy settled with prose brief JSON, but NO matching scout_research invocation exists
  const missingScoutCall = evaluateScoutAcceptance({
    mode: "direct-https",
    processOk: true,
    toolCalls: [{ tool: "delegate", toolCallId: "del-1", args: { agent: "scout-public", task: "Check" } }],
    toolResults: [settledDaddyDelegate],
  });
  assert.equal(missingScoutCall.ok, false);
  assert.equal(missingScoutCall.matchingScoutInvocation, false);
  assert.equal(missingScoutCall.validBriefReference, false);
  assert.equal(missingScoutCall.cleanupEvidenceValid, false);

  // POSITIVE: distinct child execution ID with matching parent execution ID passes
  const okDistinctChildId = evaluateScoutAcceptance({
    mode: "direct-https",
    processOk: true,
    toolCalls: [
      { tool: "delegate", toolCallId: "del-1", executionId: "parent-exec-main", args: { agent: "scout-public" } },
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        executionId: "child-exec-distinct-88",
        parentExecutionId: "parent-exec-main",
        args: { question: "Node 24" },
      },
    ],
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        executionId: "child-exec-distinct-88",
        parentExecutionId: "parent-exec-main",
        isError: false,
        text: "ok",
        details: {
          mode: "direct-urls",
          cleanup: { state: "not-started", workerStarted: false, mode: "direct-urls" },
          briefReference: validRef,
          briefSha256: validRef.sha256,
        },
      },
    ],
  });
  assert.equal(okDistinctChildId.ok, true);
  assert.equal(okDistinctChildId.matchingScoutInvocation, true);

  // NEGATIVE: conflicting explicit parent execution ID fails
  const conflictingParentExec = evaluateScoutAcceptance({
    mode: "direct-https",
    processOk: true,
    toolCalls: [
      { tool: "delegate", toolCallId: "del-1", executionId: "parent-exec-main", args: { agent: "scout-public" } },
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        executionId: "child-exec-distinct-88",
        parentExecutionId: "parent-exec-WRONG",
        args: { question: "Node 24" },
      },
    ],
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        executionId: "child-exec-distinct-88",
        parentExecutionId: "parent-exec-WRONG",
        isError: false,
        text: "ok",
        details: {
          mode: "direct-urls",
          cleanup: { state: "not-started", workerStarted: false, mode: "direct-urls" },
          briefReference: validRef,
        },
      },
    ],
  });
  assert.equal(conflictingParentExec.ok, false);
  assert.equal(conflictingParentExec.matchingScoutInvocation, false);

  // NEGATIVE: ambiguous linkage with multiple scout_research invocations claiming the delegation fails
  const ambiguousLinkage = evaluateScoutAcceptance({
    mode: "direct-https",
    processOk: true,
    toolCalls: [
      { tool: "delegate", toolCallId: "del-1", executionId: "parent-exec-main", args: { agent: "scout-public" } },
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        parentCallId: "del-1",
        args: { question: "Node 24" },
      },
      {
        tool: "scout_research",
        toolCallId: "scout-2",
        parentCallId: "del-1",
        args: { question: "Node 24 (second attempt)" },
      },
    ],
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        parentCallId: "del-1",
        isError: false,
        text: "ok",
        details: {
          mode: "direct-urls",
          cleanup: { state: "not-started", workerStarted: false, mode: "direct-urls" },
          briefReference: validRef,
        },
      },
      {
        tool: "scout_research",
        toolCallId: "scout-2",
        parentCallId: "del-1",
        isError: false,
        text: "ok",
        details: {
          mode: "direct-urls",
          cleanup: { state: "not-started", workerStarted: false, mode: "direct-urls" },
          briefReference: validRef,
        },
      },
    ],
  });
  assert.equal(ambiguousLinkage.ok, false);
  assert.equal(ambiguousLinkage.matchingScoutInvocation, false);
  assert.ok(ambiguousLinkage.failureReasons.some((r) => /ambiguous/i.test(r)));

  // POSITIVE 1: Direct HTTPS with structured mode="direct-urls", cleanup={state:"not-started",workerStarted:false}, valid briefReference
  const okDirect = evaluateScoutAcceptance({
    mode: "direct-https",
    processOk: true,
    toolCalls: baseDelegateCalls,
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        parentCallId: "del-1",
        isError: false,
        text: "ok",
        details: {
          mode: "direct-urls",
          cleanup: { state: "not-started", workerStarted: false, mode: "direct-urls" },
          briefReference: validRef,
          briefSha256: validRef.sha256,
        },
      },
    ],
  });
  assert.equal(okDirect.ok, true);
  assert.equal(okDirect.validBriefReference, true);
  assert.equal(okDirect.cleanupEvidenceValid, true);

  // POSITIVE 2: Docker with structured affirmative worker execution + cleanup.confirmed === true and valid briefReference
  const okDocker = evaluateScoutAcceptance({
    mode: "docker",
    processOk: true,
    toolCalls: baseDelegateCalls,
    toolResults: [
      settledDaddyDelegate,
      {
        tool: "scout_research",
        toolCallId: "scout-1",
        parentCallId: "del-1",
        isError: false,
        text: "ok",
        details: {
          mode: "docker",
          briefReference: validRef,
          briefSha256: validRef.sha256,
          runtime: {
            container: "pi-scout-container-1",
            cleanup: { confirmed: true, containerAbsent: true },
            modelCallbackSettled: true,
            discoveryCallbackSettled: true,
          },
        },
      },
    ],
  });
  assert.equal(okDocker.ok, true);
  assert.equal(okDocker.validBriefReference, true);
  assert.equal(okDocker.cleanupEvidenceValid, true);
});

test("Review pass 4: benchmark reporting distinguishes skipped checks, selectedChecksPassed vs fullSuitePassed, and observed lifecycle peak active children", (t) => {
  const skipped = makeSkippedTask();
  assert.deepEqual(skipped, { status: "skipped", skipped: true, reason: "excluded by --only" });
  assert.equal("ok" in skipped, false);
  assert.equal("expectedFindingsScore" in skipped, false);

  // 1. Required-but-blocked Docker reports blocked, selectedChecksPassed false, fullSuitePassed false
  const blockedDockerSummary = summarizeAcceptance([
    { id: "task4.scout.directHttps", required: true, status: "passed", passed: true, detail: "ok" },
    { id: "task4.scout.docker", required: true, status: "blocked", passed: false, detail: "daemon unavailable" },
  ]);
  assert.equal(blockedDockerSummary.selectedChecksPassed, false);
  assert.equal(blockedDockerSummary.fullSuitePassed, false);
  assert.deepEqual(blockedDockerSummary.blockedCheckIds, ["task4.scout.docker"]);
  assert.equal(blockedDockerSummary.failedRequired.length, 1);

  // 2. Executed-but-failed optional Docker preserves selectedChecksPassed true but fullSuitePassed false
  const optionalFailedDockerSummary = summarizeAcceptance([
    { id: "task4.scout.directHttps", required: true, status: "passed", passed: true, detail: "ok" },
    { id: "task4.scout.docker", required: false, status: "failed", passed: false, detail: "failed container" },
  ]);
  assert.equal(optionalFailedDockerSummary.selectedChecksPassed, true);
  assert.equal(optionalFailedDockerSummary.fullSuitePassed, false);
  assert.deepEqual(optionalFailedDockerSummary.failedCheckIds, ["task4.scout.docker"]);

  // 3. Successful deliberately filtered run reports selectedChecksPassed true, fullSuitePassed false
  const filteredSummary = summarizeAcceptance([
    { id: "task2c.ordinarySkillEdit.standard", required: true, status: "passed", passed: true, detail: "ok" },
    { id: "task3b.explicitReviewerDelegation.standard", required: true, status: "passed", passed: true, detail: "ok" },
    { id: "task1.simpleEdit.candidate", required: true, status: "skipped", passed: null, detail: "excluded by --only" },
    { id: "task4.scout.directHttps", required: true, status: "skipped", passed: null, detail: "excluded by --only" },
  ]);
  assert.equal(filteredSummary.selectedChecksPassed, true);
  assert.equal(filteredSummary.fullSuitePassed, false);
  assert.deepEqual(filteredSummary.skippedCheckIds, ["task1.simpleEdit.candidate", "task4.scout.directHttps"]);

  const fullSummary = summarizeAcceptance([
    { id: "a", required: true, status: "passed", passed: true, detail: "ok" },
    { id: "b", required: true, status: "passed", passed: true, detail: "ok" },
  ]);
  assert.equal(fullSummary.selectedChecksPassed, true);
  assert.equal(fullSummary.fullSuitePassed, true);
  assert.deepEqual(fullSummary.skippedCheckIds, []);

  const failedSummary = summarizeAcceptance([
    { id: "a", required: true, status: "passed", passed: true, detail: "ok" },
    { id: "b", required: true, status: "failed", passed: false, detail: "failed" },
  ]);
  assert.equal(failedSummary.selectedChecksPassed, false);
  assert.equal(failedSummary.fullSuitePassed, false);

  // Observed peak active children computed strictly from real child_lifecycle ledger entries (both envelope and raw)
  const dir = makeTempDir(t, "daddy-ledger-peak-");
  const ledger = join(dir, "grants.jsonl");
  writeFileSync(
    ledger,
    [
      JSON.stringify({
        kind: "lifecycle",
        body: { event: "child_lifecycle", executionId: "exec-1", state: "starting" },
      }),
      JSON.stringify({
        kind: "lifecycle",
        body: { event: "child_lifecycle", executionId: "exec-2", state: "starting" },
      }),
      JSON.stringify({
        kind: "lifecycle",
        body: { event: "child_lifecycle", executionId: "exec-1", state: "completed" },
      }),
      JSON.stringify({
        kind: "lifecycle",
        body: { event: "child_lifecycle", executionId: "exec-3", state: "running" },
      }),
      JSON.stringify({
        kind: "lifecycle",
        body: { event: "child_lifecycle", executionId: "exec-2", state: "completed" },
      }),
      JSON.stringify({ kind: "lifecycle", body: { event: "child_lifecycle", executionId: "exec-3", state: "failed" } }),
    ].join("\n") + "\n",
    "utf8",
  );
  const obs = computeObservedPeakActiveFromLedger(ledger);
  assert.equal(obs.observedPeakActiveChildren, 2);
  assert.equal(obs.lifecycleEventCount, 6);
  assert.equal(computeObservedPeakActiveFromLedger(join(dir, "missing.jsonl")).observedPeakActiveChildren, null);
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

test("Review pass 5: ordinary skill-edit requires observed Harness verification of changed behavior and reports extra scenarios separately", () => {
  const beforeText = "# Release Tagger\nPrefix tags with `v`.\n";
  const afterText = "# Release Tagger\nPrefix tags with lowercase `v` (never uppercase `V`).\n";

  // Regression: edit succeeds but Harness never runs -> behavioral check fails
  const noHarness = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    toolCalls: [{ tool: "edit", args: { path: "SKILL.md" } }],
    toolResults: [{ tool: "edit", isError: false, text: "ok" }],
  });
  assert.equal(noHarness.ok, false);
  assert.equal(noHarness.skillEdited, true);
  assert.equal(noHarness.harnessInvoked, false);
  assert.equal(noHarness.requiredScenarioPassed, false);
  assert.ok(noHarness.failureReasons.some((r) => /never invoked/i.test(r)));

  // Regression: edit succeeds, Harness runs but does NOT evaluate required scenario "tag-prefix"
  const missingScenario = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["notes-commit"] } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: {
          scenarios: [{ id: "notes-commit", verdict: "PASS" }],
          coverage: { scenariosRun: ["notes-commit"] },
        },
      },
    ],
  });
  assert.equal(missingScenario.ok, false);
  assert.equal(missingScenario.harnessInvoked, true);
  assert.equal(missingScenario.requiredScenarioPassed, false);

  // Positive: edit succeeds, Harness runs required "tag-prefix" (PASS) and extra scenario "notes-commit"
  const okEval = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["tag-prefix", "notes-commit"] } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: {
          scenarios: [
            { id: "tag-prefix", verdict: "PASS" },
            { id: "notes-commit", verdict: "PASS" },
          ],
          coverage: { scenariosRun: ["tag-prefix", "notes-commit"] },
        },
      },
    ],
  });
  assert.equal(okEval.ok, true);
  assert.equal(okEval.skillEdited, true);
  assert.equal(okEval.harnessInvoked, true);
  assert.equal(okEval.requiredScenarioPassed, true);
  assert.equal(okEval.requiredScenario, "tag-prefix");
  assert.deepEqual(okEval.extraScenariosRun, ["notes-commit"]);

  // Timeline regression 1: PASS → edit → FAIL (must fail)
  const passEditFail = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    toolCalls: [
      { tool: "skill_check_run", toolCallId: "h-1" },
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-2" },
    ],
    toolResults: [
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-2",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "FAIL" }] },
      },
    ],
  });
  assert.equal(passEditFail.ok, false);
  assert.equal(passEditFail.requiredScenarioPassed, false);
  assert.equal(passEditFail.latestApplicableVerdict, "FAIL");

  // Timeline regression 2: FAIL → fix → PASS (must pass)
  const failFixPass = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1" },
      { tool: "edit", toolCallId: "e-2", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-2", args: { scenarios: ["tag-prefix", "notes-commit"] } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "FAIL" }] },
      },
      { tool: "edit", toolCallId: "e-2", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-2",
        isError: false,
        details: {
          scenarios: [
            { id: "tag-prefix", verdict: "PASS" },
            { id: "notes-commit", verdict: "PASS" },
          ],
          coverage: { scenariosRun: ["tag-prefix", "notes-commit"] },
        },
      },
    ],
  });
  assert.equal(failFixPass.ok, true);
  assert.equal(failFixPass.requiredScenarioPassed, true);
  assert.equal(failFixPass.latestApplicableVerdict, "PASS");
  assert.deepEqual(failFixPass.extraScenariosRun, ["notes-commit"]);

  // Timeline regression 3: PASS → edit with no rerun (insufficient evidence / must fail)
  const passEditNoRerun = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    toolCalls: [
      { tool: "skill_check_run", toolCallId: "h-1" },
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
    ],
    toolResults: [
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
    ],
  });
  assert.equal(passEditNoRerun.ok, false);
  assert.equal(passEditNoRerun.rerunAfterFinalEdit, false);
  assert.equal(passEditNoRerun.requiredScenarioPassed, false);
  assert.ok(passEditNoRerun.failureReasons.some((r) => /insufficient evidence/i.test(r)));

  // Focused regression 1: PASS → edit-diff on SKILL.md → no rerun must fail
  const passEditDiffNoRerun = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    toolCalls: [
      { tool: "skill_check_run", toolCallId: "h-1" },
      { tool: "edit-diff", toolCallId: "ed-1", args: { path: "SKILL.md" } },
    ],
    toolResults: [
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      { tool: "edit-diff", toolCallId: "ed-1", isError: false, text: "ok" },
    ],
  });
  assert.equal(passEditDiffNoRerun.ok, false);
  assert.equal(passEditDiffNoRerun.rerunAfterFinalEdit, false);
  assert.equal(passEditDiffNoRerun.requiredScenarioPassed, false);
  assert.ok(passEditDiffNoRerun.failureReasons.some((r) => /insufficient evidence/i.test(r)));

  // Regression: Fixture edit → tag-prefix PASS → linked tag-prefix FAIL with isError:true
  const editPassFailError = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    fixtureDir: "/fake/fixture",
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["tag-prefix"] } },
      { tool: "skill_check_run", toolCallId: "h-2", args: { scenarios: ["tag-prefix"] } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      {
        tool: "skill_check_run",
        toolCallId: "h-2",
        isError: true,
        details: { scenarios: [{ id: "tag-prefix", verdict: "FAIL" }] },
      },
    ],
  });
  assert.equal(editPassFailError.ok, false);
  assert.equal(editPassFailError.requiredScenarioPassed, false);
  assert.equal(editPassFailError.latestApplicableVerdict, "FAIL");

  // Regression: Fixture edit → tag-prefix PASS → another tag-prefix call with no completion
  const editPassCallNoCompletion = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    fixtureDir: "/fake/fixture",
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["tag-prefix"] } },
      { tool: "skill_check_run", toolCallId: "h-2", args: { scenarios: ["tag-prefix"] } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      // h-2 has no completion in toolResults!
    ],
  });
  assert.equal(editPassCallNoCompletion.ok, false);
  assert.equal(editPassCallNoCompletion.requiredScenarioPassed, false);
  assert.equal(editPassCallNoCompletion.latestApplicableVerdict, null);
  assert.ok(editPassCallNoCompletion.failureReasons.some((r) => /no completion/i.test(r)));

  // Regression: Fixture edit → tag-prefix PASS → write other/SKILL.md must not move fixture boundary
  const editPassWriteOtherSkillMd = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    fixtureDir: "/fake/fixture",
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["tag-prefix"] } },
      { tool: "write", toolCallId: "w-other", args: { path: "other/SKILL.md" } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      { tool: "write", toolCallId: "w-other", isError: false, text: "ok" },
    ],
  });
  assert.equal(editPassWriteOtherSkillMd.ok, true);
  assert.equal(editPassWriteOtherSkillMd.requiredScenarioPassed, true);
  assert.equal(editPassWriteOtherSkillMd.latestApplicableVerdict, "PASS");

  // Regression: A mutation with no matching completion must fail (no default-success)
  const mutationNoCompletion = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    fixtureDir: "/fake/fixture",
    toolCalls: [
      { tool: "edit", toolCallId: "e-uncompleted", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["tag-prefix"] } },
    ],
    toolResults: [
      // e-uncompleted has no completion in toolResults
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
    ],
  });
  assert.equal(mutationNoCompletion.ok, false);
  assert.ok(mutationNoCompletion.failureReasons.some((r) => /cannot establish the mutation boundary/i.test(r)));

  // Regression: Harness call/result pair with missing IDs must fail (no tool-name-only fallback)
  const harnessMissingCallId = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    fixtureDir: "/fake/fixture",
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run" }, // missing toolCallId
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run", // missing toolCallId
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
    ],
  });
  assert.equal(harnessMissingCallId.ok, false);
  assert.equal(harnessMissingCallId.requiredScenarioPassed, false);
  assert.ok(harnessMissingCallId.failureReasons.some((r) => /no completion/i.test(r)));

  // Regression: A later run explicitly limited to an unrelated scenario leaves the required verdict intact
  const passFollowedByUnrelatedRun = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    fixtureDir: "/fake/fixture",
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["tag-prefix"] } },
      { tool: "skill_check_run", toolCallId: "h-2", args: { scenarios: ["notes-commit"] } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      {
        tool: "skill_check_run",
        toolCallId: "h-2",
        isError: false,
        details: { scenarios: [{ id: "notes-commit", verdict: "PASS" }] },
      },
    ],
  });
  assert.equal(passFollowedByUnrelatedRun.ok, true);
  assert.equal(passFollowedByUnrelatedRun.requiredScenarioPassed, true);
  assert.equal(passFollowedByUnrelatedRun.latestApplicableVerdict, "PASS");

  // Focused regression 2: PASS → edit SKILL.md → Harness call with no matching result must fail
  const passEditHarnessNoResult = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    toolCalls: [
      { tool: "skill_check_run", toolCallId: "h-1" },
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-2" },
    ],
    toolResults: [
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      // h-2 has no matching result in toolResults!
    ],
  });
  assert.equal(passEditHarnessNoResult.ok, false);
  assert.equal(passEditHarnessNoResult.requiredScenarioPassed, false);
  assert.equal(passEditHarnessNoResult.latestApplicableVerdict, null);
  assert.ok(passEditHarnessNoResult.failureReasons.some((r) => /no completion/i.test(r)));

  // Focused regression 3: Edit SKILL.md → matching PASS → write an unrelated file must still pass
  const editPassWriteUnrelated = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1" },
      { tool: "write", toolCallId: "w-unrelated", args: { path: "notes.txt" } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: {
          scenarios: [
            { id: "tag-prefix", verdict: "PASS" },
            { id: "notes-commit", verdict: "PASS" },
          ],
          coverage: { scenariosRun: ["tag-prefix", "notes-commit"] },
        },
      },
      { tool: "write", toolCallId: "w-unrelated", isError: false, text: "ok" },
    ],
  });
  assert.equal(editPassWriteUnrelated.ok, true);
  assert.equal(editPassWriteUnrelated.skillEdited, true);
  assert.equal(editPassWriteUnrelated.requiredScenarioPassed, true);
  assert.equal(editPassWriteUnrelated.latestApplicableVerdict, "PASS");
  assert.deepEqual(editPassWriteUnrelated.extraScenariosRun, ["notes-commit"]);

  // Focused regression 4: File changed but trace cannot establish mutation boundary -> insufficient evidence
  const fileChangedNoTrace = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    toolCalls: [{ tool: "skill_check_run", toolCallId: "h-1" }],
    toolResults: [
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
    ],
  });
  assert.equal(fileChangedNoTrace.ok, false);
  assert.ok(fileChangedNoTrace.failureReasons.some((r) => /insufficient evidence/i.test(r)));

  // Regression: Confirmed SKILL.md edit → linked tag-prefix PASS → another SKILL.md edit with no completion
  const editPassUncompletedEdit = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    fixtureDir: "/fake/fixture",
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["tag-prefix"] } },
      { tool: "edit", toolCallId: "e-2", args: { path: "SKILL.md" } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      // e-2 has no completion in toolResults!
    ],
  });
  assert.equal(editPassUncompletedEdit.ok, false);
  assert.ok(editPassUncompletedEdit.failureReasons.some((r) => /insufficient evidence/i.test(r)));

  // Regression: Confirmed SKILL.md edit → linked tag-prefix PASS → another SKILL.md edit with duplicate completions
  const editPassDuplicateCompletions = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    fixtureDir: "/fake/fixture",
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["tag-prefix"] } },
      { tool: "edit", toolCallId: "e-2", args: { path: "SKILL.md" } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      { tool: "edit", toolCallId: "e-2", isError: false, text: "ok 1" },
      { tool: "edit", toolCallId: "e-2", isError: false, text: "ok 2" },
    ],
  });
  assert.equal(editPassDuplicateCompletions.ok, false);
  assert.ok(editPassDuplicateCompletions.failureReasons.some((r) => /insufficient evidence/i.test(r)));

  // Case-sensitivity: confirmed SKILL.md edit → linked tag-prefix PASS → write distinct skill.md stays passing
  const caseSensitiveDistinct = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    fixtureDir: "/fake/fixture",
    caseSensitive: true,
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["tag-prefix"] } },
      { tool: "write", toolCallId: "w-distinct", args: { path: "skill.md" } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      { tool: "write", toolCallId: "w-distinct", isError: false, text: "ok" },
    ],
  });
  assert.equal(caseSensitiveDistinct.ok, true);
  assert.equal(caseSensitiveDistinct.requiredScenarioPassed, true);
  assert.equal(caseSensitiveDistinct.latestApplicableVerdict, "PASS");

  // Native Windows case-insensitive behavior: write to skill.md is the same file as SKILL.md
  const caseInsensitiveSame = evaluateOrdinarySkillEdit({
    processOk: true,
    beforeText,
    afterText,
    fixtureDir: "/fake/fixture",
    caseSensitive: false,
    toolCalls: [
      { tool: "edit", toolCallId: "e-1", args: { path: "SKILL.md" } },
      { tool: "skill_check_run", toolCallId: "h-1", args: { scenarios: ["tag-prefix"] } },
      { tool: "write", toolCallId: "w-same", args: { path: "skill.md" } },
    ],
    toolResults: [
      { tool: "edit", toolCallId: "e-1", isError: false, text: "ok" },
      {
        tool: "skill_check_run",
        toolCallId: "h-1",
        isError: false,
        details: { scenarios: [{ id: "tag-prefix", verdict: "PASS" }] },
      },
      { tool: "write", toolCallId: "w-same", isError: false, text: "ok" },
    ],
  });
  assert.equal(caseInsensitiveSame.ok, false);
});
