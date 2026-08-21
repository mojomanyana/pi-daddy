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
import {
  establishRegistryPin,
  loadWorkspaceRegistry,
  registryDigest,
  registryPin,
} from "../src/workspace.ts";
import { registeredWorkspaceIds } from "../src/init.ts";
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
 * SITE 4 — `catalog.ts` `unknownCapabilities`. The one that mattered most.
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
 * SITE 5 — `delegate.ts`, the path a DELEGATED child's grant actually travels.
 *
 * Breaks by: reverting `delegate.ts` to `result.effective.join(",")`, or deleting the `NARROWING_VIOLATED`
 * refusal. The pre-existing test for this rule asserted on `childEnv`, which is the *interceptor* path — so
 * the rule was enforced on one route and advertised for both.
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
 * An approval banked for a capability the child never receives would be authority with nothing to spend it
 * on. Breaks by: reverting `ENV_APPROVED` to clamp against `result.effective`.
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
 * SITE 6 — `delegation-approval.ts`. ADR-0035 claimed this in three places and never built it.
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
 * SITE 8 — `definitions.ts` `ceilingForDefinition`.
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
 * SITE 10 — `resolve.ts` `subsumedBy`, which contradicted its own F9 rule.
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

  // A well-formed id still loads, so the guard is not simply refusing everything. And an INTERNAL space is
  // deliberately allowed: only characters that make one id read as several are refused, which is the line
  // 0.18.1 drew on purpose — "a security patch should close the hole without inventing a new way to refuse
  // a legitimate setup". `workspace: prod` is one capability in every channel that carries it.
  const fine = await write("fine.json", { version: 1, workspaces: { "prod-1": { path: "/w/p" }, "east us": { path: "/w/e" } } });
  assert.deepEqual(Object.keys((await loadWorkspaceRegistry(fine)).workspaces).sort(), ["east us", "prod-1"]);
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
 * Routing attenuated by ID and not by DESTINATION, which review showed made the capability name something a
 * descendant could redefine.
 *
 * ADR-0035 asserts the registry is "operator-owned" as a fact. Nothing enforced it, and a child holding
 * `workspace:staging` plus `tool:write` — not `bash`, so squarely inside ADR-0012's scope — could rewrite the
 * `staging` entry to point at any other Git worktree and route its grandchild there with a real exclusive
 * write lease. Measured in review.
 *
 * **Two mechanisms, because one is not enough and saying so matters.** The mode/ownership check refuses a
 * registry another *user* could rewrite; it cannot help here at all, because a governed child runs as the
 * same uid as its parent and no file mode distinguishes them. The pin is what closes this: the root records
 * the registry's digest, every descendant inherits it verbatim, and a mismatch refuses.
 *
 * Breaks by: deleting the `assertRegistryUnchanged` call in `loadWorkspaceRegistry`; or letting
 * `establishRegistryPin` overwrite an inherited pin, which is a descendant re-minting its own tampering.
 */
test("a descendant cannot repoint the registry entry it holds at another worktree", async () => {
  const dir = await tempDir("pi-daddy-pin-");
  const path = join(dir, "registry.json");
  const honest = { version: 1, workspaces: { staging: { path: "/w/staging" }, prod: { path: "/w/prod" } } };
  await writeFile(path, JSON.stringify(honest), "utf8");

  // The ROOT pins what it read. No pin inherited, so it establishes one.
  const rootEnv: NodeJS.ProcessEnv = { PI_GRANTS_WORKSPACE_REGISTRY: path };
  await establishRegistryPin(rootEnv);
  const pin = rootEnv.PI_GRANTS_WORKSPACE_PIN;
  assert.match(pin ?? "", /^[0-9a-f]{64}:[0-9a-f]{64}$/, "a pin names the file as well as its contents");
  assert.ok(pin?.endsWith(registryDigest(JSON.stringify(honest))));

  // Unchanged registry: the descendant reads it fine.
  assert.deepEqual(Object.keys((await loadWorkspaceRegistry(path, pin)).workspaces).sort(), ["prod", "staging"]);

  // THE ATTACK: the child rewrites `staging` to point at prod's worktree, keeping the id it legitimately
  // holds. Before the pin this resolved, leased and started a grandchild in prod.
  const tampered = { version: 1, workspaces: { staging: { path: "/w/prod" }, prod: { path: "/w/prod" } } };
  await writeFile(path, JSON.stringify(tampered), "utf8");

  // A DESCENDANT must inherit the pin VERBATIM. Asserted *after* the tampering on purpose: re-minting an
  // unchanged file produces the same digest, so checking before this point cannot fail — which is precisely
  // the decoration rule 7 warns about, and this test asserted exactly that until a mutation caught it.
  // Here, a re-minting `establishRegistryPin` would pin the child's own edit and the attack would succeed.
  const childEnvVars: NodeJS.ProcessEnv = { PI_GRANTS_WORKSPACE_REGISTRY: path, PI_GRANTS_WORKSPACE_PIN: pin };
  await establishRegistryPin(childEnvVars);
  assert.equal(childEnvVars.PI_GRANTS_WORKSPACE_PIN, pin, "an inherited pin is never recomputed");
  assert.notEqual(
    childEnvVars.PI_GRANTS_WORKSPACE_PIN,
    registryPin(path, JSON.stringify(tampered)),
    "a descendant must not be able to re-pin over its own edit",
  );

  await assert.rejects(loadWorkspaceRegistry(path, pin), (e: Error & { code?: string }) => {
    assert.equal(e.code, "WORKSPACE_REGISTRY_CHANGED");
    assert.match(e.message, /has changed since this delegation tree started/);
    return true;
  });

  // And the ROOT — which holds no pin — is unaffected, so an operator editing their own registry between
  // sessions is not broken by this.
  assert.deepEqual(Object.keys((await loadWorkspaceRegistry(path, undefined)).workspaces).sort(), ["prod", "staging"]);
});

/**
 * The half Unix CAN express: nobody else may rewrite it. Refuses rather than trusting.
 *
 * Breaks by: removing the uid or mode check in `loadWorkspaceRegistry`.
 */
test("a registry anyone else could rewrite is refused", async () => {
  const dir = await tempDir("pi-daddy-mode-");
  const path = join(dir, "registry.json");
  await writeFile(path, JSON.stringify({ version: 1, workspaces: { prod: { path: "/w/prod" } } }), "utf8");

  await chmod(path, 0o644);
  assert.deepEqual(Object.keys((await loadWorkspaceRegistry(path, undefined)).workspaces), ["prod"], "0644 is fine");

  for (const mode of [0o666, 0o646, 0o662] as const) {
    await chmod(path, mode);
    await assert.rejects(loadWorkspaceRegistry(path, undefined), (e: Error & { code?: string }) => {
      assert.equal(e.code, "WORKSPACE_NOT_REGISTERED");
      assert.match(e.message, /group- or world-writable/);
      return true;
    }, `mode ${mode.toString(8)} must be refused`);
  }
  await chmod(path, 0o600);
  assert.deepEqual(Object.keys((await loadWorkspaceRegistry(path, undefined)).workspaces), ["prod"], "0600 is fine");
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
test("a registry that is not a regular file is refused, not waited on", async () => {
  const dir = await tempDir("pi-daddy-fifo-");
  const fifo = join(dir, "registry.json");
  await new Promise<void>((ok, no) => execFile("mkfifo", [fifo], (e) => (e ? no(e) : ok())));

  const started = Date.now();
  await assert.rejects(loadWorkspaceRegistry(fifo, undefined), (e: Error & { code?: string }) => {
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

/** The catalog enumerates registered workspaces for `/grants` and `init`. Display, never authority. */
test("registered workspaces are catalogued, and marked as their own kind", () => {
  assert.deepEqual(catalog.byKind("workspace"), ["workspace:prod", "workspace:staging"]);
  assert.equal(catalog.has("workspace:prod"), true);
  assert.equal(catalog.has("workspace:never-registered"), false);
});
