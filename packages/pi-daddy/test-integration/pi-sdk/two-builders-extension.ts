/** Local scripted child: all candidate edits/tests/commits happen through Pi's actual Bash tool. */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerConfig, PROVIDER, toolStep, textStep } from "./scripted-provider.ts";
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export default function (pi: ExtensionAPI) {
  let called = false;
  const jobPath = join(process.env.P14_JOBS!, basename(process.cwd()) + ".json");
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  pi.on("session_start", () => {
    appendFileSync(
      process.env.P14_LAUNCHES!,
      JSON.stringify({ workspace: basename(process.cwd()), job: job.id }) + "\n",
    );
  });
  pi.registerProvider(
    PROVIDER,
    providerConfig((request) => {
      if (!called) {
        called = true;
        return toolStep(
          "bash",
          { command: `${quote(process.execPath)} ${quote(process.env.P14_RUNNER!)} ${quote(jobPath)}` },
          "build-tool",
        );
      }
      if (request.context.messages.some((message) => message.role === "toolResult" && message.isError)) {
        writeFileSync(
          job.result + "-tool-error.json",
          JSON.stringify(request.context.messages.filter((message) => message.role === "toolResult")),
        );
        return { stopReason: "error", errorMessage: "intentional pilot build failure", content: [] };
      }
      return textStep(JSON.parse(readFileSync(job.result, "utf8")).final);
    }),
  );
}
