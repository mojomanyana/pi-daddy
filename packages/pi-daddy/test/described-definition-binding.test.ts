/**
 * The harness carries the definitionId (owner decision of 2026-11-17), as the extension actually wires it.
 *
 * The real `grants.ts` loads against a fake `pi` whose selected skills are a Principal package laid out like
 * `test/selected-definitions.test.ts` builds it (verified manifest, hashes and delegated agent bodies) plus two
 * ordinary definitions. A fake child named `pi` on PATH answers every governed launch, and the ledger is a real
 * file. Session starts are driven with the reasons Pi 1.0.4 sends: a reload builds a new extension instance for
 * the same session manager; `/new`, resume and fork bring a new session manager; tree navigation fires
 * `session_tree` on the same instance.
 *
 * **The production changes that break these tests**, one per case:
 *
 *  - not filling an omitted definitionId from the last describe, in any one of the three tools;
 *  - remembering per call or globally instead of per agent; letting a supplied ID update the memory or lose to it;
 *  - dropping the memory on `/reload`, or keeping it across `/new`, resume, fork, tree navigation or a root
 *    replacement; recording a describe that was refused or failed;
 *  - not refusing a remembered ID whose definition changed, or telling the model to copy an ID there;
 *  - giving a chain step or batch child another entry's binding, or checking it with another entry's source;
 *  - not recording the ID and its source in the result details, or recording one never used; writing it to the
 *    ledger, whose closed schema skill-harness pins; recording a remembered ID as the caller's request in capture;
 *  - digesting how a call got its definitionId instead of the selected definition: an identical `operation_id`
 *    retry must stay the same request across a describe or tree navigation, and a changed definition must not be.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import grantsExtension from "../extensions/grants.ts";
import { bindDescribedDefinitions, registerDefinitionDescribe } from "../extensions/definition-describe.ts";
import { ENV_PUBLIC_EVIDENCE_DIR } from "../src/kernel/env-names.ts";
import { GRANT_ENV_KEYS } from "../src/kernel/propagation.ts";
import { selectedDefinitions } from "../src/kernel/selected-definitions.ts";
import { piFixtureScript } from "./pi-fixture.ts";
import { toolSources } from "./tool-sources-fixture.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const KEYS = [...GRANT_ENV_KEYS, "PATH", "PI_CODING_AGENT_DIR", "PI_DADDY_GATED"];
const saved = new Map<string, string | undefined>();
afterEach(() => {
  for (const [key, value] of saved) value === undefined ? delete process.env[key] : (process.env[key] = value);
  saved.clear();
});

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const PHASES = ["plan", "build", "review", "debug", "investigate"];
const agentBody = (phase: string, edit = "") =>
  `---\nname: principal-${phase}\ndescription: delegated\nallowed-tools: read, write\n---\nEXACT DELEGATED ${phase}${edit}\n`;
const ADMISSION = " This call stopped before operation admission; it started no child.";
const notDescribed = (agent: string) =>
  `Principal delegation for agent "${agent}" has no described definition. Describe it first with delegate_describe.` +
  ADMISSION;

/** The Principal package of `test/selected-definitions.test.ts`, plus ordinary `notes` and gated `shell`. */
async function writeDefinitions(root: string, edits: Record<string, string> = {}) {
  const bindings: Record<string, unknown> = {};
  await mkdir(join(root, "agents"), { recursive: true });
  for (const phase of PHASES) {
    await mkdir(join(root, phase), { recursive: true });
    const skill = `---\nname: ${phase}\ndescription: inline\nallowed-tools: read\n---\nINLINE`;
    const agent = agentBody(phase, edits[phase]);
    await writeFile(join(root, phase, "SKILL.md"), skill);
    await writeFile(join(root, "agents", `principal-${phase}.md`), agent);
    bindings[phase] = {
      skill: `${phase}/SKILL.md`,
      agent: `agents/principal-${phase}.md`,
      skillSha256: hash(skill),
      agentSha256: hash(agent),
    };
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "principal-pi-skills", version: "4.7.3" }));
  await writeFile(
    join(root, "principal-agents.json"),
    JSON.stringify({ version: 1, package: "principal-pi-skills", bindings }),
  );
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(
    join(root, "notes", "SKILL.md"),
    "---\nname: notes\ndescription: ordinary\nallowed-tools: read\n---\nTake notes.",
  );
  await mkdir(join(root, "shell"), { recursive: true });
  await writeFile(
    join(root, "shell", "SKILL.md"),
    "---\nname: shell\ndescription: gated\nallowed-tools: bash\n---\nRun the check.",
  );
}

async function harness(env: Record<string, string> = {}) {
  const dir = await tempDir("described-binding-");
  for (const key of KEYS) if (!saved.has(key)) saved.set(key, process.env[key]);
  for (const key of GRANT_ENV_KEYS) delete process.env[key];
  delete process.env.PI_DADDY_GATED;
  const root = join(dir, "pkg");
  await writeDefinitions(root);
  const bin = join(dir, "bin");
  await mkdir(bin);
  const launches = join(dir, "launches");
  await writeFile(
    join(bin, "pi"),
    piFixtureScript(
      `require("node:fs").appendFileSync(${JSON.stringify(launches)}, "x\\n");\nconsole.log("CHILD DONE");\n`,
    ),
  );
  await chmod(join(bin, "pi"), 0o755);
  const ledger = join(dir, "ledger.jsonl");
  Object.assign(process.env, {
    PATH: `${bin}:${saved.get("PATH")}`,
    PI_CODING_AGENT_DIR: dir, // a private existing root, so the durable operation owner binds
    PI_DADDY_GRANT: "tool:read,tool:bash,tool:delegate,agent:build,agent:review,agent:notes,agent:shell",
    PI_DADDY_LEDGER: ledger,
    ...env,
  });
  const commands = [
    ...["build", "review"].map((phase) => ({
      source: "skill",
      name: `skill:${phase}`,
      sourceInfo: { path: join(root, phase, "SKILL.md") },
    })),
    ...["notes", "shell"].map((name) => ({
      source: "skill",
      name: `skill:${name}`,
      sourceInfo: { path: join(root, name, "SKILL.md") },
    })),
  ];
  const native = toolSources().map((tool) => ({ ...tool, description: tool.name, parameters: {}, exposure: "direct" }));
  const active = ["read", "bash", "delegate", "delegate_all", "delegate_chain", "delegate_describe"];
  let owners = 0;
  // One stable ID per session manager, as Pi's: durable operation records are owned by it across a reload.
  const newOwner = () => {
    const id = `fixture-session-${++owners}`;
    return { getSessionId: () => id };
  };
  let ctx = {
    cwd: dir,
    hasUI: false,
    ui: { notify: () => {}, select: async () => undefined },
    signal: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: newOwner(),
  };

  /** One Pi extension runtime: a reload or a replaced session builds a new one, as Pi does. */
  const load = () => {
    const tools = new Map<string, any>();
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    grantsExtension({
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => void hooks.set(name, handler),
      registerTool: (spec: { name: string }) => void tools.set(spec.name, spec),
      registerCommand: () => {},
      getAllTools: () => native,
      getActiveTools: () => active,
      setActiveTools: () => {},
      getCommands: () => commands,
    } as never);
    return { tools, hooks };
  };
  let runtime = load();
  const start = async (reason?: string) => {
    await runtime.hooks.get("session_start")!(reason ? { reason } : {}, ctx);
    await runtime.hooks.get("before_provider_request")!({ payload: { tools: active.map((name) => ({ name })) } }, ctx);
  };
  await start();

  const call = (tool: string, args: Record<string, unknown>) =>
    runtime.tools.get(tool).execute(`call-${tool}`, args, undefined, undefined, ctx) as Promise<any>;
  const describe = async (agent: string) => (await call("delegate_describe", { agent })).details.definitionId as string;
  const decisions = async () =>
    (await readFile(ledger, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).body)
      .filter((body) => body.event === "capability_decision");
  const launched = async () => (await readFile(launches, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return {
    dir,
    root,
    commands,
    call,
    describe,
    decisions,
    launched,
    /** Pi's `/reload`: the old runtime shuts down, a new one starts for the same session manager. */
    reload: async () => {
      await runtime.hooks.get("session_shutdown")!({ reason: "reload" }, ctx);
      runtime = load();
      await start("reload");
    },
    /** A replaced session (`/new`, resume, fork): a new session manager, on a new runtime or this one. */
    replace: async (reason: string, newRuntime: boolean) => {
      await runtime.hooks.get("session_shutdown")!({ reason }, ctx);
      ctx = { ...ctx, sessionManager: newOwner() };
      if (newRuntime) runtime = load();
      await start(reason);
    },
    tree: () => runtime.hooks.get("session_tree")!({ type: "session_tree", newLeafId: null, oldLeafId: null }, ctx),
    edit: (phase: string, text: string) => writeDefinitions(root, { [phase]: text }),
    close: () => runtime.hooks.get("session_shutdown")!({ reason: "quit" }, ctx),
  };
}

const remembered = (definitionId: string) => ({ definitionId, source: "remembered" });
const supplied = (definitionId: string) => ({ definitionId, source: "supplied" });
const changedSince = (agent: string) =>
  `Definition snapshot changed or is unavailable for agent "${agent}": it changed since this session described it. ` +
  "Describe it again with delegate_describe.";
const suppliedStale = (agent: string) =>
  `Definition snapshot changed or is unavailable for agent "${agent}": the supplied definitionId does not match ` +
  "its current selection. Describe it again with delegate_describe and omit the ID.";
/** The binding is reported in result details only: no capability decision carries it (closed, pinned schema). */
const assertNoLedgerBinding = (decisions: Array<Record<string, unknown>>) => {
  assert.notEqual(decisions.length, 0);
  for (const decision of decisions)
    assert.deepEqual(
      [Object.hasOwn(decision, "definitionId"), Object.hasOwn(decision, "definitionIdSource")],
      [false, false],
    );
};
/**
 * An unresolvable model is refused only after the identity check, so a probe shows without launching a child
 * whether a Principal delegation carried the current definitionId ("bound"; no other ID passes that check), was
 * refused as never described, or was refused because its remembered ID changed since the describe.
 */
const UNRESOLVED = "nope/nope";
async function probe(f: Awaited<ReturnType<typeof harness>>, spec: Record<string, unknown>) {
  try {
    await f.call("delegate", { task: "probe", ...spec, model: UNRESOLVED });
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith(notDescribed(String(spec.agent)))) return "not described";
    if (message.startsWith(changedSince(String(spec.agent)))) return "changed";
    assert.match(message, /nope\/nope/);
    return "bound";
  }
  assert.fail("a probe must not launch");
}

test("a described agent's definitionId fills delegate, a delegate_all child and a delegate_chain step", async () => {
  const f = await harness();
  try {
    await assert.rejects(f.call("delegate", { agent: "build", task: "before describe" }), {
      message: notDescribed("build") + " This does not establish whether an earlier call used the same operation ID.",
    });
    assert.equal(await f.launched(), 0);
    const described = await f.call("delegate_describe", { agent: "build" });
    const id = described.details.definitionId;
    assert.match(id, /^[a-f0-9]{64}$/);
    assert.deepEqual(described.details.delegationArguments, { agent: "build", definitionId: id }, "shape kept");

    const single = await f.call("delegate", { agent: "build", task: "one" });
    assert.equal(single.isError, false, single.content[0].text);
    assert.deepEqual(single.details.definitionBinding, remembered(id));
    const all = await f.call("delegate_all", {
      children: [
        { agent: "build", task: "two" },
        { agent: "notes", task: "ordinary, never described" },
      ],
    });
    assert.equal(all.isError, false, all.content[0].text);
    assert.deepEqual(
      all.details.outcomes.map((outcome: any) => outcome.definitionBinding),
      [remembered(id), undefined],
    );
    const chain = await f.call("delegate_chain", { steps: [{ agent: "build", task: "three" }] });
    assert.equal(chain.isError, false, chain.content[0].text);
    assert.deepEqual(chain.details.outcomes[0].definitionBinding, remembered(id));

    assert.equal(await f.launched(), 4);
    // Fan-out children append concurrently, so the ledger is compared as a multiset.
    const decisions = await f.decisions();
    assert.deepEqual(
      decisions.map((decision) => JSON.stringify([decision.agentType, decision.blocked])).sort(),
      [
        ["build", false],
        ["build", false],
        ["build", false],
        ["notes", false],
      ].map((row) => JSON.stringify(row)),
    );
    assertNoLedgerBinding(decisions);
    for (const result of [single, all, chain])
      assert.equal(JSON.stringify(result.content).includes(id), false, "the model is not handed the ID");
  } finally {
    await f.close();
  }
});

test("two agents keep their own described definitionIds", async () => {
  const f = await harness();
  try {
    const build = await f.describe("build");
    assert.equal(await probe(f, { agent: "review" }), "not described");
    const review = await f.describe("review");
    assert.notEqual(build, review);
    assert.equal(await probe(f, { agent: "review" }), "bound");
    assert.equal(await probe(f, { agent: "build" }), "bound", "still build's own ID, not review's");
    assert.equal(await f.launched(), 0);
  } finally {
    await f.close();
  }
});

test("/reload keeps the binding; a definition changed since its describe refuses until described again", async () => {
  const f = await harness();
  try {
    const first = await f.describe("build");
    await f.reload();
    assert.equal(await probe(f, { agent: "build" }), "bound", "same definition after reload");

    await f.edit("build", " changed");
    await f.reload();
    const recorded = (await f.decisions()).length;
    await assert.rejects(f.call("delegate", { agent: "build", task: "stale" }), (error: Error) => {
      assert.equal(
        error.message,
        changedSince("build") +
          ADMISSION +
          " This does not establish whether an earlier call used the same operation ID.",
      );
      assert.doesNotMatch(error.message, /copy|delegationArguments/i);
      return true;
    });
    await assert.rejects(f.call("delegate_chain", { steps: [{ agent: "build", task: "stale" }] }), /changed since/);
    await assert.rejects(f.call("delegate_all", { children: [{ agent: "build", task: "stale" }] }), /changed since/);
    assert.equal((await f.decisions()).length, recorded, "a stale binding is an input error: no decision is written");

    const second = await f.describe("build");
    assert.notEqual(second, first);
    assert.equal(await probe(f, { agent: "build" }), "bound");
    assert.equal(await f.launched(), 0);
  } finally {
    await f.close();
  }
});

test("an agent no longer selected after /reload refuses its remembered ID as changed, not as a wrong name", async () => {
  const f = await harness();
  try {
    await f.describe("notes");
    f.commands.splice(
      f.commands.findIndex((command) => command.name === "skill:notes"),
      1,
    );
    await f.reload();
    await assert.rejects(f.call("delegate", { agent: "notes", task: "gone" }), (error: Error) => {
      assert.equal(error.message.startsWith(changedSince("notes") + ADMISSION), true, error.message);
      return true;
    });
    await assert.rejects(
      f.call("delegate", { agent: "notes", definitionId: "e".repeat(64), task: "gone" }),
      /^Error: Delegation agent "notes" is not in the current selected definitions\. Use the exact agent name/,
    );
    assert.equal(await f.launched(), 0);
  } finally {
    await f.close();
  }
});

test("a supplied definitionId wins over the remembered one and never replaces it", async () => {
  const f = await harness();
  try {
    const first = await f.describe("build");
    assert.equal(await probe(f, { agent: "build", definitionId: first }), "bound");
    await assert.rejects(
      f.call("delegate_all", { children: [{ agent: "build", definitionId: "f".repeat(64), task: "explicit stale" }] }),
      (error: Error) => {
        assert.equal(error.message.startsWith(suppliedStale("build") + ADMISSION), true, error.message);
        return true;
      },
    );
    assert.equal(await probe(f, { agent: "build" }), "bound", "a refused supplied ID changed nothing");

    await f.edit("build", " changed");
    await f.reload();
    // A caller that already holds the current ID may supply it: that call is bound to it, and the memory keeps `first`.
    const current = (await selectedDefinitions(f.commands)).definitions.get("build")!.definitionId!;
    assert.notEqual(current, first);
    assert.equal(await probe(f, { agent: "build", definitionId: current }), "bound", "the supplied ID won");
    assert.equal(await probe(f, { agent: "build" }), "changed", "the memory still holds the first ID");
    assert.equal(await f.launched(), 0);
  } finally {
    await f.close();
  }
});

test("/new, resume, fork, tree navigation and a root replacement drop the binding; /reload keeps it", async () => {
  const f = await harness();
  try {
    const events: Array<[string, () => Promise<unknown>]> = [
      ["new on a new runtime", () => f.replace("new", true)],
      ["new on this runtime", () => f.replace("new", false)],
      ["resume on a new runtime", () => f.replace("resume", true)],
      ["resume on this runtime", () => f.replace("resume", false)],
      ["fork on a new runtime", () => f.replace("fork", true)],
      ["fork on this runtime", () => f.replace("fork", false)],
      ["tree navigation", async () => f.tree()],
      [
        "a reload that explicitly replaces the root",
        async () => {
          process.env.PI_DADDY_GRANT = "tool:read,tool:delegate,agent:build";
          await f.reload();
        },
      ],
    ];
    for (const [label, event] of events) {
      const id = await f.describe("build");
      assert.ok(id);
      assert.equal(await probe(f, { agent: "build" }), "bound", `${label}: bound before`);
      await f.reload();
      assert.equal(await probe(f, { agent: "build" }), "bound", `${label}: a reload keeps it`);
      await event();
      assert.equal(await probe(f, { agent: "build" }), "not described", `${label}: dropped`);
    }
    assert.equal(await f.launched(), 0);
  } finally {
    await f.close();
  }
});

/** The fixture session of `test/definition-input-recovery.test.ts`, with a reload lifecycle to hold the memory. */
function describeFixture() {
  const definition = Object.freeze({
    name: "build",
    description: "Build",
    allowedTools: "read",
    body: "Read.",
    source: "/fixture/build/SKILL.md",
    definitionId: "a".repeat(64),
  });
  const session: Record<string, any> = {
    ownGrant: ["tool:read", "tool:delegate", "agent:build", "agent:notes"],
    depth: 0,
    ownerBound: true,
    mayDelegate: true,
    reloadLifecycle: { root: {} },
    definitions: new Map<string, unknown>([
      ["build", definition],
      ["notes", { ...definition, name: "notes", definitionId: "b".repeat(64) }],
    ]),
    ensureDefinitions: async () => {},
  };
  let tool: any;
  registerDefinitionDescribe({ registerTool: (value: unknown) => (tool = value) } as never, session as never);
  const describe = (agent: string) => tool.execute("describe", { agent }, undefined, undefined, {});
  const binding = (agent: string) => bindDescribedDefinitions(session as never, [{ agent }]).bindings[0];
  return { session, describe, binding };
}

test("a refused or failed describe binds nothing and leaves an earlier binding as it was", async () => {
  const f = describeFixture();
  f.session.ownGrant = ["tool:read", "tool:delegate", "agent:notes"];
  await assert.rejects(f.describe("build"), /outside this session's grant/);
  f.session.ownGrant.push("agent:build");
  assert.equal(f.binding("build"), undefined, "refused");
  f.session.parentToolContext = () => {
    throw Error("tool inventory unavailable");
  };
  await assert.rejects(f.describe("build"), /tool inventory unavailable/);
  assert.equal(f.binding("build"), undefined, "failed after reading the definition");
  delete f.session.parentToolContext;
  await f.describe("build");
  assert.deepEqual(f.binding("build"), remembered("a".repeat(64)));
  f.session.definitions.set("build", { ...f.session.definitions.get("build"), definitionId: undefined });
  await assert.rejects(f.describe("build"), /selected definition is unavailable/);
  assert.deepEqual(f.binding("build"), remembered("a".repeat(64)), "the earlier binding is unchanged");
  assert.equal(f.binding("notes"), undefined, "another agent is not bound by it");
});

test("a describe that straddles a session replacement binds only the session it started in", async () => {
  const f = describeFixture();
  const started = f.session.reloadLifecycle;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  f.session.ensureDefinitions = () => gate;
  const pending = f.describe("build");
  f.session.reloadLifecycle = { root: {} }; // what a `/new` session start binds while the describe waits
  release();
  await pending;
  assert.equal(f.binding("build"), undefined, "the replacement session never saw this describe");
  assert.deepEqual(started.describedDefinitions, new Map([["build", "a".repeat(64)]]));
});

test("binding reads only the call: a supplied ID, even empty, is never replaced and an unnamed agent binds nothing", async () => {
  const f = describeFixture();
  await f.describe("build");
  const { specs, bindings } = bindDescribedDefinitions(f.session as never, [
    { agent: "build", task: "t" },
    { agent: "build", definitionId: "", task: "t" },
    { agent: "build", definitionId: "c".repeat(64), task: "t" },
    { task: "t", tools: ["read"] },
    { agent: "notes", task: "t" },
  ]);
  assert.deepEqual(specs, [
    { agent: "build", task: "t", definitionId: "a".repeat(64) },
    { agent: "build", definitionId: "", task: "t" },
    { agent: "build", definitionId: "c".repeat(64), task: "t" },
    { task: "t", tools: ["read"] },
    { agent: "notes", task: "t" },
  ]);
  assert.deepEqual(bindings, [
    remembered("a".repeat(64)),
    { definitionId: "", source: "supplied" },
    { definitionId: "c".repeat(64), source: "supplied" },
    undefined,
    undefined,
  ]);
  assert.deepEqual(f.binding("build"), remembered("a".repeat(64)), "binding a call never writes the memory");
  delete f.session.reloadLifecycle;
  assert.equal(f.binding("build"), undefined, "no lifecycle, no memory");
});

test("each chain step carries its own binding: two steps with different agents", async () => {
  const f = await harness();
  try {
    const id = await f.describe("build");
    const chain = await f.call("delegate_chain", {
      steps: [
        { agent: "notes", task: "ordinary, never described" },
        { agent: "build", task: "described" },
      ],
    });
    assert.equal(chain.isError, false, chain.content[0].text);
    assert.deepEqual(
      chain.details.outcomes.map((outcome: any) => [outcome.agent, outcome.definitionBinding]),
      [
        ["notes", undefined],
        ["build", remembered(id)],
      ],
    );
    assert.equal(await f.launched(), 2);
  } finally {
    await f.close();
  }
});

test("a refused or gated second chain step is checked with its own binding and records none", async () => {
  const f = await harness();
  try {
    const build = await f.describe("build");
    const review = await f.describe("review");
    await f.edit("review", " changed");
    await f.reload();
    assert.equal(await probe(f, { agent: "build", definitionId: build }), "bound", "build itself did not change");
    const recorded = (await f.decisions()).length;
    // Step 1 is fine either way; step 2's refusal names how step 2 got its ID, not how step 1 did.
    await assert.rejects(
      f.call("delegate_chain", {
        steps: [
          { agent: "build", definitionId: build, task: "supplied, current" },
          { agent: "review", task: "remembered, stale" },
        ],
      }),
      (error: Error) => {
        assert.equal(error.message.startsWith(changedSince("review") + ADMISSION), true, error.message);
        return true;
      },
    );
    await assert.rejects(
      f.call("delegate_chain", {
        steps: [
          { agent: "build", task: "remembered, current" },
          { agent: "review", definitionId: review, task: "supplied, stale" },
        ],
      }),
      (error: Error) => {
        assert.equal(error.message.startsWith(suppliedStale("review") + ADMISSION), true, error.message);
        return true;
      },
    );
    assert.equal((await f.decisions()).length, recorded, "a stale step is an input error: no decision is written");

    // `bash` is gated and this session has nobody to ask, so the chain's upfront gate declines step 2.
    await f.describe("shell");
    await assert.rejects(
      f.call("delegate_chain", {
        steps: [
          { agent: "build", task: "remembered" },
          { agent: "shell", task: "gated" },
        ],
      }),
      /was not approved for shell/,
    );
    const decisions = (await f.decisions()).slice(recorded);
    assert.deepEqual(
      decisions.map((decision) => [decision.agentType, decision.blocked]),
      [["shell", true]],
    );
    assertNoLedgerBinding(decisions);
    assert.equal(await f.launched(), 0);
  } finally {
    await f.close();
  }
});

test("operation election checks the bound entry: a delegate_all child, a chain's first step and a delegate", async () => {
  const f = await harness();
  try {
    await f.describe("build");
    // Not in the grant and not gated, so the election's preview denies it and records that refusal. A Principal
    // entry that reached the election without its remembered ID would be refused as never described instead.
    const denied = (operation_id: string) => ({
      agent: "build",
      task: "denied at election",
      operation_id,
      context: { mode: "summary", summary: "x" },
    });
    await assert.rejects(
      f.call("delegate_all", { children: [{ agent: "notes", task: "ordinary" }, denied("bind:denied-batch")] }),
      /context:summary/,
    );
    await assert.rejects(f.call("delegate_chain", { steps: [denied("bind:denied-chain")] }), /context:summary/);
    await assert.rejects(f.call("delegate", denied("bind:denied-single")), /context:summary/);
    const decisions = await f.decisions();
    assert.deepEqual(
      decisions.map((decision) => [decision.agentType, decision.blocked]),
      [
        ["build", true],
        ["build", true],
        ["build", true],
      ],
    );
    assertNoLedgerBinding(decisions);
    assert.equal(await f.launched(), 0);
  } finally {
    await f.close();
  }
});

test("a remembered ID is the same operation request as the supplied one: a repeat returns the original", async () => {
  const f = await harness();
  try {
    const id = await f.describe("build");
    const step = { agent: "build", task: "once", operation_id: "bind:chain-once" };
    const first = await f.call("delegate_chain", { steps: [{ ...step, definitionId: id }] });
    assert.equal(first.isError, false, first.content[0].text);
    assert.deepEqual(first.details.outcomes[0].definitionBinding, supplied(id));
    const repeat = await f.call("delegate_chain", { steps: [step] });
    assert.equal(repeat.details.outcomes[0].operation.reused, true, repeat.content[0].text);
    assert.equal(repeat.details.outcomes[0].operation.executionId, first.details.outcomes[0].operation.executionId);
    assert.deepEqual(repeat.details.outcomes[0].definitionBinding, remembered(id));
    assert.equal(await f.launched(), 1);
  } finally {
    await f.close();
  }
});

test("an identical operation_id retry is the same request before and after a describe and after tree navigation", async () => {
  const f = await harness();
  try {
    const call = { agent: "notes", task: "once", operation_id: "probe:notes-1" };
    const first = await f.call("delegate", call);
    assert.equal(first.isError, false, first.content[0].text);
    assert.equal(first.details.definitionBinding, undefined);
    const id = await f.describe("notes");
    const afterDescribe = await f.call("delegate", call);
    assert.equal(afterDescribe.details.operation.reused, true, afterDescribe.content[0].text);
    assert.equal(afterDescribe.details.operation.executionId, first.details.operation.executionId);
    assert.deepEqual(afterDescribe.details.definitionBinding, remembered(id));

    const bound = { ...call, operation_id: "probe:notes-2" };
    const second = await f.call("delegate", bound);
    assert.equal(second.isError, false, second.content[0].text);
    assert.deepEqual(second.details.definitionBinding, remembered(id));
    await f.tree();
    for (const [retry, original] of [
      [call, first],
      [bound, second],
    ]) {
      const afterTree = await f.call("delegate", retry);
      assert.equal(afterTree.details.operation.reused, true, afterTree.content[0].text);
      assert.equal(afterTree.details.operation.executionId, original.details.operation.executionId);
      assert.equal(afterTree.details.definitionBinding, undefined);
    }
    assert.equal(await f.launched(), 2);
  } finally {
    await f.close();
  }
});

test("a changed definition cannot reuse an operation retained for the old one", async () => {
  const f = await harness();
  try {
    const call = { agent: "notes", task: "once", operation_id: "probe:notes-changed" };
    const first = await f.call("delegate", call);
    assert.equal(first.isError, false, first.content[0].text);
    const before = (await selectedDefinitions(f.commands)).definitions.get("notes")!;
    // Only the frontmatter changes: the body (and so the body digest the request already covered) stays the same.
    await writeFile(
      join(f.root, "notes", "SKILL.md"),
      "---\nname: notes\ndescription: ordinary, reworded\nallowed-tools: read\n---\nTake notes.",
    );
    const after = (await selectedDefinitions(f.commands)).definitions.get("notes")!;
    assert.deepEqual([after.body === before.body, after.definitionId === before.definitionId], [true, false]);
    await f.reload();
    await assert.rejects(f.call("delegate", call), { message: "Operation identity conflict with retained request" });
    assert.equal(await f.launched(), 1);
  } finally {
    await f.close();
  }
});

test("public capture keeps the caller's own request: a remembered ID is observed, never recorded as requested", async () => {
  const f = await harness({ [ENV_PUBLIC_EVIDENCE_DIR]: await tempDir("described-binding-capture-") });
  const manifest = async (result: any) => {
    const status = JSON.parse(result.content.at(-1).text.slice("Public evidence capture: ".length));
    assert.equal(status.status, "captured");
    return JSON.parse(await readFile(status.ref.path, "utf8"));
  };
  try {
    const id = await f.describe("build");
    const filled = await manifest(await f.call("delegate", { agent: "build", task: "remembered" }));
    assert.deepEqual(
      filled.requested.map((row: any) => [row.requestedDefinitionId, row.definitionId]),
      [[null, id]],
    );
    const explicit = await manifest(await f.call("delegate", { agent: "build", definitionId: id, task: "supplied" }));
    assert.deepEqual(
      explicit.requested.map((row: any) => [row.requestedDefinitionId, row.definitionId]),
      [[id, id]],
    );
  } finally {
    await f.close();
  }
});
