import { mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dailyFixture, dailyAuthority } from "../test/daily-view-fixture.ts";
import { readDailyView } from "../src/daily-view.ts";
import { renderDailyView } from "../src/daily-view-render.ts";

/** Explicit owned scratch location; no model/transport or production authority factory. */
export async function buildDailyFixture(scratchParent: string): Promise<Record<string, string>> {
  const scratch = await mkdtemp(join(scratchParent, "daily-fixture-"));
  const work = dailyFixture().text;
  const archive = await readFile(new URL("../contracts/daily-view/v1/p03/fixtures/retained-executions.json", import.meta.url), "utf8");
  await writeFile(join(scratch, "work.jsonl"), work); await writeFile(join(scratch, "archive.json"), archive);
  const view = await readDailyView({ workLedgerPath: join(scratch, "work.jsonl"), archiveProjectionPath: join(scratch, "archive.json"), workContext: dailyAuthority() });
  return { "work.jsonl": work, "view.json": JSON.stringify(view, null, 2) + "\n", "view.txt": renderDailyView(view, 120) + "\n" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, target, scratch] = process.argv.slice(2);
  if (!["--write", "--check"].includes(mode) || !target || !scratch || process.argv.length !== 5) throw new Error("use --write|--check EXPLICIT_TARGET EXPLICIT_SCRATCH_PARENT");
  const files = await buildDailyFixture(resolve(scratch));
  if (mode === "--write") await mkdir(resolve(target));
  for (const [name, text] of Object.entries(files)) {
    if (mode === "--write") await writeFile(join(resolve(target), name), text, { flag: "wx" });
    else if (await readFile(join(resolve(target), name), "utf8") !== text) throw new Error(`daily fixture mismatch: ${name}`);
  }
}
