#!/usr/bin/env node
/**
 * RPC driver for live verification of pi-daddy approvals.
 *
 * Spawns `pi --mode rpc`, sends one prompt, echoes every JSON line pi emits, and answers
 * `extension_ui_request`/`select` with a configured value — which is exactly the channel
 * `ctx.ui.select` reaches in rpc mode, i.e. the same call the TUI dialog serves.
 *
 * usage: node drive.mjs --cwd DIR --msg "text" [--answer "Allow once"] [--answer-2 "..."]
 *                       [--cancel] [--timeout 90] [--no-extensions] [--print-mode]
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const cwd = opt("cwd", process.cwd());
const msg = opt("msg", "hello");
const answers = [opt("answer", null), opt("answer-2", null), opt("answer-3", null)].filter((a) => a !== null);
const cancel = flag("cancel");
const timeoutS = Number(opt("timeout", "120"));
const EXT = "/home/alavanja/prepos/pi-daddy/packages/pi-daddy/extensions/grants.ts";

const args = ["--no-session"];
if (flag("no-extensions")) args.push("--no-extensions");
args.push("-e", EXT, "--mode", "rpc");

const child = spawn("pi", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });

let answerIdx = 0;
let buf = "";
let done = false;

const finish = (code) => {
  if (done) return;
  done = true;
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => process.exit(code), 300);
};

child.stdout.on("data", (chunk) => {
  buf += String(chunk);
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { console.log("RAW  " + line); continue; }
    if (ev.type === "tool_execution_update" || ev.type === "message_update" || ev.type === "agent_end" ||
        ev.type === "turn_end" || ev.type === "message_start" || ev.type === "entry_appended") continue;

    if (ev.type === "extension_ui_request" && ev.method === "notify") {
      console.log("NOTIFY[" + (ev.notifyType ?? "info") + "] " + ev.message);
    } else if (ev.type === "extension_ui_request" && ev.method === "select") {
      console.log("SELECT title=" + JSON.stringify(ev.title));
      console.log("SELECT options=" + JSON.stringify(ev.options) + " timeout=" + ev.timeout);
      let resp;
      if (cancel) {
        resp = { type: "extension_ui_response", id: ev.id, cancelled: true };
        console.log("ANSWER cancelled");
      } else {
        const value = answers[answerIdx] ?? answers[answers.length - 1] ?? "Deny";
        answerIdx++;
        resp = { type: "extension_ui_response", id: ev.id, value };
        console.log("ANSWER " + JSON.stringify(value));
      }
      child.stdin.write(JSON.stringify(resp) + "\n");
    } else if (ev.type === "extension_ui_request" && ev.method === "setWidget") {
      /* powerline noise — ignore */
    } else if (ev.type === "extension_ui_request" && ev.method === "setStatus") {
      /* ignore */
    } else if (ev.type === "assistant" || ev.type === "message") {
      console.log("MSG " + JSON.stringify(ev).slice(0, 4000));
    } else if (ev.type === "response") {
      console.log("RESPONSE " + JSON.stringify(ev).slice(0, 2000));
      if (ev.command === "get_last_assistant_text") setTimeout(() => finish(0), 500);
    } else if (ev.type === "agent_settled") {
      console.log("EVENT agent_settled");
      child.stdin.write(JSON.stringify({ type: "get_last_assistant_text", id: "final" }) + "\n");
    } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const parts = (ev.message.content ?? []).map((p) =>
        p.type === "text" ? "TEXT " + p.text : p.type === "toolCall" ? "TOOLCALL " + p.name + " " + JSON.stringify(p.arguments) : p.type,
      );
      console.log("ASSISTANT " + JSON.stringify(parts).slice(0, 3000));
    } else if (ev.type === "message_end" && ev.message?.role === "toolResult") {
      console.log("TOOLRESULT " + JSON.stringify(ev.message).slice(0, 2000));
    } else {
      console.log("EVENT " + JSON.stringify(ev).slice(0, 3000));
    }
  }
});

child.stderr.on("data", (c) => process.stderr.write("ERR " + String(c)));
child.on("close", (code) => { console.log("EXIT " + code); finish(0); });

child.stdin.write(JSON.stringify({ type: "prompt", id: "1", message: msg }) + "\n");
setTimeout(() => { console.log("TIMEOUT after " + timeoutS + "s"); finish(2); }, timeoutS * 1000);
