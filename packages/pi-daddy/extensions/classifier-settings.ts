import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readEcosystemConfig, saveEcosystemConfig, type EcosystemHarvestConfig } from "../src/kernel/ecosystem-config.ts";
import { classifierCatalog, harvestProbability, thresholdFor } from "../src/products/decision-classifier.ts";
import { harvestClassifierDigest } from "../src/products/session-harvest.ts";

export function createClassifierSettings(getContext: () => ExtensionContext | undefined, isRoot: () => boolean) {
  let catalog = new Set<string>();
  let shadowModel: string | undefined;
  return {
    shadowModel: () => shadowModel,
    reset() {
      shadowModel = undefined;
      catalog = new Set();
    },
    async action(input: Record<string, unknown>) {
      const ctx = getContext();
      if (!isRoot() || !ctx) throw Error("Classifier settings require the root session.");
      const config = readEcosystemConfig() ?? {};
      const harvest = config.harvest ?? {};
      if (input.action === "list") {
        const result = await classifierCatalog(ctx.modelRegistry);
        catalog = new Set(result.models);
        const ids = [...catalog];
        if (harvest.classifier && !catalog.has(harvest.classifier)) ids.push(harvest.classifier);
        return {
          ...result,
          selected: harvest.classifier ?? "",
          currentMode: harvest.mode ?? "auto",
          shadow: Boolean(shadowModel && shadowModel === harvest.classifier),
          thresholds: Object.fromEntries(ids.map((id) => [id, thresholdFor(harvest, id)])),
          legacyThreshold: harvest.minConfidence ?? 0.75,
        };
      }
      const model = input.model;
      if (typeof model !== "string" || (model && !catalog.has(model) && !(input.action === "save" && input.mode === "off" && model === harvest.classifier)))
        throw Error("Refresh the catalog and select an available classifier.");
      const threshold = input.threshold;
      if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)
        throw Error("Threshold must be a number from 0 to 1.");
      if (input.action === "test") {
        if (!model) throw Error("Choose a decision classifier to test.");
        const digest = harvestClassifierDigest({
          prompt: "Verify the installed package.",
          failureSummary: "The source checkout passed but the installed command has no entry point.",
          editedFiles: ["package.json"],
          verifyCommands: ["test installed-package"],
          thrashDetected: false,
          escalated: false,
          reviewBlockers: 1,
          userSteered: false,
          toolFailedAndEdited: false,
        });
        const start = performance.now();
        const answer = await harvestProbability(ctx.modelRegistry, model, digest, AbortSignal.timeout(15000));
        return { ...answer, save: answer.probability >= threshold, latencyMs: Math.round(performance.now() - start) };
      }
      const mode = input.mode;
      if (
        input.action !== "save" ||
        (mode !== "auto" && mode !== "suggest" && mode !== "off") ||
        typeof input.shadow !== "boolean"
      )
        throw Error("Invalid classifier settings.");
      if (input.shadow && !model) throw Error("Select a decision classifier for routing comparisons.");
      const next: EcosystemHarvestConfig = { ...harvest, mode };
      if (model) {
        next.classifier = model;
        next.thresholds = { ...harvest.thresholds, [model]: threshold };
      } else {
        delete next.classifier;
        next.minConfidence = threshold;
      }
      saveEcosystemConfig({ ...config, harvest: next });
      shadowModel = input.shadow ? model : undefined;
      return { saved: true };
    },
  };
}
