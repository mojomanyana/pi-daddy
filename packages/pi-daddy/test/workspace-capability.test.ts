/**
 * ADR-0035's namespace, at every site that has to know about it.
 *
 * **Why this file is organised by SITE rather than by behaviour.** ADR-0035 minted `workspace:<id>` and
 * taught three places about it — `normaliseCapability`, `resolve()`'s wildcard rule, and `childEnv`'s
 * inheritance filter — out of the nine that already knew about `agent:`. Two review passes then found one
 * defect per untaught site, and the severe one made the ADR's own Decision unreachable in production:
 * `unknownCapabilities` refused every `workspace:<id>` as *"a typo, or an uninstalled package"*, so no
 * child could ever hold a workspace capability and routing stopped dead below the root instead of
 * attenuating. `resolve.test.ts` already covers the three sites that were right. This file covers the six
 * that were not, and it is deliberately a checklist: **a tenth site, or a fifth namespace, adds a case
 * here.** That is the only form of the lesson that survives a session ending.
 *
 * Every test names the production edit that breaks it (rule 7). None of them passes on `92ccbb8`.
 *
 * Cases are labelled by SITE NAME, not by number. They were numbered, and the numbers said 4, 5, 6, 8, 10 —
 * implying ten sites where every document said nine, with the two missing numbers landing on the two sites
 * that had no case at all. A count is a claim, and this file exists because a count was wrong.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmod, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { planDelegation } from "../src/delegate.ts";
import { makeCatalog, classifyToolNames, unknownCapabilities, workspaceEntries } from "../src/catalog.ts";
import { WORKSPACE_WILDCARD, resolve } from "../src/resolve.ts";
import { ENV_APPROVED, ENV_GRANT, inheritableGrant } from "../src/propagation.ts";
import { ceilingForDefinition, type SkillDefinition } from "../src/definitions.ts";
import { loadWorkspaceRegistry, registeredWorkspaceIds, resolveWorkspace } from "../src/workspace.ts";

import { buildCatalog } from "../src/catalog.ts";
import { DELEGATE_SUBJECT, type InheritableApproval } from "../src/approval.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/** A catalog is ALWAYS present in production — `delegationContext()` awaits `catalogReady`. */
const catalog = makeCatalog([
  ...classifyToolNames(["read", "write", "delegate", "bash"]),
  ...workspaceEntries({ version: 1, workspaces: { prod: { path: "/w/prod" }, staging: { path: "/w/staging" } } }),
]);

const ctx = (over: Record<string, unknown> = {}) => ({
  ownGrant: ["tool:read", "tool:delegate", "workspace:prod"],
  depth: 0,
  maxDepth: 3,
  gated: [],
  approved: [] as InheritableApproval[],
  catalog,
  ...over,
});

/**
 * SITE — `catalog.ts` `unknownCapabilities`. The one that mattered most.
 *
 * Breaks by: removing `workspace:` from the `exempt` predicate in `unknownCapabilities`.
 *
 * Probe g36 could not catch this because it appends `workspace:prod` to `ownGrant` by hand and never builds
 * a catalog, so it measured a path production does not take.
 */
test("a child CAN be granted a workspace capability — with a catalog present, as production always has", () => {
  const plan = planDelegation({ task: "t", tools: ["read", "workspace:prod"] }, ctx() as never);
  assert.equal(plan.ok, true, plan.reason ?? "should be grantable");
  assert.deepEqual(plan.effective, ["tool:read", "workspace:prod"]);

  // And the unknown check itself: exempt as a NAMESPACE, so an id absent from the registry still passes
  // here and is refused precisely later, by `resolveWorkspace`, with WORKSPACE_NOT_REGISTERED.
  assert.deepEqual(unknownCapabilities(["workspace:prod", "workspace:never-registered", WORKSPACE_WILDCARD], catalog), []);
  assert.deepEqual(unknownCapabilities(["tool:nonexistent"], catalog), ["tool:nonexistent"]);
});

/**
 * The three-level transitivity test R-26 was found by, in the new namespace.
 *
 * Breaks by: removing the `mayRouteToWorkspace` guard in `planDelegation`, OR by re-breaking site 4 — with
 * the catalog check in place the middle step cannot hold the capability at all, so level 3 is unreachable
 * for the wrong reason and this test stops meaning what it says.
 */
test("routing attenuates three levels down, and terminates where the id was not handed on", () => {
  // Level 1: a root holding both routes a child to prod, and hands on ONLY staging.
  const toChild = planDelegation(
    { task: "t", tools: ["read", "delegate", "workspace:staging"], boundWorkspaceId: "prod" },
    ctx({ ownGrant: ["tool:read", "tool:delegate", "workspace:prod", "workspace:staging"] }) as never,
  );
  assert.equal(toChild.ok, true, toChild.reason ?? "root may route to prod");
  const childGrant = toChild.env[ENV_GRANT].split(",");
  assert.equal(childGrant.includes("workspace:staging"), true, "the id it was given descends");
  assert.equal(childGrant.includes("workspace:prod"), false, "the id it was NOT given does not");

  // Level 2 → 3: that child may route a grandchild to staging...
  const childCtx = ctx({ ownGrant: childGrant, depth: 1 });
  assert.equal(planDelegation({ task: "t", tools: ["read"], boundWorkspaceId: "staging" }, childCtx as never).ok, true);

  // ...and may NOT route it to prod. This is R-131's exact escalation, refused.
  const escalation = planDelegation({ task: "t", tools: ["read"], boundWorkspaceId: "prod" }, childCtx as never);
  assert.equal(escalation.ok, false);
  assert.equal(escalation.refusal?.code, "WORKSPACE_NOT_AUTHORIZED");
  assert.deepEqual(escalation.result.denied, ["workspace:prod"], "recorded where isEscalationAttempt looks");
});

/**
 * SITE — `delegate.ts`, the path a DELEGATED child's grant actually travels.
 *
 * Breaks by: deleting the `NARROWING_VIOLATED` refusal. (An earlier docstring here also named "reverting
 * `delegate.ts` to `result.effective`" — that edit fails the R-135 case below, not this one, as R-135's own
 * docstring says. A breaker list that names the wrong case is the same defect as one that names none: it
 * tells the next reader a guard is defended when something else is defending it.)
 *
 * The pre-existing test for this rule asserted on `childEnv`, which is the *interceptor* path — so the rule
 * was enforced on one route and advertised for both.
 */
test("`workspace:*` cannot be handed to a child by either route", () => {
  // The delegation route refuses outright rather than stripping: a child recorded as granted something it
  // does not receive is a ledger asserting authority nobody has, which is R-131 inverted.
  const handed = planDelegation(
    { task: "t", tools: ["read", "workspace:*"] },
    ctx({ ownGrant: ["tool:read", "tool:delegate", WORKSPACE_WILDCARD] }) as never,
  );
  assert.equal(handed.ok, false);
  assert.equal(handed.refusal?.code, "NARROWING_VIOLATED");
  assert.match(handed.reason ?? "", /held, never inherited/);

  // And the shared rule, which both routes now call.
  assert.deepEqual(inheritableGrant(["tool:read", "tool:*", WORKSPACE_WILDCARD, "workspace:prod", "agent:*"]), [
    "tool:read", "workspace:prod", "agent:*",
  ]);
});

/**
 * R-135, and it is NOT an ADR-0035 defect — it is R-26's own rule, unenforced on the primary path since
 * ADR-0016 made this package the spawner.
 *
 * *"A root may HOLD `tool:*` … but handing it down would let every descendant reacquire the full catalog,
 * which makes attenuation meaningless below the root"* is `childEnv`'s docstring, and `childEnv` is the
 * INTERCEPTOR path — the one ADR-0016 demoted to a tripwire. `delegate.ts` built the child's
 * `PI_GRANTS_GRANT` from `result.effective` with no filter, and `tool:*` is not in `UNIVERSAL_CAPABILITIES`
 * (only `fabric_exec` is), so `assertNarrowing` never stopped it either. Measured on `92ccbb8`: a parent
 * holding `tool:*` and delegating `tools: ["tool:*"]` produced `PI_GRANTS_GRANT="tool:*"` in the child, so
 * that child could hand its own grandchildren anything at all. Attenuation ended at the root.
 *
 * This is the test that makes the `inheritableGrant` call site falsifiable: reverting `delegate.ts` to
 * `result.effective` fails HERE and nowhere else, because the `workspace:*` case is refused upstream and so
 * can never exercise the filter.
 *
 * Breaks by: `const inheritable = result.effective;` in `delegate.ts`.
 */
test("R-135: a delegated child never inherits `tool:*`, on the path that actually spawns", () => {
  const plan = planDelegation(
    { task: "t", tools: ["tool:*"] },
    { ownGrant: ["tool:*"], depth: 0, maxDepth: 3, gated: [], approved: [] } as never,
  );
  assert.equal(plan.ok, true, "granting it is allowed — governance is opt-in and a root may hold it");
  assert.deepEqual(plan.effective, ["tool:*"], "and the record says what was granted");
  assert.equal(plan.env[ENV_GRANT], "", "but the child inherits the ENUMERATED grant only — here, nothing");

  // `tool:*` keeps its established silent strip rather than joining `workspace:*`'s refusal, and the
  // asymmetry is deliberate: an ungoverned session's own grant IS `tool:*`, so refusing to spawn from one
  // would break governance-is-opt-in. `workspace:*` is only ever in `requested` because somebody asked.
  const alongside = planDelegation(
    { task: "t", tools: ["tool:*", "read"] },
    { ownGrant: ["tool:*"], depth: 0, maxDepth: 3, gated: [], approved: [] } as never,
  );
  assert.equal(alongside.env[ENV_GRANT], "tool:read", "the enumerated part still descends");
});

/**
 * An approval descends only for a capability the child actually holds.
 *
 * **This case does NOT guard `delegate.ts`'s `ENV_APPROVED` clamp, and an earlier docstring claimed it did.**
 * It said "breaks by reverting `ENV_APPROVED` to clamp against `result.effective`"; a mutation audit applied
 * exactly that and the suite stayed green. Two reasons, both worth keeping written down: `inheritApprovals`
 * already drops `WILDCARD` internally, and the only other difference — `WORKSPACE_WILDCARD` — cannot reach
 * `result.effective` at all, because the `NARROWING_VIOLATED` refusal rejects it first. So the clamp is
 * **unreachable defence-in-depth**, in the same category as `assertCapabilitiesArePropagatable`, whose own
 * comment says it "should be unreachable — which is exactly why it exists".
 *
 * Kept, because a backstop behind one guard is cheap and this codebase has been bitten by removing them. The
 * false claim is what got deleted. What this case DOES pin: an approval for a held capability reaches the
 * child, which breaks if `inheritApprovals` stops matching or if site 4 regresses.
 */
test("inherited approvals are clamped to what the child actually inherits", () => {
  const plan = planDelegation(
    { task: "t", tools: ["read", "workspace:prod"] },
    ctx({
      ownGrant: ["tool:read", "tool:delegate", "workspace:prod"],
      approved: [{ capability: "workspace:prod", subject: DELEGATE_SUBJECT, scope: "session" }],
    }) as never,
  );
  assert.equal(plan.ok, true, plan.reason ?? "");
  assert.equal(plan.env[ENV_GRANT].split(",").includes("workspace:prod"), true);
  assert.equal((plan.env[ENV_APPROVED] ?? "").includes("workspace:prod"), true, "held, so the approval descends");
});

/**
 * SITE — `delegation-approval.ts`. ADR-0035 claimed this in three places and never built it.
 *
 * Breaks by: deleting the `boundWorkspaceId` call to `gateAuthority` in `resolveDelegationApproval`.
 *
 * The control is the load-bearing half: gating an ordinary requested tool must still work through the same
 * call, so a green test here cannot be "the gate is broken for everything".
 */
test("PI_GRANTS_GATED=workspace:<id> asks a human before routing there", () => {
  const gated = planDelegation(
    { task: "t", tools: ["read"], boundWorkspaceId: "prod" },
    ctx({ gated: ["workspace:prod"] }) as never,
  );
  assert.equal(gated.ok, false, "a gated routing authority must not proceed unasked");
  assert.deepEqual(gated.result.gatedBlocked, ["workspace:prod"]);
  // Never in `requested`/`effective`: this is the PARENT spending its authority now, not something the
  // child is handed — ADR-0024's rule for `agent:<name>`, which this shares.
  assert.equal(gated.requested.includes("workspace:prod"), false);

  // `workspace:*` in the gate covers every id, as `agent:*` does.
  const byWildcard = planDelegation(
    { task: "t", tools: ["read"], boundWorkspaceId: "prod" },
    ctx({ gated: [WORKSPACE_WILDCARD] }) as never,
  );
  assert.deepEqual(byWildcard.result.gatedBlocked, ["workspace:prod"]);

  // Approved, it proceeds — the ordinary approval path, not a second mechanism.
  const approved = planDelegation(
    { task: "t", tools: ["read"], boundWorkspaceId: "prod" },
    ctx({
      gated: ["workspace:prod"],
      approved: [{ capability: "workspace:prod", subject: DELEGATE_SUBJECT, scope: "session" }],
    }) as never,
  );
  assert.equal(approved.ok, true, approved.reason ?? "an approved routing authority proceeds");

  // CONTROL: the same call still gates an ordinary requested capability.
  const control = planDelegation(
    { task: "t", tools: ["read"], boundWorkspaceId: "prod" },
    ctx({ gated: ["tool:read"] }) as never,
  );
  assert.deepEqual(control.result.gatedBlocked, ["tool:read"]);
});

/**
 * SITE — `definitions.ts` `ceilingForDefinition`.
 *
 * Breaks by: dropping `workspace:` from `CAPABILITY_NAMESPACE_PREFIXES`, which is now the single list
 * `normaliseCapability` reads too — so one edit can no longer make the two disagree.
 */
test("a definition may declare a workspace it routes to, and the id survives intact", () => {
  const def: SkillDefinition = {
    name: "deployer", description: "deploys", allowedTools: "Read, workspace:prod, agent:helper",
    body: "b", source: "/skills/deployer/SKILL.md",
  };
  assert.deepEqual(ceilingForDefinition(def).capabilities, ["agent:helper", "tool:read", "workspace:prod"]);
  // Not `tool:workspace:prod` — the bug this replaces produced a capability that names nothing, was refused
  // as unknown, and made `init` discard the whole definition as "probably a typo or an attack".
});

/**
 * SITE — `resolve.ts` `subsumedBy`, which contradicted its own F9 rule.
 *
 * Breaks by: removing the `anyWorkspace` clause from `subsumedBy`.
 */
test("a wildcard holder is not told its own namespace is `subsumed`", () => {
  assert.deepEqual(resolve({ requested: ["workspace:prod"], parentGrant: [WORKSPACE_WILDCARD], gated: [] }).subsumedBy, []);
  // The three wildcards agree, which is the property that kept drifting.
  assert.deepEqual(resolve({ requested: ["agent:x"], parentGrant: ["agent:*"], gated: [] }).subsumedBy, []);
  assert.deepEqual(resolve({ requested: ["tool:read"], parentGrant: ["tool:*"], gated: [] }).subsumedBy, []);
  // Still reported where it means something: `bash` really is broader than the list suggests.
  assert.deepEqual(resolve({ requested: ["tool:grep"], parentGrant: ["tool:bash"], gated: [] }).subsumedBy, ["tool:grep"]);
});

/**
 * The registry became an input to the GRANT GRAMMAR when ADR-0035 made an id the tail of a capability id.
 *
 * Breaks by: deleting the `isWellFormedCapability` check in `loadWorkspaceRegistry`. 0.18.1 was a security
 * release for exactly one comma: `workspace:a,b` in a grant splits into `workspace:a` **plus `tool:b`**.
 */
test("a registry id that would not survive the grant grammar is refused at load", async () => {
  const dir = await tempDir("pi-daddy-ws-id-");
  const write = async (name: string, body: unknown) => {
    const p = join(dir, name);
    await writeFile(p, JSON.stringify(body), "utf8");
    return p;
  };

  const comma = await write("comma.json", { version: 1, workspaces: { "a,b": { path: "/w/a" } } });
  await assert.rejects(loadWorkspaceRegistry(comma), (e: Error & { code?: string }) => {
    assert.equal(e.code, "GRANT_ID_MALFORMED");
    assert.match(e.message, /comma/);
    return true;
  });

  const newline = await write("newline.json", { version: 1, workspaces: { "a\nb": { path: "/w/a" } } });
  await assert.rejects(loadWorkspaceRegistry(newline), (e: Error & { code?: string }) => e.code === "GRANT_ID_MALFORMED");

  const trailing = await write("trailing.json", { version: 1, workspaces: { "prod ": { path: "/w/p" } } });
  await assert.rejects(loadWorkspaceRegistry(trailing), (e: Error & { code?: string }) => e.code === "GRANT_ID_MALFORMED");

  // **An internal space is refused, and an earlier version of this test asserted the opposite.** It blessed
  // `"east us"` and claimed "`workspace: prod` is one capability in every channel that carries it". That is
  // false, and the channel is one file over: `ceilingForDefinition` splits `allowed-tools` on `[\s,]+`.
  assert.deepEqual(
    ceilingForDefinition({
      name: "d", description: "", allowedTools: "read, workspace:prod bash", body: "", source: "/s",
    } as SkillDefinition).capabilities,
    ["tool:bash", "tool:read", "workspace:prod"],
    "one space in a registry id buys routing over PRODUCTION plus a shell, neither of them typed",
  );
  const spaced = await write("spaced.json", { version: 1, workspaces: { "east us": { path: "/w/e" } } });
  await assert.rejects(loadWorkspaceRegistry(spaced), (e: Error & { code?: string }) => e.code === "GRANT_ID_MALFORMED");

  // A wildcard as an id minted WORKSPACE_WILDCARD: an operator naming ONE worktree held routing authority
  // over every id in the registry, including ones added later, while `workspace:*` was simultaneously
  // unusable for delegation. Two reviewers found this independently.
  const star = await write("star.json", { version: 1, workspaces: { "*": { path: "/w/one" } } });
  await assert.rejects(loadWorkspaceRegistry(star), (e: Error & { code?: string }) => e.code === "GRANT_ID_MALFORMED");

  // The shell metacharacters that reached the generated file's ROUTABLE WORKSPACES block, whose own
  // instructions tell the operator to paste the id into PI_GRANTS_GRANT (R-77/R-78's argument).
  for (const hostile of [
    'a";touch /tmp/pwned;x="', "a$(id)", "a" + String.fromCharCode(96) + "id", "a;b", "a'b",
    "a|b", "a&b", "a>b", "a#b", "a[31m", "..", "caf\u00e9", "_leading", "-leading",
  ]) {
    const p = await write(`hostile-${Buffer.from(hostile).toString("hex").slice(0, 12)}.json`,
      { version: 1, workspaces: { [hostile]: { path: "/w/x" } } });
    await assert.rejects(loadWorkspaceRegistry(p), (e: Error & { code?: string }) => e.code === "GRANT_ID_MALFORMED",
      `${JSON.stringify(hostile)} must be refused at the registry`);
  }

  // **A SLASH IS DELIBERATELY ALLOWED**, and this is the case the first version of this guard got wrong.
  // Git worktrees are routinely named after their branch, so `feature/x` is the ordinary id — and a slash
  // splits nothing: not the comma-separated grant, not `allowed-tools`' `[\s,]+`. Reusing the TOOL-name
  // grammar refused it and broke a configuration published 0.18.1 accepted, for no safety at all.
  const fine = await write("fine.json", {
    version: 1,
    workspaces: {
      "prod-1": { path: "/w/p" }, "east.us_2": { path: "/w/e" },
      "feature/x": { path: "/w/f" }, "claude/issue-42": { path: "/w/c" },
    },
  });
  assert.deepEqual(
    Object.keys((await loadWorkspaceRegistry(fine)).workspaces).sort(),
    ["claude/issue-42", "east.us_2", "feature/x", "prod-1"],
    "a branch-named worktree is the ordinary case and must load",
  );
  // And it routes, end to end — not merely loads.
  assert.equal(
    planDelegation(
      { task: "t", tools: ["read"], boundWorkspaceId: "feature/x" },
      ctx({ ownGrant: ["tool:read", "tool:delegate", "workspace:feature/x"] }) as never,
    ).ok,
    true,
    "a slash id must survive the planner too, not just the loader",
  );
});

/**
 * A model-supplied `workspace_id` reaches `denied`, which is the one signal audit tooling counts.
 *
 * Breaks by: deleting the well-formedness check that precedes the routing guard in `planDelegation`.
 */
test("a malformed model-supplied workspace id is refused as malformed, not as unauthorised", () => {
  const plan = planDelegation({ task: "t", tools: ["read"], boundWorkspaceId: "prod,tool:bash" }, ctx() as never);
  assert.equal(plan.refusal?.code, "GRANT_ID_MALFORMED");
  assert.deepEqual(plan.result.denied, [], "an unparseable id must not be seeded into the escalation channel");
});

/**
 * The half Unix CAN express — narrowly, and the narrow statement is the point.
 *
 * This refuses a WORLD-writable registry: any local user could otherwise redirect a governed child into a
 * worktree nobody authorised. It does **not** establish "nobody else may rewrite it", which an earlier
 * version of this comment claimed. Two measured reasons: the check inspects the file and never its parent
 * directory, and `rename(2)`/`unlink(2)` need only directory write — a 0600 registry in a world-writable
 * non-sticky directory was accepted and then atomically replaced. And it cannot touch a same-uid child at
 * all, which is R-137's territory and is now recorded OPEN rather than half-blocked.
 *
 * Group-writable is deliberately ALLOWED. `umask 002` with per-user groups (Debian/Ubuntu
 * `USERGROUPS_ENAB`) produces 0664 for every file the operator creates, and refusing that broke a
 * configuration published 0.18.1 accepted while exposing nothing — the group has one member.
 *
 * Breaks by: removing the mode check. The uid check is deliberately UNGUARDED by any test, because a test
 * cannot create a file owned by another user; that is stated here rather than claimed as verified.
 */
test("a registry anyone else could rewrite is refused", async () => {
  const dir = await tempDir("pi-daddy-mode-");
  const path = join(dir, "registry.json");
  await writeFile(path, JSON.stringify({ version: 1, workspaces: { prod: { path: "/w/prod" } } }), "utf8");

  await chmod(path, 0o644);
  assert.deepEqual(Object.keys((await loadWorkspaceRegistry(path)).workspaces), ["prod"], "0644 is fine");

  for (const mode of [0o666, 0o646, 0o607] as const) {
    await chmod(path, mode);
    await assert.rejects(loadWorkspaceRegistry(path), (e: Error & { code?: string }) => {
      assert.equal(e.code, "WORKSPACE_NOT_REGISTERED");
      assert.match(e.message, /world-writable/);
      return true;
    }, `mode ${mode.toString(8)} must be refused`);
  }
  for (const mode of [0o600, 0o664, 0o660] as const) {
    await chmod(path, mode);
    assert.deepEqual(
      Object.keys((await loadWorkspaceRegistry(path)).workspaces), ["prod"],
      `mode ${mode.toString(8)} is a normal umask result and must load`,
    );
  }
});

/**
 * R-79's defect class, reintroduced by 0.19.0's new readers and caught before release.
 *
 * `buildCatalog` and `registeredWorkspaceIds` are awaited inside `session_start`, so a blocking path there
 * stopped the session before every control after it — and `delegate` awaits the same promise. An
 * `AbortSignal` does NOT fix this: a FIFO blocks inside `open(2)` before any read begins, so the signal is
 * never observed. `stat` first is the fix.
 *
 * Breaks by: removing the `isFile()` check, or replacing it with a signal-only timeout.
 */
test("a registry that is not a regular file is refused, not waited on", { timeout: 5_000 }, async () => {
  const dir = await tempDir("pi-daddy-fifo-");
  const fifo = join(dir, "registry.json");
  await new Promise<void>((ok, no) => execFile("mkfifo", [fifo], (e) => (e ? no(e) : ok())));

  const started = Date.now();
  await assert.rejects(loadWorkspaceRegistry(fifo), (e: Error & { code?: string }) => {
    assert.equal(e.code, "WORKSPACE_NOT_REGISTERED");
    assert.match(e.message, /not a regular file/);
    return true;
  });
  assert.ok(Date.now() - started < 1_000, "must refuse immediately rather than block on open(2)");

  // And the soft-failing readers return rather than hanging the session.
  assert.deepEqual(await registeredWorkspaceIds(fifo), []);
  const catalog = await buildCatalog({ cwd: dir, observedTools: null, registryPath: fifo });
  assert.deepEqual(catalog.byKind("workspace"), []);
  assert.ok(Date.now() - started < 5_000, "session start must not block");
});

/**
 * `denied` is the one escalation signal, and three refusals were bypassing it.
 *
 * `isEscalationAttempt` and `/grants ledger` read `denied`. A refusal that leaves it empty is invisible to
 * both, so a model can probe repeatedly and nothing counts it. Review found three ways in, all measured:
 * `workspace_id: ""` was falsy so it skipped both guards and failed closed much later with `denied: []`; a
 * requested `workspace:*` from a caller holding nothing of the sort got `NARROWING_VIOLATED` with an empty
 * `denied` **and** a reason asserting the wildcard "is held" to a session that held it not; and a bare
 * `workspace:` passed the namespace exemption entirely.
 *
 * Breaks by: reverting either `request.boundWorkspaceId !== undefined` to a truthiness check; dropping the
 * `holdsWorkspaceWildcard` condition; or exempting `workspace:` in `unknownCapabilities` without requiring a
 * well-formed id.
 */
test("an unauthorised routing probe always lands in `denied`, whatever shape it takes", () => {
  // Empty id: malformed, not "no workspace".
  const empty = planDelegation({ task: "t", tools: ["read"], boundWorkspaceId: "" }, ctx() as never);
  assert.equal(empty.refusal?.code, "GRANT_ID_MALFORMED", empty.reason ?? "");

  // `workspace:*` requested by a caller that does NOT hold it is an escalation, counted as one.
  const probe = planDelegation(
    { task: "t", tools: ["workspace:*"] },
    ctx({ ownGrant: ["tool:read", "tool:delegate", "workspace:prod"] }) as never,
  );
  assert.equal(probe.refusal?.code, "CAPABILITY_ESCALATION", probe.reason ?? "");
  assert.deepEqual(probe.result.denied, [WORKSPACE_WILDCARD], "the probe is visible to isEscalationAttempt");
  // ...and the same request from a caller that DOES hold it still gets the honest narrowing refusal.
  const holder = planDelegation(
    { task: "t", tools: ["workspace:*"] },
    ctx({ ownGrant: ["tool:read", "tool:delegate", WORKSPACE_WILDCARD] }) as never,
  );
  assert.equal(holder.refusal?.code, "NARROWING_VIOLATED", holder.reason ?? "");

  // A bare namespace prefix names nothing and must not ride the exemption into a grant.
  assert.deepEqual(unknownCapabilities(["workspace:"], catalog), ["workspace:"]);
});

/**
 * One authority, one entry. The ordinary chained-routing shape produced two.
 *
 * Route the child to `prod` *and* grant it `workspace:prod` so it can route onward — the configuration
 * ADR-0035's "two authorities" model is *for* — spelled the authorising id and the requested id identically,
 * so the gate appended a duplicate that reached the refusal text a model reads and the append-only ledger.
 *
 * Breaks by: dropping the `!result.gatedBlocked.includes(c)` filter in `resolveDelegationApproval`.
 */
test("a gated capability that is also requested is listed once", () => {
  const plan = planDelegation(
    { task: "t", tools: ["read", "workspace:prod"], boundWorkspaceId: "prod" },
    ctx({ gated: ["workspace:prod"] }) as never,
  );
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.result.gatedBlocked, ["workspace:prod"], "the parent's authority and the child's grant are one entry");
  assert.doesNotMatch(plan.reason ?? "", /workspace:prod, workspace:prod/);
});

/**
 * The three unguarded halves of the "names the file" fix, and the size ceiling.
 *
 * The fourth review pass reverted each of these separately and the whole suite stayed green — four
 * independent edits with no test between them, in the commit whose message said the compensating control "is
 * as strong as the claim that leaned on it". It is load-bearing: `docs/SPEC.md` asserts the refusal names the
 * file, and `catalog.ts` exempts the ENTIRE `workspace:` namespace from the unknown check *because* of that
 * ("a second, weaker check here can only turn that precise refusal into a misleading one").
 *
 * Breaks by: dropping `registry.source` from the refusal message, dropping the `known` id listing, dropping
 * `registry_path` from the details, removing `source` from the object `loadWorkspaceRegistry` returns, or
 * removing the size ceiling.
 */
test("an unregistered id is refused by a message that names the file and what it does hold", async () => {
  const dir = await tempDir("pi-daddy-names-");
  const path = join(dir, "registry.json");
  await writeFile(path, JSON.stringify({
    version: 1, workspaces: { prod: { path: "/w/p" }, staging: { path: "/w/s" } },
  }), "utf8");

  const registry = await loadWorkspaceRegistry(path);
  assert.equal(registry.source, path, "the object carries where it came from, so a caller cannot forget it");

  await assert.rejects(resolveWorkspace(registry, "nope"), (e: Error & { code?: string; details?: Record<string, string> }) => {
    assert.equal(e.code, "WORKSPACE_NOT_REGISTERED");
    assert.match(e.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "names the FILE to edit");
    assert.match(e.message, /it lists: prod, staging/, "and what it does hold");
    assert.equal(e.details?.registry_path, path, "machine-readable for an external controller");
    return true;
  });

  // A hand-built registry (tests, fixtures) has no source and must still produce a usable message.
  await assert.rejects(
    resolveWorkspace({ version: 1, workspaces: {} }, "nope"),
    (e: Error) => /it lists nothing/.test(e.message),
  );
});

test("a registry larger than the ceiling is refused rather than read into memory", async () => {
  const dir = await tempDir("pi-daddy-huge-");
  const path = join(dir, "registry.json");
  // Just over 1 MiB of valid JSON: the ceiling must fire on SIZE, before any parse.
  const filler = "x".repeat(1024 * 1024);
  await writeFile(path, JSON.stringify({ version: 1, workspaces: { prod: { path: "/w/p" } }, pad: filler }), "utf8");
  await assert.rejects(loadWorkspaceRegistry(path), (e: Error & { code?: string }) => {
    assert.equal(e.code, "WORKSPACE_NOT_REGISTERED");
    assert.match(e.message, /over the \d+ limit/);
    return true;
  });
});

/** The catalog enumerates registered workspaces for `/grants` and `init`. Display, never authority. */
test("registered workspaces are catalogued, and marked as their own kind", () => {
  assert.deepEqual(catalog.byKind("workspace"), ["workspace:prod", "workspace:staging"]);
  assert.equal(catalog.has("workspace:prod"), true);
  assert.equal(catalog.has("workspace:never-registered"), false);
});
