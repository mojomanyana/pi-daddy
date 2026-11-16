/** Reproducible, no-model screen fixtures. Rendered observations are synthetic, not a live acceptance run. */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dashboardAcceptanceFixture } from "../test/dashboard-acceptance-fixture.ts";
import { renderDashboardScreen } from "../src/products/dashboard-screen.ts";

const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/preview-dashboard.ts OUTPUT_DIRECTORY");
await mkdir(output, { recursive: true });
for (const [name, width, height] of [
  ["narrow", 64, 40],
  ["wide", 150, 40],
] as const) {
  const { options, display } = dashboardAcceptanceFixture(width, height);
  const save = async (state: string) => {
    const file = join(output, `${name}-${state}.txt`);
    await writeFile(file, renderDashboardScreen(options) + "\n");
    console.log(resolve(file));
  };
  await save("running");
  options.session!.pendingApprovals.push({ id: "permission", subject: "review", capability: "tool:bash" });
  await save("permission");
  options.session!.pendingApprovals = [];
  for (const [key, state] of [
    ["component:bookie", "memory"],
    ["component:scout-worker", "research"],
  ]) {
    options.screen.selectedKey = key;
    renderDashboardScreen(options);
    display.key("return");
    await save(state!);
    display.key("escape");
  }
  options.session!.observation!.sessionId = "after-new";
  delete options.session!.observation!.turn;
  await save("after-new");
}
