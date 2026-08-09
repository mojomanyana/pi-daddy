/**
 * pi-token-audit — where did your tokens and money actually go?
 *
 * Pi reports total input tokens and their cache split, and it reports which tool ran. It reports
 * nothing in between: there is no field anywhere for "how much of this request was tool
 * definitions". That number is what this extension measures.
 *
 * Method (stated because it is derived, not provider-reported):
 *   1. On `before_provider_request`, measure the serialized character length of the whole payload
 *      and of its `tools` array.
 *   2. On the next assistant `message_end`, read the provider's real prompt-token count.
 *   3. Divide to get an OBSERVED chars-per-token for this provider/model, then apply it to the
 *      tool-definition characters.
 *
 * So the ratio is measured per turn rather than assumed, and the spread across turns is reported as
 * the error bar. No tokenizer dependency, no second API call, no guessing.
 *
 * PRIVACY INVARIANT: this extension never retains message content, prompts, tool arguments, or tool
 * results. It measures lengths and immediately discards the serialized strings. Everything it keeps
 * is a number, a tool name, or a model id.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One request/response pair, counts only. */
interface TurnRecord {
  model: string;
  provider: string;
  /** serialized chars of the entire provider payload */
  payloadChars: number;
  /** serialized chars of the payload's tool-definition array */
  toolChars: number;
  /** number of tool definitions sent */
  toolCount: number;
  /** how many were marked deferred, where the provider supports it */
  deferredCount: number;
  promptTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
  /** promptTokens / payloadChars, measured — null when the pairing failed */
  charsPerToken: number | null;
  /** toolChars / charsPerToken, i.e. the number pi does not expose */
  estToolTokens: number | null;
}

const PENDING_LIMIT = 8;

export default function (pi: ExtensionAPI) {
  const turns: TurnRecord[] = [];
  /** Measurements awaiting the usage numbers from the matching response. */
  const pending: Array<Omit<TurnRecord, "promptTokens" | "outputTokens" | "cacheRead" | "cacheWrite" | "costTotal" | "charsPerToken" | "estToolTokens">> = [];

  const safeLen = (value: unknown): number => {
    if (value === undefined || value === null) return 0;
    try {
      return JSON.stringify(value)?.length ?? 0;
    } catch {
      return 0; // circular or unserializable — count it as unmeasured rather than throwing
    }
  };

  /** Providers name the tool array differently; check the known spellings. */
  const findTools = (payload: Record<string, unknown>): unknown[] => {
    for (const key of ["tools", "toolConfig", "functions"]) {
      const candidate = payload?.[key];
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  };

  const countDeferred = (tools: unknown[]): number =>
    tools.filter((t) => {
      const tool = t as Record<string, unknown> | null;
      return Boolean(tool && (tool.defer_loading === true || tool.deferLoading === true));
    }).length;

  pi.on("before_provider_request", (event, ctx) => {
    try {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const tools = findTools(payload);
      pending.push({
        model: String(payload.model ?? ctx.model?.id ?? "unknown"),
        provider: String((payload as { provider?: unknown }).provider ?? "unknown"),
        payloadChars: safeLen(payload),
        toolChars: safeLen(tools),
        toolCount: tools.length,
        deferredCount: countDeferred(tools),
      });
      // Bound the buffer: a request whose response never arrives must not leak memory.
      while (pending.length > PENDING_LIMIT) pending.shift();
    } catch {
      /* never throw into the agent loop */
    }
    return undefined; // inspect only — never replace the payload
  });

  pi.on("message_end", (event) => {
    try {
      const message = event?.message as { role?: string; usage?: Record<string, unknown> } | undefined;
      if (!message || message.role !== "assistant" || !message.usage) return undefined;
      const measured = pending.shift();
      if (!measured) return undefined;

      const usage = message.usage as {
        input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
        cost?: { total?: number };
      };
      const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      const charsPerToken = promptTokens > 0 ? measured.payloadChars / promptTokens : null;

      turns.push({
        ...measured,
        promptTokens,
        outputTokens: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        costTotal: usage.cost?.total ?? 0,
        charsPerToken,
        estToolTokens: charsPerToken ? measured.toolChars / charsPerToken : null,
      });
    } catch {
      /* never throw into the agent loop */
    }
    return undefined; // never rewrite the message
  });

  // Headless/scripted use: `PI_TOKEN_AUDIT_PRINT=1 pi -p "..."` emits the report to stderr on exit.
  // stderr rather than stdout so it never contaminates `--mode json` output.
  if (process.env.PI_TOKEN_AUDIT_PRINT) {
    pi.on("agent_end", () => {
      try {
        process.stderr.write(`\n${renderReport(turns)}\n`);
      } catch {
        /* never throw into the agent loop */
      }
      return undefined;
    });
  }

  pi.registerCommand("token-audit", {
    description: "Report where this session's tokens and money went, including the tool-definition share",
    handler: async (args, ctx) => {
      try {
        const text = args?.trim() === "json" ? renderJson(turns) : renderReport(turns);
        ctx.ui.notify(text, "info");
      } catch (error) {
        ctx.ui.notify(`token-audit failed: ${String(error)}`, "error");
      }
    },
  });
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function renderJson(turns: TurnRecord[]): string {
  return JSON.stringify({ turnCount: turns.length, turns }, null, 2);
}

function renderReport(turns: TurnRecord[]): string {
  if (!turns.length) {
    return "token-audit: no completed provider requests measured yet in this session.";
  }

  const sum = (pick: (t: TurnRecord) => number) => turns.reduce((acc, t) => acc + pick(t), 0);
  const promptTokens = sum((t) => t.promptTokens);
  const cacheRead = sum((t) => t.cacheRead);
  const cacheWrite = sum((t) => t.cacheWrite);
  const cost = sum((t) => t.costTotal);

  const paired = turns.filter((t) => t.estToolTokens !== null);
  const toolTokens = paired.reduce((acc, t) => acc + (t.estToolTokens ?? 0), 0);
  const ratios = turns.map((t) => t.charsPerToken).filter((r): r is number => r !== null);
  const medianRatio = median(ratios);
  const spread = ratios.length > 1
    ? `${Math.min(...ratios).toFixed(2)}–${Math.max(...ratios).toFixed(2)}`
    : "n/a";

  const lastTurn = turns[turns.length - 1];
  const share = promptTokens > 0 ? (100 * toolTokens) / promptTokens : 0;
  const cacheRatio = cacheWrite > 0 ? `${(cacheRead / cacheWrite).toFixed(0)} : 1` : "no cache writes seen";

  const lines = [
    `token-audit — ${turns.length} provider request(s), model ${lastTurn.model}`,
    ``,
    `  prompt tokens        ${promptTokens.toLocaleString()}`,
    `    served from cache   ${cacheRead.toLocaleString()} (${promptTokens ? ((100 * cacheRead) / promptTokens).toFixed(1) : "0"}%)`,
    `    cache writes        ${cacheWrite.toLocaleString()}   read:write = ${cacheRatio}`,
    `  output tokens        ${sum((t) => t.outputTokens).toLocaleString()}`,
    `  cost                 $${cost.toFixed(4)}`,
    ``,
    `  TOOL DEFINITIONS     ~${Math.round(toolTokens).toLocaleString()} tokens (~${share.toFixed(1)}% of prompt tokens)`,
    `    tools sent          ${lastTurn.toolCount}${lastTurn.deferredCount ? ` (${lastTurn.deferredCount} deferred)` : ""}`,
    `    definition chars    ${lastTurn.toolChars.toLocaleString()} in the last request`,
    ``,
    `  method: chars/token measured per turn from this provider's own counts.`,
    `    median ${medianRatio ? medianRatio.toFixed(2) : "n/a"} chars/token, observed range ${spread} across ${ratios.length} turn(s).`,
    `    Tool-token figures are derived, not provider-reported — treat the range as the error bar.`,
  ];

  if (share > 0 && share < 15) {
    lines.push(
      ``,
      `  Reading: definitions are a small share of this context, so they are cheap to keep and`,
      `  expensive to churn (they sit at the head of the cacheable prefix). Dynamic tool loading`,
      `  has little to win here — the context itself is the cost driver.`,
    );
  } else if (share >= 40) {
    lines.push(
      ``,
      `  Reading: definitions dominate this context. This is the regime where deferred/dynamic`,
      `  tool loading pays — check whether your provider supports native deferred loading.`,
    );
  }

  return lines.join("\n");
}
