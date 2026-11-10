import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { DashboardChoiceAction, DashboardChoiceDetail } from "../src/kernel/dashboard-choice.ts";
import type { DashboardSessionSnapshot } from "../src/products/dashboard-session-client.ts";
import { inspectChoice } from "../src/products/dashboard-choice-picker.ts";
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
    refuse = false;
  let sequence = 0;
  let releaseSave: (() => void) | undefined;
  const inspected: string[] = [];
  const submissions: Extract<DashboardChoiceAction, { action: "answer-choice" }>[] = [];
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
      ...(editable ? { choiceControls: { sourceGeneration } } : {}),
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
    await see(/r retry save/);
    assert.match(frame, /q: use both/);
    assert.doesNotMatch(frame, /Answer saved in Bookie/);
    refuse = false;
    key("r");
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
    editable = false;
    await see(/Which sky guide/);
    key(down);
    await see(/> Which sky guide/);
    key(enter);
    await see(/Saved in this project/);
    assert.equal(inspected.length, 5);
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
