/**
 * Full 5-Tab Interactive Terminal Side-Panel Dashboard Client (Layer 3: products).
 *
 * Tabs: [1] Overview  [2] Tasks  [3] Memory  [4] Research  [5] Settings
 * Works in ANY terminal (iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal, tmux, VS Code)
 * on macOS, Linux, and Windows — zero Herdr required. Supports zero-copy-paste auto-attach
 * when run as bare `pi-daddy panel` inside the active workspace.
 */
import { createInterface } from "node:readline";
import { readPanelLocator } from "../kernel/ecosystem-config.ts";
import type { WebDashboardState } from "./web-dashboard.ts";

export type PanelTab = 1 | 2 | 3 | 4 | 5;

const TAB_NAMES: Record<PanelTab, string> = {
  1: "Overview",
  2: "Tasks",
  3: "Memory",
  4: "Research",
  5: "Settings",
};

const WORK_MODE_CYCLE: Array<{ mode: "standard" | "ambitious"; emphases: string[] }> = [
  { mode: "standard", emphases: [] },
  { mode: "ambitious", emphases: [] },
  { mode: "ambitious", emphases: ["depth"] },
  { mode: "ambitious", emphases: ["range"] },
  { mode: "ambitious", emphases: ["altitude"] },
  { mode: "ambitious", emphases: ["speed"] },
];
const THINKING_CYCLE = ["off", "low", "medium", "high"] as const;

export function renderTerminalPanel(state: WebDashboardState, notice = "", width = 76, tab: PanelTab = 1): string {
  const hr = "─".repeat(Math.max(40, Math.min(width, 100)));
  const sel = state.workMode?.selection;
  const modeLabel =
    !sel || sel.mode === "standard"
      ? "Standard"
      : `Ambitious (${sel.emphases.length ? sel.emphases.join("+") : "balanced"})`;
  const u = state.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheHitPct: 0,
    costUsd: 0,
    turns: 0,
  };
  const totalK = ((u.inputTokens + u.outputTokens + u.cacheReadTokens) / 1000).toFixed(1);
  const tabBar = ([1, 2, 3, 4, 5] as const)
    .map((n) => (n === tab ? `[${n}:${TAB_NAMES[n]}*]` : ` ${n}:${TAB_NAMES[n]} `))
    .join(" ");

  const lines = [
    `PI DADDY · TERMINAL SIDE PANEL  [${state.busy ? "RUNNING" : "IDLE"}]  (${state.platform})`,
    tabBar,
    hr,
  ];

  if (tab === 1) {
    lines.push(
      `Model:    ${state.model} (${state.thinking}) | Cost: $${u.costUsd.toFixed(4)} (${totalK}K tok, ${u.cacheHitPct}% cache)`,
      `Mode:     ${modeLabel}  |  Auto: ${state.autoEnabled ? "ON" : "OFF"}  |  Turns: ${u.turns}`,
      `CWD:      ${state.cwd}`,
      `Tools:    ${state.activeTools.join(", ") || "(none)"}`,
      hr,
      "LIVE ACTIVITY (latest first):",
    );
    const events = [...(state.recentEvents ?? [])].reverse().slice(0, 10);
    if (events.length === 0) lines.push("  (no activity yet)");
    else {
      for (const ev of events) {
        lines.push(`  ${ev.at.slice(11, 19)}  ${ev.kind.padEnd(11)} ${ev.detail.slice(0, Math.max(20, width - 26))}`);
      }
    }
  } else if (tab === 2) {
    lines.push("DELEGATIONS, TOURNAMENTS & ESCALATIONS:");
    const tasks = [...(state.tasks ?? [])].reverse().slice(0, 12);
    if (tasks.length === 0) lines.push("  (no delegated tasks or tournaments in this session yet)");
    else {
      for (const t of tasks) {
        lines.push(`  ${t.at.slice(11, 19)}  [${t.status}] ${t.kind}: ${t.detail.slice(0, Math.max(20, width - 28))}`);
      }
    }
  } else if (tab === 3) {
    lines.push("BOOKIE PROJECT MEMORY:");
    const mem = state.memoryLines ?? [];
    if (mem.length === 0) lines.push("  (no Bookie observations yet — use /bookie-task or /bookie-distill)");
    else for (const m of mem.slice(0, 12)) lines.push(`  • ${m.slice(0, Math.max(24, width - 6))}`);
  } else if (tab === 4) {
    lines.push("SCOUT PUBLIC RESEARCH:");
    const res = state.researchLines ?? [];
    if (res.length === 0) lines.push("  (no Scout research briefs in this session yet)");
    else for (const r of res.slice(0, 12)) lines.push(`  • ${r.slice(0, Math.max(24, width - 6))}`);
  } else {
    lines.push(
      `Work Mode:  ${modeLabel}   (press [m] to cycle)`,
      `Daddy Auto: ${state.autoEnabled ? "ON" : "OFF"}   (press [a] to toggle)`,
      `Thinking:   ${state.thinking}   (press [t] to cycle)`,
      `Model Tiers (press [e] to edit & save to ecosystem.json):`,
      `  FAST:     ${state.modelTiers.fast || "(unset)"}`,
      `  WORK:     ${state.modelTiers.work || "(unset)"}`,
      `  STRONG:   ${state.modelTiers.strong || "(unset)"}`,
      `Optional Tools (press [o] to toggle):`,
      `  ${(state.optionalTools ?? []).map((t) => `${state.activeTools.includes(t) ? "[x]" : "[ ]"} ${t}`).join("  ")}`,
    );
  }

  lines.push(hr);
  lines.push("Keys: [1-5] tabs  [s] steer  [f] follow-up  [m] mode  [a] auto  [t] think");
  lines.push("      [o] tools   [e] tiers  [x] escalate   [q] quit");
  if (notice) lines.push(`> ${notice}`);
  return lines.join("\n");
}

export async function runTerminalPanel(urlInput?: string, cwd = process.cwd()): Promise<void> {
  const resolvedUrl = urlInput?.trim() || readPanelLocator(cwd)?.url;
  if (!resolvedUrl) {
    throw new Error(
      `No active Pi Daddy side panel found for ${cwd}. Start Pi and run /dashboard, or pass the explicit URL.`,
    );
  }
  const parsed = new URL(resolvedUrl);
  const token = parsed.searchParams.get("token") ?? "";
  if (!token) throw new Error("Panel URL must include ?token=...");
  const base = `${parsed.protocol}//${parsed.host}`;

  let state: WebDashboardState | undefined;
  let tab: PanelTab = 1;
  let notice = "Connected.";
  let prompting = false;
  let closed = false;
  let optToolIdx = 0;
  const ac = new AbortController();

  const draw = () => {
    if (prompting || !state) return;
    const cols = process.stdout.columns || 78;
    process.stdout.write(`\x1b[2J\x1b[H${renderTerminalPanel(state, notice, cols, tab)}\n`);
  };

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    notice = res.ok ? `OK (${path})` : `ERR: ${json.error ?? res.status}`;
    draw();
  };

  const sseLoop = (async () => {
    const res = await fetch(`${base}/events?token=${encodeURIComponent(token)}`, { signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`Panel connection failed (${res.status})`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          state = JSON.parse(dataLine.slice(6)) as WebDashboardState;
          draw();
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  })().catch((err) => {
    if (!closed) {
      notice = `Disconnected: ${err instanceof Error ? err.message : String(err)}`;
      draw();
    }
  });

  const askLine = (promptLabel: string): Promise<string> =>
    new Promise((resolve) => {
      prompting = true;
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`\n${promptLabel}: `, (answer) => {
        rl.close();
        prompting = false;
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          process.stdin.resume();
        }
        resolve(answer.trim());
      });
    });

  await new Promise<void>((resolveDone) => {
    const cleanup = () => {
      if (closed) return;
      closed = true;
      ac.abort();
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      process.stdin.pause();
      resolveDone();
    };
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (key: string) => {
        if (prompting) return;
        if (key === "\u0003" || key === "q") {
          cleanup();
          return;
        }
        if (["1", "2", "3", "4", "5"].includes(key)) {
          tab = Number(key) as PanelTab;
          draw();
          return;
        }
        if (key === "s" || key === "f") {
          const deliverAs = key === "s" ? "steer" : "followUp";
          void askLine(deliverAs === "steer" ? "Steer now" : "Queue follow-up").then(async (msg) => {
            if (msg) await post("/api/steer", { message: msg, deliverAs });
            else draw();
          });
        } else if (key === "a" && state) {
          void post("/api/auto-mode", { enabled: !state.autoEnabled });
        } else if (key === "m" && state) {
          const cur = state.workMode?.selection;
          const idx = WORK_MODE_CYCLE.findIndex(
            (x) => x.mode === cur?.mode && x.emphases.join(",") === (cur?.emphases ?? []).join(","),
          );
          const next = WORK_MODE_CYCLE[(idx + 1) % WORK_MODE_CYCLE.length];
          void post("/api/work-mode", { ...next, scope: "session" });
        } else if (key === "t" && state) {
          const idx = THINKING_CYCLE.indexOf(state.thinking as (typeof THINKING_CYCLE)[number]);
          const next = THINKING_CYCLE[(idx + 1) % THINKING_CYCLE.length];
          void post("/api/config", { thinking: next });
        } else if (key === "o" && state && state.optionalTools.length > 0) {
          const name = state.optionalTools[optToolIdx % state.optionalTools.length];
          optToolIdx++;
          const enabled = !state.activeTools.includes(name);
          void post("/api/config", { toggleTool: { name, enabled } });
        } else if (key === "e" && state) {
          void askLine("Edit tier (fast|work|strong provider/model)").then(async (line) => {
            const [tier, ...rest] = line.split(/\s+/);
            const val = rest.join(" ").trim();
            if (["fast", "work", "strong"].includes(tier)) {
              await post("/api/config", { modelTiers: { [tier]: val } });
            } else {
              notice = "Use: fast|work|strong provider/model";
              draw();
            }
          });
        } else if (key === "x") {
          void post("/api/escalate", { reason: "terminal-panel" });
        }
      });
    }
    void sseLoop.finally(cleanup);
  });
}
