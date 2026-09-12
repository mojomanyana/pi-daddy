/** Locate the pinned, lifecycle-only Herdr Pi integration shipped with this package. */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Explicit `-e` survives Pi's `--no-extensions`; only this audited source is loaded for a Herdr child.
 *
 * Source-loaded tests resolve the adjacent vendor file. Installed builds resolve the packed `src/` copy,
 * deliberately rather than discovering an operator's extension directory.
 */
export function bundledHerdrPiLifecycleExtension(): string {
  const candidates = [
    new URL("./vendor/herdr-pi-lifecycle.ts", import.meta.url),
    new URL("../src/vendor/herdr-pi-lifecycle.ts", import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  throw new Error("the bundled Herdr Pi lifecycle integration is missing from this package");
}
