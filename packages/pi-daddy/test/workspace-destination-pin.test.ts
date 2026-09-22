import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { childEnv, GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
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
  const keys = ["PI_DADDY_WORKSPACE_REGISTRY", "PI_DADDY_WORKSPACE_PIN", "PI_CODING_AGENT_DIR"] as const;
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  try {
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
