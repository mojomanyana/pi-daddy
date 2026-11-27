// Loaded only by the explicitly requested live smoke run. Use the dashboard's synthetic turn.
import { readEcosystemConfig } from "../../packages/pi-daddy/src/kernel/ecosystem-config.ts";
import { createClassifierSettings } from "../../packages/pi-daddy/extensions/classifier-settings.ts";

export default function liveClassifierCheck(pi) {
  let checked = false;
  pi.on("before_agent_start", async (_event, ctx) => {
    const isRoot = () => (process.env.PI_DADDY_DEPTH ?? "0") === "0";
    if (checked || !isRoot()) return;
    checked = true;
    const settings = createClassifierSettings(() => ctx, isRoot);
    try {
      if (!readEcosystemConfig()?.harvest?.classifier) {
        ctx.ui.notify("Classifier check skipped. Select a decision model in /dashboard settings to test it.", "info");
        return;
      }
      const catalog = await settings.action({action:"list"});
      const model = catalog.selected;
      if (!model || !catalog.models.includes(model)) {
        ctx.ui.notify("Classifier check needs a connected model. Choose one in /dashboard settings.", "warning");
        return;
      }
      const result = await settings.action({action:"test",model,threshold:catalog.thresholds[model]});
      ctx.ui.notify("Classifier synthetic turn · " + model + " · score " + result.probability +
        " · " + (result.save ? "save" : "skip") + " · " + result.latencyMs + " ms", "info");
    } catch {
      ctx.ui.notify("Classifier check could not finish. Open /dashboard settings to connect or test a replacement.", "warning");
    }
  });
}
