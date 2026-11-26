import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseModelSpec } from "../kernel/ecosystem-config.ts";
import { supportedModelEfforts } from "../kernel/model-preflight.ts";
import type { ProviderCatalog } from "./provider-detect.ts";

/** Explicitly loaded by setup/doctor's isolated offline Pi process. Output contains only model and status metadata. */
export default function providerCatalogProbe(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const specs: string[] = JSON.parse(process.env.PI_DADDY_CATALOG_REQUEST ?? "[]");
    const registry = ctx.modelRegistry;
    const catalog: ProviderCatalog = { providers: Object.create(null), models: Object.create(null) };
    const chat = registry.getAvailable();
    const available = new Set(chat.map((m) => m.provider + "/" + m.id));
    const providers = new Set(chat.map((m) => m.provider));
    for (const spec of specs) {
      const parsed = parseModelSpec(spec);
      if (!parsed) continue;
      const { provider, modelId } = parsed;
      const status = registry.getProviderAuthStatus(provider);
      catalog.providers[provider] = { configured: status.configured && providers.has(provider), source: status.source };
      const model = registry.find(provider, modelId);
      if (status.configured && model && available.has(provider + "/" + modelId)) {
        catalog.models[spec] = supportedModelEfforts(model);
      }
    }
    process.stdout.write("PI_DADDY_CATALOG " + JSON.stringify(catalog) + "\n");
    ctx.shutdown();
  });
}
