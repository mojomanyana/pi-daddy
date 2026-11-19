/** Real SDK request boundaries with a scripted local provider; no hosted model or JEV calls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { GrantsSession } from "../../extensions/session.ts";
import { initializeSessionAutoMode, closeSessionAutoMode } from "../../extensions/session-auto-mode.ts";
import {
  beginWorkModeRequest,
  initializeWorkMode,
  registerWorkMode,
  setWorkMode,
  workModeSnapshot,
} from "../../extensions/work-mode.ts";
import { createFixture } from "./fixture-harness.ts";
import { textStep, type Step } from "./scripted-provider.ts";

const sdkVersion = JSON.parse(
  readFileSync(
    join(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), "../../package.json"),
    "utf8",
  ),
).version;
const ambitious = { mode: "ambitious" as const, emphases: ["depth" as const] };
const later = { mode: "ambitious" as const, emphases: ["range" as const] };
const standard = { mode: "standard" as const, emphases: [] };

async function boundaryFixture(
  options: {
    retry?: boolean;
    next?: (index: number, owner: GrantsSession) => Step;
    onEnd?: (pi: ExtensionAPI, owner: GrantsSession, count: number) => void;
    onStart?: (event: BeforeAgentStartEvent) => void;
    earlyOverride?: string;
  } = {},
) {
  const owner = {
    episodeId: "work-mode-boundary",
    ownerBound: true,
    depth: 0,
    reloadLifecycle: { root: {} },
  } as unknown as GrantsSession;
  let starts = 0;
  let ends = 0;
  const fixture = await createFixture({
    // The same test runs in the repository SDK and the isolated supported-runtime composition.
    sdkVersion: sdkVersion as "1.0.4",
    settings: { retry: { enabled: !!options.retry, maxRetries: 1, baseDelayMs: 1 } },
    next: (_request, index) => options.next?.(index, owner) ?? textStep(),
    extension: () => (pi) => {
      if (options.earlyOverride) pi.on("before_agent_start", () => ({ systemPrompt: options.earlyOverride }));
      registerWorkMode(pi, owner);
      pi.on("session_start", async (event, ctx) => {
        await initializeSessionAutoMode(owner, {}, ctx.sessionManager.getSessionId());
        initializeWorkMode(pi, owner, ctx, event.reason, {});
      });
      pi.on("before_agent_start", (event) => {
        starts++;
        options.onStart?.(event);
      });
      pi.on("agent_end", () => {
        options.onEnd?.(pi, owner, ++ends);
      });
    },
  });
  return {
    ...fixture,
    owner,
    get starts() {
      return starts;
    },
    async close() {
      await closeSessionAutoMode(owner);
      await fixture.close();
    },
  };
}

test("a post-hook preparation failure cannot reuse a consumed next-request mode on the next prompt", async () => {
  const f = await boundaryFixture();
  try {
    setWorkMode(f.owner, ambitious, "next-request");
    // Failure injection is after the real native before_agent_start hook, before the local provider.
    const native = f.session as unknown as { _normalizePromptImages: (...args: unknown[]) => Promise<unknown> };
    const normalize = native._normalizePromptImages;
    assert.equal(typeof normalize, "function", "SDK exposes the expected preparation seam");
    native._normalizePromptImages = async () => {
      throw new Error("fixture post-hook preparation failure");
    };
    await assert.rejects(f.session.prompt("first request"), /fixture post-hook preparation failure/);
    native._normalizePromptImages = normalize;
    assert.equal(f.requests.length, 0);
    assert.equal(f.starts, 1);
    assert.equal(f.events.filter((event) => event.type === "agent_settled").length, 0);
    assert.equal(workModeSnapshot(f.owner).nextRequest, undefined, "one-shot already consumed durably");
    assert.equal(workModeSnapshot(f.owner).active, undefined, "failed preparation is idle in the visible status");
    await f.session.prompt("separate second request");
    assert.equal(f.starts, 2);
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(getCurrentSystemPrompt(f.requests[0].context.messages), /<pi-daddy-work-mode>/);
    assert.deepEqual(workModeSnapshot(f.owner).selection, standard);
    assert.equal(workModeSnapshot(f.owner).active, undefined);
    assert.equal(f.errors.length, 0);
  } finally {
    await f.close();
  }
});

test("Ambitious guidance preserves later extension prompt sections and guidelines", async () => {
  const f = await boundaryFixture({
    onStart: (event) => {
      event.systemPromptOptions.sections.fixture = "Current task-specific fixture context";
      event.systemPromptOptions.promptGuidelines.push("Preserve the fixture read-only constraint.");
    },
  });
  try {
    await f.session.prompt("standard request");
    setWorkMode(f.owner, ambitious, "session");
    await f.session.prompt("ambitious request");
    for (const request of f.requests) {
      const prompt = getCurrentSystemPrompt(request.context.messages);
      assert.match(prompt, /Current task-specific fixture context/);
      assert.match(prompt, /Preserve the fixture read-only constraint/);
    }
    assert.match(getCurrentSystemPrompt(f.requests[1].context.messages), /<pi-daddy-work-mode>/);
    assert.equal(f.errors.length, 0);
  } finally {
    await f.close();
  }
});

test("an earlier explicit full-prompt override is retained and receives guidance only for the chosen request", async () => {
  const override = "Exact earlier extension override. Preserve its read-only role.";
  const f = await boundaryFixture({ earlyOverride: override });
  try {
    setWorkMode(f.owner, ambitious, "next-request");
    await f.session.prompt("ambitious request");
    const prompt = getCurrentSystemPrompt(f.requests[0].context.messages);
    assert.ok(prompt.startsWith(`${override}\n\n<pi-daddy-work-mode>`));
    assert.equal(prompt.match(/<pi-daddy-work-mode>/g)?.length, 1);
    await f.session.prompt("standard request");
    assert.equal(getCurrentSystemPrompt(f.requests[1].context.messages), override);
    assert.equal(f.errors.length, 0);
  } finally {
    await f.close();
  }
});

test("native disk session restore retains selection and pending mode but cannot replay its recorded consumption", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-mode-disk-"));
  const owners: GrantsSession[] = [];
  const bind = async (manager: SessionManager, reason: string) => {
    const owner = {
      episodeId: "work-mode-disk",
      ownerBound: true,
      depth: 0,
      reloadLifecycle: { root: {} },
    } as unknown as GrantsSession;
    owners.push(owner);
    await initializeSessionAutoMode(owner, {}, manager.getSessionId());
    initializeWorkMode(
      {
        appendEntry: (type, data) => {
          manager.appendCustomEntry(type, data);
        },
      },
      owner,
      { sessionManager: manager, ui: { notify() {} } as never },
      reason,
      {},
    );
    return owner;
  };
  try {
    const manager = SessionManager.create(root, join(root, "sessions"));
    // Native sessions become durable after a conversation starts; metadata alone intentionally does not create a file.
    manager.appendMessage({ role: "user", content: "fixture conversation", timestamp: Date.now() });
    const initial = await bind(manager, "new");
    setWorkMode(initial, ambitious, "session");
    setWorkMode(initial, later, "next-request");
    const file = manager.getSessionFile()!;
    assert.match(readFileSync(file, "utf8"), /pi-daddy:work-mode:v1/);
    const restored = await bind(SessionManager.open(file), "resume");
    assert.deepEqual(workModeSnapshot(restored).selection, ambitious);
    assert.deepEqual(workModeSnapshot(restored).nextRequest, later);
    assert.deepEqual(beginWorkModeRequest(restored, true), later);
    const consumed = await bind(SessionManager.open(file), "resume");
    assert.deepEqual(workModeSnapshot(consumed).selection, ambitious);
    assert.equal(workModeSnapshot(consumed).nextRequest, undefined);
    assert.deepEqual(beginWorkModeRequest(consumed, true), ambitious);
    const next = await bind(SessionManager.create(root, join(root, "sessions")), "new");
    assert.deepEqual(workModeSnapshot(next).selection, standard);
    assert.equal(workModeSnapshot(next).nextRequest, undefined);
  } finally {
    for (const owner of owners) await closeSessionAutoMode(owner);
    await rm(root, { recursive: true, force: true });
  }
});

test("native retry retains its initial mode and leaves a mid-run one-shot selection for the next prompt", async () => {
  const f = await boundaryFixture({
    retry: true,
    next: (index, owner) => {
      if (index !== 0) return textStep();
      setWorkMode(owner, later, "next-request");
      return { stopReason: "error", errorMessage: "HTTP 503 service unavailable" };
    },
  });
  try {
    setWorkMode(f.owner, ambitious, "next-request");
    await f.session.prompt("one request with a transient local scripted error");
    assert.equal(f.requests.length, 2);
    assert.equal(f.starts, 1, "native retry does not re-emit before_agent_start");
    assert.equal(f.events.filter((event) => event.type === "auto_retry_start").length, 1);
    for (const request of f.requests) {
      assert.match(getCurrentSystemPrompt(request.context.messages), /Deeper proof:/);
      assert.doesNotMatch(getCurrentSystemPrompt(request.context.messages), /Broader approaches:/);
    }
    assert.deepEqual(workModeSnapshot(f.owner).nextRequest, later);
    await f.session.prompt("separate subsequent request");
    assert.equal(f.starts, 2);
    assert.match(getCurrentSystemPrompt(f.requests[2].context.messages), /Broader approaches:/);
    assert.doesNotMatch(getCurrentSystemPrompt(f.requests[2].context.messages), /Deeper proof:/);
    assert.equal(workModeSnapshot(f.owner).nextRequest, undefined);
    assert.equal(f.errors.length, 0);
  } finally {
    await f.close();
  }
});

test("a queued continuation belongs to the current captured mode, not the later session selection", async () => {
  const f = await boundaryFixture({
    onEnd: (pi, owner, count) => {
      if (count !== 1) return;
      setWorkMode(owner, standard, "session");
      pi.sendMessage(
        { customType: "fixture-follow-up", content: "Finish this same request", display: false },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });
  try {
    setWorkMode(f.owner, ambitious, "session");
    await f.session.prompt("request with a queued continuation");
    assert.equal(f.requests.length, 2);
    assert.equal(f.starts, 1, "native continuation does not re-emit before_agent_start");
    for (const request of f.requests) assert.match(getCurrentSystemPrompt(request.context.messages), /Deeper proof:/);
    await f.session.prompt("separate next request");
    assert.equal(f.starts, 2);
    assert.doesNotMatch(getCurrentSystemPrompt(f.requests[2].context.messages), /<pi-daddy-work-mode>/);
    assert.equal(f.errors.length, 0);
  } finally {
    await f.close();
  }
});
