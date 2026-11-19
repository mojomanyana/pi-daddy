/** Real Pi hooks and scripted inference only: no HTTP, credentials or hosted model calls. */
import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { createFixture } from "./fixture-harness.ts";
import grants from "../../extensions/grants.ts";
import { createGrantsSession, type GrantsSession } from "../../extensions/session.ts";
import { GRANT_ENV_KEYS } from "../../src/kernel/propagation.ts";
import { closeSessionAutoMode } from "../../extensions/session-auto-mode.ts";
import { workModeSnapshot } from "../../extensions/work-mode.ts";
import { textStep } from "./scripted-provider.ts";

test("native command and request hooks keep Standard unchanged, consume one-shot guidance and restore the base prompt", async () => {
  const keys = [...GRANT_ENV_KEYS, "PI_CODING_AGENT_DIR", "PI_DADDY_HERDR", "PI_DADDY_ACTIVITY_TIMELINE", "HERDR_ENV"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  let current: GrantsSession | undefined;
  try {
    for (const key of keys) delete process.env[key];
    process.env.PI_DADDY_HERDR = "0";
    process.env.PI_DADDY_ACTIVITY_TIMELINE = "off";
    fixture = await createFixture({
      prepare: async (root) => {
        process.env.PI_CODING_AGENT_DIR = join(root, "agent");
      },
      extension: () => (pi) => {
        current = createGrantsSession(undefined);
        grants(pi, current);
      },
      next: (_request, index) =>
        index === 1 ? { stopReason: "error", errorMessage: "scripted failure" } : textStep("done"),
    });
    assert.equal(fixture.requests.length, 0);
    await fixture.session.prompt("a Standard request");
    const baseline = getCurrentSystemPrompt(fixture.requests[0].context.messages);
    assert.doesNotMatch(baseline, /pi-daddy-work-mode/);
    assert.equal(workModeSnapshot(current!).active, undefined);
    await fixture.session.prompt("/work-mode ambitious next depth");
    assert.equal(fixture.requests.length, 1, "operator selection does not invoke a provider");
    await fixture.session.prompt("the selected one-shot request fails");
    assert.match(getCurrentSystemPrompt(fixture.requests[1].context.messages), /pi-daddy-work-mode/);
    assert.match(getCurrentSystemPrompt(fixture.requests[1].context.messages), /Deeper proof/);
    assert.equal(workModeSnapshot(current!).nextRequest, undefined);
    await fixture.session.prompt("the next request stays Standard");
    assert.equal(getCurrentSystemPrompt(fixture.requests[2].context.messages), baseline);
    assert.equal(fixture.requests.length, 3, "no hidden research, judge or other model invocations");
    assert.equal((await current!.autoMode!.read()).enabled, false);
    assert.deepEqual(fixture.errors, []);
  } finally {
    if (current) await closeSessionAutoMode(current);
    await fixture?.close();
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});
