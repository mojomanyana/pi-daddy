/** Install FIRST: native Pi remains observable, but only its parent can control work. */
import { writeSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const OWNED_PI_VIEW_READY = "pi-daddy:owned-pi-view-ready";
export function failOwnedPiUi(error: unknown): never {
  try {
    writeSync(2, "pi-daddy: owned Pi UI refused: " + String(error) + "\n");
  } finally {
    process.exit(70);
  }
}

export default function ownedPiView(pi: ExtensionAPI): void {
  try {
    if (typeof pi.registerMarkdownTransformer !== "function") throw Error("Pi lacks its public markdown renderer hook");
    pi.registerMarkdownTransformer((markdown, context) =>
      context.messageType === "assistant-thinking" ? "Thinking hidden" : markdown,
    );
    let guarded = false;
    // No await here: the first session handler installs the guard before another handler can yield.
    pi.on("session_start", (_event, ctx) => {
      try {
        if (guarded) throw Error("the owned session cannot be replaced");
        if (
          ctx.mode !== "tui" ||
          typeof ctx.ui.onTerminalInput !== "function" ||
          typeof ctx.ui.getToolsExpanded !== "function" ||
          typeof ctx.ui.setToolsExpanded !== "function"
        )
          throw Error("Pi lacks the required native TUI controls");
        const unsubscribe = ctx.ui.onTerminalInput((data) => {
          // The renderer consumes this exact terminal response before dispatching any user action.
          if (/^\x1b\[6;\d+;\d+t$/.test(data)) return;
          try {
            if (["\x0f", "\x1b[111;5u", "\x1b[111;5:1u", "\x1b[111;5:2u", "\x1b[27;5;111~"].includes(data))
              ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded());
          } catch (error) {
            failOwnedPiUi(error);
          }
          return { consume: true };
        });
        if (typeof unsubscribe !== "function") throw Error("Pi did not install the terminal input guard");
        ctx.ui.setEditorText("");
        ctx.ui.setStatus("pi-daddy-owned", "View only · parent controls the task · Ctrl+O expands tools");
        guarded = true;
        pi.events.emit(OWNED_PI_VIEW_READY, {
          sessionManager: ctx.sessionManager,
          sessionId: ctx.sessionManager.getSessionId(),
        });
      } catch (error) {
        failOwnedPiUi(error);
      }
    });
  } catch (error) {
    failOwnedPiUi(error);
  }
}
