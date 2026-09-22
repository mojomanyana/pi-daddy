import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { nullDecider, type Decider, type Question } from "../src/advisors/decider.ts";
import { createAdvisor, type AdviceRecord } from "../src/advisors/advisor.ts";
import { JEV_ENDPOINT, JEV_MODEL, jevDecider, parseAdvice, wireRequest } from "../src/advisors/jev.ts";
import { ADVISOR_KEY_ENV, advisorSettingsFrom } from "../src/advisors/settings.ts";
import { createAdvisorSession } from "../extensions/advisor-session.ts";
import { readRecordsFile } from "../src/governance/record.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { after } from "node:test";

after(cleanupTempDirs);

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const QUESTIONS: Record<string, Question> = {
  keep: { kind: "noul", instructions: "Keep it?", whenTrue: "yes", whenFalse: "no" },
  which: { kind: "choice", instructions: "Which?", options: { a: "first", b: "second" } },
  urgency: { kind: "score", instructions: "How urgent?", levels: ["low", "mid", "high"] },
};
const REQUEST = { state: { secret: "do not ship this" }, questions: QUESTIONS };

/**
 * ADR-0077. An advisor may select, rank, annotate or propose; it can never widen a grant, satisfy a gate or stand
 * in for a human. These make that structural instead of remembered.
 */

test("no type in the advisors layer names a capability or a refusal code", async () => {
  // The boundary ADR-0076 fixed, enforced mechanically because "we agreed not to" is how it would erode. Breaks
  // by: importing Capability or RefusalCode into src/advisors, which is exactly how an advisor would acquire the
  // ability to hand something back that a governance path could act on.
  const offenders: string[] = [];
  for (const name of await readdir(join(packageRoot, "src", "advisors"))) {
    if (!name.endsWith(".ts")) continue;
    const text = await readFile(join(packageRoot, "src", "advisors", name), "utf8");
    for (const banned of ["Capability", "RefusalCode", "GovernanceRefusal", "refusal("])
      if (new RegExp(`\\b${banned.replace("(", "\\(")}`).test(text.replace(/^\s*\*.*$/gm, "")))
        offenders.push(`${name}: ${banned}`);
  }
  assert.deepEqual(offenders, [], "an advisor type must not be able to name authority");
});

test("no kernel or governance module imports the advisors layer", async () => {
  // The other half: even a pure advisor type must not appear on a governance path, or an advisor result becomes
  // something a decision can read. Breaks by: importing from ../advisors/ inside src/kernel or src/governance.
  const offenders: string[] = [];
  for (const layer of ["kernel", "governance"])
    for (const name of await readdir(join(packageRoot, "src", layer))) {
      if (!name.endsWith(".ts")) continue;
      const text = await readFile(join(packageRoot, "src", layer, name), "utf8");
      if (/from "\.\.\/advisors\//.test(text)) offenders.push(`${layer}/${name}`);
    }
  assert.deepEqual(offenders, []);
});

test("the default advisor is off, and asking it still writes a record", async () => {
  // "Every use is recorded" includes the uses that produced nothing — an advisor that silently stopped answering
  // would otherwise be indistinguishable from one nobody called. Breaks by: returning early before `record`.
  const records: AdviceRecord[] = [];
  const advisor = createAdvisor({ decider: nullDecider, record: (r) => void records.push(r) });
  assert.equal(await advisor.ask("handoff-pruning", REQUEST), null);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "disabled");
  assert.equal(records[0].answered, false);
  assert.deepEqual(records[0].questions, ["keep", "which", "urgency"]);
});

test("a record names the decision and the answers, and never the state", async () => {
  // ADR-0021: the ledger has never stored a task, and an advisor must not become the way it starts. The state is
  // caller-composed and can carry task text or file contents. Breaks by: putting `request.state` in the record.
  const records: AdviceRecord[] = [];
  const decider: Decider = {
    name: "fake",
    decide: async () => ({
      answers: {
        keep: { kind: "noul", value: true, confidence: 0.9 },
        which: { kind: "choice", value: "b" },
        urgency: { kind: "score", value: 2 },
      },
      model: "typesafe/jev-1.13-20260917",
    }),
  };
  const advisor = createAdvisor({ decider, record: (r) => void records.push(r), enabled: true });
  const advice = await advisor.ask("handoff-pruning", REQUEST);
  assert.equal(advice?.answers.which.value, "b");
  const serialised = JSON.stringify(records[0]);
  assert.doesNotMatch(serialised, /do not ship this/, "the state must never reach the record");
  assert.equal(records[0].outcome, "answered");
  assert.equal(records[0].model, "typesafe/jev-1.13-20260917");
  assert.deepEqual(records[0].answers?.keep, { value: true, confidence: 0.9 });
  assert.deepEqual(records[0].answers?.which, { value: "b" }, "a confidence that was not reported is not invented");
});

test("a slow advisor is no advice, recorded as a timeout, and the caller proceeds", async () => {
  // An advisor sits on a path a human is waiting for. Breaks by: removing the timeout, or letting the abort throw.
  const records: AdviceRecord[] = [];
  const decider: Decider = {
    name: "slow",
    decide: (_r, signal) =>
      new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
  };
  const advisor = createAdvisor({ decider, record: (r) => void records.push(r), enabled: true, timeoutMs: 20 });
  assert.equal(await advisor.ask("routing", REQUEST), null);
  assert.equal(records[0].outcome, "timeout");
});

test("a decider that throws is no advice, not an exception the caller must handle", async () => {
  // Breaks by: letting the rejection escape `ask`, which would make an optional advisor able to fail a delegation.
  const records: AdviceRecord[] = [];
  const decider: Decider = {
    name: "broken",
    decide: async () => {
      throw new Error("transport");
    },
  };
  const advisor = createAdvisor({ decider, record: (r) => void records.push(r), enabled: true });
  assert.equal(await advisor.ask("routing", REQUEST), null);
  assert.equal(records[0].outcome, "error");
});

test("the Jev request is built in the shape OpenRouter documents", () => {
  // Verified against OpenRouter's SDK reference for POST /api/alpha/decisions. Breaks by: renaming a wire field,
  // which would be accepted by nothing and reported as "no advice" forever.
  const wire = wireRequest(REQUEST, JEV_MODEL) as Record<string, any>;
  assert.equal(wire.model, "typesafe/jev-1.13");
  assert.equal(JEV_ENDPOINT, "https://openrouter.ai/api/alpha/decisions");
  assert.deepEqual(wire.questions.keep, {
    type: "noul",
    instructions: "Keep it?",
    criteria: { true: "yes", false: "no" },
  });
  assert.deepEqual(wire.questions.which, {
    type: "choice",
    instructions: "Which?",
    criteria: { a: "first", b: "second" },
  });
  assert.deepEqual(wire.questions.urgency, {
    type: "score",
    instructions: "How urgent?",
    criteria: ["low", "mid", "high"],
  });
});

test("an answer outside the question's own vocabulary is no advice, not a low-confidence one", () => {
  // The response shape is documented but never exemplified, and no live call has been made — so the parser is
  // strict about WHAT an answer may be and generous about where it sits. Breaks by: accepting a choice that was
  // never offered, which would hand a caller an option it did not have.
  assert.equal(parseAdvice(REQUEST, { answers: { keep: true, which: "c", urgency: 1 } }), null, "c was not offered");
  assert.equal(parseAdvice(REQUEST, { answers: { keep: true, which: "a", urgency: 9 } }), null, "9 is not a level");
  assert.equal(parseAdvice(REQUEST, { answers: { keep: "yes", which: "a", urgency: 1 } }), null, "noul is boolean");
  assert.equal(parseAdvice(REQUEST, { answers: { which: "a", urgency: 1 } }), null, "every question or none");
  assert.equal(parseAdvice(REQUEST, {}), null);
  assert.equal(parseAdvice(REQUEST, "nope"), null);

  const flat = parseAdvice(REQUEST, { answers: { keep: true, which: "a", urgency: 1 }, model: "m" });
  assert.deepEqual(flat?.answers.which, { kind: "choice", value: "a" });
  assert.equal(flat?.model, "m");
  const nested = parseAdvice(REQUEST, {
    answers: { keep: { value: false, p: 0.8 }, which: { answer: "b", confidence: 0.7 }, urgency: { value: 3 } },
  });
  assert.deepEqual(nested?.answers.keep, { kind: "noul", value: false, confidence: 0.8 });
  assert.deepEqual(nested?.answers.which, { kind: "choice", value: "b", confidence: 0.7 });
  assert.deepEqual(nested?.answers.urgency, { kind: "score", value: 3 });
});

test("a non-2xx from the endpoint is no advice, not a thrown error", async () => {
  // The caller is mid-decision: "the advisor is unavailable" and "the advisor had nothing to say" are the same
  // answer. Breaks by: throwing on !response.ok.
  const decider = jevDecider({ apiKey: "k", fetch: async () => new Response("nope", { status: 500 }) });
  assert.equal(await decider.decide(REQUEST), null);

  const sent: Array<{ url: string; init: RequestInit }> = [];
  const ok = jevDecider({
    apiKey: "secret-key",
    fetch: async (url, init) => {
      sent.push({ url: String(url), init: init as RequestInit });
      return new Response(JSON.stringify({ answers: { keep: true, which: "a", urgency: 1 } }), { status: 200 });
    },
  });
  const advice = await ok.decide(REQUEST);
  assert.equal(advice?.answers.keep.value, true);
  assert.equal(sent[0].url, JEV_ENDPOINT);
  assert.equal((sent[0].init.headers as Record<string, string>).authorization, "Bearer secret-key");
});

test("an advisor is off unless the settings say so and a key is present, and a typo does not enable it", () => {
  // Rule 8: malformed configuration disables the thing and NAMES the field. An operator who mistypes must not get
  // silence (they conclude it is broken) or an advisor (a third party reads their session unasked).
  const withKey = { [ADVISOR_KEY_ENV]: "jev_live" } as NodeJS.ProcessEnv;
  assert.equal(advisorSettingsFrom(undefined, withKey).enabled, false);
  assert.equal(advisorSettingsFrom({ enabled: true, decider: "jev" }, withKey).enabled, true);
  assert.equal(advisorSettingsFrom({ enabled: true, decider: "jev" }, {}).enabled, false, "no key, no advisor");
  assert.match(String(advisorSettingsFrom({ enabled: true, decider: "jev" }, {}).refusal), new RegExp(ADVISOR_KEY_ENV));
  assert.match(String(advisorSettingsFrom({ enabeld: true }, withKey).refusal), /unknown field\(s\) enabeld/);
  assert.match(String(advisorSettingsFrom({ enabled: true, decider: "gpt" }, withKey).refusal), /must be "jev"/);
  assert.match(
    String(advisorSettingsFrom({ enabled: true, decider: "jev", timeoutMs: 0 }, withKey).refusal),
    /between 1 and 30000/,
  );
  assert.equal(advisorSettingsFrom({ enabled: false, decider: "jev" }, withKey).enabled, false);
});

test("every use reaches the ledger as an advice record, including the uses that produced nothing", async () => {
  // "Every call writes an advice record" is ADR-0076's rule for this layer, and the disabled case is the one a
  // reviewer needs most: without it, an advisor that stopped answering looks exactly like one nobody used.
  // Breaks by: dropping the `record` wiring in createAdvisorSession, or making it conditional on being enabled.
  const dir = await tempDir("advisor-record-");
  const ledgerPath = join(dir, "grants.jsonl");
  const session = createAdvisorSession({ block: undefined, ledgerPath, env: {} });
  assert.equal(session.settings.enabled, false);
  assert.equal(await session.advisor.ask("handoff-pruning", REQUEST), null);

  const { records, damage } = await readRecordsFile<AdviceRecord>(ledgerPath);
  assert.equal(damage, null);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "advice", "an advice record shares the one envelope every other record uses");
  assert.equal(records[0].body.purpose, "handoff-pruning");
  assert.equal(records[0].body.outcome, "disabled");
  assert.doesNotMatch(JSON.stringify(records[0]), /do not ship this/);
});

test("settings that ask for an advisor without a key produce a reported refusal, not an advisor", () => {
  // Breaks by: constructing the jev decider before checking the key, which would send an unauthenticated request
  // on every decision and report each as "no advice" forever.
  const session = createAdvisorSession({ block: { enabled: true, decider: "jev" }, env: {} });
  assert.equal(session.settings.enabled, false);
  assert.match(String(session.settings.refusal), new RegExp(ADVISOR_KEY_ENV));
});
