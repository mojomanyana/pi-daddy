import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  initializeSessionAutoMode,
  getDashboardControlState,
  setAutoApproval,
  closeSessionAutoMode,
} from "../extensions/session-auto-mode.ts";
import {
  beginExtensionLifecycle,
  bindReloadLifecycle,
  rememberChildPublication,
} from "../extensions/reload-environment.ts";
import type { GrantsSession } from "../extensions/session.ts";
import { newEpisodeId } from "../src/kernel/episode-id.ts";
import { childEnv } from "../src/kernel/propagation.ts";
import { planDelegation } from "../src/kernel/delegate.ts";
import { ENV_AUTO_MODE, ENV_AUTO_MODE_REF, ENV_FANOUT } from "../src/kernel/env-names.ts";
import { readRecords } from "../src/governance/record.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const fixture = () =>
  ({ ownerBound: true, episodeId: newEpisodeId(), reloadLifecycle: { root: {} } }) as unknown as GrantsSession;

test("reload keeps the current owner override; a new native session starts from its environment default", async () => {
  const first = fixture();
  const reloaded = fixture();
  try {
    await initializeSessionAutoMode(first, {}, "native-1");
    await setAutoApproval(first, true, "dashboard");
    reloaded.reloadLifecycle = first.reloadLifecycle;
    await initializeSessionAutoMode(reloaded, {}, "native-1");
    assert.equal(reloaded.autoMode, first.autoMode);
    assert.deepEqual((await getDashboardControlState(reloaded)).auto, { enabled: true, source: "session" });
    await initializeSessionAutoMode(reloaded, {}, "native-2");
    assert.deepEqual((await getDashboardControlState(reloaded)).auto, { enabled: false, source: "default" });
    await assert.rejects(getDashboardControlState(first), /unavailable/);
  } finally {
    await closeSessionAutoMode(first);
    await closeSessionAutoMode(reloaded);
  }
});

test("both child environment paths carry the same live owner, never a copied ON flag", async () => {
  const parent = fixture(),
    child = fixture();
  try {
    await initializeSessionAutoMode(parent, { [ENV_AUTO_MODE]: "1" }, "parent");
    const common = {
      ownGrant: ["tool:read"],
      depth: 0,
      maxDepth: 3,
      gated: [],
      autoModeRef: parent.autoMode!.reference,
    };
    const inherited = childEnv(common);
    const plan = planDelegation({ task: "Read the fixture", tools: ["read"] }, common);
    assert.equal(plan.ok, true);
    assert.equal(plan.env[ENV_AUTO_MODE_REF], inherited[ENV_AUTO_MODE_REF]);
    assert.equal(plan.env[ENV_AUTO_MODE], "0");
    await initializeSessionAutoMode(child, { ...inherited, [ENV_AUTO_MODE]: "1" }, "child");
    assert.equal(await child.autoMode!.admit(), true);
    await setAutoApproval(parent, false, "dashboard");
    assert.equal(await child.autoMode!.admit(), false);
    await assert.rejects(setAutoApproval(child, true, "dashboard"), /owning root/);
  } finally {
    await closeSessionAutoMode(child);
    await closeSessionAutoMode(parent);
  }
});

test("Auto mutations are audited; failed ON grants nothing and failed OFF stays OFF", async () => {
  const session = fixture();
  const cwd = await tempDir("auto-audit-");
  const ledger = join(cwd, "ledger.jsonl");
  const blocker = join(cwd, "not-a-directory");
  await writeFile(blocker, "x");
  try {
    await initializeSessionAutoMode(session, {}, "audit");
    session.ledgerPath = ledger;
    await setAutoApproval(session, true, "dashboard");
    const event = readRecords(await readFile(ledger, "utf8")).records[0]!.body as {
      event: string;
      trigger: string;
      autoMode: { enabled: boolean };
    };
    assert.equal(event.event, "session_config");
    assert.equal(event.trigger, "auto-mode");
    assert.equal(event.autoMode.enabled, true);
    session.ledgerPath = join(blocker, "ledger.jsonl");
    await assert.rejects(setAutoApproval(session, false, "dashboard"));
    assert.equal(await session.autoMode!.admit(), false);
    await assert.rejects(setAutoApproval(session, true, "dashboard"));
    assert.equal(await session.autoMode!.admit(), false);
  } finally {
    await closeSessionAutoMode(session);
  }
});

test("malformed root settings and unavailable inherited owners do not silently enable Auto", async () => {
  const invalid = fixture(),
    root = fixture(),
    child = fixture();
  try {
    await assert.rejects(
      initializeSessionAutoMode(invalid, { [ENV_AUTO_MODE]: "true" }, "invalid"),
      /PI_DADDY_AUTO_MODE/,
    );
    await initializeSessionAutoMode(root, {}, "root");
    const reference = root.autoMode!.reference;
    await closeSessionAutoMode(root);
    await assert.rejects(
      initializeSessionAutoMode(
        child,
        { [ENV_AUTO_MODE]: "1", [ENV_AUTO_MODE_REF]: JSON.stringify(reference) },
        "child",
      ),
      /unavailable/,
    );
    await assert.rejects(getDashboardControlState(child), /unavailable/);
  } finally {
    await closeSessionAutoMode(invalid);
    await closeSessionAutoMode(root);
    await closeSessionAutoMode(child);
  }
});

test("a new SDK owner cannot inherit a previous local owner's published Auto override", async () => {
  const previous = { ...process.env };
  const first = fixture(),
    second = fixture();
  try {
    delete process.env[ENV_AUTO_MODE];
    delete process.env[ENV_AUTO_MODE_REF];
    const initial = beginExtensionLifecycle();
    const one = bindReloadLifecycle({}, initial.lifecycle);
    first.reloadLifecycle = one.lifecycle;
    await initializeSessionAutoMode(first, one.environment, "one");
    await setAutoApproval(first, true, "dashboard");
    process.env[ENV_AUTO_MODE] = "0";
    process.env[ENV_AUTO_MODE_REF] = JSON.stringify(first.autoMode!.reference);
    rememberChildPublication(first.reloadLifecycle);
    process.env[ENV_FANOUT] = "7";
    const fresh = beginExtensionLifecycle();
    const two = bindReloadLifecycle({}, fresh.lifecycle);
    second.reloadLifecycle = two.lifecycle;
    assert.equal(two.environment[ENV_FANOUT], "7");
    await initializeSessionAutoMode(second, two.environment, "two");
    assert.deepEqual((await getDashboardControlState(second)).auto, { enabled: false, source: "default" });
    assert.notEqual(second.autoMode!.reference.ownerId, first.autoMode!.reference.ownerId);
    assert.equal(await first.autoMode!.admit(), true);
    await setAutoApproval(second, true, "dashboard");
    await setAutoApproval(first, false, "dashboard");
    assert.equal(await second.autoMode!.admit(), true);
  } finally {
    await closeSessionAutoMode(first);
    await closeSessionAutoMode(second);
    for (const key of [ENV_AUTO_MODE, ENV_AUTO_MODE_REF, ENV_FANOUT])
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]);
  }
});

test("new SDK owners retain explicit Auto defaults and references instead of unrelated local publications", async () => {
  const previous = { ...process.env };
  const publisher = fixture(),
    external = fixture(),
    explicitDefault = fixture(),
    explicitReference = fixture();
  try {
    delete process.env[ENV_AUTO_MODE];
    delete process.env[ENV_AUTO_MODE_REF];
    publisher.reloadLifecycle = beginExtensionLifecycle().lifecycle;
    await initializeSessionAutoMode(publisher, {}, "publisher");
    await initializeSessionAutoMode(external, { [ENV_AUTO_MODE]: "1" }, "external");
    process.env[ENV_AUTO_MODE] = "0";
    process.env[ENV_AUTO_MODE_REF] = JSON.stringify(publisher.autoMode!.reference);
    rememberChildPublication(publisher.reloadLifecycle);

    process.env[ENV_AUTO_MODE] = "1";
    const defaultOwner = bindReloadLifecycle({}, beginExtensionLifecycle().lifecycle);
    explicitDefault.reloadLifecycle = defaultOwner.lifecycle;
    await initializeSessionAutoMode(explicitDefault, defaultOwner.environment, "explicit-default");
    assert.deepEqual((await getDashboardControlState(explicitDefault)).auto, { enabled: true, source: "environment" });
    assert.notEqual(explicitDefault.autoMode!.reference.ownerId, publisher.autoMode!.reference.ownerId);

    process.env[ENV_AUTO_MODE_REF] = JSON.stringify(external.autoMode!.reference);
    const referenceOwner = bindReloadLifecycle({}, beginExtensionLifecycle().lifecycle);
    explicitReference.reloadLifecycle = referenceOwner.lifecycle;
    await initializeSessionAutoMode(explicitReference, referenceOwner.environment, "explicit-reference");
    assert.equal(explicitReference.autoMode!.reference.ownerId, external.autoMode!.reference.ownerId);
    await setAutoApproval(external, false, "dashboard");
    assert.equal(await explicitReference.autoMode!.admit(), false);
  } finally {
    await Promise.all([publisher, external, explicitDefault, explicitReference].map(closeSessionAutoMode));
    for (const key of [ENV_AUTO_MODE, ENV_AUTO_MODE_REF])
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]);
  }
});
