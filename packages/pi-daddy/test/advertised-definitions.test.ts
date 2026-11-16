/**
 * The `agent` parameter's "Available:" list against the planner that decides a spawn.
 *
 * Since 0.57.0 `childToolDeliveryRefusal` makes the planner refuse, before any prompt, a delegation whose tools
 * a governed child cannot load. The description went on filtering by `maySpawnDefinition` alone, so a definition
 * declaring another extension's tool was advertised as available while every attempt at it was refused.
 *
 * These register the real tools over a real session and ask the real planner through `planWithApprovals`, the
 * path `/grants` previews with, so the list and the enforcer are compared on the inputs dispatch reads: the
 * session's tool inventory and its extension path. `test/delegate-all-wiring.test.ts` holds the same claim against
 * the loaded extension.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { registerDelegationTools } from "../extensions/delegation.ts";
import { planWithApprovals } from "../extensions/run-delegation.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { classifyToolNames, makeCatalog } from "../src/kernel/catalog.ts";
import { snapshotChildTools, type ChildToolSource } from "../src/kernel/child-tools.ts";
import { maySpawnDefinition } from "../src/kernel/delegate.ts";
import type { SkillDefinition } from "../src/kernel/definitions.ts";
import { toolSources } from "./tool-sources-fixture.ts";

/** The path `toolSources()` gives Daddy's own tools, which is the file Pi loads as the extension. */
const extensionPath = fileURLToPath(new URL("../extensions/grants.ts", import.meta.url));
const governed = ["delegate", "delegate_all", "delegate_chain", "delegate_describe"];
const scout = { name: "scout_research", sourceInfo: { source: "package", path: "/selected/scout.ts" } };
/** A parent that loaded native Pi, Daddy and one other extension's tool. */
const parentInventory = (): ChildToolSource[] => [...toolSources(), scout];

/** `allowed-tools` by definition name. */
const ceilings: Record<string, string> = {
  "native-only": "Read Grep",
  "handoff-reader": "read context:files",
  "tool-less": "",
  coordinator: "read delegate delegate_all",
  "scout-public": "scout_research",
  "scout-mixed": "read scout_research",
  "chain-only": "read delegate_chain",
};
const held = [
  ...["read", "grep", ...governed, "scout_research"].map((name) => `tool:${name}`),
  ...Object.keys(ceilings).map((name) => `agent:${name}`),
];

interface Options {
  /** `undefined` leaves `session.childToolSources` unset, as for a caller that predates the inventory. */
  inventory?: () => readonly ChildToolSource[];
  extensionPath?: string;
  ownGrant?: string[];
  definitions?: Record<string, string>;
}

function fixture(options: Options = {}) {
  const session = createGrantsSession(options.extensionPath);
  const declared = options.definitions ?? ceilings;
  session.ownGrant = options.ownGrant ?? held;
  session.gated = [];
  session.depth = 0;
  session.maxDepth = 2;
  session.definitions = new Map(
    Object.entries(declared).map(([name, allowedTools]): [string, SkillDefinition] => [
      name,
      { name, description: `Does ${name}.`, allowedTools, body: `Do ${name}.`, source: `/fixture/${name}/SKILL.md` },
    ]),
  );
  session.catalog = makeCatalog([
    ...classifyToolNames(["read", "grep", ...governed, "scout_research"]),
    ...Object.keys(declared).map((name) => ({ capability: `agent:${name}`, kind: "agentType" as const })),
  ]);
  session.catalogReady = Promise.resolve(session.catalog);
  // The shape `extensions/grants.ts` wires: public origins re-read on every call.
  if (options.inventory) session.childToolSources = () => snapshotChildTools(options.inventory!());

  const tools = new Map<string, { parameters: any }>();
  const pi = { registerTool: (tool: { name: string; parameters: any }) => void tools.set(tool.name, tool) };
  const registration = registerDelegationTools(pi as never, session);
  registration.refreshSpawnable();

  const described = () => ({
    delegate: tools.get("delegate")!.parameters.properties.agent.description as string,
    delegate_all: tools.get("delegate_all")!.parameters.properties.children.items.properties.agent
      .description as string,
  });
  /** The names both schemas advertise; they must be one list. */
  const advertised = (): string[] => {
    const text = described();
    assert.equal(text.delegate, text.delegate_all, "both tools describe one list");
    const list = /Available: (.*)\.$/.exec(text.delegate)?.[1];
    assert.ok(list !== undefined, text.delegate);
    return list === "none" ? [] : list.split(", ");
  };
  /** What a real `delegate({agent})` would be told, with no human asked. */
  const plan = async (name: string) =>
    (await planWithApprovals(session, { task: "(preview)", agent: name }, {}, null)).plan;
  return { session, registration, advertised, plan };
}

test("a definition needing another extension's tool is not advertised; a native-only one is", () => {
  // Breaks if `spawnable()` in `extensions/delegation.ts` stops filtering by `childToolDeliveryRefusal`: the
  // parent holds `tool:scout_research` and both `agent:` ids, so the grant filter alone lists scout-public.
  const f = fixture({
    inventory: parentInventory,
    definitions: { "native-only": "Read Grep", "scout-public": "scout_research" },
  });
  assert.ok(maySpawnDefinition(f.session.ownGrant, "scout-public"), "the grant is not what withholds it");
  assert.deepEqual(f.advertised(), ["native-only"]);
});

test("the advertised list and the planner agree in both directions on the same inventory", async () => {
  // Breaks if the list is computed from anything but the planner's own delivery rule over the session's
  // inventory and extension path: dropping the filter advertises the delivery-refused names, and a second
  // spelling of "native" or "governed" (or a missing `extensionPath`) hides a name the planner accepts.
  const overridden = () => [
    ...parentInventory().filter((tool) => tool.name !== "read"),
    { name: "read", sourceInfo: { source: "package", path: "/override/read.ts" } },
  ];
  const cases: { name: string; inventory?: () => ChildToolSource[]; accepted: string[]; undeliverable: string[] }[] = [
    {
      name: "observed parent inventory",
      inventory: parentInventory,
      accepted: ["coordinator", "handoff-reader", "native-only", "tool-less"],
      undeliverable: ["chain-only", "scout-mixed", "scout-public"],
    },
    {
      // A parent extension replaced native `read`, so no child can be promised it.
      name: "native read overridden",
      inventory: overridden,
      accepted: ["tool-less"],
      undeliverable: ["chain-only", "coordinator", "handoff-reader", "native-only", "scout-mixed", "scout-public"],
    },
    {
      name: "no inventory supplied",
      accepted: ["coordinator", "handoff-reader", "native-only", "tool-less"],
      undeliverable: ["chain-only", "scout-mixed", "scout-public"],
    },
  ];
  for (const scenario of cases) {
    const f = fixture({ inventory: scenario.inventory, extensionPath });
    const advertised = f.advertised();
    const accepted: string[] = [];
    const undeliverable: string[] = [];
    for (const name of Object.keys(ceilings).sort()) {
      const plan = await f.plan(name);
      if (plan.ok) accepted.push(name);
      else if (plan.refusal?.details?.kind === "child-tool-unavailable") undeliverable.push(name);
      else assert.fail(`${scenario.name}: ${name} was refused for an unrelated reason: ${plan.reason}`);
    }
    // The planner's own verdicts, pinned so neither direction below can pass on an empty set.
    assert.deepEqual(accepted, scenario.accepted, scenario.name);
    assert.deepEqual(undeliverable, scenario.undeliverable, scenario.name);
    for (const name of undeliverable)
      assert.ok(!advertised.includes(name), `${scenario.name}: ${name} is advertised and always refused`);
    for (const name of accepted)
      assert.ok(advertised.includes(name), `${scenario.name}: ${name} is spawnable and was hidden`);
  }
});

test("an undeliverable ceiling stays hidden when the planner reports the missing grant first", async () => {
  // Breaks if the filter copies the planner's reporting order (delivery checked only once every tool is held):
  // the planner then names the escalation, and the list would advertise a definition no grant can make run.
  const f = fixture({
    inventory: parentInventory,
    extensionPath,
    ownGrant: held.filter((capability) => capability !== "tool:scout_research"),
  });
  const plan = await f.plan("scout-public");
  assert.equal(plan.refusal?.code, "CAPABILITY_ESCALATION");
  assert.ok(!f.advertised().includes("scout-public"));
  assert.ok(f.advertised().includes("native-only"));
});

test("without an inventory native tools still count as deliverable and external ones never do", async () => {
  // Breaks if a missing `session.childToolSources` is read as an EMPTY inventory (`?.() ?? []`): the planner
  // treats an unobserved native tool as deliverable, so native-only would be hidden while it still spawns.
  const f = fixture({ definitions: { "native-only": "Read Grep", "scout-public": "scout_research" } });
  assert.equal(f.session.childToolSources, undefined);
  assert.deepEqual(f.advertised(), ["native-only"]);
  assert.equal((await f.plan("native-only")).ok, true);
  assert.equal((await f.plan("scout-public")).refusal?.details?.kind, "child-tool-unavailable");
});

test("a definition that sub-delegates is advertised only where the governance entrypoint can load", async () => {
  // Breaks if `spawnable()` omits `session.extensionPath` from what it hands `childToolDeliveryRefusal`: a
  // coordinator the planner accepts would vanish from the list in every session.
  const definitions = { coordinator: "read delegate delegate_all" };
  const present = fixture({ inventory: parentInventory, extensionPath, definitions });
  assert.deepEqual(present.advertised(), ["coordinator"]);
  assert.equal((await present.plan("coordinator")).ok, true);

  // No entrypoint to hand a child, or `delegate` registered by some other file: the planner refuses both.
  const foreign = () => [
    ...toolSources().filter((tool) => !governed.includes(tool.name)),
    ...governed.map((name) => ({ name, sourceInfo: { source: "local", path: "/elsewhere/grants.ts" } })),
  ];
  for (const options of [{ inventory: parentInventory }, { inventory: foreign, extensionPath }]) {
    const absent = fixture({ ...options, definitions });
    assert.equal((await absent.plan("coordinator")).refusal?.details?.kind, "child-tool-unavailable");
    assert.deepEqual(absent.advertised(), []);
  }
});

test("an unreadable or changed inventory never throws into a hook and reaches both schemas", () => {
  // Breaks if the inventory read in `spawnable()` loses its guard (the throw escapes registration and every
  // refresh), if an unread inventory lists anything but the planner's unobserved set, or if `refreshSpawnable`
  // stops rewriting one of the two schemas (`advertised` compares them).
  let inventory: () => readonly ChildToolSource[] = parentInventory;
  const f = fixture({ inventory: () => inventory(), extensionPath });
  assert.deepEqual(f.advertised(), ["coordinator", "handoff-reader", "native-only", "tool-less"]);

  inventory = () => parentInventory().filter((tool) => tool.name !== "grep");
  f.registration.refreshSpawnable();
  assert.deepEqual(f.advertised(), ["coordinator", "handoff-reader", "tool-less"]);

  // Pi's `getAllTools` throws on a stale runtime. Registration reads it too, before any refresh.
  inventory = () => {
    throw new Error("This extension ctx is stale after session replacement or reload.");
  };
  assert.doesNotThrow(() => f.registration.refreshSpawnable());
  assert.doesNotThrow(() => registerDelegationTools({ registerTool: () => {} } as never, f.session));
  // Native tools count again and the external one still does not: a subset of what the grant alone listed.
  assert.deepEqual(f.advertised(), ["coordinator", "handoff-reader", "native-only", "tool-less"]);
});
