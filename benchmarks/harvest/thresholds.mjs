import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function sweepThresholds(report, thresholds) {
  if (report.status !== "complete" || !report.rows?.length || report.rows.length !== report.cases) {
    throw Error("A complete OpenRouter report with per-case rows is required.");
  }
  const eligible = report.rows.filter((row) => row.eligible);
  const positives = report.rows.filter((row) => row.expected).length;
  const gateMisses = report.rows.filter((row) => row.expected && !row.eligible).length;
  if (!thresholds.length || thresholds.some((t) => !Number.isFinite(t) || t < 0 || t > 1)) {
    throw Error("Thresholds must be numbers from 0 to 1.");
  }

  const scores = [];
  for (const model of report.models) {
    for (const row of eligible) {
      const result = row[model];
      if (!result || !["ok", "invalid-response", "request-error"].includes(result.status)) {
        throw Error("Missing result for " + model + " on " + row.id);
      }
      const p = result.probability;
      if (result.status === "ok" && !(Number.isFinite(p) && p >= 0 && p <= 1)) {
        throw Error("Missing or invalid probability for " + model + " on " + row.id);
      }
    }
    for (const threshold of [...new Set(thresholds)].sort((a, b) => b - a)) {
      const saves = eligible.filter((row) => row[model].status === "ok" && row[model].probability >= threshold);
      const caught = saves.filter((row) => row.expected).length;
      scores.push({
        model, threshold, caught, missed: positives - caught, falseSaves: saves.length - caught,
        precision: saves.length ? caught / saves.length : null, recall: positives ? caught / positives : null,
      });
    }
  }
  return { positives, gateMisses, scores };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [path, ...values] = process.argv.slice(2);
    if (!path) throw Error("Use thresholds.mjs REPORT.json [THRESHOLD ...]");
    const report = JSON.parse(readFileSync(path, "utf8"));
    const thresholds = [...(report.thresholds ? Object.values(report.thresholds) : [report.threshold]), ...(values.length ? values.map(Number) : [0.65, 0.5, 0.35, 0.2, 0.1])];
    const { positives, gateMisses, scores } = sweepThresholds(report, thresholds);
    console.log(positives + " labeled regressions, including " + gateMisses + " missed before classification.");
    const percent = (x) => x === null ? "-" : (100 * x).toFixed(1) + "%";
    console.table(scores.map((s) => ({ ...s, precision: percent(s.precision), recall: percent(s.recall) })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
