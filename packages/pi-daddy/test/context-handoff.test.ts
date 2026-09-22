import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  CONTEXT_MAX_BYTES,
  CONTEXT_MODES,
  CONTEXT_SUBSUMPTION,
  contextCapability,
  fenceContext,
  isContextCapability,
  parseContextRequest,
  selectPrunedTurns,
} from "../src/kernel/context-handoff.ts";
import { resolve as resolveGrant } from "../src/kernel/resolve.ts";
import { planSpawn } from "../src/kernel/spawn.ts";
import { DEFAULT_GATED } from "../src/kernel/propagation.ts";
import { createHandoffStager } from "../extensions/context-staging.ts";
import { planDelegation } from "../src/kernel/delegate.ts";
import { planChain } from "../extensions/chain-plan.ts";
import { parseSkillDefinition } from "../src/kernel/definitions.ts";
import { activitySessionFor } from "../src/executors/activity-session.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/**
 * ADR-0078. The handoff is an attenuating dimension, so most of what must hold is a property of `resolve`, not of
 * new code — these force that it really is wired that way rather than merely described that way.
 */

test("a handoff mode attenuates like any other capability, and fork subsumes every weaker mode", () => {
  // Breaks by: dropping CONTEXT_SUBSUMPTION from SUBSUMPTION, which turns a legal narrowing into an escalation.
  const granted = resolveGrant({ requested: ["context:files"], parentGrant: ["context:fork"] });
  assert.deepEqual(granted.effective, ["context:files"]);
  assert.deepEqual(granted.subsumedBy, ["context:files"], "holding fork covers files, and the record says so");

  const escalation = resolveGrant({ requested: ["context:fork"], parentGrant: ["context:files"] });
  assert.deepEqual(escalation.effective, []);
  assert.deepEqual(escalation.denied, ["context:fork"], "a child may never widen its own handoff");

  for (const mode of ["files", "pruned", "summary"] as const)
    assert.ok(
      (CONTEXT_SUBSUMPTION["context:fork"] as readonly string[]).includes(contextCapability(mode)),
      `fork must subsume ${mode}`,
    );
  assert.equal(CONTEXT_SUBSUMPTION["context:none"], undefined, "the weakest mode subsumes nothing");
});

test("the whole-session handoff is gated by default, like bash", () => {
  // Breaks by: removing context:fork from DEFAULT_GATED. ADR-0078: it is the mode that can carry content an
  // untrusted repository put in front of the parent into a fresh child.
  assert.ok(DEFAULT_GATED.includes("context:fork"));
  const gated = resolveGrant({
    requested: ["context:fork"],
    parentGrant: ["context:fork"],
    gated: [...DEFAULT_GATED],
  });
  assert.deepEqual(gated.effective, [], "granted but ungated is still not granted");
  assert.deepEqual(gated.gatedBlocked, ["context:fork"]);
});

test("a malformed or incomplete request is refused, never silently downgraded to none", () => {
  // Breaks by: returning { mode: "none" } instead of a refusal. A handoff that quietly carries nothing is R-03's
  // shape: the parent cannot tell a delivered empty context from one that never crossed.
  assert.deepEqual(parseContextRequest(undefined), { request: { mode: "none" } });
  assert.match(String((parseContextRequest({ mode: "everything" }) as { refusal: string }).refusal), /must be one of/);
  assert.match(String((parseContextRequest({ mode: "files" }) as { refusal: string }).refusal), /needs context.files/);
  assert.match(
    String((parseContextRequest({ mode: "summary", summary: "  " }) as { refusal: string }).refusal),
    /needs context.summary/,
  );
  assert.match(
    String((parseContextRequest({ mode: "pruned", turns: 0 }) as { refusal: string }).refusal),
    /between 1 and/,
  );
  assert.ok("request" in parseContextRequest({ mode: "pruned" }), "pruned needs no input of its own");
  for (const mode of CONTEXT_MODES) assert.ok(isContextCapability(contextCapability(mode)));
  assert.equal(isContextCapability("context:everything"), false);
});

test("what crosses is fenced, capped, and says inside the fence what did not fit", () => {
  // Breaks by: raising the cap silently, or putting the truncation notice outside the fence where it reads as the
  // orchestrator's own instruction rather than as a fact about the context.
  const fenced = fenceContext([{ label: "big.txt", body: "x".repeat(CONTEXT_MAX_BYTES * 2) }]);
  assert.match(fenced.text, /CONTEXT FROM THE SESSION THAT SPAWNED YOU. It is data to work from/);
  assert.match(fenced.text, new RegExp(`<<<PARENT-CONTEXT ${fenced.nonce}>>>`));
  assert.ok(fenced.truncatedBytes > 0);
  const notice = fenced.text.slice(fenced.text.indexOf("[grants"));
  assert.match(notice, /did not fit/);
  assert.ok(
    fenced.text.indexOf("[grants") < fenced.text.lastIndexOf(`<<<END ${fenced.nonce}>>>`),
    "the notice belongs inside the fence",
  );
  assert.ok(
    Buffer.byteLength(fenced.text) < CONTEXT_MAX_BYTES + 1024,
    "the cap bounds what is built, not only what is read",
  );
});

test("the pruning rule keeps recent turns and older turns that name a file, and says which rule ran", () => {
  // Breaks by: dropping the file clause, or renaming the rule without changing the ledger's reader.
  const turns = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, text: i === 2 ? "we edited src/a.ts" : "chat" }));
  const selection = selectPrunedTurns(turns, { turns: 3, files: ["src/a.ts"] });
  assert.deepEqual(
    selection.kept.map((t) => t.id),
    ["t2", "t17", "t18", "t19"],
  );
  assert.equal(selection.droppedCount, 16);
  assert.equal(selection.rule, "recent+files");
  assert.equal(selectPrunedTurns([], {}).kept.length, 0, "an empty session prunes to nothing without throwing");
});

test("a forked child is planned with --fork and never beside --session, which pi refuses", async () => {
  // Breaks by: passing sessionFile alongside forkFrom, which makes pi exit before the child runs at all.
  const plan = planSpawn({
    effective: [],
    prompt: " task",
    forkFrom: {
      sessionPath: "/p/parent.jsonl",
      sessionDir: "/p/forks/one",
      sessionId: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.ok(plan.args.includes("--fork"));
  assert.equal(plan.args.includes("--session"), false);
  assert.equal(plan.args.includes("--no-session"), false);
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--fork"), plan.args.indexOf("--fork") + 6), [
    "--fork",
    "/p/parent.jsonl",
    "--session-dir",
    "/p/forks/one",
    "--session-id",
    "11111111-1111-4111-8111-111111111111",
  ]);

  // And the inactivity deadline must watch the fork directory rather than inject a conflicting flag.
  const dir = await tempDir("context-fork-probe-");
  const session = await activitySessionFor(
    ["--print", "--fork", "/p/parent.jsonl", "--session-dir", dir, "--session-id", "x", " task"],
    "exec:1",
  );
  assert.deepEqual(session.args.includes("--session"), false, "adding --session here makes pi refuse the spawn");
  assert.equal(await session.probe(), undefined, "no marker before pi writes the fork");
  await writeFile(join(dir, "2026-01-01_x.jsonl"), "{}\n");
  assert.notEqual(await session.probe(), undefined, "the fork's own file is the activity signal");
});

test("staging reads only inside the working directory and says so when it will not", async () => {
  // Breaks by: resolving a model-supplied path without confining it, which turns the fence into a read tool.
  const cwd = await tempDir("context-staging-");
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n");
  const stage = createHandoffStager({ cwd, forkRoot: join(cwd, "forks") });

  const inside = stage({ mode: "files", files: ["src/a.ts"] });
  assert.match(String(inside.contextPrompt), /export const a = 1;/);
  assert.equal(inside.record?.mode, "files");
  assert.equal(inside.record?.sections, 1);

  const outside = stage({ mode: "files", files: ["../../etc/passwd", "/etc/passwd"] });
  assert.doesNotMatch(String(outside.contextPrompt), /root:/);
  assert.match(String(outside.contextPrompt), /outside this session's working directory/);

  const missing = stage({ mode: "files", files: ["src/gone.ts"] });
  assert.match(String(missing.contextPrompt), /could not be read/, "a missing file is said, not silently dropped");

  const summary = stage({ mode: "summary", summary: "we chose flock over mtime" });
  assert.match(String(summary.contextPrompt), /we chose flock over mtime/);
  assert.equal(summary.record?.mode, "summary");
});

const definition = (allowedTools: string) =>
  parseSkillDefinition(
    "/p/review/SKILL.md",
    `---\nname: review\ndescription: d\nallowed-tools: ${allowedTools}\n---\nbody\n`,
  )!;

const planWith = (allowedTools: string, parentGrant: string[], mode: string) =>
  planDelegation(
    { task: "t", agent: "review", context: { mode, summary: "s", files: ["a.ts"] } } as never,
    {
      ownGrant: ["agent:*", ...parentGrant] as never,
      depth: 0,
      maxDepth: 2,
      gated: [],
      definitions: new Map([["review", definition(allowedTools)]]),
    } as never,
  );

test("a definition's allowed-tools is the ceiling on what context it may receive", () => {
  // The headline property, and it was FALSE when this test was written: the declared `context:` ids were stripped
  // from `requested` and the asked-for mode appended, which replaced the ceiling instead of being bounded by it.
  // Measured then: ceiling `context:files` + ask `fork` handed the child `context:fork`, and a definition naming
  // no context at all received `context:files`. Breaks by: dropping the `permitted.has(wanted)` check in
  // `planDelegation`, or checking it against the parent's grant instead of the declaration.
  const parent = ["context:fork", "tool:read"];

  const over = planWith("Read, context:files", parent, "fork");
  assert.equal(over.ok, false, "a definition capped at files must not receive fork");
  assert.equal(over.refusal?.code, "CONTEXT_REQUEST_INVALID");
  assert.match(String(over.reason), /permits context:files/);

  const undeclared = planWith("Read", parent, "files");
  assert.equal(undeclared.ok, false, "a definition that declares no context receives none");
  assert.match(String(undeclared.reason), /declares no context: capability/);

  const within = planWith("Read, context:files", parent, "files");
  assert.equal(within.ok, true);
  assert.ok(within.effective.includes("context:files"));
  assert.equal(within.handoff?.mode, "files");

  // Declaring the strongest mode permits asking for a weaker one, which is what subsumption is for.
  const weaker = planWith("Read, context:fork", ["context:fork", "tool:read"], "summary");
  assert.equal(weaker.ok, true);
  assert.ok(weaker.effective.includes("context:summary"));

  // And the parent's own grant still bounds it independently of the declaration.
  const ungranted = planWith("Read, context:fork", ["context:files", "tool:read"], "fork");
  assert.equal(ungranted.ok, false, "a ceiling cannot grant what the parent does not hold");
});

test("a symlink inside the working directory does not escape the confinement", async () => {
  // `resolve`/`relative` are LEXICAL, so before this the check passed for `cwd/link -> /tmp/outside` and the
  // outside file's contents appeared inside the fence — and a checkout full of `node_modules/.bin` symlinks makes
  // that ordinary. Breaks by: going back to `resolve` without `realpathSync`.
  const { symlink } = await import("node:fs/promises");
  const cwd = await tempDir("context-symlink-");
  const outside = await tempDir("context-outside-");
  await writeFile(join(outside, "secret.txt"), "SECRET-VALUE\n");
  await symlink(join(outside, "secret.txt"), join(cwd, "link.txt"));
  await symlink(outside, join(cwd, "updir"));
  const stage = createHandoffStager({ cwd, forkRoot: join(cwd, "forks") });

  for (const path of ["link.txt", "updir/secret.txt"]) {
    const staged = stage({ mode: "files", files: [path] });
    assert.doesNotMatch(String(staged.contextPrompt), /SECRET-VALUE/, `${path} escaped the working directory`);
    assert.match(String(staged.contextPrompt), /outside this session's working directory/);
  }
});

test("a path that is not a regular file is refused rather than read", async () => {
  // A FIFO satisfies statSync and then never returns from a read, which would block the whole pi session with no
  // watchdog — from a model-supplied path. Breaks by: dropping the `isFile()` check.
  const cwd = await tempDir("context-fifo-");
  await mkdir(join(cwd, "adir"));
  const staged = stageOf(cwd)({ mode: "files", files: ["adir"] });
  assert.match(String(staged.contextPrompt), /not a regular file/);
});

function stageOf(cwd: string) {
  return createHandoffStager({ cwd, forkRoot: join(cwd, "forks") });
}

test("a fork with no parent session refuses instead of throwing, and a real one is recorded and disposable", async () => {
  // `planDelegation` is pure and no caller expects it to throw: a throw escaped as a raw error with no ledger
  // record at all, or as APPROVAL_FLOW_FAILED after the human had already said yes. Breaks by: throwing again.
  const cwd = await tempDir("context-fork-");
  const noSession = stageOf(cwd)({ mode: "fork" });
  assert.match(String(noSession.refusal), /not persisted/);
  assert.equal(noSession.forkFrom, undefined);

  const parentFile = join(cwd, "parent.jsonl");
  await writeFile(parentFile, '{"type":"session"}\n{"type":"message"}\n');
  const staged = createHandoffStager({
    cwd,
    forkRoot: join(cwd, "forks"),
    parentSession: { getSessionFile: () => parentFile, getEntries: () => [{ id: "a", type: "message" }] },
  })({ mode: "fork" });
  assert.ok(staged.forkFrom, "a persisted parent session can be forked");
  // The largest handoff there is must not be the smallest number in the audit trail.
  assert.ok((staged.record?.bytes ?? 0) > 0, "a fork records the bytes that crossed");
  assert.equal(staged.record?.keptTurns, 1);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(staged.forkFrom!.sessionDir), true);
  staged.dispose?.();
  assert.equal(existsSync(staged.forkFrom!.sessionDir), false, "a fork's copy of the parent session is removed");
});

test("a chain step can ask for context, and its gate is raised before any step runs", async () => {
  // ADR-0033: a chain is planned as ONE unit, so a fork wanted by step 2 must be answered before step 1 starts.
  // ADR-0078 left chains out; this closes it. Breaks by: dropping `context: step.context` from `planChain`, which
  // makes every step's handoff silently `none`.
  let staged = 0;
  const session = {
    ownSpawnId: "d0",
    delegationContext: async () => ({
      ownGrant: ["agent:*", "tool:read", "context:fork"],
      depth: 0,
      maxDepth: 3,
      gated: ["context:fork"],
      definitions: new Map([
        ["plan", definition("Read, context:files")],
        ["build", definition("Read, context:fork")],
      ]),
      // Staging reads files and copies the parent's session. The gating pass throws its plans away, so running it
      // there would read every step's files upfront and allocate a fork directory nothing would ever dispose.
      stageHandoff: () => {
        staged += 1;
        return { contextPrompt: "x" };
      },
    }),
  };
  const steps = [
    { task: "a", agent: "plan", context: { mode: "files", files: ["a.ts"] } },
    { task: "b", agent: "build", context: { mode: "fork" } },
  ];
  const chain = await planChain(session as never, steps as never, ["exec:1", "exec:2"] as never);
  assert.equal(chain.doomed, undefined);
  assert.deepEqual(
    chain.requests.map((r) => `${r.capability}@${r.subject}`),
    ["context:fork@build"],
    "the whole-session handoff a later step wants is gated upfront",
  );
  assert.equal(chain.requests[0]?.stepIndex, 1, "and the dialog names the step that asked");
  assert.equal(staged, 0, "the gating pass must stage nothing");

  // A step's own definition still caps it, exactly as for a single delegate.
  const over = await planChain(
    session as never,
    [{ task: "a", agent: "plan", context: { mode: "fork" } }] as never,
    ["exec:1"] as never,
  );
  assert.match(String(over.doomed?.reason), /plan may not receive context:fork/);
});

/**
 * When the budget binds, it must drop the turns FURTHEST from the task, not the nearest.
 *
 * **Measured, 2026-09-22 handoff probe, 78 real pi sessions.** Sections were filled in array order and
 * pruned turns are pushed oldest-first, so the cap cut the most recent turns — the ones adjacent to the task
 * and the most likely to matter. The cap bound in 13% of sessions at the old default and 60% at 20 turns,
 * and the effect was visible end to end: delivered recall of task-referenced entities PEAKED at 20 turns and
 * then FELL at 50 (0.813 → 0.762), so asking for more context made the child worse off. Filling by
 * `keepRank` makes it monotone (0.870 → 0.874).
 *
 * **The production change that breaks these:** filling `fenceContext` in array order again, or dropping
 * `keepRank` from the turn sections in `context-staging.ts`.
 */
test("the budget keeps the highest-ranked sections and still presents them in order", () => {
  // Two sections, each 90% of the budget, so one survives whole and the other is cut to a remnant. Asserting
  // on the HEADER is not enough — a truncated section still prints its header, which is how the first draft
  // of this test passed with the defect in place. The body lengths are what tell the two fills apart.
  const body = (marker: string) => marker.repeat(Math.floor(CONTEXT_MAX_BYTES * 0.9));
  const fenced = fenceContext([
    { label: "oldest", body: body("a"), keepRank: 1 },
    { label: "newest", body: body("b"), keepRank: 2 },
  ]);
  assert.ok(fenced.truncatedBytes > 0, "this case is only meaningful when the budget actually binds");
  const aCount = (fenced.text.match(/a/g) ?? []).length;
  const bCount = (fenced.text.match(/b/g) ?? []).length;
  assert.ok(
    bCount > aCount,
    `the newest section must survive the cap, not the oldest — kept ${bCount} newest bytes and ${aCount} oldest`,
  );
  // Rank decides what survives; the array decides what order the survivors are read in.
  const fitting = fenceContext([
    { label: "oldest", body: "first", keepRank: 1 },
    { label: "newest", body: "second", keepRank: 2 },
  ]);
  assert.ok(
    fitting.text.indexOf("--- oldest ---") < fitting.text.indexOf("--- newest ---"),
    "presentation stays chronological — a child reading its parent out of order is a different defect",
  );
});

test("sections with no rank keep array order, so nothing else changes", () => {
  const fenced = fenceContext([
    { label: "one", body: "a" },
    { label: "two", body: "b" },
    { label: "three", body: "c" },
  ]);
  assert.ok(fenced.text.indexOf("--- one ---") < fenced.text.indexOf("--- two ---"));
  assert.ok(fenced.text.indexOf("--- two ---") < fenced.text.indexOf("--- three ---"));
  assert.equal(fenced.truncatedBytes, 0);
});

test("the real stager ranks turns so the cap drops the OLDEST, end to end", async () => {
  // The kernel test above proves `fenceContext` honours `keepRank`. This proves the stager sets it — removing
  // `keepRank` from the turn sections left all 896 tests green, which is the wiring-without-a-guard shape
  // three reviewers found in the previous change.
  const cwd = await tempDir("context-rank-");
  const big = (marker: string) => marker.repeat(Math.floor(CONTEXT_MAX_BYTES * 0.9));
  const parentSession = {
    getEntries: () => [
      { type: "message", id: "old", message: big("a") },
      { type: "message", id: "new", message: big("b") },
    ],
  };
  const staged = createHandoffStager({ cwd, forkRoot: join(cwd, "forks"), parentSession: parentSession as never })({
    mode: "pruned",
  });
  const text = String(staged.contextPrompt);
  const aCount = (text.match(/a/g) ?? []).length;
  const bCount = (text.match(/b/g) ?? []).length;
  assert.ok((staged.record?.truncatedBytes ?? 0) > 0, "only meaningful when the cap binds");
  assert.ok(bCount > aCount, `the newest turn must survive, kept ${bCount} newest and ${aCount} oldest bytes`);
});

test("a file the parent NAMED outlives turns a rule merely selected", async () => {
  // Review measured the first `keepRank` losing this: turn sections were ranked and file sections defaulted to
  // zero, so a `pruned` handoff carrying both dropped the explicitly named file FIRST — and a wholly skipped
  // section emits no header, so the child could not tell a file had been named at all. That inverts the
  // module's own ordering, where `files` is content the parent names and `pruned` is turns a rule guessed at.
  // Breaks by: dropping `CONTEXT_RANK.file` from the file sections in `context-staging.ts`.
  const cwd = await tempDir("context-band-");
  await writeFile(join(cwd, "constraint.md"), "DECISION: the parser must stay synchronous\n");
  const parentSession = {
    getEntries: () =>
      Array.from({ length: 12 }, (_, i) => ({ type: "message", id: `t${i}`, message: "z".repeat(4000) })),
  };
  const staged = createHandoffStager({ cwd, forkRoot: join(cwd, "forks"), parentSession: parentSession as never })({
    mode: "pruned",
    files: ["constraint.md"],
  });
  const text = String(staged.contextPrompt);
  assert.ok((staged.record?.truncatedBytes ?? 0) > 0, "only meaningful when the cap binds");
  assert.match(text, /DECISION: the parser must stay synchronous/, "the named file must survive the budget");
});

test("a turn kept for NAMING a file outranks a turn kept for being recent", async () => {
  // The rule reaches back past the recency window for turns that name the caller's files, and those turns sit
  // at the FRONT of the selection. A bare positional rank therefore evicted the rule's one non-recency signal
  // first, while the ledger went on calling the rule `recent+files`. Breaks by: ranking every turn from its
  // position alone, without the `fileMatchedTurn` band.
  const cwd = await tempDir("context-band-turn-");
  const entries = [
    { type: "message", id: "old-but-relevant", message: "src/auth.ts must stay synchronous" },
    ...Array.from({ length: 30 }, (_, i) => ({ type: "message", id: `t${i}`, message: "z".repeat(4000) })),
  ];
  const staged = createHandoffStager({
    cwd,
    forkRoot: join(cwd, "forks"),
    parentSession: { getEntries: () => entries } as never,
  })({ mode: "pruned", turns: 25, files: ["src/auth.ts"] });
  const text = String(staged.contextPrompt);
  assert.ok((staged.record?.truncatedBytes ?? 0) > 0, "only meaningful when the cap binds");
  assert.match(text, /must stay synchronous/, "the file-matching turn is why the rule is called recent+files");
});

test("the record counts the turns that CROSSED, not the ones the rule selected", async () => {
  // `context-staging.ts` says the record is "what actually crossed, never what was asked for", and it counted
  // sections before the budget ran — so a handoff could record twenty-one kept turns having sent thirteen.
  // Raising the default turn count moved the cap from binding in 13% of handoffs to 60%, which made the wrong
  // number the usual one. Breaks by: counting `sections.length` or the pre-fence `keptTurns` again.
  const cwd = await tempDir("context-record-");
  const parentSession = {
    getEntries: () =>
      Array.from({ length: 30 }, (_, i) => ({ type: "message", id: `t${i}`, message: "z".repeat(4000) })),
  };
  const staged = createHandoffStager({ cwd, forkRoot: join(cwd, "forks"), parentSession: parentSession as never })({
    mode: "pruned",
    turns: 30,
  });
  const record = staged.record as { keptTurns: number; droppedTurns: number; truncatedBytes: number };
  assert.ok(record.truncatedBytes > 0, "only meaningful when the cap binds");
  const headers = (String(staged.contextPrompt).match(/--- parent turn /g) ?? []).length;
  assert.equal(record.keptTurns, headers, `recorded ${record.keptTurns} kept, the child received ${headers}`);
  assert.equal(record.keptTurns + record.droppedTurns, 30, "every turn is accounted for as kept or dropped");
});
