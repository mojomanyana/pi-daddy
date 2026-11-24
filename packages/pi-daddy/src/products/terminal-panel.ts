/**
 * Interactive Terminal Side-Panel Dashboard Client (Layer 3: products).
 *
 * Connects to the standalone localhost side-panel HTTP/SSE server from ANY terminal
 * (tmux, WezTerm, iTerm2, Ghostty, Windows Terminal, VS Code split — macOS/Linux/Windows,
 * zero Herdr required). Supports live steering, work-mode cycling, Auto toggle, and thinking level.
 */
import { createInterface } from "node:readline";
import type { WebDashboardState } from "./web-dashboard.ts";

const WORK_MODE_CYCLE: Array<{ mode: "standard" | "ambitious"; emphases: string[] }> = [
  { mode: "standard", emphases: [] },
  { mode: "ambitious", emphases: [] },
  { mode: "ambitious", emphases: ["depth"] },
  { mode: "ambitious", emphases: ["range"] },
  { mode: "ambitious", emphases: ["altitude"] },
  { mode: "ambitious", emphases: ["speed"] },
];
const THINKING_CYCLE = ["off", "low", "medium", "high"] as const;

export function renderTerminalPanel(state: WebDashboardState, notice = "", width = 72): string {
  const hr = "─".repeat(Math.max(36, Math.min(width, 100)));
  const sel = state.workMode?.selection;
  const modeLabel =
    !sel || sel.mode === "standard"
      ? "Standard"
      : `Ambitious (${sel.emphases.length ? sel.emphases.join("+") : "balanced"})`;
  const lines = [
    `PI DADDY · TERMINAL SIDE PANEL  [${state.busy ? "RUNNING" : "IDLE"}]  (${state.platform})`,
    hr,
    `Model:    ${state.model}  (thinking: ${state.thinking})`,
    `Mode:     ${modeLabel}  |  Auto: ${state.autoEnabled ? "ON" : "OFF"}`,
    `CWD:      ${state.cwd}`,
    `Tools:    ${state.activeTools.join(", ") || "(none)"}`,
    `Tiers:    FAST=${state.modelTiers.fast || "-"} | WORK=${state.modelTiers.work || "-"} | STRONG=${state.modelTiers.strong || "-"}`,
    hr,
    "ACTIVITY (latest first):",
  ];
  const events = [...(state.recentEvents ?? [])].reverse().slice(0, 10);
  if (events.length === 0) lines.push("  (no activity yet)");
  else {
    for (const ev of events) {
      lines.push(`  ${ev.at.slice(11, 19)}  ${ev.kind.padEnd(11)} ${ev.detail.slice(0, Math.max(20, width - 26))}`);
    }
  }
  lines.push(hr);
  lines.push("Keys: [s] steer  [f] follow-up  [m] work-mode  [a] auto  [t] thinking  [q] quit");
  if (notice) lines.push(`> ${notice}`);
  return lines.join("\n");
}

export async function runTerminalPanel(urlInput: string): Promise<void> {
  const parsed = new URL(urlInput);
  const token = parsed.searchParams.get("token") ?? "";
  if (!token) throw new Error("Panel URL must include ?token=...");
  const base = `${parsed.protocol}//${parsed.host}`;

  let state: WebDashboardState | undefined;
  let notice = "Connected.";
  let prompting = false;
  let closed = false;
  const ac = new AbortController();

  const draw = () => {
    if (prompting || !state) return;
    const cols = process.stdout.columns || 76;
    process.stdout.write(`\x1b[2J\x1b[H${renderTerminalPanel(state, notice, cols)}\n`);
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

  // Start SSE stream in background
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
        }
      });
    }
    void sseLoop.finally(cleanup);
  });
}
