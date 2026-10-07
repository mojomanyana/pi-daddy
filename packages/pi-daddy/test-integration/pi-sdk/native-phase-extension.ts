/** Scripted child checks the actual provider context and invocation, with no network. */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerConfig, PROVIDER, textStep } from "./scripted-provider.ts";
export default function (pi: ExtensionAPI) {
  pi.registerProvider(
    PROVIDER,
    providerConfig((request) => {
      const argv = process.argv;
      const body = argv[argv.indexOf("--append-system-prompt") + 1];
      const strings: string[] = [];
      const collect = (value: unknown): void => {
        if (typeof value === "string") strings.push(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      collect(request.context);
      return textStep(
        JSON.stringify({
          bodySha256: createHash("sha256").update(body).digest("hex"),
          bodyObserved: strings.some((s) => s.includes(body)),
          model: `${request.model.provider}/${request.model.id}`,
          thinking: request.options?.reasoning,
          tools: argv[argv.indexOf("--tools") + 1],
          noExtensions: argv.includes("--no-extensions"),
          noSkills: argv.includes("--no-skills"),
        }),
      );
    }),
  );
}
