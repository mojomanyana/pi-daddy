/** Authored partial product fixture; edits are executed only through the child's registered Pi write tool. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providerConfig, PROVIDER, textStep, toolStep } from "./scripted-provider.ts";

export const PRODUCT_FILES = {
  "workshop-desk/package.json": '{"name":"workshop-desk-fixture","private":true,"type":"module"}\n',
  "workshop-desk/server.mjs":
    'import { attendees } from "./store.mjs";\nexport const listAttendees = () => [...attendees.values()];\n',
  "workshop-desk/store.mjs":
    'export const attendees = new Map();\nexport const validName = (name) => typeof name === "string" && name.trim().length > 0;\n',
  "workshop-desk/README.md":
    "# Workshop Desk partial scaffold\n\nAttendee validation and in-memory storage only. Workshop CRUD, persistence and UI remain unfinished.\n",
};
export const PRODUCT_REPORT = [
  "Partial Workshop Desk backend scaffold delivered in four files.",
  "Delivered: attendee-name validation, in-memory attendee storage and a list helper.",
  "Unfinished: workshop CRUD, durable persistence and UI. Stage 1 is not complete.",
  "Checks: four registered write calls completed. No product tests or research were performed.",
  "Next: implement workshop CRUD and persistence, then run backend checks before any UI work.",
].join("\n");

export default function (pi: ExtensionAPI) {
  const files = Object.entries(PRODUCT_FILES);
  pi.registerProvider(
    PROVIDER,
    providerConfig((request) => {
      const results = request.context.messages.filter((message) => message.role === "toolResult");
      if (results.some((message) => message.isError || message.toolName !== "write") || results.length > files.length) {
        return { stopReason: "error", errorMessage: "Product fixture requires exactly four successful write calls." };
      }
      const file = files[results.length];
      return file
        ? toolStep("write", { path: file[0], content: file[1] }, `product-write-${results.length}`)
        : textStep(PRODUCT_REPORT);
    }),
  );
}
