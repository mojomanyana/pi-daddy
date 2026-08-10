/**
 * Integration — the extension's decisions, read out of a real pi process.
 *
 * Model-free: every assertion here drives `/grants`, whose handler runs `decideSpawn` over each known
 * agent type and prints an allow/BLOCK verdict. That exercises the whole wiring — env parsing, agent-type
 * loading, `publishChildEnv`, the decision function — without a model deciding anything, so it is fast,
 * deterministic and costs nothing.
 *
 * These cover the extension-level behaviours that unit tests structurally cannot: `src/` is pure, so a
 * defect in how the extension READS its configuration is invisible to it. G7's `NaN` bug lived there for
 * exactly that reason.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { fixture, piAvailable, runCommand, verdictFor } from "./harness.ts";

const DOCS_WRITER = `---
name: docs-writer
tools: read, write
---
Fix documentation typos.
`;

const FABRIC = `---
name: fabric-agent
tools: read, fabric_exec
---
Declares a universal capability.
`;

const WIDE = `---
name: wide
---
No tools: key at all, so the ceiling is the wildcard.
`;

describe("governance decisions in a real pi process", { skip: piAvailable() ? false : "pi is not on PATH" }, () => {
  let project: string;
  const projectOnce = async () => (project ??= await fixture({ "docs-writer": DOCS_WRITER, "fabric-agent": FABRIC, wide: WIDE }));

  test("an enumerated grant allows a type it covers and blocks one it does not", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({ cwd, command: "/grants", env: { PI_GRANTS_GRANT: "tool:read,tool:write" } });

    assert.match(verdictFor(r, "docs-writer") ?? "", /^allow/);
    assert.match(verdictFor(r, "wide") ?? "", /^BLOCK/, "a wildcard ceiling cannot be covered by an enumerated grant");
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

    assert.match(verdictFor(r, "docs-writer") ?? "", /requires approval for tool:write/);
  });

  test("a wildcard holder is refused a gate it cannot be asked about (ADR-0011 Finding 1)", async () => {
    const cwd = await projectOnce();
    const r = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "tool:*", PI_GRANTS_GATED: "tool:write" },
    });

    const verdict = verdictFor(r, "docs-writer") ?? "";
    assert.match(verdict, /^BLOCK/, "holding the wildcard is authority to grant widely, never to skip a human");
    assert.doesNotMatch(verdict, /requires approval/, "no dialog is offered here, so it must not name one");
    assert.match(verdict, /PI_GRANTS_GRANT/, "it must name the remedy");
    assert.equal(r.selects.length, 0, "and it must not raise a dialog");
  });

  test("a universal capability is refused on both grant shapes (ADR-0011)", async () => {
    const cwd = await projectOnce();

    const wildcard = await runCommand({ cwd, command: "/grants", env: { PI_GRANTS_GRANT: "tool:*" } });
    assert.match(verdictFor(wildcard, "fabric-agent") ?? "", /transitively confers the whole catalog/);

    const enumerated = await runCommand({
      cwd,
      command: "/grants",
      env: { PI_GRANTS_GRANT: "tool:read,tool:fabric_exec" },
    });
    assert.match(verdictFor(enumerated, "fabric-agent") ?? "", /would retain tool:fabric_exec/);
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
