/**
 * Module-size guard, ADR-0076 PR 3a.
 *
 * `extensions/grants.ts` reached 866 lines and every wiring bug this package had lived in it, so a ceiling was
 * added in 2026-08. It counted newlines, and by 2026-09 eight files had been minified to fit under it — one
 * line in `measured-order.ts` was 1,815 characters. A guard that can be satisfied by deleting newlines
 * measures nothing, so this one counts **statements** (via the TypeScript AST) and caps **line length**:
 *
 * - at most MAX_STATEMENTS statements per shipped module. Measured when introduced: largest module 395
 *   statements (`products/dashboard-host.ts`), 24 modules over 400 lines after formatting, so the old line
 *   ceiling is gone and this one is deliberately tight — the next change to the largest file splits it;
 * - no line longer than MAX_LINE_CHARS anywhere. Prettier (`npm run format:check`, width 120) is the
 *   enforcement for code width; this absolute cap exists for what Prettier cannot break — long string
 *   literals, regexes, comment prose — and for minified code, which sat at 300 to 1,815 characters per line.
 *
 * Scope: `src/` and `extensions/` recursively, the code that ships; `scripts/` for the line cap only. `vendor/` directories are exempt (foreign
 * code, hash-pinned). Tests are exempt: a long test file is many small cases.
 *
 * Production change that breaks this test: a module growing past MAX_STATEMENTS statements, or any shipped
 * line over MAX_LINE_CHARS. Split the module, the way `extensions/grants.ts` was split into `session.ts`,
 * `approvals.ts`, `delegation.ts` and `grants-command.ts`.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const MAX_STATEMENTS = 400;
const MAX_LINE_CHARS = 200;
const packageRoot = join(import.meta.dirname, "..");

async function shippedModules(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(packageRoot, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "vendor") out.push(...(await shippedModules(relative)));
    } else if (entry.name.endsWith(".ts")) out.push(relative);
  }
  return out;
}

function countStatements(fileName: string, source: string): number {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isStatement(node) && !ts.isBlock(node)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

test("no shipped module exceeds the statement ceiling", async () => {
  const oversized: string[] = [];
  for (const dir of ["src", "extensions"]) {
    for (const relative of await shippedModules(dir)) {
      const statements = countStatements(relative, await readFile(join(packageRoot, relative), "utf8"));
      if (statements > MAX_STATEMENTS) oversized.push(`${relative} (${statements} statements)`);
    }
  }
  assert.deepEqual(oversized, [], `over ${MAX_STATEMENTS} statements: ${oversized.join(", ")} — split it`);
});

test("no shipped line exceeds the length cap", async () => {
  const long: string[] = [];
  for (const dir of ["src", "extensions", "scripts"]) {
    for (const relative of await shippedModules(dir)) {
      const lines = (await readFile(join(packageRoot, relative), "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (line.length > MAX_LINE_CHARS) long.push(`${relative}:${index + 1} (${line.length} chars)`);
      });
    }
  }
  assert.deepEqual(long, [], `lines over ${MAX_LINE_CHARS} characters (minified or unbroken): ${long.join(", ")}`);
});

test("the guard measures statements, not newlines", () => {
  // The change that makes this red: replacing countStatements with a newline count.
  const expanded = "const a = 1;\nconst b = 2;\nif (a) {\n  b;\n}\n";
  const minified = "const a = 1; const b = 2; if (a) { b; }";
  assert.equal(countStatements("x.ts", expanded), countStatements("x.ts", minified));
  assert.equal(countStatements("x.ts", minified), 4);
});
