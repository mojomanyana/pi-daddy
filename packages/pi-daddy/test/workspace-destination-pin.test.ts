import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { childEnv, mergeChildEnv, GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
import { loadWorkspaceRegistry, resolveWorkspace } from "../src/kernel/workspace.ts";
import {
  attenuateWorkspacePin,
  destinationDigest,
  establishWorkspacePin,
  formatWorkspacePin,
  parseWorkspacePin,
  ENV_WORKSPACE_PIN,
} from "../src/kernel/workspace-pin.ts";
import { createGrantsSession, loadProjectDefinitions } from "../extensions/session.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

/**
 * ADR-0042: rewriting the registry must not change what an inherited workspace id is allowed to MEAN.
 *
 * **This file is `g37-registry-tamper`'s positive reversal**, which the decision record requires before the
 * mechanism counts as implemented: the probe's control must stay green while its tamper case turns into a
 * refusal. The record also says the first attempt at this was reverted after four failures because it "was
 * treated as a small patch", so the cases below cover the tamper, the control, attenuation, and every
 * failure state of the wire — missing, empty, malformed and mismatched.
 *
 * **The production changes that break them:** dropping the `checkPinnedDestination` call in
 * `resolveWorkspace`; dropping `workspacePin` from `childEnv`; letting a session that inherited a pin
 * establish a new one; or removing `ENV_WORKSPACE_PIN` from `GRANT_ENV_KEYS`, which would let a child keep
 * its parent's unnarrowed pin.
 */

async function gitDir(prefix: string): Promise<string> {
  const dir = await tempDir(prefix);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

/** Run with a registry and optional inherited pin in scope, restoring whatever was there. */
async function withPinEnv(env: { registry: string; pin?: string }, body: () => Promise<void>): Promise<void> {
  // EVERY governance key, not just the two this helper sets. `publishChildEnv` writes `PI_DADDY_DEPTH=1` into
  // `process.env`, so a test that published left the next test's session looking like a DESCENDANT — which,
  // correctly, never mints a pin. The first version of this helper saved three keys and the resulting failure
  // read as a bug in the fix rather than in the harness.
  const keys = [...GRANT_ENV_KEYS, "PI_DADDY_WORKSPACE_REGISTRY", "PI_CODING_AGENT_DIR"] as const;
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    process.env.PI_DADDY_WORKSPACE_REGISTRY = env.registry;
    if (env.pin === undefined) delete process.env.PI_DADDY_WORKSPACE_PIN;
    else process.env.PI_DADDY_WORKSPACE_PIN = env.pin;
    process.env.PI_CODING_AGENT_DIR = await tempDir("pin-agent-");
    await body();
  } finally {
    for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("g37 reversal: a rewritten registry cannot repoint an authorised id at another worktree", async () => {
  const staging = await gitDir("pin-staging-");
  const prod = await gitDir("pin-prod-");
  const registryPath = join(await tempDir("pin-registry-"), "registry.json");
  const write = (target: string) =>
    writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { staging: { path: target } } }));

  // The operator's registry, and the pin a root establishes from it before anything can touch it.
  await write(staging);
  const pin = parseWorkspacePin(
    formatWorkspacePin(await establishWorkspacePin(await loadWorkspaceRegistry(registryPath), realpath)),
  );

  // The CONTROL. Routing to the id it was granted, against the registry it was granted against, still works.
  const ok = await resolveWorkspace(await loadWorkspaceRegistry(registryPath), "staging", pin);
  assert.equal(ok.root, await realpath(staging));

  // The TAMPER, which is exactly what a child holding `workspace:staging` and `tool:write` can do: the
  // registry is a file owned by the same uid, so it needs no privilege it was not granted.
  await write(prod);
  const tampered = await loadWorkspaceRegistry(registryPath);
  await assert.rejects(
    () => resolveWorkspace(tampered, "staging", pin),
    (error: Error) => {
      assert.match(error.message, /is not routable/);
      assert.match(error.message, /no longer means what it meant/);
      return true;
    },
    "a repointed id must refuse; this is the escalation g37 measured",
  );

  // The capability check was never what was violated: `workspace:staging` is held throughout, and the id it
  // routes to is the id it was granted. What changed is the destination behind the name, and that is the only
  // thing the pin looks at.
});

test("without a pin entry, an id that resolves is still refused", async () => {
  // The line the test above cannot make without contradicting itself: an EMPTY pin refuses rather than
  // falling back to "no pin means no opinion". A mechanism a child can switch off by clearing one variable
  // is not a mechanism.
  const dir = await gitDir("pin-nopin-");
  const registryPath = join(await tempDir("pin-nopin-registry-"), "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { w: { path: dir } } }));
  const registry = await loadWorkspaceRegistry(registryPath);
  for (const [label, pin] of [
    ["empty", parseWorkspacePin("")],
    ["absent", parseWorkspacePin(undefined)],
    ["malformed", parseWorkspacePin("w:not-a-digest")],
    ["another id", parseWorkspacePin(`other:${destinationDigest("/somewhere")}`)],
  ] as const) {
    await assert.rejects(() => resolveWorkspace(registry, "w", pin), /is not routable/, `${label} must refuse`);
  }
});

test("a child inherits pins only for the workspaces its own grant names", () => {
  // Attenuation, which is the difference between a pin and a hint: a child that cannot see an entry cannot
  // route to it even by rewriting the registry, because it has no pin to offer.
  const pins = new Map([
    ["staging", destinationDigest("/srv/staging")],
    ["prod", destinationDigest("/srv/prod")],
  ]);
  const narrowed = attenuateWorkspacePin(pins, ["tool:read", "workspace:staging"]);
  assert.deepEqual([...narrowed.keys()], ["staging"]);
  assert.deepEqual([...attenuateWorkspacePin(pins, ["tool:read"]).keys()], [], "no workspace, no pin");
});

test("childEnv narrows the pin and never hands down more than the child holds", () => {
  const pins = new Map([
    ["staging", destinationDigest("/srv/staging")],
    ["prod", destinationDigest("/srv/prod")],
  ]);
  const env = childEnv({
    ownGrant: ["tool:read", "workspace:staging"],
    depth: 0,
    maxDepth: 2,
    gated: [],
    workspacePin: pins,
  });
  assert.equal(env[ENV_WORKSPACE_PIN], `staging:${destinationDigest("/srv/staging")}`);
  assert.ok(!env[ENV_WORKSPACE_PIN]!.includes("prod"), "a workspace the child does not hold must not be pinned");

  // Written even when it narrows to nothing, for the reason ENV_APPROVED is: an omitted key does not
  // overwrite, so the child would inherit the parent's UNNARROWED pin through the process-global publication.
  const none = childEnv({ ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [], workspacePin: pins });
  assert.equal(none[ENV_WORKSPACE_PIN], "");
});

test("the pin is stripped from a child's environment like every other governance value", () => {
  assert.ok(
    (GRANT_ENV_KEYS as readonly string[]).includes(ENV_WORKSPACE_PIN),
    "if the pin is not stripped, a child keeps its parent's unnarrowed one and attenuation is decorative",
  );
});

test("a malformed pin refuses rather than being read past", () => {
  for (const raw of ["staging", "staging:", ":abc", "staging:XYZ", "staging:abc,staging:def"]) {
    const parsed = parseWorkspacePin(raw);
    assert.ok("refusal" in parsed, `${JSON.stringify(raw)} must refuse, not parse`);
  }
  const good = parseWorkspacePin(`a/b:${destinationDigest("/x")},c:${destinationDigest("/y")}`);
  assert.ok("pins" in good && good.pins.size === 2, "a workspace id may contain a slash and must still parse");
});

test("a session that inherited a pin does not mint a new one", async () => {
  // **This rule IS the mechanism.** If a descendant could establish its own pin it would rewrite the registry,
  // re-establish from the rewrite, and route anywhere; every other guard here would be decoration. So an
  // inherited value survives session start untouched, even when it disagrees with the registry on disk —
  // disagreeing with the registry is precisely what it is for.
  //
  // Asserted on the SESSION rather than on `process.env`, because `publishChildEnv` writes the CHILD's
  // narrowed pin into the environment. An earlier draft of this test read the variable back and failed, which
  // is how that collision was found at all.
  //
  // Breaks by: dropping the inherited-pin early return in `establishRootPin`.
  const dir = await gitDir("pin-inherit-");
  const registryPath = join(dir, "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { w1: { path: dir } } }));
  const stale = "0".repeat(32);
  await withPinEnv({ registry: registryPath, pin: `w1:${stale}` }, async () => {
    const session = createGrantsSession(undefined);
    await loadProjectDefinitions(session, dir);
    assert.equal(session.workspacePin?.get("w1"), stale, "an inherited pin must not be replaced by the registry");
  });
});

test("a root with no inherited pin establishes one from the registry", async () => {
  // The other half: without it a real session could route nowhere and the mechanism would be unusable.
  // Breaks by: removing the `establishRootPin` call from `loadProjectDefinitions`.
  const dir = await gitDir("pin-establish-");
  const registryPath = join(dir, "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { w1: { path: dir } } }));
  await withPinEnv({ registry: registryPath }, async () => {
    const session = createGrantsSession(undefined);
    await loadProjectDefinitions(session, dir);
    assert.equal(session.workspacePin?.get("w1"), destinationDigest(await realpath(dir)));
  });
});

test("publishing a child's environment does not narrow the SESSION's own pin", async () => {
  // **The defect review found, and the one this whole mechanism nearly died of.** `publishChildEnv` writes the
  // CHILD's narrowed pin into `process.env`. `establishRootPin` read that variable back, so any later reload —
  // and `/grants init` does exactly this, `adoptGrant` then a definitions refresh — made the session adopt its
  // own child's authority. Worst case is a `workspace:*` root: `inheritableGrant` strips the wildcard, so the
  // published child pin is EMPTY, and the root lost all routing until restart while being told "no destination
  // pin was inherited" by a session that had established one and thrown it away.
  //
  // Breaks by: reading `process.env[ENV_WORKSPACE_PIN]` in `establishRootPin` instead of the lifecycle root.
  const dir = await gitDir("pin-reload-");
  const other = await gitDir("pin-reload-other-");
  const registryPath = join(dir, "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { w1: { path: dir }, w2: { path: other } } }));
  await withPinEnv({ registry: registryPath }, async () => {
    process.env.PI_DADDY_GRANT = "tool:read,workspace:w1";
    const session = createGrantsSession(undefined);
    await loadProjectDefinitions(session, dir);
    assert.deepEqual([...(session.workspacePin?.keys() ?? [])].sort(), ["w1", "w2"], "the root pins the registry");

    // What `/grants init` does: publish a child environment, then reload definitions.
    session.publishChildEnv();
    await loadProjectDefinitions(session, dir);
    assert.deepEqual(
      [...(session.workspacePin?.keys() ?? [])].sort(),
      ["w1", "w2"],
      "a reload must not shrink the session's own pin to what its child was handed",
    );
  });
});

test("a wildcard root keeps its pin across a reload, though its children inherit none", async () => {
  // The severe shape of the case above: `workspace:*` is held and never inherited (R-131), so the published
  // child pin is empty. Reading it back left the root unable to route anywhere at all.
  const dir = await gitDir("pin-wildcard-");
  const registryPath = join(dir, "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { w1: { path: dir } } }));
  await withPinEnv({ registry: registryPath }, async () => {
    process.env.PI_DADDY_GRANT = "tool:read,workspace:*";
    const session = createGrantsSession(undefined);
    await loadProjectDefinitions(session, dir);
    session.publishChildEnv();
    await loadProjectDefinitions(session, dir);
    assert.equal(
      session.workspacePin?.get("w1"),
      destinationDigest(await realpath(dir)),
      "a wildcard root must still route after a reload",
    );
  });
});

test("a registered workspace that cannot be canonicalised is reported, not dropped in silence", async () => {
  // `registeredWorkspaceIds` one file over carries the long argument against `catch {}` here. An unmounted
  // worktree used to vanish and be met later as "no destination pin was inherited", naming neither the
  // directory nor the reason. Breaks by: removing the `onSkipped` call in `establishWorkspacePin`.
  const dir = await gitDir("pin-missing-");
  const skipped: string[] = [];
  const pins = await establishWorkspacePin(
    { workspaces: { good: { path: dir }, gone: { path: join(dir, "does-not-exist") } } },
    realpath,
    (id, reason) => skipped.push(`${id}: ${reason}`),
  );
  assert.deepEqual([...pins.keys()], ["good"]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /^gone: its destination could not be canonicalised/);
});

test("a pin naming one id twice with different destinations refuses", () => {
  // The branch review found deletable with the whole suite green: the earlier malformed-pin case used a
  // non-digest, so the first entry failed the format check and the duplicate branch was never reached. Its own
  // comment calls it security-relevant — picking either digest would let a tamperer supply both.
  const a = destinationDigest("/srv/staging");
  const b = destinationDigest("/srv/prod");
  assert.ok("refusal" in parseWorkspacePin(`w:${a},w:${b}`), "two destinations for one id must refuse");
  assert.ok("pins" in parseWorkspacePin(`w:${a},w:${a}`), "the same destination twice is merely redundant");
});

test("publishChildEnv actually clears a stale pin from the environment", () => {
  // The restatement test asserted `GRANT_ENV_KEYS.includes(...)` — a re-read of the line it guards, exercising
  // no behaviour. This exercises the property that line exists for: a parent's unnarrowed pin must not survive
  // into what a child inherits. Breaks by: removing ENV_WORKSPACE_PIN from GRANT_ENV_KEYS.
  const stale = { PI_DADDY_WORKSPACE_PIN: `secret:${destinationDigest("/srv/secret")}` } as NodeJS.ProcessEnv;
  const merged = mergeChildEnv(stale, childEnv({ ownGrant: ["tool:read"], depth: 0, maxDepth: 2, gated: [] }));
  assert.equal(merged.PI_DADDY_WORKSPACE_PIN, undefined, "a parent's pin must not survive into a child");
});

test("a DESCENDANT that arrives with no pin mints nothing and routes nowhere", async () => {
  // **The escalation a security review reproduced end to end, across a real process boundary.**
  // `workspacePinEnv` OMITS the variable when a parent has no pin of its own — which happens whenever that
  // parent's registry was unreadable at its start, a state any child holding `tool:write` can arrange by
  // truncating the file. The child then read the ABSENCE as "I am a root", minted a pin from the registry it
  // had just rewritten, and routed to the prod worktree while holding only `workspace:staging`. The pin was in
  // place throughout and did not stop it, because the child was never asked to prove it had inherited one.
  //
  // Depth is already in the environment and already attenuates downward, so it is enough on its own.
  // Breaks by: removing the `session.depth > 0` guard in `establishRootPin`.
  const dir = await gitDir("pin-descendant-");
  const registryPath = join(dir, "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { staging: { path: dir } } }));
  await withPinEnv({ registry: registryPath }, async () => {
    process.env.PI_DADDY_GRANT = "tool:write,workspace:staging";
    process.env.PI_DADDY_DEPTH = "1";
    const session = createGrantsSession(undefined);
    await loadProjectDefinitions(session, dir);
    assert.equal(session.workspacePin?.size, 0, "a descendant with no inherited pin must hold none of its own");
  });
});

test("a MALFORMED inherited pin refuses rather than promoting the session to root", async () => {
  // The same fall-through: a refusal from `parseWorkspacePin` was treated as "no pin", so a corrupt value
  // earned a promotion instead of a refusal. The module header says missing, empty, malformed and mismatched
  // all refuse; that was true of the routing check and false of the function that decides what routing sees.
  // Breaks by: letting a `{refusal}` parse fall through to the registry.
  const dir = await gitDir("pin-malformed-");
  const registryPath = join(dir, "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { staging: { path: dir } } }));
  for (const corrupt of ["staging", "staging:", "staging:XYZ", `staging:${"0".repeat(31)}`]) {
    await withPinEnv({ registry: registryPath, pin: corrupt }, async () => {
      process.env.PI_DADDY_GRANT = "tool:write,workspace:staging";
      const session = createGrantsSession(undefined);
      await loadProjectDefinitions(session, dir);
      assert.equal(session.workspacePin?.size, 0, `${JSON.stringify(corrupt)} must refuse, not mint`);
    });
  }
});

test("a session settles its pin once, so a reload cannot re-mint over a rewritten registry", async () => {
  // `/grants init` re-established a root's pin from whatever the registry said at that moment, and a child had
  // had the whole session to rewrite it. The guard "only a session that inherited no pin may mint" was
  // satisfied because the session's own publication had erased the evidence.
  // Breaks by: removing the `pinSettled` early return.
  const dir = await gitDir("pin-settle-");
  const other = await gitDir("pin-settle-other-");
  const registryPath = join(dir, "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { staging: { path: dir } } }));
  await withPinEnv({ registry: registryPath }, async () => {
    process.env.PI_DADDY_GRANT = "tool:write,workspace:staging";
    const session = createGrantsSession(undefined);
    await loadProjectDefinitions(session, dir);
    const first = session.workspacePin?.get("staging");

    // The tamper a child can perform with `tool:write` alone, then the reload `/grants init` performs.
    await writeFile(registryPath, JSON.stringify({ version: 1, workspaces: { staging: { path: other } } }));
    session.publishChildEnv();
    await loadProjectDefinitions(session, dir);
    assert.equal(session.workspacePin?.get("staging"), first, "a reload must not re-mint over a rewritten registry");
    assert.notEqual(first, destinationDigest(await realpath(other)));
  });
});

test("/grants says which ids are pinned, so a refusal is discoverable before it happens", async () => {
  // ADR-0042 made the pin a PRECONDITION for routing and gave it no operator surface at all — not `/grants`,
  // not session start, not the README. An operator refused for want of a pin could not discover the mechanism
  // existed. Breaks by: removing the `pinned` line from `grants-command.ts`.
  const { grantsCommand } = await import("../extensions/grants-command.ts");
  const { makeCatalog } = await import("../src/kernel/catalog.ts");
  const render = async (workspacePin?: ReadonlyMap<string, string>): Promise<string> => {
    let out = "";
    await grantsCommand.handler("", {
      ui: { notify: (text: string) => void (out = text) },
      grants: {
        cwd: process.cwd(),
        governed: true,
        ownGrant: ["workspace:w1"],
        executor: { disclosure: "in-process (test)" },
        advisor: { decider: "none" },
        observed: true,
        depth: 0,
        maxDepth: 2,
        catalog: makeCatalog([{ capability: "workspace:w1", kind: "workspace" }]),
        definitions: new Map(),
        sessionApprovals: new Set(),
        inheritedApprovals: new Map(),
        previewDelegation: async () => assert.fail("no definitions"),
        ...(workspacePin ? { workspacePin } : {}),
      },
    } as never);
    return out;
  };
  assert.match(await render(new Map([["w1", destinationDigest("/srv/w1")]])), /pinned {5}w1/);
  assert.match(await render(new Map()), /pinned.*none inherited/);
  assert.match(await render(undefined), /pinned.*no workspace is routable/);
});
