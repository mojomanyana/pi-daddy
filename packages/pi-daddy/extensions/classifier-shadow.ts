import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { maySpawnDefinition } from "../src/kernel/delegate.ts";
import { userStateDir } from "../src/kernel/project-paths.ts";
import { readEcosystemConfig } from "../src/kernel/ecosystem-config.ts";
import { askClassifier } from "../src/products/decision-classifier.ts";
import { redactHarvestText } from "../src/products/session-harvest.ts";
import type { GrantsSession } from "./session.ts";

export const shadowLog = () => join(userStateDir(), "classifier-routing.jsonl");
type Row = { sessionId: string; toolCallId: string; kind: string };
function append(row: Row & Record<string, unknown>) {
  mkdirSync(userStateDir(), { recursive: true, mode: 0o700 });
  appendFileSync(shadowLog(), JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n", { mode: 0o600 });
}

export function registerClassifierShadow(pi: ExtensionAPI, session: GrantsSession, selected: () => string | undefined,
  report?: (detail: string, ctx: ExtensionContext) => void) {
  let prompt = "",
    toolObserved = false,
    delegateObserved = false;
  let prior: string[] = [];
  let lifetime = new AbortController();
  const pending = new Map<string, Row[]>();
  pi.on("before_agent_start", (ev) => {
    prompt = selected() && session.depth === 0 && "prompt" in ev ? redactHarvestText(ev.prompt).slice(0, 800) : "";
    toolObserved = false;
    delegateObserved = false;
    prior = [];
  });
  const observe = (
    ctx: ExtensionContext,
    base: Row,
    model: string,
    actual: string,
    candidates: Map<string, string>,
  ) => {
    if (candidates.size < 2 || !candidates.has(actual)) return;
    const entries = [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b));
    // Stable aliases keep punctuation and provider constraints out of choice labels.
    const criteria = Object.fromEntries(
      entries.map(([name, desc], i) => ["c" + i, name + " - " + redactHarvestText(desc).slice(0, 140)]),
    );
    criteria.abstain = "Insufficient evidence or no appropriate option.";
    const evidence = { request: prompt, previousTools: prior.slice(-6) };
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(12000)]);
    const records = pending.get(base.toolCallId) ?? [];
    records.push(base);
    pending.set(base.toolCallId, records);
    append({ ...base, event: "selection", actual, model, candidates: entries.map(([name]) => name) });
    const start = performance.now();
    const sessionSignal = lifetime.signal;
    void askClassifier(
      ctx.modelRegistry,
      model,
      evidence,
      {
        type: "choice",
        instructions: "Which available " + base.kind + " is most useful for the next step of this request?",
        criteria,
      },
      signal,
    )
      .then(({ value }) => {
        const match =
          typeof value === "string" && /^c(0|[1-9][0-9]*)$/.test(value) ? entries[Number(value.slice(1))] : undefined;
        if (!match && value !== "abstain") throw Error("Invalid route");
        append({
          ...base,
          event: "prediction",
          predicted: match?.[0] ?? null,
          elapsedMs: Math.round(performance.now() - start),
        });
        if (!sessionSignal.aborted && selected() === model) report?.(
          `Routing comparison · ${base.kind}: Pi chose ${actual}; classifier ${match ? "chose " + match[0] : "abstained"}`, ctx);
      })
      .catch(() => {
        try {
          append({ ...base, event: "prediction-unavailable" });
          if (!sessionSignal.aborted && selected() === model) report?.("Routing comparison · classifier unavailable. Choose a working classifier in /dashboard settings.", ctx);
        } catch {}
      });
  };
  pi.on("tool_execution_start", (ev, ctx) => {
    if (session.depth !== 0 || !selected() || !prompt) return;
    try {
      const model = readEcosystemConfig()?.harvest?.classifier;
      if (!model || model !== selected()) return;
      const base = { sessionId: ctx.sessionManager.getSessionId(), toolCallId: ev.toolCallId };
      if (!toolObserved) {
        toolObserved = true;
        const active = new Set(pi.getActiveTools());
        const choices = pi
          .getAllTools()
          .filter((t) => active.has(t.name))
          .map((t) => [t.name, t.description] as const);
        observe(ctx, { ...base, kind: "tool" }, model, ev.toolName, new Map(choices));
      }
      const agent = (ev.args as { agent?: string } | undefined)?.agent;
      if (!delegateObserved && ev.toolName === "delegate" && typeof agent === "string") {
        const choices = [...session.definitions.values()].filter(
          (d) => d.binding?.package === "principal-pi-skills" && maySpawnDefinition(session.ownGrant, d.name),
        );
        if (choices.some((d) => d.name === agent)) {
          delegateObserved = true;
          observe(
            ctx,
            { ...base, kind: "specialist" },
            model,
            agent,
            new Map(choices.map((d) => [d.name, d.description])),
          );
        }
      }
      prior = [...prior.slice(-5), ev.toolName];
    } catch {
      /* Observation never interrupts the real tool. */
    }
  });
  pi.on("tool_execution_end", (ev) => {
    const rows = pending.get(ev.toolCallId) ?? [];
    pending.delete(ev.toolCallId);
    for (const base of rows) {
      try {
        append({ ...base, event: "tool-ended", toolError: ev.isError });
      } catch {}
    }
  });
  pi.on("session_shutdown", () => {
    lifetime.abort();
    lifetime = new AbortController();
    pending.clear();
    prompt = "";
  });
}
