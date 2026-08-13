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
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, piAvailable, runCommand, verdictFor } from "./harness.ts";

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
    const r = await runCommand({ cwd, command: "/grants", env: { PI_GRANTS_GRANT: "tool:read,tool:write" } });

    assert.match(verdictFor(r, "docs-writer") ?? "", /^allow/);
    assert.match(
      verdictFor(r, "undeclared") ?? "",
      /^BLOCK/,
      "a definition that declares no allowed-tools is refused, however wide the grant",
    );
  });

  test("a capability the session does not hold is refused as escalation", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({ cwd, command: "/grants", env: { PI_GRANTS_GRANT: "tool:read" } });

    const verdict = verdictFor(r, "docs-writer") ?? "";
    assert.match(verdict, /^BLOCK/);
    assert.match(verdict, /tool:write/);
    assert.match(verdict, /escalation blocked/);
  });

  test("a gated capability blocks, and names approval, on an enumerated grant", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "tool:read,tool:write", PI_GRANTS_GATED: "tool:write" },
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
      env: { PI_GRANTS_GRANT: "tool:read,tool:fabric_exec" },
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
    const dir = await mkdtemp(join(tmpdir(), "grants-it-ledger-"));
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
  });

  test("an ungoverned session reports itself inactive", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({ cwd, command: "/grants" });

    assert.ok(
      r.notifies.some((n) => n.message.includes("grants: inactive")),
      "with PI_GRANTS_GRANT unset the README promises nothing is blocked",
    );
  });

  after(() => {
    // Fixtures live under the OS temp dir and are left for inspection when a test fails; the OS reaps them.
  });
});
