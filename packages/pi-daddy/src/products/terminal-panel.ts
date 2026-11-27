/**
 * Full 5-Tab Interactive Terminal Side-Panel Dashboard Client (Layer 3: products).
 *
 * Tabs: [1] Overview  [2] Tasks  [3] Memory  [4] Research  [5] Settings
 * Works in ANY terminal (iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal, tmux, VS Code)
 * on macOS, Linux, and Windows. Supports zero-copy-paste auto-attach
 * when run as bare `pi-daddy panel` inside the active workspace.
 */
import { createInterface } from "node:readline";
import { preferenceFields, type PreferenceCatalog } from "./ecosystem-settings-panel.ts";
import { readPanelLocator } from "../kernel/ecosystem-config.ts";
import { sectionHeading, colorSessionLine } from "./dashboard-layout.ts";
import { truncate } from "./dashboard-render.ts";
import { wrapDashboardLines } from "./dashboard-screen.ts";
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

type ClassifierRequest = (input: Record<string, unknown>) => Promise<unknown>;

/** The terminal and browser both read and write the owning Pi session's classifier settings. */
export async function editTerminalClassifier(request: ClassifierRequest, ask: (label: string) => Promise<string>) {
  const catalog = (await request({ action: "list" })) as {
    models: string[];
    selected: string;
    recovery: string;
    thresholds: Record<string, number>;
    legacyThreshold: number;
    currentMode: string;
    shadow: boolean;
    errors: string[];
  };
  const models = [...new Set(["", ...catalog.models, catalog.selected])];
  const choices = models.map((id, index) => {
    const label = (id || "Configured fast chat model").replace(/[\x00-\x1f\x7f]/g, "");
    const status =
      id === catalog.selected ? (id && !catalog.models.includes(id) ? " (saved, unavailable)" : " (current)") : "";
    return `${index}. ${label}${status}`;
  });
  const reply = await ask(
    [
      ...catalog.errors,
      ...(catalog.recovery ? [catalog.recovery] : []),
      ...choices,
      "Select a classifier by number (Enter cancels)",
    ].join("\n"),
  );
  if (!reply) return "Cancelled.";
  const model = models[Number(reply)];
  if (!/^\d+$/.test(reply) || model === undefined) throw Error("Choose a listed classifier number.");
  const remembered = model ? catalog.thresholds[model] : catalog.legacyThreshold;
  if (model && !catalog.models.includes(model)) {
    const action = await ask(
      "This saved model is unavailable. Type off to disable harvesting, or press Enter to return.",
    );
    if (action !== "off") return catalog.recovery;
    await request({ action: "save", model, threshold: remembered, mode: "off", shadow: false });
    return "Harvesting off.";
  }
  const text = await ask(`Save threshold, 0 to 1 [${remembered}]`);
  const threshold = text ? Number(text) : remembered;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw Error("Enter a threshold from 0 to 1.");
  const defaultMode = model === catalog.selected ? catalog.currentMode : "suggest";
  const mode = (await ask(`Harvest mode: suggest, auto, off [${defaultMode}]`)) || defaultMode;
  if (!["suggest", "auto", "off"].includes(mode)) throw Error("Choose suggest, auto, or off.");
  let shadow = false;
  if (model) {
    const current = model === catalog.selected && catalog.shadow ? "y" : "n";
    const choice =
      (await ask(
        `Compare routing this session? Sends redacted requests and candidate descriptions to this classifier (y/n) [${current}]`,
      )) || current;
    if (!["y", "n"].includes(choice.toLowerCase())) throw Error("Choose y or n.");
    shadow = choice.toLowerCase() === "y";
  }
  const settings = { model, threshold, mode, shadow };
  const action = await ask(
    model ? "save, test synthetic turn, or Enter to cancel (save/test)" : "Type save or press Enter to cancel",
  );
  if (!action) return "Cancelled.";
  if (action === "test" && model) {
    const result = (await request({ action, ...settings })) as {
      probability: number;
      latencyMs: number;
      save: boolean;
    };
    return `Synthetic turn: probability ${result.probability}, ${result.save ? "save" : "skip"}, ${result.latencyMs} ms. Settings not saved.`;
  }
  if (action !== "save") throw Error("No settings saved. Choose a listed action.");
  await request({ action, ...settings });
  return `Saved: ${model || "configured fast chat model"}, threshold ${threshold}, mode ${mode}, comparisons ${shadow ? "on" : "off"}.`;
}

export async function editTerminalPreferences(request: ClassifierRequest, ask: (label: string) => Promise<string>) {
  const c = (await request({ action: "list" })) as PreferenceCatalog;
  const reply = await ask(
    [
      "Current Pi model: " + c.current,
      ...preferenceFields.map(
        ([k, title], i) =>
          i +
          1 +
          ". " +
          title +
          "  [" +
          (typeof c.values[k] === "boolean" ? (c.values[k] ? "On" : "Off") : c.values[k]) +
          "]",
      ),
      "Select a setting (Enter cancels)",
    ].join("\n"),
  );
  if (!reply) return "Cancelled.";
  const field = preferenceFields[Number(reply) - 1];
  if (!/^\d+$/.test(reply) || !field) throw Error("Choose a listed setting number.");
  const [key, title, help] = field;
  if (key === "autoSyncReviews" && !c.bookieSyncReady) throw Error("Load the Bookie review sync update first.");
  if (key.startsWith("scout") && !c.scoutReady) throw Error("Load the Scout settings update first.");
  const choices = key === "scoutModel" ? ["session", ...c.models] : key === "scoutThinking" ? c.levels : [true, false];
  const text = await ask(
    [
      help,
      ...choices.map(
        (v, i) =>
          i +
          1 +
          ". " +
          (v === "session" ? "Follow Pi: " + c.current : typeof v === "boolean" ? (v ? "On" : "Off") : v),
      ),
      "Select a value to save (Enter cancels)",
    ].join("\n"),
  );
  if (!text) return "Cancelled.";
  const value = choices[Number(text) - 1];
  if (!/^\d+$/.test(text) || value === undefined) throw Error("Choose a listed value.");
  await request({ action: "save", key, value });
  return title + " saved: " + value;
}

export function renderTerminalPanel(
  state: WebDashboardState,
  notice = "",
  width = 76,
  tab: PanelTab = 1,
  height = 40,
  scroll = 0,
  color = false,
): string {
  const cols = Math.max(1, width);
  const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ");
  const fit = (value: string) => truncate(clean(value), cols);
  const heading = (name: string) => sectionHeading(name, cols);
  const mode = state.workMode?.selection;
  const modeName = mode?.mode === "ambitious" ? `Ambitious ${mode.emphases.join(" + ")}`.trim() : "Standard";
  const header = fit(`PI DADDY  ·  ${state.busy ? "Running" : "Idle"}  ·  ${TAB_NAMES[tab]}`);
  const names = cols < 58 ? ["Now", "Tasks", "Mem", "Res", "Set"] : Object.values(TAB_NAMES);
  const nav = fit(names.map((name, i) => (tab === i + 1 ? `[${i + 1} ${name}]` : `${i + 1} ${name}`)).join("  "));
  const body: string[] = [];
  if (tab === 1) {
    const task = state.tasks?.at(-1);
    body.push(
      heading("Current session"),
      state.model,
      `${modeName}  ·  Thinking ${state.thinking}  ·  Auto ${state.autoEnabled ? "on" : "off"}`,
    );
    const u = state.usage;
    if (u)
      body.push(
        `$${u.costUsd.toFixed(4)}  ·  ${((u.inputTokens + u.outputTokens + u.cacheReadTokens) / 1000).toFixed(1)}K tokens  ·  ${u.cacheHitPct}% cache`,
      );
    body.push(`Workspace  ${state.cwd}`);
    if (task) body.push(`Latest task  ${task.kind} · ${task.status} · ${task.detail}`);
    if (state.harvest)
      body.push(
        `Harvest  ${state.harvest.scenarioId} · ${state.harvest.savedPath ? "saved" : "suggested"} (${Math.round(state.harvest.confidence * 100)}%)`,
      );
    body.push("", heading("Ecosystem activity"));
    const contributions = state.ecosystemActivity?.slice(-5).reverse() ?? [];
    if (!contributions.length) body.push("Waiting for an ecosystem tool or harvest.");
    for (const ev of contributions) body.push(`${ev.at.slice(11, 19)}  ${ev.detail}`);
    body.push("", heading("Live activity"));
    for (const ev of [...(state.recentEvents ?? [])].reverse())
      body.push(`${ev.at.slice(11, 19)}  ${ev.detail || ev.kind}`);
    if (!state.recentEvents?.length) body.push("Waiting for session activity.");
    body.push("", heading("Active tools"), state.activeTools.join(", ") || "None");
  } else if (tab === 2) {
    body.push(heading("Recent tasks"));
    for (const t of [...(state.tasks ?? [])].reverse())
      body.push(`${t.at.slice(11, 19)}  ${t.kind} · ${t.status}`, `  ${t.detail}`);
    if (!state.tasks?.length) body.push("No delegations or escalations yet.");
  } else if (tab === 3 || tab === 4) {
    const rows = tab === 3 ? state.memoryLines : state.researchLines;
    body.push(heading(tab === 3 ? "Bookie project memory" : "Scout research"));
    body.push(
      ...(rows?.length
        ? rows
        : [tab === 3 ? "No observations yet. Use /bookie-task in Pi." : "No research yet. Ask Pi to use Scout."]),
    );
  } else {
    body.push(
      heading("Ecosystem settings"),
      "[p] Scout model & thinking, Bookie memory, dashboard and escalation",
      "",
      heading("Decision classifier"),
      "[c] Select model, threshold or test",
      "After an outage, save a working classifier to retry the turn.",
    );
    if (state.classifierNeedsModel) body.push("Action needed: choose a working classifier with [c].");
    const c = state.classifier;
    if (c)
      body.push(
        c.model || "Configured fast chat model",
        `Threshold ${c.threshold}  ·  Harvest ${c.mode}`,
        `Background comparisons  ${c.shadow ? "on" : "off"}`,
      );
    body.push(
      "Threshold: minimum score to suggest or save.",
      "Suggest: review first. Auto: save. Off: skip.",
      "",
      heading("Agent settings"),
      `[m] Work mode    ${modeName}`,
      `[a] Daddy Auto   ${state.autoEnabled ? "on" : "off"}`,
      "Auto approves eligible Daddy tool requests.",
      "Changing Auto also switches Bookie memory. Use [p] to change Bookie alone.",
      `[t] Thinking     ${state.thinking}`,
      "",
      heading("Model tiers"),
      "[e] Edit a tier",
      ...(["fast", "work", "strong"] as const).map(
        (t) => `${t.toUpperCase().padEnd(7)} ${state.modelTiers[t] || "(unset)"}`,
      ),
      "",
      heading("Optional tools"),
      "[o] Choose a tool to toggle",
      ...state.optionalTools.map((name) => `  ${state.activeTools.includes(name) ? "[x]" : "[ ]"} ${name}`),
    );
  }
  const footer = [
    tab === 5 ? "[p] ecosystem  [c] classifier  [e] tiers  [o] tools" : "[s] steer   [f] follow-up   [h] harvest",
    "←/→ tabs   ↑/↓ scroll   [?] keys   [q] quit",
  ];
  if (notice) footer.unshift(notice);
  const rows = wrapDashboardLines(body, cols);
  const available = Math.max(1, height - 2 - footer.length);
  const offset = Math.max(0, Math.min(scroll, rows.length - available));
  const visible = rows.slice(offset, offset + available);
  if (offset || rows.length > available)
    footer[footer.length - 1] =
      `↑/↓ ${offset + 1}–${offset + visible.length}/${rows.length}   ←/→ tabs   [?] keys   [q] quit`;
  const paint = (line: string, role: "header" | "body" | "navigation") => (color ? colorSessionLine(line, role) : line);
  return [
    paint(header, "header"),
    paint(nav, "navigation"),
    ...visible.map((line) => paint(fit(line), "body")),
    ...footer.map(fit),
  ].join("\n");
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
  let scroll = 0;
  let showHelp = false;
  const ac = new AbortController();

  const draw = () => {
    if (prompting || !state) return;
    const cols = process.stdout.columns || 78;
    const help = [
      "Navigation",
      "1–5 or ←/→  Switch tabs",
      "↑/↓  Scroll content",
      "Session actions",
      "[s] Steer    [f] Queue follow-up",
      "[x] Escalate   [h] Save harvest",
      "Settings (tab 5)",
      "[p] Scout and ecosystem settings",
      "[c] Decision classifier   [e] Model tiers",
      "[m] Work mode   [a] Automatic approvals",
      "[t] Agent thinking   [o] Optional tools",
      "[?] or Esc  Return   [q] Quit",
    ];
    const screen = showHelp
      ? help.map((line) => truncate(line, cols)).join("\n")
      : renderTerminalPanel(
          state,
          notice,
          cols,
          tab,
          process.stdout.rows || 32,
          scroll,
          process.env.NO_COLOR === undefined && !!process.stdout.isTTY,
        );
    process.stdout.write(
      `\x1b[H${screen
        .split("\n")
        .map((line) => line + "\x1b[K")
        .join("\n")}\x1b[J`,
    );
  };

  const request = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw Error(json.error ?? String(res.status));
    return json;
  };

  const post = async (path: string, body: unknown) => {
    try {
      await request(path, body);
      notice = `OK (${path})`;
    } catch (error) {
      notice = `ERR: ${error instanceof Error ? error.message : String(error)}`;
    }
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

  let editingClassifier = false;
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
    process.stdout.on("resize", draw);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      process.stdout.off("resize", draw);
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
        if (editingClassifier) return;
        if (key === "?" || (key === "\x1b" && showHelp)) {
          showHelp = !showHelp;
          draw();
          return;
        }
        if (showHelp) return;
        if (key === "\x1b[C" || key === "\x1b[D") {
          tab = (1 + ((tab - 1 + (key === "\x1b[C" ? 1 : 4)) % 5)) as PanelTab;
          scroll = 0;
          draw();
          return;
        }
        if (key === "\x1b[A" || key === "\x1b[B") {
          const next = Math.max(0, scroll + (key === "\x1b[A" ? -1 : 1));
          if (
            state &&
            renderTerminalPanel(state, notice, process.stdout.columns || 78, tab, process.stdout.rows || 32, scroll) !==
              renderTerminalPanel(state, notice, process.stdout.columns || 78, tab, process.stdout.rows || 32, next)
          )
            scroll = next;
          draw();
          return;
        }
        if (["1", "2", "3", "4", "5"].includes(key)) {
          tab = Number(key) as PanelTab;
          scroll = 0;
          draw();
          return;
        }
        if ((key === "c" || key === "p") && tab === 5 && state) {
          editingClassifier = true;
          notice = "Loading settings...";
          draw();
          const edit = key === "p" ? editTerminalPreferences : editTerminalClassifier;
          void edit(
            (input) => request(key === "p" ? "/api/preferences" : "/api/classifiers", input),
            (label) => (closed ? Promise.reject(Error("Panel closed.")) : askLine(label)),
          )
            .then((message) => {
              notice = message;
            })
            .catch((error) => {
              notice = `ERR: ${error instanceof Error ? error.message : String(error)}`;
            })
            .finally(() => {
              editingClassifier = false;
              if (!closed) draw();
            });
        } else if (key === "s" || key === "f") {
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
          const options = [...state.optionalTools];
          void askLine(
            options
              .map((name, i) => `${i + 1}. ${name} (${state!.activeTools.includes(name) ? "on" : "off"})`)
              .join("\n") + "\nChoose a tool number; Enter cancels",
          ).then(async (answer) => {
            const name = options[Number(answer) - 1];
            if (!/^\d+$/.test(answer) || !name || !state) {
              notice = answer ? "Choose a listed tool number." : "Cancelled.";
              draw();
              return;
            }
            await post("/api/config", { toggleTool: { name, enabled: !state.activeTools.includes(name) } });
          });
        } else if (key === "e" && state) {
          editingClassifier = true;
          void (async () => {
            const catalog = (await request("/api/preferences", { action: "list" })) as unknown as PreferenceCatalog;
            const tier = await askLine("Which tier? fast, work, or strong (Enter cancels)");
            if (!tier) return;
            if (!["fast", "work", "strong"].includes(tier)) throw Error("Choose fast, work or strong.");
            const options = ["session", ...catalog.models];
            const answer = await askLine(
              options.map((m, i) => i + 1 + ". " + (m === "session" ? "Follow Pi: " + catalog.current : m)).join("\n") +
                "\nChoose a connected model (Enter cancels)",
            );
            if (!answer) return;
            const model = options[Number(answer) - 1];
            if (!/^\d+$/.test(answer) || !model) throw Error("Choose a listed number.");
            await request("/api/config", { modelTiers: { [tier]: model } });
            notice = tier + " model saved: " + model;
          })()
            .catch((error) => {
              notice = String(error);
            })
            .finally(() => {
              editingClassifier = false;
              draw();
            });
        } else if (key === "x") {
          void post("/api/escalate", { reason: "terminal-panel" });
        } else if (key === "h") {
          void post("/api/harvest", { reason: "terminal-panel" });
        }
      });
    }
    void sseLoop.finally(cleanup);
  });
}
