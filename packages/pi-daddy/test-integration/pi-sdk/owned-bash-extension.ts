import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerConfig, PROVIDER, toolStep, textStep } from "./scripted-provider.ts";
export default function (pi: ExtensionAPI) {
  let calls = 0;
  pi.registerProvider(
    PROVIDER,
    providerConfig(() => (calls++ === 0 ? toolStep("bash", { command: process.env.P07_BASH_COMMAND! }) : textStep())),
  );
}
