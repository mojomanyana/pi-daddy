/**
 * The tripwire's refusal text — ADR-0016 point 5.
 *
 * The hook itself is covered by the wiring suite; this is about **what the refusal tells the model to do
 * instead**, which turned out to matter as much as the refusal.
 *
 * **Observed 2026-08-17.** An operator asked for parallel work in a governed session. A third-party `subagent`
 * tool was refused correctly — and the message said *"Use `delegate` instead"*, naming only the serial tool. The
 * model then planned a single sequential `delegate`, which is a reasonable reading of the only instruction it
 * was given. `delegate_all` existed, takes up to `MAX_CHILDREN_PER_CALL` concurrent children, and was the right
 * answer to the request.
 *
 * A refusal that points at the wrong replacement is a refusal that gets obeyed badly, and that is a governance
 * defect rather than a wording one: the operator's alternative to being redirected well is unsetting
 * `PI_GRANTS_GRANT`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHILDREN_PER_CALL } from "../src/fanout.ts";
import { SPAWN_TOOLS, tripwireReason } from "../extensions/tripwire.ts";

test("the refusal names delegate_all, not just delegate", () => {
  // The production change that breaks this: dropping delegate_all from the text.
  const reason = tripwireReason("subagent");
  assert.match(reason, /delegate_all/, "the concurrent tool must be named");
  assert.match(reason, /`delegate`/, "and so must the single one");
});

test("the refusal says WHICH is which, so a parallel request is not answered serially", () => {
  // Naming both and leaving the model to guess would reproduce the original defect with more words.
  const reason = tripwireReason("subagent");
  assert.match(reason, /delegate_all[^.]*concurrent|concurrent[^.]*delegate_all/i);
});

test("the refusal names the tool that was refused, so the model knows what to stop using", () => {
  assert.match(tripwireReason("subagent"), /"subagent"/);
  assert.match(tripwireReason("spawn_agent"), /"spawn_agent"/);
});

test("the refusal says what is LOST by going around governance, not merely that it is forbidden", () => {
  // A refusal an operator cannot evaluate is one they route around. Naming the three things a foreign spawner
  // skips is what makes "unset PI_GRANTS_GRANT" an informed choice rather than the path of least resistance.
  const reason = tripwireReason("Agent");
  for (const missing of [/no grant/, /no depth bound/, /no ledger/]) assert.match(reason, missing);
});

test("the refusal still offers the ungoverned escape hatch by name", () => {
  // Governance is opt-in; a tripwire that hid the way out would be pretending otherwise.
  assert.match(tripwireReason("subagent"), /PI_GRANTS_GRANT/);
});

test("every tool name the tripwire watches for is one the refusal can describe", () => {
  // A name added to the set without a working message is a refusal with a hole in it.
  for (const name of SPAWN_TOOLS) {
    const reason = tripwireReason(name);
    assert.match(reason, new RegExp(`"${name}"`));
    assert.match(reason, /delegate_all/);
  }
});

test("the tripwire watches the third-party spawn tool names it was written for", () => {
  for (const name of ["subagent", "Agent", "spawn_agent"]) {
    assert.ok(SPAWN_TOOLS.has(name), `${name} must remain a watched spawn tool`);
  }
});

test("the message does not promise a child count it cannot deliver", () => {
  // If it names a limit, that limit must be the real one. A description disagreeing with the enforcer is R-28.
  const reason = tripwireReason("subagent");
  const claimed = reason.match(/(\d+)\s+(?:concurrent|children|at once)/i);
  if (claimed) assert.equal(Number(claimed[1]), MAX_CHILDREN_PER_CALL);
});
