import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { beginExtensionLifecycle, bindReloadLifecycle } from "../extensions/reload-environment.ts";
import { createGrantsSession, loadProjectDefinitions } from "../extensions/session.ts";
import { acceptWorkspaces, reconcileAcceptedWorkspaces } from "../src/governance/workspace-acceptance.ts";
import { GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

/**
 * The registry's id SET, which the destination pin does not cover.
 *
 * **Measured 2026-09-22, and it is why this exists.** ADR-0042 binds what an id MEANS. It says nothing about
 * which ids exist, and the registry is an ordinary file whose path a governed child inherits. A child holding
 * `tool:write` appended an entry of its own; the pin stopped it resolving in that session, because there was
 * no pin entry for it, and stopped nothing afterwards. The NEXT root session minted a pin from the tampered
 * registry, the catalog listed the id, and `workspace:*` admits any id at all. End to end, with no operator
 * action: `catalog ['workspace:evil','workspace:good']`, `pinned ['good','evil']`, routed into the child's
 * own directory.
 *
 * **The production changes that break these:** dropping the acceptance narrowing in `settleWorkspacePin`, or
 * letting a malformed acceptance record fall back to the registry.
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

const KEYS = [...GRANT_ENV_KEYS, "PI_DADDY_WORKSPACE_REGISTRY", "PI_CODING_AGENT_DIR"] as const;

async function withEnv(registry: string, grant: string, body: (agentDir: string) => Promise<void>): Promise<void> {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  const agentDir = await tempDir("accept-agent-");
  try {
    for (const k of KEYS) delete process.env[k];
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_DADDY_WORKSPACE_REGISTRY = registry;
    process.env.PI_DADDY_GRANT = grant;
    await body(agentDir);
  } finally {
    for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

function session(cwd: string) {
  const bound = bindReloadLifecycle({}, beginExtensionLifecycle().lifecycle);
  const s = createGrantsSession(undefined, bound.lifecycle);
  s.reconcileEnvironment(bound.environment, bound.lifecycle);
  return s;
}

test("an id a child added to the registry is not pinned, and so is not routable", async () => {
  const good = await gitDir("accept-good-");
  const evil = await gitDir("accept-evil-");
  const registry = join(await tempDir("accept-registry-"), "registry.json");
  const write = (ws: Record<string, { path: string }>) =>
    writeFile(registry, JSON.stringify({ version: 1, workspaces: ws }));

  await write({ good: { path: good } });
  // The wildcard is the shape that made this reachable with no operator action at all.
  await withEnv(registry, "tool:read,tool:write,workspace:*", async () => {
    const first = session(good);
    await loadProjectDefinitions(first, good);
    assert.deepEqual([...(first.workspacePin?.keys() ?? [])], ["good"], "the operator's own id is accepted");

    // The tamper: a child holding `tool:write` appends its own entry. It inherits the registry path.
    await write({ good: { path: good }, evil: { path: evil } });

    const next = session(good);
    await loadProjectDefinitions(next, good);
    assert.deepEqual(
      [...(next.workspacePin?.keys() ?? [])],
      ["good"],
      "a child-added id must not be pinned by the next session, however wide the grant",
    );
    assert.deepEqual(next.workspaceAcceptance?.unaccepted, ["evil"]);
    assert.ok(
      next.workspaceSkips.some((s) => s.includes("evil") && s.includes("never accepted")),
      "and the operator is told, rather than finding an id quietly missing",
    );
  });
});

test("trust on first use accepts what is already there, and says so", async () => {
  const dir = await gitDir("accept-tofu-");
  const registry = join(await tempDir("accept-tofu-registry-"), "registry.json");
  await writeFile(registry, JSON.stringify({ version: 1, workspaces: { a: { path: dir }, b: { path: dir } } }));
  await withEnv(registry, "tool:read,workspace:*", async () => {
    const s = session(dir);
    await loadProjectDefinitions(s, dir);
    assert.equal(s.workspaceAcceptance?.firstUse, true, "a machine that accepted nothing yet accepts what it has");
    assert.deepEqual(s.workspaceAcceptance?.accepted, ["a", "b"]);
    assert.deepEqual(s.workspaceAcceptance?.unaccepted, []);
  });
});

test("a malformed acceptance record accepts nothing rather than everything", async () => {
  // The same direction `grant-store.ts` takes for a malformed grant: the file records a decision, so an
  // unreadable one means the decision is unknown. Falling back to the registry would make corrupting one byte
  // the way to bypass this entirely.
  const dir = await tempDir("accept-malformed-");
  const registry = join(dir, "registry.json");
  await writeFile(registry, JSON.stringify({ version: 1, workspaces: { a: { path: dir } } }));
  const agentDir = await tempDir("accept-malformed-agent-");
  const env = { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv;
  const { acceptedWorkspacesPath } = await import("../src/kernel/project-paths.ts");
  const path = acceptedWorkspacesPath(registry, env);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "{ not json");
  const result = await reconcileAcceptedWorkspaces(registry, ["a"], env);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.unaccepted, ["a"]);
  assert.equal(result.firstUse, false);
});

test("accepting records the registry's current ids for the next session", async () => {
  const dir = await tempDir("accept-verb-");
  const registry = join(dir, "registry.json");
  const agentDir = await tempDir("accept-verb-agent-");
  const env = { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv;
  await writeFile(registry, JSON.stringify({ version: 1, workspaces: {} }));
  assert.deepEqual(await reconcileAcceptedWorkspaces(registry, [], env), {
    accepted: [],
    firstUse: true,
    unaccepted: [],
  });
  assert.deepEqual(await acceptWorkspaces(registry, ["b", "a", "a"], env), ["a", "b"], "sorted and deduplicated");
  const after = await reconcileAcceptedWorkspaces(registry, ["a", "b", "c"], env);
  assert.deepEqual(after.accepted, ["a", "b"]);
  assert.deepEqual(after.unaccepted, ["c"], "an id added after acceptance is still refused");
});

test("/grants marks an unaccepted id in the routable line, not only in a separate notice", async () => {
  // The catalog loads the unnarrowed registry, so it lists ids that cannot be routed to. Session start names
  // them, but a reader had to join two places to learn that a listed id was unusable — and review measured a
  // clean-looking `routable` line naming a workspace the session would refuse.
  // Breaks by: printing `catalog.byKind("workspace")` unmarked again.
  const { grantsCommand } = await import("../extensions/grants-command.ts");
  const { makeCatalog } = await import("../src/kernel/catalog.ts");
  let out = "";
  await grantsCommand.handler("", {
    ui: { notify: (text: string) => void (out = text) },
    grants: {
      cwd: process.cwd(),
      governed: true,
      ownGrant: ["workspace:*"],
      executor: { disclosure: "in-process (test)" },
      advisor: { decider: "none" },
      observed: true,
      depth: 0,
      maxDepth: 2,
      catalog: makeCatalog([
        { capability: "workspace:good", kind: "workspace" },
        { capability: "workspace:evil", kind: "workspace" },
      ]),
      definitions: new Map(),
      sessionApprovals: new Set(),
      inheritedApprovals: new Map(),
      previewDelegation: async () => assert.fail("no definitions"),
      workspacePin: new Map([["good", "0".repeat(32)]]),
      unacceptedWorkspaces: ["evil"],
    },
  } as never);
  assert.match(out, /workspace:evil \(NOT ACCEPTED\)/, "an id that cannot be routed to must not read as routable");
  assert.doesNotMatch(out, /workspace:good \(NOT ACCEPTED\)/);
  assert.match(out, /unaccepted evil/);
});
