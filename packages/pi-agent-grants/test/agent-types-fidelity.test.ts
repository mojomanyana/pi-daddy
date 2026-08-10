/**
 * ADR-0013 — the ceiling must match what `pi-subagents` actually builds.
 *
 * Every expectation here was read out of `@tintinweb/pi-subagents@0.14.3` source
 * (`src/custom-agents.ts`, `src/default-agents.ts`) and is tabulated in ADR-0013. The old reader was
 * "deliberately not a YAML parser", which was defensible until it started disagreeing with the real one
 * **in the permissive direction** — a block-list `tools:` read as *absent*, absence meant the wildcard,
 * and with a wildcard delegator the spawn was allowed while the ledger recorded `effective: ["tool:*"]`
 * for a child that actually held two tools.
 *
 * We match pi's SEMANTICS rather than importing its parser: `@earendil-works/pi-coding-agent` resolves
 * only inside a pi process, and `src/` has to stay importable by `node --test` with no pi present.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ceilingFor, parseAgentType, PI_BUILTIN_TOOLS, WILDCARD } from "../src/agent-types.ts";

const parse = (text: string, source = "/x/docs-writer.md") => parseAgentType(source, text);
const fm = (body: string) => `---\n${body}\n---\nprompt text\n`;
const allBuiltins = [...PI_BUILTIN_TOOLS].map((t) => `tool:${t}`).sort();

test("an omitted tools: key means ALL BUILT-INS, not the wildcard", () => {
  // csvList(undefined, BUILTIN_TOOL_NAMES) returns its defaults. Calling that `tool:*` overstated it:
  // the wildcard cannot be covered by any enumerated grant, so a delegator holding every built-in was
  // refused a child that would only ever have received those same built-ins.
  const type = parse(fm("description: does things"))!;
  assert.deepEqual(ceilingFor(type, { extensionTools: [] }), allBuiltins);
});

test("a YAML block list is read, not mistaken for an absent key", () => {
  // THE permissive-direction bug. pi's parser yields an array; pi-subagents then String()s it into
  // "read,grep". The old reader skipped the key entirely and returned the wildcard.
  const type = parse(fm("tools:\n  - read\n  - grep"))!;
  assert.deepEqual(ceilingFor(type, { extensionTools: [] }), ["tool:grep", "tool:read"]);
});

test("an inline array is read the same way", () => {
  const type = parse(fm("tools: [read, grep]"))!;
  assert.deepEqual(ceilingFor(type, { extensionTools: [] }), ["tool:grep", "tool:read"]);
});

test("plain CSV still works", () => {
  const type = parse(fm("tools: read, grep"))!;
  assert.deepEqual(ceilingFor(type, { extensionTools: [] }), ["tool:grep", "tool:read"]);
});

test("`none` means zero built-ins", () => {
  const type = parse(fm("tools: none"))!;
  assert.deepEqual(ceilingFor(type, { extensionTools: [] }), []);
});

test("`*` and `all` expand to every built-in, plus any plain entries", () => {
  for (const wildcard of ["*", "all", "ALL"]) {
    const type = parse(fm(`tools: ${wildcard}`))!;
    assert.deepEqual(ceilingFor(type, { extensionTools: [] }), allBuiltins, `for ${wildcard}`);
  }
});

test("a tools: list containing ONLY ext: entries yields zero built-ins", () => {
  // Documented explicitly in parseToolsField: "tools: present with only ext: entries -> zero built-ins".
  const type = parse(fm("tools: ext:pkg/thing"))!;
  assert.deepEqual(ceilingFor(type, { extensionTools: [] }), ["ext:pkg/thing"]);
});

test("the type's name comes from the FILENAME, not the frontmatter", () => {
  // pi-subagents keys by basename(file, ".md"). Trusting the frontmatter `name` meant our registry and
  // the spawner could disagree about which definition a given type refers to.
  const type = parse(fm("name: something-else\ntools: read"), "/x/agents/real-name.md")!;
  assert.equal(type.name, "real-name");
});

// ── extensions / skills: the ceiling is not just `tools:` ────────────────────────────────────────

test("extensions default to true, so the ceiling includes the session's extension tools", () => {
  const type = parse(fm("tools: read"))!;
  assert.deepEqual(ceilingFor(type, { extensionTools: ["tool:web_search"] }), [
    "tool:read",
    "tool:web_search",
  ]);
});

test("extensions: false keeps the ceiling to the tools: list", () => {
  const type = parse(fm("tools: read\nextensions: false"))!;
  assert.deepEqual(ceilingFor(type, { extensionTools: ["tool:web_search"] }), ["tool:read"]);
});

test("an unknown extension surface fails CLOSED, not open", () => {
  // If we have not observed this session's tools yet we cannot enumerate what the child would inherit.
  // Guessing "just the tools: list" would be an under-count, and an under-counted ceiling is one that
  // gets ALLOWED. The wildcard is the honest answer: we do not know, so nothing can cover it.
  const type = parse(fm("tools: read"))!;
  assert.deepEqual(ceilingFor(type), [WILDCARD]);
});

test("a type that inherits nothing needs no observed surface", () => {
  const type = parse(fm("tools: read\nextensions: false"))!;
  assert.deepEqual(ceilingFor(type), ["tool:read"], "nothing is inherited, so nothing is unknown");
});

test("disallowed_tools is still subtracted last", () => {
  const type = parse(fm("tools: read, write\ndisallowed_tools: write"))!;
  assert.deepEqual(ceilingFor(type, { extensionTools: [] }), ["tool:read"]);
});
