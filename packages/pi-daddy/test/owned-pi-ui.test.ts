import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { after, test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir, cleanupTempDirs } from "./tmp.ts";
after(cleanupTempDirs);

const extension = new URL("../src/executors/owned-pi-ui.ts", import.meta.url).href;
const view = new URL("../src/executors/owned-pi-view.ts", import.meta.url).href;
const header = {
  type: "session",
  version: 3,
  id: "actual-fixture-session",
  cwd: "/fixture",
  timestamp: "2026-10-09T00:00:00.000Z",
};
const user = { role: "user", content: "actual initial task", timestamp: 1 };
const assistant = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "private thinking fixture" },
    { type: "text", text: "exact final" },
  ],
  usage: { input: 2, output: 3 },
  stopReason: "stop",
  timestamp: 2,
};
const events = [
  { type: "agent_start" },
  { type: "message_end", message: user },
  { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "fixture.txt" } },
  {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "read",
    partialResult: { content: [{ type: "text", text: "partial" }] },
  },
  {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "result" }] },
    isError: false,
  },
  {
    type: "message_update",
    message: assistant,
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "exact final", partial: assistant },
  },
  { type: "message_end", message: assistant },
  { type: "agent_end", messages: [user, assistant] },
  { type: "agent_settled", aborted: false },
];
const keys = [
  "another task\r",
  "/quit\r",
  "!touch unexpected\r",
  "\x03",
  "\x1b",
  "\x10",
  "\x1b[200~pasted task\x1b[201~",
  "\x0f",
  "\x1b[111;5u",
];
async function runFixture(mode = "tui", withPipe = true, trust?: { agentDir: string; paths: string[] }) {
  const script = `
    import {closeSync} from "node:fs";
    import ownedPiUi from ${JSON.stringify(extension)};
    import ownedPiView from ${JSON.stringify(view)};
    const handlers = new Map(), subscriptions = new Map(); let input, transform, expanded=false, toggles=0, status, editorText="pretyped shell command", delayedInputs=[];
    const ctx = {
      mode:${JSON.stringify(mode === "json" ? "json" : "tui")},
      ui:{onTerminalInput(fn){input=fn;return ()=>{}},getToolsExpanded(){return expanded},
        setToolsExpanded(value){expanded=value;toggles++},setEditorText(value){editorText=value},setStatus(key,value){status={key,value}}},
      sessionManager:{getHeader(){return ${JSON.stringify(header)}},getSessionId(){return ${JSON.stringify(header.id)}}},
      shutdown(){console.log(JSON.stringify({shutdown:true,toggles,inputs,cellReply,status,editorText,delayedInputs,
        hidden:transform('private thinking fixture',{messageType:'assistant-thinking'}),
        assistant:transform('visible reply',{messageType:'assistant'}),user:transform('visible task',{messageType:'user'})}));}
    };
    if(!${withPipe}){try{closeSync(6)}catch{}}
    const api = {
      on(name,handler){const list=handlers.get(name)||[];list.push(handler);handlers.set(name,list)},
      registerMarkdownTransformer(fn){transform=fn},
      events:{on(name,handler){subscriptions.set(name,handler);return ()=>subscriptions.delete(name)},emit(name,data){subscriptions.get(name)?.(data)}}
    };
    if(${JSON.stringify(mode)}!=="no-guard")ownedPiView(api);
    api.on('session_start', async()=>{
      if(${JSON.stringify(mode)}==='no-guard')return;
      delayedInputs.push(input('!touch unexpected\\r'));
      await new Promise(resolve=>setImmediate(resolve));
      delayedInputs.push(input('/settings\\r'));
    });
    api.on('message_end', event=>{
      if(event.message.role==='assistant')event.message.content[1].text+=' transformed';
    });
    ownedPiUi(api);
    const emit=async(name,event,context)=>{for(const handler of handlers.get(name)||[])await handler(event,context)};
    if(${JSON.stringify(mode)}==='trust'){
      const decisions=await Promise.all(${JSON.stringify(trust?.paths ?? [])}.map(cwd=>handlers.get("project_trust")[0]({type:"project_trust",cwd},{})));
      console.log(JSON.stringify(decisions));process.exit(0);
    }
    if(${JSON.stringify(mode)}==='no-hook')ctx.ui.onTerminalInput=undefined;
    await emit('session_start',{type:'session_start'},ctx);
    const inputs=${JSON.stringify(keys)}.map(key=>input(key));
    const cellReply=input('\x1b[6;16;8t');
    const events=${JSON.stringify(events)}; events[4].result.content[0].text="large-result:"+"x".repeat(256*1024);
    for(const event of events)await emit(event.type,event,ctx);
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: trust ? { ...process.env, PI_CODING_AGENT_DIR: trust.agentDir } : process.env,
    stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", ...(withPipe ? ["pipe" as const] : [])],
  });
  let stdout = "",
    stderr = "",
    protocol = "";
  child.stdout!.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  if (withPipe)
    (child.stdio.at(6) as Readable).on("data", (chunk: Buffer) => {
      protocol += chunk;
    });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr, protocol };
}

test("owned Pi UI preserves actual events, hides only rendered thinking, and consumes task/control input", async () => {
  const result = await runFixture();
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(result.stdout);
  assert.equal(state.shutdown, true);
  assert.equal(state.toggles, 2);
  assert.equal(state.editorText, "");
  assert.deepEqual(state.delayedInputs, [{ consume: true }, { consume: true }]);
  assert.deepEqual(state.status, {
    key: "pi-daddy-owned",
    value: "View only · parent controls the task · Ctrl+O expands tools",
  });
  assert.equal(state.cellReply, undefined);
  assert.deepEqual(
    state.inputs,
    keys.map(() => ({ consume: true })),
  );
  assert.equal(state.hidden, "Thinking hidden");
  assert.equal(state.assistant, "visible reply");
  assert.equal(state.user, "visible task");
  const records = result.protocol
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const expected = JSON.parse(JSON.stringify(events)) as any[];
  expected[4].result.content[0].text = "large-result:" + "x".repeat(256 * 1024);
  expected[6].message.content[1].text += " transformed";
  expected[5] = {
    type: "message_update",
    usage: assistant.usage,
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "exact final" },
  };
  assert.deepEqual(records, [header, ...expected]);
  assert.ok(
    result.protocol.includes("private thinking fixture"),
    "render-only hiding must not alter authoritative events",
  );
});

test("missing event pipe or native TUI controls terminate rather than leave an unrestricted child", async () => {
  for (const [mode, pipe] of [
    ["tui", false],
    ["json", true],
    ["no-hook", true],
    ["no-guard", true],
  ] as const) {
    const result = await runFixture(mode, pipe);
    assert.equal(result.code, 70, result.stderr);
    assert.match(result.stderr, /owned Pi UI refused/);
    assert.equal(result.stdout, "");
    assert.equal(result.protocol, "");
  }
});

test("view-only project trust preserves remembered decisions and global defaults without config writes", async () => {
  const root = await tempDir("pd-owned-ui-trust-");
  const agentDir = join(root, "agent");
  const paths = [join(root, "unknown"), join(root, "trusted"), join(root, "refused")];
  await mkdir(agentDir);
  for (const cwd of paths) await mkdir(join(cwd, ".pi"), { recursive: true });
  const projectSettings = join(paths[0], ".pi", "settings.json");
  await writeFile(projectSettings, JSON.stringify({ defaultProjectTrust: "always" }));
  const trustPath = join(agentDir, "trust.json"),
    settingsPath = join(agentDir, "settings.json");
  const savedTrust = JSON.stringify({ [paths[1]]: true, [paths[2]]: false });
  await writeFile(trustPath, savedTrust);
  for (const defaultProjectTrust of ["ask", "always"] as const) {
    const savedSettings = JSON.stringify({ defaultProjectTrust });
    await writeFile(settingsPath, savedSettings);
    const result = await runFixture("trust", true, { agentDir, paths });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { trusted: defaultProjectTrust === "always" ? "yes" : "no", remember: false },
      { trusted: "yes", remember: false },
      { trusted: "no", remember: false },
    ]);
    assert.equal(await readFile(trustPath, "utf8"), savedTrust);
    assert.equal(await readFile(settingsPath, "utf8"), savedSettings);
    assert.equal(await readFile(projectSettings, "utf8"), JSON.stringify({ defaultProjectTrust: "always" }));
  }
  await writeFile(trustPath, "malformed trust fixture");
  const refused = await runFixture("trust", true, { agentDir, paths });
  assert.equal(refused.code, 70);
  assert.match(refused.stderr, /owned Pi UI refused/);
  assert.equal(refused.stdout, "");
});
