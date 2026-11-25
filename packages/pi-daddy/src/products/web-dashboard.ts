/**
 * Standalone Multi-Tab Side-Panel Server (Layer 3: products).
 *
 * Powers BOTH the 5-tab interactive Terminal Side Panel (`pi-daddy panel`) AND the Browser UI
 * (`/dashboard open`) across macOS, Linux, and Windows with zero Herdr dependency.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { WorkModeSelection, WorkModeSnapshot } from "../kernel/work-mode.ts";

export interface WebDashboardEvent {
  readonly at: string;
  readonly kind: string;
  readonly detail: string;
}

export interface WebDashboardUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheHitPct: number;
  readonly costUsd: number;
  readonly turns: number;
}

export interface WebDashboardTask {
  readonly at: string;
  readonly kind: string;
  readonly status: string;
  readonly detail: string;
}

export interface WebDashboardModelTiers {
  readonly fast: string;
  readonly work: string;
  readonly strong: string;
}

export interface WebDashboardHarvestInfo {
  readonly scenarioId: string;
  readonly reason: string;
  readonly confidence: number;
  readonly savedPath?: string;
}

export interface WebDashboardState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly platform: string;
  readonly model: string;
  readonly thinking: string;
  readonly autoEnabled: boolean;
  readonly activeTools: readonly string[];
  readonly optionalTools: readonly string[];
  readonly modelTiers: WebDashboardModelTiers;
  readonly workMode: WorkModeSnapshot;
  readonly busy: boolean;
  readonly usage: WebDashboardUsage;
  readonly tasks: readonly WebDashboardTask[];
  readonly memoryLines: readonly string[];
  readonly researchLines: readonly string[];
  readonly recentEvents: readonly WebDashboardEvent[];
  readonly harvest?: WebDashboardHarvestInfo;
}

export interface WebDashboardConfigUpdate {
  readonly thinking?: string;
  readonly modelTiers?: Partial<WebDashboardModelTiers>;
  readonly toggleTool?: { readonly name: string; readonly enabled: boolean };
}

export interface WebDashboardHandle {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  push(state: WebDashboardState): void;
  close(): Promise<void>;
}

export interface StartWebDashboardOptions {
  readonly getState: () => WebDashboardState;
  readonly onWorkModeChange?: (selection: WorkModeSelection, scope: "session" | "next-request") => void;
  readonly onSteer?: (message: string, deliverAs: "steer" | "followUp") => Promise<void> | void;
  readonly onAutoModeChange?: (enabled: boolean) => Promise<void> | void;
  readonly onConfigChange?: (patch: WebDashboardConfigUpdate) => Promise<void> | void;
  readonly onEscalate?: (reason?: string) => Promise<void> | void;
  readonly onHarvest?: (
    reason?: string,
  ) =>
    | Promise<{ saved: boolean; path?: string; scenarioId?: string }>
    | { saved: boolean; path?: string; scenarioId?: string };
}

function tokenMatches(supplied: string | null, expected: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      if (body.length < 16_384) body += String(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) reject(new Error("JSON object required"));
        else resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function renderHtml(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Pi Daddy · Side Panel</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --bd:#30363d; --fg:#e6edf3; --mut:#8b949e; --acc:#58a6ff; --ok:#3fb950; }
  * { box-sizing:border-box; }
  body { margin:0; font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--bg); color:var(--fg); padding:12px; }
  .wrap { display:flex; flex-direction:column; gap:10px; max-width:960px; margin:0 auto; }
  .hdr { display:flex; justify-content:space-between; align-items:center; gap:8px; }
  h1 { font-size:14px; margin:0; color:var(--acc); }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--mut); margin:0 0 8px; }
  .card { background:var(--card); border:1px solid var(--bd); border-radius:8px; padding:12px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; border:1px solid var(--bd); font-size:11px; margin:2px 4px 2px 0; }
  .pill.on { border-color:var(--ok); color:var(--ok); }
  .row { margin:4px 0; word-break:break-all; }
  textarea, input, select { width:100%; background:#0d1117; color:var(--fg); border:1px solid var(--bd); border-radius:6px; padding:6px 8px; font:inherit; font-size:12px; }
  button { background:#21262d; color:var(--fg); border:1px solid var(--bd); border-radius:6px; padding:5px 10px; cursor:pointer; font:inherit; font-size:12px; }
  button:hover { border-color:var(--acc); }
  button.primary { background:#1f6feb; border-color:#388bfd; color:#fff; }
  .bar { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; align-items:center; }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:10px; }
  label.chk { display:inline-flex; align-items:center; gap:4px; font-size:12px; cursor:pointer; margin-right:8px; }
  label.chk input { width:auto; }
  #feed { max-height:220px; overflow:auto; font-size:11.5px; }
  .ev { padding:3px 0; border-bottom:1px solid #21262d; }
  .ts { color:var(--mut); margin-right:6px; }
  .msg { color:var(--mut); font-size:11px; margin-top:5px; min-height:14px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Pi Daddy · Side Panel</h1>
    <span id="usage" class="pill">$0.000 · 0 tok</span>
    <span id="status" class="pill">connecting…</span>
  </div>
  <div class="card">
    <h2>Live Steering & Escalation</h2>
    <textarea id="steer-text" rows="2" placeholder="Steer active run or queue follow-up…"></textarea>
    <div class="bar">
      <button class="primary" onclick="sendSteer('steer')">Steer Now</button>
      <button onclick="sendSteer('followUp')">Queue Follow-up</button>
      <button onclick="escalate()">Escalate to Strong</button>
      <button onclick="harvestEval()">Harvest Eval</button>
      <span id="steer-msg" class="msg"></span>
    </div>
  </div>
  <div class="grid2">
    <div class="card">
      <h2>Work Mode & Permissions</h2>
      <div class="row">Current: <strong id="wm">-</strong></div>
      <div class="bar" style="margin-top:6px">
        <label class="chk"><input type="checkbox" value="speed" class="emp" />speed</label>
        <label class="chk"><input type="checkbox" value="altitude" class="emp" />altitude</label>
        <label class="chk"><input type="checkbox" value="depth" class="emp" />depth</label>
        <label class="chk"><input type="checkbox" value="range" class="emp" />range</label>
      </div>
      <div class="bar">
        <button onclick="applyMode('standard')">Standard</button>
        <button class="primary" onclick="applyMode('ambitious')">Apply Ambitious</button>
        <button id="auto-btn" onclick="toggleAuto()">Auto: OFF</button>
      </div>
      <div id="wm-msg" class="msg"></div>
    </div>
    <div class="card">
      <h2>Runtime Configuration</h2>
      <div class="row">Model: <strong id="model">-</strong> · <span id="platform">-</span></div>
      <div class="bar">
        <span>Thinking:</span>
        <select id="thinking" style="width:auto" onchange="saveThinking()">
          <option value="off">off</option><option value="minimal">minimal</option>
          <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
        </select>
      </div>
      <div class="row" style="margin-top:6px"><input id="m-fast" placeholder="models.fast" /></div>
      <div class="row"><input id="m-work" placeholder="models.work" /></div>
      <div class="row"><input id="m-strong" placeholder="models.strong" /></div>
      <div class="bar">
        <button onclick="saveTiers()">Save Model Tiers</button>
        <span id="cfg-msg" class="msg"></span>
      </div>
    </div>
  </div>
  <div class="grid2">
    <div class="card"><h2>Memory (Bookie)</h2><div id="mem" class="row">-</div></div>
    <div class="card"><h2>Research (Scout)</h2><div id="res" class="row">-</div></div>
  </div>
  <div class="card">
    <h2>Tools & Workspace</h2>
    <div class="row" style="color:var(--mut);font-size:11px" id="cwd">-</div>
    <div id="tools" class="bar"></div>
    <div id="opt-tools" class="bar"></div>
  </div>
  <div class="card">
    <h2>Live Activity Feed</h2>
    <div id="feed">Waiting for events…</div>
  </div>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
let LAST = null;
async function post(path, body) {
  const r = await fetch(path + '?token=' + encodeURIComponent(TOKEN), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}
function render(s) {
  LAST = s;
  const st = document.getElementById('status');
  st.textContent = s.busy ? 'running' : 'idle';
  st.className = 'pill ' + (s.busy ? 'on' : '');
  const u = s.usage || { inputTokens:0, outputTokens:0, cacheReadTokens:0, cacheHitPct:0, costUsd:0 };
  const tot = Math.round((u.inputTokens + u.outputTokens + u.cacheReadTokens) / 1000);
  document.getElementById('usage').textContent = '$' + (u.costUsd || 0).toFixed(4) + ' · ' + tot + 'K tok · ' + (u.cacheHitPct || 0) + '% cache';
  document.getElementById('model').textContent = s.model;
  document.getElementById('platform').textContent = s.platform;
  document.getElementById('cwd').textContent = s.cwd;
  const th = document.getElementById('thinking');
  if (document.activeElement !== th && s.thinking) th.value = s.thinking;
  const ab = document.getElementById('auto-btn');
  ab.textContent = 'Auto: ' + (s.autoEnabled ? 'ON' : 'OFF');
  ab.className = s.autoEnabled ? 'primary' : '';
  const sel = s.workMode && s.workMode.selection;
  document.getElementById('wm').textContent = sel ? (sel.mode === 'standard' ? 'Standard' : 'Ambitious (' + (sel.emphases.join('+') || 'balanced') + ')') : 'Standard';
  for (const el of document.querySelectorAll('.emp')) {
    if (document.activeElement !== el) el.checked = !!(sel && sel.emphases && sel.emphases.includes(el.value));
  }
  const t = s.modelTiers || {};
  for (const [id, val] of [['m-fast', t.fast], ['m-work', t.work], ['m-strong', t.strong]]) {
    const el = document.getElementById(id);
    if (document.activeElement !== el) el.value = val || '';
  }
  const esc = v => String(v || '').replace(/</g, '&lt;');
  document.getElementById('mem').innerHTML = (s.memoryLines || []).length ? s.memoryLines.map(x => '<div class="ev">' + esc(x) + '</div>').join('') : 'No Bookie observations yet.';
  document.getElementById('res').innerHTML = (s.researchLines || []).length ? s.researchLines.map(x => '<div class="ev">' + esc(x) + '</div>').join('') : 'No Scout observations yet.';
  const active = new Set(s.activeTools || []);
  document.getElementById('tools').innerHTML = (s.activeTools || []).map(x => '<span class="pill on">' + x + '</span>').join('');
  document.getElementById('opt-tools').innerHTML = (s.optionalTools || []).map(name => {
    const on = active.has(name);
    return '<button onclick="toggleTool(' + JSON.stringify(name) + ',' + (!on) + ')">' + (on ? 'Disable ' : 'Enable ') + name + '</button>';
  }).join('');
  const feed = document.getElementById('feed');
  const rows = (s.recentEvents || []).slice().reverse();
  feed.innerHTML = rows.length
    ? rows.map(e => '<div class="ev"><span class="ts">' + e.at.slice(11,19) + '</span><strong>' + e.kind + '</strong> ' + esc(e.detail) + '</div>').join('')
    : 'No activity yet.';
}
async function sendSteer(deliverAs) {
  const box = document.getElementById('steer-text');
  const msg = document.getElementById('steer-msg');
  const text = box.value.trim();
  if (!text) return;
  const r = await post('/api/steer', { message: text, deliverAs });
  if (r.ok) { box.value = ''; msg.textContent = deliverAs === 'steer' ? 'Steered.' : 'Queued.'; }
  else msg.textContent = r.data.error || 'Failed';
}
async function escalate() {
  const r = await post('/api/escalate', { reason: 'operator-requested' });
  document.getElementById('steer-msg').textContent = r.ok ? 'Escalation requested.' : (r.data.error || 'Failed');
}
async function harvestEval() {
  const r = await post('/api/harvest', { reason: 'web-panel' });
  document.getElementById('steer-msg').textContent = r.ok ? ('Harvested: ' + (r.data.scenarioId || 'saved')) : (r.data.error || 'Failed');
}
async function applyMode(mode) {
  const emphases = mode === 'ambitious' ? [...document.querySelectorAll('.emp:checked')].map(e => e.value) : [];
  const r = await post('/api/work-mode', { mode, emphases, scope: 'session' });
  document.getElementById('wm-msg').textContent = r.ok ? 'Updated.' : (r.data.error || 'Failed');
}
async function toggleAuto() {
  const r = await post('/api/auto-mode', { enabled: !(LAST && LAST.autoEnabled) });
  document.getElementById('wm-msg').textContent = r.ok ? 'Auto updated.' : (r.data.error || 'Failed');
}
async function saveThinking() {
  const r = await post('/api/config', { thinking: document.getElementById('thinking').value });
  document.getElementById('cfg-msg').textContent = r.ok ? 'Thinking updated.' : (r.data.error || 'Failed');
}
async function saveTiers() {
  const r = await post('/api/config', {
    modelTiers: {
      fast: document.getElementById('m-fast').value.trim(),
      work: document.getElementById('m-work').value.trim(),
      strong: document.getElementById('m-strong').value.trim(),
    }
  });
  document.getElementById('cfg-msg').textContent = r.ok ? 'Model tiers saved.' : (r.data.error || 'Failed');
}
async function toggleTool(name, enabled) { await post('/api/config', { toggleTool: { name, enabled } }); }
const es = new EventSource('/events?token=' + encodeURIComponent(TOKEN));
es.onmessage = (ev) => { try { render(JSON.parse(ev.data)); } catch {} };
</script>
</body>
</html>`;
}

export async function startWebDashboard(options: StartWebDashboardOptions): Promise<WebDashboardHandle> {
  const token = randomBytes(16).toString("hex");
  const clients = new Set<ServerResponse>();
  const html = renderHtml(token);

  const broadcast = () => {
    const frame = `data: ${JSON.stringify(options.getState())}\n\n`;
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  };

  const jsonReply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!tokenMatches(parsed.searchParams.get("token"), token)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    if (req.method === "GET" && parsed.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && parsed.pathname === "/api/state") {
      jsonReply(res, 200, options.getState());
      return;
    }
    if (req.method === "GET" && parsed.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(options.getState())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST") {
      void readJsonBody(req)
        .then(async (data) => {
          if (parsed.pathname === "/api/work-mode") {
            if (!options.onWorkModeChange) throw new Error("Work mode editing unavailable");
            const scope = data.scope === "next-request" ? "next-request" : "session";
            options.onWorkModeChange(
              { mode: data.mode as "standard" | "ambitious", emphases: (data.emphases as []) ?? [] },
              scope,
            );
          } else if (parsed.pathname === "/api/steer") {
            if (!options.onSteer) throw new Error("Steering unavailable");
            const text = typeof data.message === "string" ? data.message.trim() : "";
            if (!text || text.length > 8000) throw new Error("Steering message must be 1..8000 chars");
            const deliverAs = data.deliverAs === "followUp" ? "followUp" : "steer";
            await options.onSteer(text, deliverAs);
          } else if (parsed.pathname === "/api/auto-mode") {
            if (!options.onAutoModeChange) throw new Error("Auto mode control unavailable");
            if (typeof data.enabled !== "boolean") throw new Error("enabled boolean required");
            await options.onAutoModeChange(data.enabled);
          } else if (parsed.pathname === "/api/config") {
            if (!options.onConfigChange) throw new Error("Config editing unavailable");
            await options.onConfigChange(data as WebDashboardConfigUpdate);
          } else if (parsed.pathname === "/api/escalate") {
            if (!options.onEscalate) throw new Error("Escalation unavailable");
            const reason = typeof data.reason === "string" ? data.reason.slice(0, 200) : undefined;
            await options.onEscalate(reason);
          } else if (parsed.pathname === "/api/harvest") {
            if (!options.onHarvest) throw new Error("Harvest unavailable");
            const reason = typeof data.reason === "string" ? data.reason.slice(0, 200) : undefined;
            const out = await options.onHarvest(reason);
            broadcast();
            jsonReply(res, 200, { ok: true, ...out });
            return;
          } else {
            jsonReply(res, 404, { error: "Not found" });
            return;
          }
          broadcast();
          jsonReply(res, 200, { ok: true });
        })
        .catch((error) => jsonReply(res, 400, { error: error instanceof Error ? error.message : "Invalid request" }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/?token=${token}`;

  return {
    url,
    port,
    token,
    push() {
      broadcast();
    },
    async close() {
      for (const client of clients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
