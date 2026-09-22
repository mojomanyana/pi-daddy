import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { REFUSAL_CODES } from "../src/kernel/refusals.ts";
import { GOVERNANCE_ENV_KEYS, LEGACY_ENV_NAMES } from "../src/kernel/env-names.ts";

/**
 * The orientation documents must not lie, and this is the control that forces it.
 *
 * `README.md` and `AGENTS.md` are all a fresh session gets: the documentation tree behind them is gone. Every
 * earlier attempt to keep prose true by convention failed the same way — a path, a variable or a count kept its old
 * spelling after the code moved, and the next session trusted it. Three of those were live when this test was
 * written: `AGENTS.md` told a new session to set the legacy test-tier variable name, `README.md` named the ledger
 * file wrongly, and twenty-seven source comments cited specification and probe documents that no longer exist.
 *
 * What is checked is what has actually rotted: repository paths, environment variables, refusal codes, `/grants`
 * verbs and npm scripts. A commit SHA is allowed in the two places where it cannot go stale — a `git show
 * <sha>:<path>` pointer into deleted history, and a sentence attributing a measurement to the commit it was taken at,
 * which the hard rules require — and refused anywhere else, where it is a claim about "where we are" that is wrong by
 * the next merge.
 *
 * The roadmap section of `AGENTS.md` is exempt from the existence checks, and only from those: it describes work
 * that has not happened, so naming a future layer or variable there is the point rather than a defect. A path is
 * also exempt on a line that says it does not exist — the documents deliberately name the pre-commit hook and the
 * docs tree they removed, and a guard that forbade saying so would make the record less honest, not more.
 *
 * Production change that breaks this test: moving or deleting a file the documents name, renaming an environment
 * variable, a refusal code or a `/grants` verb, or removing an npm script, without editing the documents.
 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));

/** Where a path named in prose may live. A path is repo-relative or package-relative; both are resolved. */
const ROOTS = [repoRoot, packageRoot, join(packageRoot, "src")];
/** First segments that mean "a path in this repository" rather than one in a user's project or a bare filename. */
const REPO_SEGMENTS = new Set([
  // The five layers, because the documents write a source path relative to `src/` as often as from the root.
  // Leaving them out is how the first draft of this test passed while `governance/record.ts` was misspelled in it.
  "kernel",
  "governance",
  "executors",
  "advisors",
  "products",
  "src",
  "extensions",
  "test",
  "test-integration",
  "scripts",
  "contracts",
  "packages",
  "docs",
  "hooks",
  "herdr-plugin",
  ".github",
]);

/**
 * Sections whose subject is what is not there: the roadmap (not built yet) and the cleanup record (deliberately
 * deleted, and naming what went is the whole value of it). Existence checks skip them; every other check does not.
 */
const EXEMPT_SECTION = /^## (Roadmap|The big cleanup)/i;

function withoutExemptSections(text: string): string {
  const sections = text.split(/\n(?=## )/);
  return sections.filter((section) => !EXEMPT_SECTION.test(section)).join("\n");
}

async function documents(): Promise<Array<{ name: string; text: string; checked: string }>> {
  const load = async (name: string, root: string) => {
    const text = await readFile(join(root, name), "utf8");
    return { name, text, checked: withoutExemptSections(text) };
  };
  return [await load("README.md", repoRoot), await load("AGENTS.md", repoRoot), await load("README.md", packageRoot)];
}

/** A line that states the thing named on it does not exist; naming it is then the point. */
const ABSENCE = /not yet created|was removed|were removed|no longer|there is no|deleted|deletion of/i;

function lineContaining(text: string, token: string): string {
  const at = text.indexOf("`" + token + "`");
  if (at === -1) return "";
  return text.slice(text.lastIndexOf("\n", at) + 1, (text.indexOf("\n", at) + 1 || text.length) - 1);
}

/** Backticked tokens, which is how every path, variable and code is written in both documents. */
function ticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

test("every repository path the orientation documents name exists", async () => {
  const missing: string[] = [];
  for (const doc of await documents()) {
    const pointers = new Set([...doc.text.matchAll(/git show\s+[0-9a-f]{7,40}:([^\s`)]+)/g)].map((m) => m[1]));
    for (const token of ticked(doc.checked)) {
      const path = token.replace(/[.,;:]+$/, "");
      if (!path.includes("/") || path.includes(" ") || path.includes("*") || path.endsWith("/")) continue;
      if (path.includes("<")) continue; // a template such as `test/<kebab-case>.test.ts`, not a path
      if (pointers.has(path)) continue; // a deleted file reached through git history, deliberately named
      if (!REPO_SEGMENTS.has(path.split("/")[0])) continue; // a path in a user's project, not in this repository
      if (ROOTS.some((root) => existsSync(join(root, path)))) continue;
      if (ABSENCE.test(lineContaining(doc.checked, token))) continue; // the line says it is gone or not yet made
      missing.push(`${doc.name}: ${path}`);
    }
  }
  assert.deepEqual(missing, [], "the documents name repository paths that do not exist");
});

test("a commit SHA appears only as a pointer into git history, never as a claim about where we are", async () => {
  const stray: string[] = [];
  for (const doc of await documents()) {
    for (const match of doc.text.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
      const before = doc.text.slice(Math.max(0, match.index - 90), match.index);
      const pointer = /git show\s+`?$/.test(before);
      const attribution = /measured[^.]*\bat\s+`?$/i.test(before);
      if (!pointer && !attribution) stray.push(`${doc.name}: ${match[0]}`);
    }
  }
  assert.deepEqual(stray, [], "a bare SHA is wrong by the next merge; write `git show <sha>:<path>` or nothing");
});

test("every environment variable the documents name is a current one, and no legacy name is instructed", async () => {
  // The test-tier switches are not governance keys and are declared nowhere else; they are named here instead.
  const current = new Set([
    ...GOVERNANCE_ENV_KEYS,
    "PI_DADDY_IT_MODEL",
    "PI_DADDY_KEEP_TMP",
    "PI_DADDY_IT_JEV",
    // The handoff probe's corpus. A test-tier switch like the others: it governs no behaviour and is read
    // only by `test-integration/pruned-handoff-probe.it.ts`.
    "PI_DADDY_PROBE_SESSIONS",
  ]);
  const unknown: string[] = [];
  const legacy: string[] = [];
  for (const doc of await documents()) {
    for (const match of doc.checked.matchAll(/\bPI_(?:DADDY|GRANTS)_[A-Z_]+\b/g)) {
      const name = match[0];
      if (Object.hasOwn(LEGACY_ENV_NAMES, name)) legacy.push(`${doc.name}: ${name}`);
      else if (!current.has(name)) unknown.push(`${doc.name}: ${name}`);
    }
  }
  assert.deepEqual(legacy, [], "the documents instruct a retired variable name");
  assert.deepEqual(unknown, [], "the documents name a variable the package does not define");
});

/**
 * Backticked SHOUTING_CASE the documents use that is NOT a refusal code.
 *
 * The check below is a heuristic — anything in backticks shaped like a refusal code must be one — and that is
 * the right trade, because a made-up code is exactly the drift it catches. It has one cost: a document may
 * legitimately name a system constant in the same shape. Each entry here is written down rather than the
 * pattern being loosened, so adding one is a visible decision and an invented refusal code still fails.
 */
const NOT_REFUSAL_CODES = new Set([
  "REFUSAL_CODES",
  // POSIX open(2) flag. Named in the bounded-reader entry because it is the specific thing that keeps a FIFO
  // from wedging session start, and no vaguer wording would let a reader check the claim.
  "O_NONBLOCK",
  // An exported constant the probe record has to name, because "the default turn count" would leave a reader
  // unable to find it. Same shape as the flag above: a real identifier, not an invented refusal.
  "DEFAULT_CONTEXT_TURNS",
  // The handoff rank bands. Named in the probe record because "what outranks what" is the decision a reader
  // has to be able to find, and a vaguer phrase would not lead them to it.
  "CONTEXT_RANK",
]);

test("every refusal code the documents name exists", async () => {
  const codes = new Set<string>(REFUSAL_CODES);
  const unknown: string[] = [];
  for (const doc of await documents())
    for (const token of ticked(doc.checked))
      if (
        /^[A-Z][A-Z_]{5,}$/.test(token) &&
        !token.startsWith("PI_") &&
        !codes.has(token) &&
        !NOT_REFUSAL_CODES.has(token)
      )
        unknown.push(`${doc.name}: ${token}`);
  assert.deepEqual(unknown, [], "the documents name a refusal code the package does not throw");
});

// Separate from the refusal codes on purpose: two `assert.deepEqual`s in one test mean the first failure hides the
// second, which is how the draft of this file reported a renamed code while staying silent about a deleted verb.
test("every `/grants` verb the documents name exists", async () => {
  const command = await readFile(join(packageRoot, "extensions", "grants-command.ts"), "utf8");
  const verbs = new Set(
    (command.match(/const KNOWN_SUBCOMMANDS: readonly string\[\] = \[([^\]]*)\]/)?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/"/g, ""))
      .filter(Boolean),
  );
  assert.ok(verbs.size > 0, "the verb list could not be read; this test would pass vacuously");
  const unknown: string[] = [];
  for (const doc of await documents())
    for (const token of ticked(doc.checked)) {
      const verb = /^\/grants\s+([a-z-]+)/.exec(token)?.[1];
      if (verb && !verbs.has(verb)) unknown.push(`${doc.name}: /grants ${verb}`);
    }
  assert.deepEqual(unknown, [], "the documents name a `/grants` verb the command does not answer to");
});

test("every npm script the documents tell a reader to run exists", async () => {
  // Both manifests: `format` and `format:check` live at the workspace root, everything else in the package.
  const scripts = new Set<string>();
  for (const root of [packageRoot, repoRoot]) {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    for (const name of Object.keys(manifest.scripts ?? {})) scripts.add(name);
  }
  const missing: string[] = [];
  for (const doc of await documents())
    for (const match of doc.checked.matchAll(/npm run ([a-z:]+)/g))
      if (!scripts.has(match[1])) missing.push(`${doc.name}: npm run ${match[1]}`);
  assert.deepEqual(missing, [], "the documents name an npm script that does not exist");
});

test("no source comment cites a file that was deleted with the docs tree", async () => {
  // The sweep that came with this test rewrote twenty-seven files; without the guard they come back one at a time.
  const { readdir } = await import("node:fs/promises");
  const offenders: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== "fixtures") await walk(path);
      } else if (/\.(ts|mjs)$/.test(entry.name) && entry.name !== "docs-drift.test.ts") {
        const text = await readFile(path, "utf8");
        for (const match of text.matchAll(/\bdocs\/[A-Za-z0-9/_.-]+/g))
          offenders.push(`${path.slice(packageRoot.length + 1)}: ${match[0]}`);
      }
    }
  };
  for (const directory of ["src", "extensions", "test", "test-integration", "scripts"])
    await walk(join(packageRoot, directory));
  assert.deepEqual(offenders, [], "a comment points at the deleted docs tree; name the probe or AGENTS.md instead");
});
