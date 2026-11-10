/** Native Pi dialog observations; no authority, input values, transcript parsing or stored history. */
import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DashboardInputPrompt } from "../src/kernel/dashboard-observation.ts";
import type { DashboardSourceOwner } from "./dashboard-sources.ts";

interface PromptEvent {
  reason?: string;
  kind?: string;
  title?: string;
}
type Handler = (event: PromptEvent, ctx: ExtensionContext) => void;
/** Newer Pi emits these public hooks; old Pi accepts registrations but never emits them. */
type PromptHooks = { on(name: "ui_prompt_start" | "ui_prompt_end", handler: Handler): (() => void) | void };
const sameFolder = (cwd: string, canonical: string) => {
  if (cwd === canonical) return true;
  try {
    return realpathSync(cwd) === canonical;
  } catch {
    return false;
  }
};
const kinds = new Set(["select", "confirm", "input", "editor"]);
const clean = (value: string) =>
  value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

export function registerDashboardPrompts(pi: ExtensionAPI, current: () => DashboardSourceOwner | undefined) {
  let owner: DashboardSourceOwner | undefined, prompt: DashboardInputPrompt | undefined;
  let closed = false,
    bridged = false,
    ordinal = 0;
  const publish = (active: boolean, label?: string) => {
    try {
      pi.events?.emit?.("herdr:blocked", { active, ...(label ? { label } : {}) });
    } catch {
      /* Display failure cannot change a dialog or its permission result. */
    }
  };
  const clear = () => {
    prompt = undefined;
    if (bridged) publish(false);
    bridged = false;
  };
  const valid = (ctx?: ExtensionContext) => {
    const next = closed ? undefined : current();
    if (next !== owner) {
      clear();
      owner = next;
    }
    return (
      !!owner &&
      (!ctx ||
        (ctx.hasUI &&
          ctx.mode === "tui" &&
          ctx.sessionManager.getSessionId() === owner.sessionId &&
          sameFolder(ctx.cwd, owner.cwd)))
    );
  };
  const start: Handler = (event, ctx) => {
    if (!valid(ctx) || event.reason !== "ui_prompt" || !kinds.has(event.kind ?? "")) return;
    const kind = event.kind as DashboardInputPrompt["kind"];
    const label = clean(typeof event.title === "string" ? event.title : "") || "Pi is waiting for your answer";
    // Pi reports the outermost native dialog once. Defensive duplicate observations must not
    // increment Herdr's blocked counter and leave the pane stuck after one corresponding end.
    if (prompt?.kind === kind && prompt.label === label) return;
    clear();
    prompt = { id: `input:${++ordinal}`, kind, label };
    bridged = true;
    publish(true, label);
  };
  const end: Handler = (event, ctx) => {
    if (!valid(ctx) || event.reason !== "ui_prompt" || !prompt || event.kind !== prompt.kind) return;
    const label = clean(typeof event.title === "string" ? event.title : "") || "Pi is waiting for your answer";
    if (prompt.label === label) clear();
  };
  const hooks = pi as unknown as PromptHooks;
  const offStart = hooks.on?.("ui_prompt_start", start);
  const offEnd = hooks.on?.("ui_prompt_end", end);
  const offShutdown = pi.on?.("session_shutdown", (_event, ctx) => {
    if (valid(ctx)) clear();
  });
  return {
    snapshot() {
      valid();
      return prompt ? { ...prompt } : undefined;
    },
    reset: clear,
    close() {
      clear();
      closed = true;
      offStart?.();
      offEnd?.();
      if (typeof offShutdown === "function") offShutdown();
    },
  };
}
