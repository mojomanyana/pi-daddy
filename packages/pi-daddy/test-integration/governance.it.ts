/**
 * Integration — the extension's decisions, read out of a real pi process.
 *
 * Model-free: every assertion here drives `/grants`, whose handler runs the REAL planner over each known
 * `SKILL.md` definition and prints an allow/BLOCK verdict. That exercises the whole wiring — env parsing,
 * definition loading, `publishChildEnv`, the decision function — without a model deciding anything, so it
 * is fast, deterministic and costs nothing. Running the real planner is deliberate: R-28 was a diagnostic
 * that disagreed with enforcement, and sharing one code path is what makes that inexpressible.
 *
 * These cover the extension-level behaviours that unit tests structurally cannot: `src/` is pure, so a
 * defect in how the extension READS its configuration is invisible to it. G7's `NaN` bug lived there for
 * exactly that reason.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digestDefinition, parseSkillDefinition } from "../src/definitions.ts";
import { cleanupTempDirs, fixture, piAvailable, runCommand, tempDir, verdictFor } from "./harness.ts";

after(cleanupTempDirs);

const DOCS_WRITER = `---
name: docs-writer
description: Fixes documentation typos.
allowed-tools: Read, Write
---
Fix documentation typos.
`;

const FABRIC = `---
name: fabric-agent
description: Declares a universal capability.
allowed-tools: Read, fabric_exec
---
Declares a universal capability.
`;

// ADR-0016 INVERTED what an absent declaration means. Under pi-subagents' format a missing \`tools:\` key
// meant pi's FULL default toolset, so this fixture was named \`wide\` and tested a wildcard ceiling. Now an
// absent \`allowed-tools\` means UNDECLARED, therefore not spawnable — the weakest state, not the
// strongest. The fixture is kept and renamed rather than deleted, because "what happens when the author
// declares nothing?" is exactly the question that used to have the dangerous answer.
const UNDECLARED = `---
name: undeclared
description: Declares no allowed-tools at all.
---
No allowed-tools key, so this cannot be spawned.
`;

describe("governance decisions in a real pi process", { skip: piAvailable() ? false : "pi is not on PATH" }, () => {
  let project: string;
  const projectOnce = async () => (project ??= await fixture({ "docs-writer": DOCS_WRITER, "fabric-agent": FABRIC, undeclared: UNDECLARED }));

  test("an enumerated grant allows a type it covers and blocks one it does not", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({ cwd, command: "/grants", env: { PI_GRANTS_GRANT: "agent:docs-writer,agent:undeclared,tool:read,tool:write" } });

    assert.match(verdictFor(r, "docs-writer") ?? "", /^allow/);
    assert.match(
      verdictFor(r, "undeclared") ?? "",
      /^BLOCK/,
      "a definition that declares no allowed-tools is refused, however wide the grant",
    );
  });

  test("a capability the session does not hold is refused as escalation", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({ cwd, command: "/grants", env: { PI_GRANTS_GRANT: "agent:docs-writer,tool:read" } });

    const verdict = verdictFor(r, "docs-writer") ?? "";
    assert.match(verdict, /^BLOCK/);
    assert.match(verdict, /tool:write/);
    assert.match(verdict, /escalation blocked/);
  });

  test("ADR-0017: a definition whose tools fit is still refused without agent:<name>", async () => {
    // R-35's exact shape, end to end: `docs-writer` needs Read+Write and the grant holds both, which used
    // to be the whole test. What is missing now is the authority to run THAT definition. The three tests
    // above had to gain `agent:` ids for this reason — proof the prerequisite bites on the real path and
    // not merely in a pure function.
    const cwd = await projectOnce();
    const r = await runCommand({ cwd, command: "/grants", env: { PI_GRANTS_GRANT: "tool:read,tool:write" } });

    const verdict = verdictFor(r, "docs-writer") ?? "";
    assert.match(verdict, /^BLOCK/, "holding every tool the definition needs is no longer sufficient");
    assert.match(verdict, /agent:docs-writer/, "and the refusal names the capability the operator must add");
  });

  test("a gated capability blocks, and names approval, on an enumerated grant", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "agent:docs-writer,tool:read,tool:write", PI_GRANTS_GATED: "tool:write" },
    });

    // Wording differs from the deleted interceptor's ("requires approval for X"); the property — a gated
    // capability blocks and the message names it — is unchanged.
    assert.match(verdictFor(r, "docs-writer") ?? "", /tool:write requires explicit approval/);
  });

  test("a wildcard holder is still subject to a gate", async () => {
    // NARROWED by ADR-0016, and the narrowing is the honest part. ADR-0011 Finding 1 described a defect
    // in `decideSpawn`'s wildcard SHORTCUT: it refused while claiming approval was required, on a path
    // where no dialog could ever be offered. That shortcut is deleted with the interceptor, so the
    // specific message it produced — and the assertions about naming `PI_GRANTS_GRANT` and offering no
    // dialog — are testing code that no longer exists.
    //
    // What survives is the property that mattered: **holding the wildcard is authority to grant widely,
    // never authority to skip a human.** That is asserted here. On the delegate path a wildcard holder
    // reaches the ordinary gate and a real dialog IS offered, which is a strictly better outcome than the
    // dead-end the Finding described.
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "tool:*", PI_GRANTS_GATED: "tool:write" },
    });

    assert.match(verdictFor(r, "docs-writer") ?? "", /^BLOCK/);
    assert.equal(r.selects.length, 0, "a preview must never raise a dialog");
  });

  test("a universal capability is refused on both grant shapes (ADR-0011)", async () => {
    const cwd = await projectOnce();

    // The REASON changed and the outcome did not. `fabric_exec` comes from `pi-fabric`, which is not
    // installed on any machine this suite runs on, so the catalog check now reports the accurate fault —
    // "not present in this session" — before universality is ever considered. That ordering is right:
    // "does not exist here" and "confers everything" are different problems with different fixes, and
    // the 2026-08-10 log already recorded that reaching the universal branch end-to-end needs
    // `npm:pi-fabric` present. The universal rule itself stays covered by `test/resolve.test.ts`.
    const wildcard = await runCommand({ cwd, command: "/grants", env: { PI_GRANTS_GRANT: "tool:*" } });
    assert.match(verdictFor(wildcard, "fabric-agent") ?? "", /^BLOCK/);
    assert.match(verdictFor(wildcard, "fabric-agent") ?? "", /fabric_exec/, "the message must name the culprit");

    const enumerated = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "agent:fabric-agent,tool:read,tool:fabric_exec" },
    });
    assert.match(verdictFor(enumerated, "fabric-agent") ?? "", /fabric_exec/);
  });

  // ── G7: configuration robustness. None of this is reachable from a unit test, because the defect was
  // in how the EXTENSION read its environment, not in any pure function. ──────────────────────────────

  test("a malformed maxDepth disables spawning and says so", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "tool:read,tool:write", PI_GRANTS_MAX_DEPTH: "not-a-number" },
    });

    const warning = r.notifies.find((n) => n.message.includes("could not be read"));
    assert.ok(warning, "the operator set the variable, so they must be told it did not take effect");
    assert.match(warning.message, /PI_GRANTS_MAX_DEPTH/);
    assert.match(warning.message, /failing closed/);
    assert.match(
      verdictFor(r, "docs-writer") ?? "",
      /^BLOCK/,
      "before 0.5.0 this yielded NaN, and every comparison against NaN is false, so the limit vanished",
    );
  });

  test("a numeric prefix is not silently accepted as a bound", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "tool:read,tool:write", PI_GRANTS_MAX_DEPTH: "2abc" },
    });
    assert.ok(
      r.notifies.some((n) => n.message.includes("could not be read")),
      "parseInt('2abc') is 2 — a typo must not become a plausible-looking bound",
    );
  });

  test("/grants ledger reads the ledger back and reports its integrity", async () => {
    // The compensating control ADR-0008 leans on, driven through a real pi process. Model-free: a slash
    // command exercises the whole wiring — env parsing, path resolution, `verifyLedger` — with no model
    // deciding anything.
    const cwd = await projectOnce();
    const dir = await tempDir("grants-it-ledger-");
    const ledger = join(dir, "ledger.jsonl");
    await writeFile(
      ledger,
      // One valid record, then a torn one. Corruption must be REPORTED, because a line that silently
      // fails to parse is indistinguishable from a spawn that never happened.
      `${JSON.stringify({
        ts: new Date().toISOString(),
        parentId: "d0",
        childId: "d0.1",
        depth: 1,
        requested: ["tool:read"],
        parentGrant: ["tool:read"],
        effective: ["tool:read"],
        denied: [],
        clipped: [],
        gatedBlocked: [],
        blocked: false,
      })}\n{"parentId":"d0","childId":"d0.2","dep\n`,
      "utf8",
    );

    const r = await runCommand({
      cwd,
      command: "/grants ledger",
      env: { PI_GRANTS_GRANT: "tool:read", PI_GRANTS_LEDGER: ledger },
    });

    const text = r.notifies.map((n) => n.message).join("\n");
    assert.match(text, /records\s+1/, "the valid record is counted");
    assert.match(text, /UNPARSEABLE LINE/, "and the torn one is reported rather than ignored");
    assert.match(text, /line 2:/, "with a line number, so it is actionable");
    assert.ok(
      !/approvals\s+\d/.test(text),
      "a ledger with no approvals must not print an approvals tally — a report that speaks about " +
        "everything every time is one an operator stops reading (R-25)",
    );
  });

  test("ADR-0020: /grants ledger counts persisted against prompt, so the layer's fate is measurable", async () => {
    // ADR-0020 keeps the persistence layer on an ASSERTED fatigue argument and names the evidence that
    // would settle it, then says it "needs no new machinery". True of the data and false of the answer:
    // nothing read `approvalSources`, so the measurement needed hand-written jq and never happened. This
    // drives the operator's actual path to that number — one command, real pi, no model.
    const cwd = await projectOnce();
    const ledger = join(await tempDir("grants-it-sources-"), "ledger.jsonl");
    const base = {
      ts: new Date().toISOString(), parentId: "d0", depth: 1, requested: [], parentGrant: [],
      effective: [], denied: [], clipped: [], gatedBlocked: [], blocked: false,
    };
    await writeFile(
      ledger,
      [
        // A mixed record — two capabilities, two sources — plus a legacy line that must not be believed.
        JSON.stringify({ ...base, childId: "d0.1", approved: ["tool:bash", "tool:write"], approvalSources: { "tool:bash": "persisted", "tool:write": "prompt" } }),
        JSON.stringify({ ...base, childId: "d0.2", approved: ["tool:bash"], approvalSources: { "tool:bash": "persisted" } }),
        JSON.stringify({ ...base, childId: "d0.3", approved: ["tool:bash"], approvalSource: "prompt" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const r = await runCommand({
      cwd,
      command: "/grants ledger",
      env: { PI_GRANTS_GRANT: "tool:read", PI_GRANTS_LEDGER: ledger },
    });

    const text = r.notifies.map((n) => n.message).join("\n");
    assert.match(text, /1 prompt · 2 persisted/, "the two numbers ADR-0020 asks to be compared");
    // Both records AND pairs, because quoting records alone overstates the layer: the two persisted records
    // here are ONE capability@subject (`tool:write@<delegate>`), so deleting the store costs one prompt.
    // Pairs against PAIRS — the comparison ADR-0020 actually asks for. Printing persisted records over a
    // denominator of all records let a wide fan-out drive the ratio toward "delete it" for free.
    assert.match(text, /ADR-0020: 1 persisted vs 1 prompted capability@subject pair\(s\)/, "pairs vs pairs");
    assert.match(text, /RECORDS ARE AN UPPER BOUND on prompts avoided/, "the raw counts are labelled as a bound");
    // Excluded OUT LOUD, and without asserting a cause: a pre-0.11.1 line is the usual reason, and a torn
    // or hand-edited one reads identically. Naming the version as fact would be a guess in a report whose
    // whole value is that its numbers mean what they say.
    assert.match(text, /1 not counted — the record named approved capabilities but no usable/, "excluded out loud");
    assert.match(text, /Usually a line written before 0\.11\.1/, "with the likely cause offered, not asserted");
  });

  test("R-51: /grants ledger groups by instructions and flags a definition that has changed", async () => {
    // ADR-0018 advertises that a record answers "did these four children run the same instructions?" and
    // "has this definition changed since?" — and until 0.11.1 NOTHING read `definitionDigest`, so both
    // needed hand-written jq. Two records for `docs-writer`: one whose digest matches the fixture on disk,
    // one that does not. The comparison uses the same `snapshotOf` that voids an approval, so the listing
    // cannot disagree with the enforcer about whether a definition changed.
    const cwd = await projectOnce();
    const dir = await tempDir("grants-it-digest-");
    const ledger = join(dir, "ledger.jsonl");
    const line = (sha: string, childId: string) =>
      JSON.stringify({
        ts: new Date().toISOString(),
        parentId: "d0",
        childId,
        depth: 1,
        agentType: "docs-writer",
        requested: ["tool:read"],
        parentGrant: ["tool:read"],
        effective: ["tool:read"],
        denied: [],
        clipped: [],
        gatedBlocked: [],
        blocked: false,
        definitionDigest: { name: "docs-writer", source: `${cwd}/.pi/skills/docs-writer/SKILL.md`, sha256: sha },
      });
    // The real digest of the DOCS_WRITER fixture body, computed the way production computes it.
    const parsed = parseSkillDefinition(`${cwd}/.pi/skills/docs-writer/SKILL.md`, DOCS_WRITER);
    assert.ok(parsed, "precondition: the fixture parses");
    const real = digestDefinition(parsed).sha256;
    await writeFile(ledger, `${line(real, "d0.1")}\n${line(real, "d0.2")}\n${line("0".repeat(64), "d0.3")}\n`, "utf8");

    const r = await runCommand({
      cwd,
      command: "/grants ledger",
      env: { PI_GRANTS_GRANT: "agent:docs-writer,tool:read,tool:write", PI_GRANTS_LEDGER: ledger },
    });

    const text = r.notifies.map((n) => n.message).join("\n");
    assert.match(text, /instructions 2 distinct version\(s\)/, "two bodies ran under one name");
    assert.match(text, new RegExp(`${real.slice(0, 12)}\\s+2 spawn\\(s\\)\\s+— current`), "the live one is counted and matched");
    assert.match(text, /0{12}\s+1 spawn\(s\)\s+— CHANGED since/, "and the stale one is named as changed");
    assert.match(text, /NOTE docs-writer ran under more than one version/);
  });

  /**
   * R-47, and **this test asserted the wrong half of it for six releases** (R-134).
   *
   * R-47 was fixed twice. *"PARTLY FIXED 2026-08-14 (0.11.1): a startup warning named the inert entry"*,
   * then *"FULLY FIXED 2026-08-14 (0.12.0) by ADR-0024: the authorising id is evaluated against the
   * gate"* — `4673348`, "gating a definition asks before it runs". The full fix made the warning false and
   * nothing removed either the warning or this test, so from 0.12.0 through 0.18.1 the integration suite
   * *required* the session banner to tell operators that a working control does nothing, and advised them
   * to withhold the capability instead. A test pinning a superseded partial fix is worse than no test: it
   * defends the stale claim against the person who notices.
   *
   * Now asserts the behaviour ADR-0024 actually shipped. **Breaks by:** removing the `gateAuthority` call
   * for `input.spawned` in `resolveDelegationApproval`, which is the real R-47 fix.
   */
  test("R-47/ADR-0024: gating an agent: id gates the SPAWN, and says so", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "agent:docs-writer,tool:read,tool:write", PI_GRANTS_GATED: "agent:docs-writer" },
    });

    assert.match(
      verdictFor(r, "docs-writer") ?? "",
      /agent:docs-writer requires explicit approval/,
      "the authorising id is evaluated against the gate, so a human is asked before the definition runs",
    );
    assert.equal(
      r.notifies.find((n) => n.message.includes("does NOT gate spawning")),
      undefined,
      "and the operator is NOT told the gate is inert, because since 0.12.0 it is not",
    );
  });

  test("R-70: a ledger of nothing but declines still reports them", async () => {
    // The declines were rendered INSIDE the approvals guard, so a ledger with no approvals printed no
    // mention of them — and a session where the operator said no to everything is both the strongest
    // evidence the gate is working and the most alarming shape an audit can take. The number that argues
    // hardest for this package's own gating was invisible in exactly the ledger that argues hardest.
    //
    // Pairs as well as records, for R-63's reason one field over: R-29 shares a decline across every
    // concurrent caller, so ONE click of Deny under a fan-out writes one record per child.
    const cwd = await projectOnce();
    const ledger = join(await tempDir("grants-it-declined-"), "ledger.jsonl");
    const base = {
      ts: "2026-08-14T00:00:00.000Z", parentId: "d0", depth: 1, requested: ["tool:bash"],
      parentGrant: ["tool:bash"], effective: [], denied: [], clipped: [],
      gatedBlocked: ["tool:bash"], blocked: true, humanDenied: true, gateOutcome: "declined",
    };
    await writeFile(
      ledger,
      [
        JSON.stringify({ ...base, childId: "d0.1", agentType: "deploy" }),
        JSON.stringify({ ...base, childId: "d0.2", agentType: "deploy" }),
        JSON.stringify({ ...base, childId: "d0.3", agentType: "deploy" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const r = await runCommand({
      cwd,
      command: "/grants ledger",
      env: { PI_GRANTS_GRANT: "tool:read", PI_GRANTS_LEDGER: ledger },
    });

    const text = r.notifies.map((n) => n.message).join("\n");
    assert.match(text, /declined   3 record\(s\) across 1 distinct capability@subject pair\(s\)/, "reported at all");
    assert.match(text, /a human was asked and said no/, "and said plainly");
    assert.ok(!/approvals  /.test(text), "precondition: there are no approvals here, which is the whole point");
  });

  test("R-74: an unknown /grants subcommand is refused, not silently ignored", async () => {
    // `/grants init` — a command that does not exist — printed the ordinary status screen with the word
    // dropped, so it read as though init had run. `/grants ledgr` behaved identically. A diagnostic that
    // answers a question nobody asked is indistinguishable from success, which is the failure shape this
    // package's risk register is mostly about.
    const cwd = await projectOnce();
    // `ledgr` rather than `init`: this test USED to use `init`, and ADR-0030 then made init a real
    // subcommand — so the test failed, correctly, on the change that invalidated its fixture. A typo of a
    // real verb is the better example anyway, because it is what actually happens.
    const r = await runCommand({ cwd, command: "/grants ledgr", env: { PI_GRANTS_GRANT: "tool:read" } });
    const text = r.notifies.map((n) => n.message).join("\n");

    assert.match(text, /unknown subcommand "ledgr" — did nothing/, "it must say it did nothing");
    assert.match(text, /Known: init, ledger, approvals, revoke/, "and what it does know");
    assert.ok(!/holding    /.test(text), "and must NOT print the status screen, which is what made it look fine");
  });

  test("R-74: a KNOWN subcommand and plain /grants are both unaffected", async () => {
    // The other half. Refusing the unknown must not refuse the known — and bare `/grants`, whose `sub` is
    // undefined rather than a wrong word, is the case a naive `sub !== known` check would break.
    const cwd = await projectOnce();
    const bare = await runCommand({ cwd, command: "/grants", env: { PI_GRANTS_GRANT: "tool:read" } });
    assert.match(bare.notifies.map((n) => n.message).join("\n"), /holding    /, "bare /grants still reports");

    const approvals = await runCommand({ cwd, command: "/grants approvals", env: { PI_GRANTS_GRANT: "tool:read" } });
    assert.ok(
      !/unknown subcommand/.test(approvals.notifies.map((n) => n.message).join("\n")),
      "a known verb must not be refused",
    );
  });

  test("ADR-0030: a stored grant governs the session with NO environment variable and NO restart", async () => {
    // The reason the store exists: `source .pi/grants.env && pi` was two steps and a restart, because the
    // grant only ever arrived through the environment. A directory that ran `/grants init` is now governed
    // by plain `pi`.
    const cwd = await fixture({ "docs-writer": DOCS_WRITER });
    const agentDir = await tempDir("grants-it-storedir-");
    const { grantStorePath } = await import("../src/grant-store.ts");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const storePath = grantStorePath(cwd);
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, cwd, grant: ["agent:docs-writer", "tool:read", "tool:write"], writtenAt: "x" }),
      "utf8",
    );

    // No PI_GRANTS_GRANT anywhere in this run.
    const r = await runCommand({ cwd, command: "/grants", env: { PI_CODING_AGENT_DIR: agentDir } });
    const text = r.notifies.map((n) => n.message).join("\n");

    assert.match(text, /grants: ACTIVE/, "a stored grant makes the session governed");
    assert.match(text, /agent:docs-writer/, "and it is the STORED grant that is held");
    assert.match(verdictFor(r, "docs-writer") ?? "", /^allow/, "and the planner uses it for real");
  });

  test("ADR-0030: PI_GRANTS_GRANT always beats the store", async () => {
    // The precedence that keeps children and CI correct. The variable is how a CHILD is governed; a store
    // that could override it would let a directory quietly re-widen a child its parent had bounded.
    const cwd = await fixture({ "docs-writer": DOCS_WRITER });
    const agentDir = await tempDir("grants-it-storedir2-");
    const { grantStorePath } = await import("../src/grant-store.ts");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const storePath = grantStorePath(cwd);
    await mkdir(dirname(storePath), { recursive: true });
    // A deliberately WIDE store beside a deliberately NARROW environment.
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, cwd, grant: ["tool:*"], writtenAt: "x" }),
      "utf8",
    );

    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_CODING_AGENT_DIR: agentDir, PI_GRANTS_GRANT: "tool:read" },
    });
    const text = r.notifies.map((n) => n.message).join("\n");

    assert.match(text, /holding    tool:read/, "the environment's narrow grant is what is held");
    assert.ok(!/tool:\*/.test(text), "the store's wide grant must not appear at all");
  });

  test("R-34: a corrupt ledger is reported at session start, unasked", async () => {
    // Detection existed and nothing ran it: `/grants ledger` found a torn line only if an operator thought
    // to look. A check you have to know to run is a feature, not a control. This drives `/grants` — NOT
    // `/grants ledger` — so what it proves is that the warning arrives without being asked for.
    const cwd = await projectOnce();
    const dir = await tempDir("grants-it-corrupt-");
    const ledger = join(dir, "ledger.jsonl");
    await writeFile(ledger, `{"parentId":"d0","childId":"d0.1","dep\n`, "utf8");

    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "agent:docs-writer,tool:read,tool:write", PI_GRANTS_LEDGER: ledger },
    });

    const alarm = r.notifies.find((n) => n.message.includes("unparseable line"));
    assert.ok(alarm, "a damaged audit trail must announce itself");
    assert.equal(alarm.type, "error", "not an info line among the startup chatter");
    assert.match(alarm.message, /line 1/, "and say where, so it is actionable");
  });

  test("R-34: a healthy ledger says nothing at startup", async () => {
    // The other half, and the one that keeps the warning worth reading: a control that speaks every session
    // is a control an operator learns to skip (R-25). The escalation COUNT is deliberately not reported
    // here either — that is a query, and `/grants ledger` answers it.
    const cwd = await projectOnce();
    const dir = await tempDir("grants-it-clean-");
    const ledger = join(dir, "ledger.jsonl");
    await writeFile(
      ledger,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        parentId: "d0",
        childId: "d0.1",
        depth: 1,
        requested: ["tool:read"],
        parentGrant: ["tool:read"],
        effective: ["tool:read"],
        denied: ["tool:write"],
        clipped: [],
        gatedBlocked: [],
        blocked: true,
      })}\n`,
      "utf8",
    );

    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "agent:docs-writer,tool:read,tool:write", PI_GRANTS_LEDGER: ledger },
    });

    assert.ok(
      !r.notifies.some((n) => n.message.includes("unparseable line")),
      "an intact ledger must not raise an alarm",
    );
    assert.ok(
      !r.notifies.some((n) => n.type === "error"),
      "and a recorded escalation attempt is history, not a startup alarm",
    );
  });

  test("R-60: a ledger that cannot be READ is louder than one that is merely torn", async () => {
    // The gap in the control above. `verifyLedger` rethrows every read error that is not ENOENT, that call
    // sat inside `session_start`'s blanket catch, and the catch was empty — so the WORSE damage produced
    // NOTHING: no alarm, and not even the `holding [...]` line. Found by asking where else the R-34 shape
    // appears ("a check nobody runs") and confirmed by execution before it was written down: a governed
    // session with PI_GRANTS_LEDGER naming a directory emitted zero notifications.
    //
    // A directory is the cheap way to make the read fail deterministically without depending on file modes,
    // which behave differently under root and on some filesystems. The failure under test is the CLASS —
    // `readFile` rejecting with something other than ENOENT — not this particular errno.
    const cwd = await projectOnce();
    const ledger = join(await tempDir("grants-it-unreadable-"), "ledger-is-a-directory");
    await mkdir(ledger, { recursive: true });

    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "agent:docs-writer,tool:read,tool:write", PI_GRANTS_LEDGER: ledger },
    });

    const alarm = r.notifies.find((n) => n.message.includes("could not be read"));
    assert.ok(alarm, "an audit trail nothing can verify must say so");
    assert.equal(alarm.type, "error");
    assert.match(alarm.message, new RegExp(ledger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "naming the path");
    assert.match(alarm.message, /PI_GRANTS_LEDGER names a writable FILE/, "and what to do about it");

    // The half that pins the actual defect: the throw used to discard every control after it. This line is
    // the last thing `session_start` emits, so its presence proves the rest of the hook still ran.
    assert.ok(
      r.notifies.some((n) => n.message.includes("grants: depth 0/")),
      "a governed session must still report itself — silence is what made this worth fixing",
    );
  });

  test("ADR-0023: agent:* beside an ungated bash is warned about", async () => {
    // `docs/SPEC.md` and ADR-0023 both call this combination poor and nothing observed it — a hazard a
    // document declares and no code detects is R-47's shape, in a control shipped one day after R-47.
    // Shipped without a test, which by rule 7 made it decoration; this is that test.
    //
    // `agent:*` authorises every SKILL.md in BOTH roots, including `~/.pi/agent/skills` which other tools
    // install into, so ADR-0017's "an operator-authored file" is not true of everything it covers.
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "agent:*,tool:read,tool:bash,tool:delegate", PI_GRANTS_GATED: "" },
    });

    const warning = r.notifies.find((n) => n.message.includes("may run with a shell"));
    assert.ok(warning, "granting every definition a shell with no gate must not be silent");
    assert.match(warning.message, /agent:\*/);
    assert.match(warning.message, /PI_GRANTS_GATED/, "and name the variable that fixes it");
  });

  test("ADR-0023: agent:* with bash GATED is not warned about", async () => {
    // The default configuration, and the reason the check tests `gated` rather than just the grant: with
    // bash gated a human is asked before any child receives it, which is the whole mitigation. Warning here
    // would be nagging about a correct setup — R-25's shape, in the warning added to prevent R-25's shape.
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "agent:*,tool:read,tool:bash,tool:delegate" },
    });

    assert.ok(
      !r.notifies.some((n) => n.message.includes("may run with a shell")),
      "bash is gated by default, so this configuration is the recommended one",
    );
  });

  test("B1: session start names what is spawnable AND what is withheld", async () => {
    // P4: the startup line reported the grant and nothing else, so an operator could not tell a working
    // install from a failed one. Measured here rather than asserted about, because the claim is about what
    // a REAL pi session prints — the same reason every other startup control in this file is tested here.
    //
    // **The production change that breaks this** (rule 7): removing the `summariseSpawnable` block from
    // `session_start`, or classifying without the planner so a withheld definition reads as spawnable.
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      // `tool:delegate` is load-bearing in this fixture and was MISSING from the first version of this
      // test, which asserted `1 of 3 spawnable` in a session that had no delegate tool at all (R-81). The
      // test encoded the defect; the case it should have covered is below.
      env: { PI_GRANTS_GRANT: "agent:docs-writer,agent:undeclared,tool:read,tool:write,tool:delegate" },
    });

    const line = r.notifies.map((n) => n.message).find((m) => m.includes("definitions spawnable"));
    assert.ok(line, `no spawnable summary at session start — notifies were:\n${r.notifies.map((n) => n.message).join("\n")}`);
    assert.match(line, /^grants: 1 of 3 definitions spawnable — docs-writer$/m);
    // The withheld half is the point of the line, and each definition names ITS OWN fix (R-82):
    // `fabric-agent` needs an id this grant does not hold; `undeclared` is authorised and declares no
    // `allowed-tools`, and that clause is the PLANNER's own wording rather than a category invented by the
    // summariser (R-81).
    assert.match(line, /fabric-agent \(needs agent:fabric-agent\)/);
    assert.match(line, /undeclared \(agent "undeclared" declares no `allowed-tools`/);
  });

  test("R-81: a session with no tool:delegate is told so, not told what is spawnable", async () => {
    // `registerDelegationTools` returns early without it, so the session has NO delegate tool — and the
    // startup line used to report definitions as spawnable in exactly that session. Measured here rather
    // than unit-tested alone, because the claim is about what a real pi session prints.
    //
    // The production change that breaks this: dropping the `mayDelegate` check in `summariseSpawnable`.
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "agent:docs-writer,tool:read,tool:write" },
    });

    const line = r.notifies.map((n) => n.message).find((m) => m.includes("none spawnable"));
    assert.ok(line, `expected the no-delegate line — notifies were:\n${r.notifies.map((n) => n.message).join("\n")}`);
    assert.match(line, /3 definitions found, none spawnable — this session holds no tool:delegate/);
    assert.ok(
      !r.notifies.some((n) => /definitions spawnable — /.test(n.message)),
      "a session that cannot delegate must not be told anything is spawnable",
    );
  });

  test("an ungoverned session reports itself inactive", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({ cwd, command: "/grants" });

    assert.ok(
      r.notifies.some((n) => n.message.includes("grants: inactive")),
      "with PI_GRANTS_GRANT unset the README promises nothing is blocked",
    );
  });

});
