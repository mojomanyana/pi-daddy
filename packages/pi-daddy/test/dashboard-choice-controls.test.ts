import assert from "node:assert/strict";
import { test } from "node:test";
import { registerDashboardSources } from "../extensions/dashboard-sources.ts";
import type { GrantsSession } from "../extensions/session.ts";
import { closeSessionAutoMode, initializeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import { ensureDashboardSessionServer } from "../extensions/dashboard-session-server.ts";
import {
  DASHBOARD_CHOICE_EVENT,
  type DashboardChoiceRegistration,
  type DashboardChoiceDetail,
} from "../src/kernel/dashboard-choice.ts";
import { DASHBOARD_SOURCE_EVENT, type DashboardSourceRegistrationReply } from "../src/kernel/dashboard-observation.ts";
import { newEpisodeId } from "../src/kernel/episode-id.ts";
import { createDashboardConnection, dashboardSessionRequest } from "../src/products/dashboard-session-client.ts";

const revision = "sha256:" + "a".repeat(64);
const id = "open-choice-abcd";
const row = { id, kind: "work" as const, state: "observed" as const, label: "Which color?" };
const detail: DashboardChoiceDetail = {
  id,
  label: row.label,
  title: "Color review",
  revision,
  options: ["Red", "Blue"],
};
function fixture() {
  const events = new Map<string, (value: unknown) => void>();
  let owner = { sessionId: "one", cwd: "/project" },
    time = Date.now();
  const display = registerDashboardSources(
    {
      events: {
        on(name: string, listener: (x: unknown) => void) {
          events.set(name, listener);
          return () => events.delete(name);
        },
      },
    } as never,
    () => owner,
    () => time,
  );
  function publisher(producer = "bookie-memory") {
    let value!: DashboardSourceRegistrationReply;
    events.get(DASHBOARD_SOURCE_EVENT)!({
      version: 1,
      ...owner,
      producer,
      producerVersion: "1",
      reply: (v: DashboardSourceRegistrationReply) => {
        value = v;
      },
    });
    assert.ok(value.ok);
    value.publish({ sequence: 0, items: [row] });
    return value;
  }
  function bind(sourceGeneration: string, fields: Partial<DashboardChoiceRegistration> = {}) {
    let value!: Parameters<DashboardChoiceRegistration["reply"]>[0];
    events.get(DASHBOARD_CHOICE_EVENT)!({
      version: 1,
      ...owner,
      sourceGeneration,
      inspect: async () => detail,
      answer: async () => "saved",
      ...fields,
      reply: (v: typeof value) => {
        value = v;
      },
    });
    return value;
  }
  return {
    display,
    publisher,
    bind,
    replaceOwner: () => {
      owner = { ...owner };
    },
    advance: (ms: number) => {
      time += ms;
    },
    expire: () => {
      time += 120001;
    },
  };
}

test("choice controls require a separate Bookie registration on the exact live display publisher", async () => {
  const f = fixture(),
    other = f.publisher("scout-local"),
    source = f.publisher();
  assert.equal(f.display.choices.controls(), undefined);
  assert.equal(f.bind(other.generation).ok, false);
  assert.equal(f.bind(source.generation, { cwd: "/other" }).ok, false);
  assert.equal(f.bind(source.generation).ok, true);
  assert.equal(f.bind(source.generation).ok, false);
  assert.equal(f.display.choices.controls()?.sourceGeneration, source.generation);
  const noClientCheck = () => {};
  assert.deepEqual(await f.display.choices.inspect(source.generation, id, noClientCheck), detail);
  assert.equal(await f.display.choices.inspect(source.generation, "open-choice-absent", noClientCheck), undefined);
  assert.equal(
    await f.display.choices.answer(source.generation, id, revision, { custom: "a", option: "b" }, noClientCheck),
    "refused",
  );
  f.expire();
  assert.equal(f.display.choices.controls(), undefined);
  assert.equal(
    await f.display.choices.answer(source.generation, id, revision, { custom: "a" }, noClientCheck),
    "refused",
  );
  source.publish({ sequence: 1, items: [row] });
  assert.deepEqual(await f.display.choices.inspect(source.generation, id, noClientCheck), detail);
  const replacement = f.publisher();
  assert.equal(
    await f.display.choices.answer(source.generation, id, revision, { custom: "a" }, noClientCheck),
    "refused",
  );
  assert.equal(f.display.choices.controls(), undefined);
  assert.equal(f.bind(replacement.generation).ok, true);
  f.replaceOwner();
  assert.equal(f.display.choices.controls(), undefined);
  f.display.close();
});

test("an open picker can renew near expiry without trusting old rows, polling an idle list, or duplicating a slow scan", async () => {
  const f = fixture(),
    source = f.publisher();
  let renewals = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.bind(source.generation, {
    async renew() {
      renewals++;
      await gate;
      source.publish({ sequence: renewals, items: [row] });
    },
  });
  assert.equal(f.display.choices.requestRenewal(), false);
  f.advance(106_000);
  assert.equal(f.display.choices.controls()?.sourceGeneration, source.generation);
  assert.equal(renewals, 0);
  assert.equal(f.display.choices.requestRenewal(), true);
  assert.equal(f.display.choices.requestRenewal(), true);
  await Promise.resolve();
  assert.equal(renewals, 1);
  f.advance(16_000);
  assert.equal(f.display.choices.controls(), undefined);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.display.choices.controls()?.sourceGeneration, source.generation);
  assert.equal(f.display.choices.requestRenewal(), false);
  source.publish({ sequence: 2, items: [] });
  f.expire();
  assert.equal(f.display.choices.requestRenewal(), false);
  f.display.close();
});

test("in-flight reads and writes honor source revocation, concurrent submissions and the private provider boundary", async () => {
  const f = fixture(),
    source = f.publisher();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let writes = 0;
  f.bind(source.generation, {
    async inspect() {
      await gate;
      return { ...detail, privateField: "private" };
    },
    async answer(_id, _rev, _answer, assertCurrent) {
      started();
      await gate;
      assertCurrent();
      writes++;
      return "saved";
    },
  });
  const inspect = f.display.choices.inspect(source.generation, id, () => {});
  const send = () => f.display.choices.answer(source.generation, id, revision, { custom: "one" }, () => {});
  const pending = send();
  await entered;
  assert.equal(await send(), "refused");
  source.close();
  release();
  assert.equal(await inspect, undefined);
  assert.equal(await pending, "unconfirmed");
  assert.equal(writes, 0);
  const next = f.publisher();
  f.bind(next.generation, {
    async inspect() {
      return { ...detail, privateField: "hidden" };
    },
  });
  assert.equal(await f.display.choices.inspect(next.generation, id, () => {}), undefined);
  f.display.close();
});

test("the authenticated owner socket pins both selection and save, strips transient content and only acknowledges a confirmed save", async () => {
  const f = fixture(),
    source = f.publisher();
  const session = {
    episodeId: newEpisodeId(),
    ownerBound: true,
    reloadLifecycle: { root: {} },
    definitions: new Map(),
    definitionRuntimeSettings: { definitions: new Map(), defaults: {} },
    definitionRuntimeOverrides: new Map(),
    dashboardObservations: f.display.snapshot,
    dashboardChoices: f.display.choices,
  } as unknown as GrantsSession;
  await initializeSessionAutoMode(session, {}, "choice-test");
  const endpoint = await ensureDashboardSessionServer(session);
  try {
    const send = (q: Parameters<typeof dashboardSessionRequest>[2]) =>
      dashboardSessionRequest(endpoint.socketPath, endpoint.token, q);
    const connection = createDashboardConnection(send);
    await connection.refresh();
    assert.equal(connection.state.snapshot?.choiceControls, undefined);
    let calls = 0,
      renewals = 0;
    const registered = f.bind(source.generation, {
      async renew() {
        renewals++;
        source.publish({ sequence: renewals, items: [row] });
      },
      async answer(_id, rev, answer, fence) {
        calls++;
        fence();
        if (rev !== revision || ("option" in answer && !detail.options.includes(answer.option))) return "refused";
        if ("custom" in answer && answer.custom === "ambiguous") throw Error("PRIVATE vault path and answer");
        return "saved";
      },
    });
    assert.ok(registered.ok);
    await connection.refresh();
    const seen = connection.state.snapshot!.observation!;
    const target = {
      choiceId: id,
      sourceGeneration: source.generation,
      expectedOwner: { sessionId: seen.sessionId, cwd: seen.cwd, generation: seen.generation },
    };
    const save = {
      ...target,
      action: "answer-choice" as const,
      revision,
      answer: { custom: "private dashboard reply" },
    };
    const view = await connection.inspectChoice(target);
    assert.deepEqual(view, detail);
    assert.doesNotMatch(JSON.stringify(connection.state), /Color review/);
    await assert.rejects(dashboardSessionRequest(endpoint.socketPath, "wrong", save));
    await assert.rejects(send({ ...save, expectedOwner: undefined } as never));
    await assert.rejects(
      send({ ...save, action: "inspect-choice", expectedOwner: { ...target.expectedOwner, cwd: "/other" } } as never),
    );
    await assert.rejects(send({ ...save, untrustedToolInput: "extra" } as never));
    assert.equal(calls, 0);
    assert.equal(
      await connection.change({ ...save, expectedOwner: { ...target.expectedOwner, generation: "old" } }),
      false,
    );
    assert.equal(calls, 0);
    assert.equal(await connection.change({ ...save, answer: { option: "not offered" } }), false);
    assert.equal(connection.state.acknowledgment?.state, "refused");
    assert.equal(await connection.change(save), true);
    assert.equal(connection.state.acknowledgment?.state, "applied");
    assert.doesNotMatch(JSON.stringify(connection.state), /private dashboard reply|Color review/);
    assert.equal(await connection.change({ ...save, answer: { custom: "ambiguous" } }), false);
    assert.equal(connection.state.acknowledgment?.state, "unconfirmed");
    assert.doesNotMatch(JSON.stringify(connection.state), /PRIVATE/);
    f.expire();
    await assert.rejects(dashboardSessionRequest(endpoint.socketPath, "bad", { action: "get", refreshChoices: true }));
    await connection.refresh("list");
    assert.equal(renewals, 0);
    connection.requestChoiceRefresh();
    await connection.refresh("list");
    await connection.refresh("list");
    assert.equal(renewals, 1);
    f.expire();
    await connection.refresh("list");
    assert.equal(renewals, 1);
    await connection.refresh("picker");
    assert.equal(renewals, 2);
    registered.close();
    assert.equal((await send({ action: "get" })).choiceControls, undefined);
    await assert.rejects(send(save));
    assert.equal(calls, 3);
  } finally {
    await endpoint.close();
    await closeSessionAutoMode(session);
    f.display.close();
  }
});
