import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { DashboardChoiceAction, DashboardChoiceDetail } from "../src/kernel/dashboard-choice.ts";
import type { DashboardSessionSnapshot } from "../src/products/dashboard-session-client.ts";
import { inspectChoice, saveChoice } from "../src/products/dashboard-choice-picker.ts";
import { createDashboardDisplayControls } from "../src/products/dashboard-display-controls.ts";
import { renderDashboardScreen } from "../src/products/dashboard-screen.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("a real terminal inspects, defers, edits, and explicitly saves only the highlighted Bookie choice", async () => {
  const cwd = await tempDir("daddy-choice-pty-");
  const socketPath = join(cwd, "owner.sock");
  const choiceId = "open-choice-" + "a".repeat(32);
  const revision = "sha256:" + "b".repeat(64);
  let labels = ["Foldout", "Chart", "Planisphere", "App"];
  const question = "Which sky guide should we print?";
  const recommendation = {
    option: "Planisphere",
    reason: "It rotates to match the observing date.",
    evidence: "Our field trial found the rotating chart readable with a dim red lamp.",
  };
  let available = true,
    editable = true,
    reclassifiable = false,
    refuse = false;
  let sequence = 0;
  let releaseSave: (() => void) | undefined;
  const inspected: string[] = [];
  const submissions: Extract<DashboardChoiceAction, { action: "answer-choice" }>[] = [];
  const corrections: Extract<DashboardChoiceAction, { action: "reclassify-choice" }>[] = [];
  const sourceGeneration = "bookie-source";
  const expectedOwner = { sessionId: "native-parent", cwd, generation: "parent-generation" };
  const row = (id: string, label: string) => ({ id, label, kind: "work" as const, state: "observed" as const });
  function snapshot(): DashboardSessionSnapshot {
    const now = new Date().toISOString();
    return {
      auto: { enabled: true, source: "session" },
      cost: null,
      rows: [],
      pendingApprovals: [],
      ...(editable
        ? { choiceControls: { sourceGeneration, ...(reclassifiable ? { reclassify: true as const } : {}) } }
        : {}),
      observation: {
        ...expectedOwner,
        version: 1,
        sequence: ++sequence,
        observedAt: now,
        resources: { scope: "owner-process", sampledAt: now, rssBytes: 10, hostHealth: "unknown" },
        capture: { transcripts: false, diagnostics: false },
        sources: [
          {
            producer: "bookie-memory",
            producerVersion: "fixture",
            generation: sourceGeneration,
            sequence,
            observedAt: now,
            staleAfterMs: 5000,
            availability: "observed",
            items: [
              row("project-memory", "Current workspace memory"),
              row("open-choice-other", "Which site?"),
              ...(available ? [row(choiceId, question)] : []),
            ],
          },
        ],
      },
    };
  }
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (bytes) => {
      input += bytes;
      if (!input.includes("\n")) return;
      const req = JSON.parse(input);
      if (req.action === "get") socket.end(JSON.stringify({ ok: true, ...snapshot() }));
      else if (req.action === "inspect-choice") {
        inspected.push(req.choiceId);
        assert.deepEqual(req.expectedOwner, expectedOwner);
        assert.equal(req.sourceGeneration, sourceGeneration);
        const choiceDetail: DashboardChoiceDetail = {
          id: choiceId,
          label: question,
          title: "Field test",
          revision,
          options: labels,
          ...(labels.includes(recommendation.option) ? { recommendation } : {}),
        };
        socket.end(JSON.stringify({ ok: true, ...snapshot(), choiceDetail }));
      } else if (req.action === "answer-choice") {
        submissions.push(req);
        releaseSave = () => {
          if (refuse)
            socket.end(JSON.stringify({ ok: false, choiceOutcome: "refused", error: "Bookie refused this answer." }));
          else {
            available = false;
            socket.end(JSON.stringify({ ok: true, ...snapshot(), choiceSaved: true }));
          }
        };
      } else if (req.action === "reclassify-choice") {
        corrections.push(req);
        available = false;
        socket.end(JSON.stringify({ ok: true, ...snapshot(), choiceReclassified: true }));
      } else assert.fail("unexpected mutation " + req.action);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  // Linux util-linux script supplies a real PTY, including readline's raw-key decoding.
  const child = spawn(
    "script",
    ["-qefc", 'stty rows 20 cols 58 && exec "$DASHBOARD_TEST_NODE" "$DASHBOARD_TEST_ENTRY" --no-color', "/dev/null"],
    {
      cwd,
      env: {
        ...process.env,
        DASHBOARD_TEST_NODE: process.execPath,
        DASHBOARD_TEST_ENTRY: join(import.meta.dirname, "../src/products/dashboard-cli.ts"),
        PI_DADDY_DASHBOARD_SESSION_SOCKET: socketPath,
        PI_DADDY_DASHBOARD_SESSION_TOKEN: "test-token",
      },
    },
  );
  let frame = "",
    bytes = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    bytes += chunk;
    let end;
    while ((end = bytes.indexOf("\x1b[J")) >= 0) {
      frame = bytes.slice(0, end).split("\x1b[H").at(-1)!.replaceAll("\x1b[2K", "").replaceAll("\r", "");
      bytes = bytes.slice(end + 3);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  function key(value: string) {
    child.stdin.write(value);
  }
  async function see(pattern: RegExp) {
    for (let attempts = 0; attempts < 200; attempts++) {
      if (pattern.test(frame)) return frame;
      if (child.exitCode !== null) break;
      await delay(25);
    }
    assert.fail("Missing " + pattern + " in terminal:\n" + frame + "\n" + stderr);
  }
  const down = "\x1b[B",
    enter = "\r",
    esc = "\x1b";
  try {
    await see(/> Which site\?/);
    key(down);
    await see(/> Which sky guide/);
    assert.equal(inspected.length, 0);
    // Detail view remains available for older producers as well as the editable picker.
    key("d");
    await see(/Saved in this project/);
    key(esc);
    await see(/> Which sky guide/);
    key(enter);
    const options = await see(/> Foldout/);
    assert.match(options, /Planisphere · Recommended/);
    assert.match(options, /It rotates to match the observing date/);
    assert.match(options.replace(/\s+/g, " "), /rotating chart readable with a dim red lamp/);
    assert.match(options, /Write my own answer/);
    key(down.repeat(5));
    await see(/> Decide later/);
    key(enter);
    await see(/> Which sky guide/);
    assert.equal(submissions.length, 0);

    labels = ["One option"];
    key(enter);
    await see(/> One option/);
    assert.doesNotMatch(frame, /Recommended|Planisphere/);
    key(enter);
    await see(/Save this answer in Bookie/);
    key(esc);
    await see(/> Which sky guide/);
    assert.equal(submissions.length, 0);

    labels = [];
    key(enter);
    await see(/> Write my own answer/);
    key(enter);
    await see(/Write your own answer/);
    key(enter);
    await see(/Write an answer first/);
    key("q: use bothX\x7f");
    await see(/q: use both▏/);
    key(enter);
    await see(/Save this answer in Bookie/);
    key("e");
    await see(/q: use both▏/);
    key(enter);
    await see(/Save this answer in Bookie/);
    refuse = true;
    key(enter);
    await see(/Saving your answer/);
    key(enter + down + enter);
    assert.equal(submissions.length, 1);
    releaseSave!();
    await see(/r review again/);
    assert.match(frame, /q: use both/);
    assert.doesNotMatch(frame, /Answer saved in Bookie/);
    refuse = false;
    key("r");
    await see(/Enter save to Bookie/);
    key(enter);
    await see(/Saving your answer/);
    releaseSave!();
    await see(/Answer saved in Bookie/);
    key(enter);
    key(esc);
    await see(/> Which site\?/);
    assert.doesNotMatch(frame, /Which sky guide/);
    assert.deepEqual(inspected, [choiceId, choiceId, choiceId]);
    assert.deepEqual(
      submissions.map(({ action, answer, choiceId, revision, sourceGeneration, expectedOwner }) => ({
        action,
        answer,
        choiceId,
        revision,
        sourceGeneration,
        expectedOwner,
      })),
      Array(2).fill({
        action: "answer-choice",
        answer: { custom: "q: use both" },
        choiceId,
        revision,
        sourceGeneration,
        expectedOwner,
      }),
    );

    available = true;
    labels = ["Foldout", "Chart", "Planisphere", "App"];
    await see(/Which sky guide/);
    key(down);
    await see(/> Which sky guide/);
    key(enter);
    await see(/> Foldout/);
    key(down.repeat(2));
    await see(/> Planisphere/);
    key(enter);
    await see(/Save this answer in Bookie/);
    assert.match(frame, /Planisphere/);
    available = false;
    await see(/This choice is unavailable/);
    assert.doesNotMatch(frame, /Planisphere|Which sky guide/);
    key(enter);
    key(esc);
    await see(/> Which site/);
    assert.equal(submissions.length, 2);

    available = true;
    await see(/Which sky guide/);
    key(down);
    await see(/> Which sky guide/);
    key(enter);
    await see(/> Foldout/);
    key(down);
    await see(/> Chart/);
    key(enter);
    await see(/Save this answer in Bookie/);
    key(enter);
    await see(/Saving your answer/);
    releaseSave!();
    await see(/Answer saved in Bookie/);
    assert.deepEqual(submissions.at(-1)!.answer, { option: "Chart" });
    assert.equal(submissions.length, 3);
    key(esc);
    await see(/> Which site/);

    available = true;
    reclassifiable = true;
    labels = [];
    await see(/Which sky guide/);
    key(down);
    await see(/> Which sky guide/);
    key(enter);
    await see(/Not a separate decision/);
    key(down.repeat(2));
    await see(/> Not a separate decision/);
    key(enter);
    await see(/No answer will be recorded/);
    assert.equal(corrections.length, 0);
    key(enter);
    await see(/Original note retained/);
    assert.equal(corrections.length, 1);
    assert.deepEqual(corrections[0], {
      token: "test-token",
      action: "reclassify-choice",
      choiceId,
      revision,
      sourceGeneration,
      expectedOwner,
    });
    assert.equal(submissions.length, 3);
    key(esc);
    await see(/> Which site/);
    assert.doesNotMatch(frame, /Which sky guide/);

    available = true;
    editable = false;
    await see(/Which sky guide/);
    key(down);
    await see(/> Which sky guide/);
    key(enter);
    await see(/Saved in this project/);
    assert.equal(inspected.length, 6);
  } finally {
    releaseSave = undefined;
    key("\x03");
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), delay(1200, undefined, { ref: false })]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an inspected draft survives renewed observations but is erased when its owner changes", async () => {
  const display = createDashboardDisplayControls(false, true);
  const time = "2026-11-10T13:00:00.000Z";
  const source = {
    producer: "bookie-memory",
    producerVersion: "fixture",
    generation: "s1",
    sequence: 1,
    observedAt: time,
    staleAfterMs: 120000,
    availability: "observed" as const,
    items: [
      { id: "project-memory", label: "Ready", state: "observed" as const, kind: "work" as const },
      { id: "open-choice-one", label: "Which kit?", state: "observed" as const, kind: "work" as const },
    ],
  };
  const session: DashboardSessionSnapshot = {
    cost: null,
    rows: [],
    pendingApprovals: [],
    auto: { enabled: true, source: "session" },
    choiceControls: { sourceGeneration: source.generation },
    observation: {
      version: 1,
      sessionId: "A",
      cwd: "/workspace",
      generation: "one",
      sequence: 1,
      observedAt: time,
      sources: [source],
      resources: { scope: "owner-process", rssBytes: 1, sampledAt: time, hostHealth: "unknown" },
      capture: { diagnostics: false, transcripts: false },
    },
  };
  const screenOptions = {
    width: 34,
    height: 13,
    items: [],
    screen: display.screen,
    session,
    connected: true,
    now: new Date(time),
  };
  renderDashboardScreen(screenOptions);
  const target = display.screen.items[0]!.choice!;
  const detail = {
    id: target.choiceId,
    label: "Which kit?",
    title: "Project kit",
    revision: "sha256:" + "2".repeat(64),
    options: [],
  };
  const conn = {
    state: { pending: false },
    change: async () => assert.fail("unexpected save"),
    inspectChoice: async () => detail,
  };
  assert.equal(display.key("return"), "inspect-choice");
  await inspectChoice(display.screen, conn);
  display.key("return");
  display.key("a", "Answer for the first project");
  for (let minute = 1; minute <= 4; minute++) {
    screenOptions.now = new Date(Date.parse(time) + 60000 * minute);
    source.observedAt = screenOptions.now.toISOString();
    source.sequence++;
    assert.match(renderDashboardScreen(screenOptions), /Answer for the first project/);
  }
  session.observation!.sessionId = "B";
  session.observation!.generation = "two";
  const revoked = renderDashboardScreen(screenOptions);
  assert.match(revoked, /choice is unavailable/);
  assert.doesNotMatch(revoked, /first project|Which kit/);
  assert.equal(display.key("return"), undefined);
  assert.equal(display.screen.picker!.draft, "");
  assert.equal(display.screen.picker!.detail, undefined);

  display.key("escape");
  renderDashboardScreen(screenOptions);
  assert.equal(display.key("return"), "inspect-choice");
  let finish: (value: DashboardChoiceDetail) => void = () => assert.fail("missing pending read");
  const late = inspectChoice(display.screen, {
    ...conn,
    inspectChoice: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  display.key("escape");
  renderDashboardScreen(screenOptions);
  display.key("return");
  finish(detail);
  await late;
  assert.equal(display.screen.picker!.phase, "loading");
  assert.equal(display.screen.picker!.detail, undefined);
});

test("Not a separate decision requires confirmation, preserves Decide later, and never sends an answer", async () => {
  for (const supported of [false, true])
    for (const width of [34, 110]) {
      const display = createDashboardDisplayControls(false, true);
      const now = new Date();
      const source = {
        producer: "bookie-memory",
        producerVersion: "fixture",
        generation: "choice-source",
        sequence: 1,
        observedAt: now.toISOString(),
        staleAfterMs: 120000,
        availability: "observed" as const,
        items: [
          { id: "project-memory", label: "Ready", kind: "work" as const, state: "observed" as const },
          {
            id: "open-choice-summary",
            label: "Keep these two decisions open",
            kind: "work" as const,
            state: "observed" as const,
          },
          { id: "open-choice-real", label: "Which export?", kind: "work" as const, state: "observed" as const },
        ],
      };
      const session: DashboardSessionSnapshot = {
        auto: { enabled: true, source: "session" },
        cost: null,
        rows: [],
        pendingApprovals: [],
        choiceControls: { sourceGeneration: source.generation, ...(supported ? { reclassify: true as const } : {}) },
        observation: {
          version: 1,
          sessionId: "one",
          cwd: "/project",
          generation: "owner",
          sequence: 1,
          observedAt: now.toISOString(),
          sources: [source],
          resources: { scope: "owner-process", sampledAt: now.toISOString(), rssBytes: 1, hostHealth: "unknown" },
          capture: { transcripts: false, diagnostics: false },
        },
      };
      const options = { width, height: 28, items: [], screen: display.screen, session, connected: true, now };
      const submissions: unknown[] = [];
      const connection = {
        state: { pending: false },
        inspectChoice: async () => ({
          id: "open-choice-summary",
          title: "Progress",
          label: source.items[1].label,
          revision: "sha256:" + "a".repeat(64),
          options: ["Option A"],
        }),
        change: async (action: unknown) => {
          submissions.push(action);
          source.items.splice(1, 1);
          return true;
        },
      };
      renderDashboardScreen(options);
      assert.equal(display.key("return"), "inspect-choice");
      await inspectChoice(display.screen, connection);
      const menu = renderDashboardScreen(options);
      assert.equal(/Not a separate decision/.test(menu), supported);
      display.key("down");
      display.key("down");
      display.key("return");
      assert.equal(display.screen.view, "main", "Decide later retains its position and makes no write");
      assert.equal(submissions.length, 0);
      assert.equal(source.items.length, 3);
      if (!supported) continue;
      renderDashboardScreen(options);
      display.key("return");
      await inspectChoice(display.screen, connection);
      display.key("down");
      display.key("down");
      display.key("down");
      display.key("return");
      assert.equal(submissions.length, 0);
      const confirm = renderDashboardScreen(options);
      assert.match(confirm, /original note/i);
      assert.match(confirm, /No answer/);
      display.key("e");
      display.key("up");
      display.key("up");
      display.key("up");
      display.key("return");
      assert.equal(display.screen.picker!.reclassifying, false);
      assert.match(renderDashboardScreen(options), /Save this answer/);
      assert.doesNotMatch(renderDashboardScreen(options), /No answer will/);
      display.key("escape");
      assert.equal(submissions.length, 0);
      renderDashboardScreen(options);
      display.key("return");
      await inspectChoice(display.screen, connection);
      display.key("down");
      display.key("down");
      display.key("down");
      display.key("return");
      delete session.choiceControls!.reclassify;
      assert.match(renderDashboardScreen(options), /choice is unavailable/);
      assert.equal(display.key("return"), undefined);
      assert.equal(submissions.length, 0);
      display.key("escape");
      session.choiceControls!.reclassify = true;
      renderDashboardScreen(options);
      display.key("return");
      await inspectChoice(display.screen, connection);
      display.key("down");
      display.key("down");
      display.key("down");
      display.key("return");
      assert.equal(
        display.key("return"),
        "answer-choice",
        "existing dispatch signal submits the selected explicit choice action",
      );
      await saveChoice(display.screen, connection);
      assert.equal(submissions.length, 1);
      assert.deepEqual(submissions[0], {
        action: "reclassify-choice",
        choiceId: "open-choice-summary",
        sourceGeneration: source.generation,
        expectedOwner: { sessionId: "one", cwd: "/project", generation: "owner" },
        revision: "sha256:" + "a".repeat(64),
      });
      assert.match(renderDashboardScreen(options), /No answer/);
      display.key("escape");
      const remaining = renderDashboardScreen(options);
      assert.match(remaining, /Which export/);
      assert.doesNotMatch(remaining, /Keep these two decisions|Needs you/);
    }
});
