import { writeFileSync } from "node:fs";
import { cases, corpusHash, inspect, modelLabels, pairedRun, summarize } from "./benchmark.mjs";
import { hasHarvestSignal } from "../../packages/pi-daddy/src/products/session-harvest.ts";

export default function (pi) {
  const path = process.env.PI_HARVEST_BENCH_REPORT;
  const mode = process.env.PI_HARVEST_BENCH_MODE;
  if (!path || !["check", "live"].includes(mode)) return;
  pi.on("session_start", async (_event, ctx) => {
    const report = {
      corpusSha256: corpusHash,
      cases: cases.length,
      eligible: cases.filter((c) => hasHarvestSignal(c.signals)).length,
      threshold: 0.75,
      mode,
      status: "starting",
      rows: [],
    };
    const persist = () => writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
    try {
      const models = await inspect(ctx.modelRegistry, ctx.model);
      report.models = modelLabels(models);
      report.blockers = models.blockers;
      if (models.blockers.length) report.status = "blocked";
      else if (report.mode === "check") report.status = "ready";
      else {
        report.status = "running";
        persist();
        await pairedRun(ctx.modelRegistry, models, (row) => {
          report.rows.push(row);
          persist();
        });
        report.status = "complete";
      }
    } catch {
      report.status = "error";
    } finally {
      if (report.rows.length) report.summary = summarize(report.rows);
      persist();
      ctx.shutdown();
    }
  });
}
