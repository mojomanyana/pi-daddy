import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { adoptDashboardHarnessBridge } from "../src/products/dashboard-harness.ts";
import { learningHarness, bindLearningConnection, loadLearningConnection, learningScopeDigest, type LearningUI } from "../src/products/learning-connection.ts";
import { loadDeclaredWork } from "../src/products/work-command.ts";
import { privateDirectory } from "../src/products/product-files.ts";
import { workPolicyMenu } from "./work-policy-session.ts";
import { linkLatestWorkOutcome } from "./learning-outcome-session.ts";
import type { createDailyDashboardSession } from "./daily-dashboard-session.ts";

/** Normal human-only entrypoint: delegates canonical learning decisions to the loaded harness wizard. */
export function createLearningSession(host: ReturnType<typeof createDailyDashboardSession>) {
  let busy = false;
  return { async run(_verb: string, ctx: ExtensionCommandContext) {
    if (busy) throw Error("A learning dialog is already open");
    if (!ctx.hasUI) throw Error("Open /grants learning in interactive Pi");
    busy = true;
    try {
      const declared = await loadDeclaredWork(join(ctx.cwd, ".pi", "work-current.json"));
      if (!declared) throw Error("Declare work with /grants work first so learning has an exact scope");
      const bridge = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("skill-harness.dashboard-host.v1")];
      const h = learningHarness(adoptDashboardHarnessBridge(bridge));
      let connected: Awaited<ReturnType<typeof loadLearningConnection>> = null;
      try { connected = await loadLearningConnection(ctx.cwd, declared, h, "local-operator"); }
      catch (error) { ctx.ui.notify(String(error), "warning"); }
      const menu = ["Open cases, comparisons, trust and outcomes", "Create learning workspace for selected work", "Connect existing learning workspace", "Adoption / rollback for next orders", "Retain current work for learning", "Link observed result from latest adopted order"];
      const choice = await ctx.ui.select(connected ? "Learning — deliberate review (not earned automatic exposure)" : "Learning not connected", connected ? menu : menu.slice(1, 3));
      if (!choice) return;
      if ([menu[1], menu[2]].includes(choice)) {
        if (host.running && !await ctx.ui.confirm("Reconnect learning after stopping the current host?", "Old host evidence is preserved. No child is cancelled. Start /grants host again after configuration.")) return;
        if (host.running) await host.run("stop");
        let directory: string;
        if (choice === menu[1]) {
          if (!await ctx.ui.confirm("Enable scoped learning retention?", "Case/comparison/trust decisions and explicitly selected output artifacts will be retained privately. No model is called; no quality, calibration or authority is invented.")) return;
          const root = join(homedir(), ".local", "state", "pi-daddy", "learning"); await mkdir(root, { recursive: true, mode: 0o700 }); await privateDirectory(root);
          const instance = join(root, randomUUID()); await privateDirectory(instance);
          directory = join(instance, "workspace");
          h.createLearningWorkspace(directory, { archiveRoot: join(instance, "archive"), scopeDigest: learningScopeDigest(declared), population: `work:${learningScopeDigest(declared).slice(0, 32)}`, author: "local-operator" });
        } else { const path = await ctx.ui.input("Existing learning workspace directory"); if (!path) return; directory = path.trim(); }
        await bindLearningConnection(ctx.cwd, declared, directory, h, "local-operator");
        connected = await loadLearningConnection(ctx.cwd, declared, h, "local-operator");
        ctx.ui.notify("Learning connected to exact work scope. Start /grants host to show it in Herdr.", "info");
      }
      if (!connected) throw Error("Connect learning first");
      if (choice === menu[5]) { await linkLatestWorkOutcome(ctx, declared, connected.workspace, h); return; }
      if (choice === menu[3]) { await workPolicyMenu(ctx, declared, connected.workspace, h); return; }
      if (choice === menu[4]) {
        if (!host.running) throw Error("Start /grants host first; it captures and binds the current work case batch through the existing archive policy");
        await host.choose("refresh-current-work"); ctx.ui.notify("Current work retained. Open Learning for real case readiness; this is not a defect label.", "info"); return;
      }
      const ui: LearningUI = { select: (title, choices) => ctx.ui.select(title, choices), input: (title, initial) => ctx.ui.input(title, initial), editor: (title, text) => ctx.ui.editor(title, text), confirm: (title, detail) => ctx.ui.confirm(title, detail), notify: (text, level) => ctx.ui.notify(text, level ?? "info") };
      await h.runLearningWizard({ directory: connected.connection.directory, cwd: ctx.cwd, ui });
      if (host.running) ctx.ui.notify("Learning saved. If you changed trust configuration, stop/start /grants host explicitly to bind it; attention is not reset.", "info");
    } finally { busy = false; }
  } };
}
