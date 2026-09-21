/**
 * ADR-0076: five source layers with a mechanically enforced import direction.
 *
 * `src/` is split into `kernel/`, `governance/`, `executors/`, `advisors/` and `products/`. A file may import
 * only from its own layer or a layer below it; `executors/` and `advisors/` are siblings that may not import
 * each other. `extensions/` and the two root files `src/index.ts` and `src/cli.ts` are the composition layer
 * and may import anything. Every other `src/` file must live inside a layer directory, so a new file at the
 * root is refused rather than silently treated as composition.
 *
 * Covered shapes: static and type-only `import … from`, `export … from`, `import("./x.ts")`,
 * `createRequire(import.meta.url)("../x")`, `new URL("../x", import.meta.url)`, and the package's own bare
 * specifiers (`pi-daddy/<subpath>`), which a layered file may never use because they resolve through the export
 * map to an arbitrary layer. A template-literal dynamic import in a layered file is refused outright, since its
 * target cannot be read statically. Not covered: paths assembled at runtime from non-literal parts.
 *
 * The production change that breaks this test: any covered import shape pointing upward, a bare self-import
 * or template import in a layered file, or a file added to `src/` outside a layer directory. Exemptions are
 * deliberately not supported here — ADR-0076's revisit trigger names "an exemption to the import-direction
 * test rather than a hook" as the event that reopens the decision.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const LAYER_RANK: Record<string, number> = { kernel: 0, governance: 1, executors: 2, advisors: 2, products: 3 };
const COMPOSITION_ROOT_FILES = new Set(["index.ts", "cli.ts"]);
const IMPORT = /(?:from|import|require\(import\.meta\.url\)|new URL)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;
const SELF_IMPORT = /(?:from|import)\s*\(?\s*["']pi-daddy(?:\/|["'])/;
const TEMPLATE_IMPORT = /import\s*\(\s*`/;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** `kernel` … `products` for a layered file, `composition` for extensions and the two root files, else null. */
function layerOf(relPath: string): string | null {
  const parts = normalize(relPath).split(sep);
  if (parts[0] === "extensions") return "composition";
  if (parts[0] !== "src") return null;
  if (parts.length === 2) return COMPOSITION_ROOT_FILES.has(parts[1]) ? "composition" : null;
  return parts[1] in LAYER_RANK ? parts[1] : null;
}

function mayImport(from: string, to: string): boolean {
  if (from === "composition") return true;
  if (to === "composition") return false;
  if (from === to) return true;
  // Siblings at the same rank (executors, advisors) may not import each other.
  return LAYER_RANK[to] < LAYER_RANK[from];
}

test("every src file lives in a layer directory, except the two composition roots", async () => {
  const files = await walk(join(packageRoot, "src"));
  const stray = files.map(f => relative(packageRoot, f)).filter(f => layerOf(f) === null);
  assert.deepEqual(stray, [], `src files outside kernel/, governance/, executors/, advisors/, products/: ${stray.join(", ")}`);
});

test("no import points upward across layers", async () => {
  const files = [...await walk(join(packageRoot, "src")), ...await walk(join(packageRoot, "extensions"))];
  const upward: string[] = [];
  for (const file of files) {
    const fromRel = relative(packageRoot, file);
    const fromLayer = layerOf(fromRel);
    if (fromLayer === null) continue; // reported by the other test
    const source = await readFile(file, "utf8");
    if (fromLayer !== "composition") {
      if (SELF_IMPORT.test(source)) upward.push(`${fromRel} [${fromLayer}] -> pi-daddy/* (bare self-import resolves through the export map)`);
      if (TEMPLATE_IMPORT.test(source)) upward.push(`${fromRel} [${fromLayer}] -> import(\`…\`) (template import cannot be checked)`);
    }
    for (const match of source.matchAll(IMPORT)) {
      const target = relative(packageRoot, normalize(join(dirname(file), match[1])));
      const toLayer = layerOf(target);
      if (toLayer === null) continue; // contracts, package.json, vendored non-ts assets
      if (!mayImport(fromLayer, toLayer)) upward.push(`${fromRel} [${fromLayer}] -> ${target} [${toLayer}]`);
    }
  }
  assert.deepEqual(upward, [], `upward imports (replace with a hook, never an exemption):\n  ${upward.join("\n  ")}`);
});
