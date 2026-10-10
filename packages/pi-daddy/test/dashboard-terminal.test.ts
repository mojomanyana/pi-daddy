import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { recordLines } from "./record-fixtures.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

/** The VT operations emitted by this CLI, replayed into persistent cells instead of stripping ANSI. */
class TerminalCells {
  cells: string[][] = [];
  row = 0;
  column = 0;
  scrolls = 0;
  width = 0;
  height = 0;
  resize(width: number, height: number): void {
    this.cells = Array.from({ length: height }, (_, row) =>
      Array.from({ length: width }, (_, column) => this.cells[row]?.[column] ?? " "),
    );
    this.width = width;
    this.height = height;
    this.row = Math.min(this.row, height - 1);
    this.column = Math.min(this.column, width - 1);
  }
  write(text: string): void {
    while (text) {
      const control = /^\u001b\[([0-9;]*)([HJKm])/.exec(text);
      if (control) {
        const mode = Number(control[1] || "0");
        if (control[2] === "H") this.row = this.column = 0;
        else if (control[2] === "K") this.cells[this.row].fill(" ", mode === 2 ? 0 : this.column);
        else if (control[2] === "J") {
          assert.equal(mode, 0, "the dashboard must not clear the whole screen on each changed frame");
          this.cells[this.row].fill(" ", this.column);
          for (let row = this.row + 1; row < this.height; row++) this.cells[row].fill(" ");
        }
        text = text.slice(control[0].length);
        continue;
      }
      const character = String.fromCodePoint(text.codePointAt(0)!);
      text = text.slice(character.length);
      assert.notEqual(character, "\u001b", "unexpected terminal operation in the fixture");
      if (character === "\r") this.column = 0;
      else if (character === "\n") {
        // Normal PTY output processing maps LF to CRLF; explicit CRLF is also supported.
        this.column = 0;
        this.row++;
        if (this.row === this.height) {
          this.cells.shift();
          this.cells.push(Array(this.width).fill(" "));
          this.row--;
          this.scrolls++;
        }
      } else {
        assert.ok(this.column < this.width, "frame text must fit the viewport");
        this.cells[this.row][this.column++] = character;
      }
    }
  }
  lines(): string[] {
    return this.cells.map((row) => row.join("").trimEnd());
  }
}

test("changed CLI frames erase old cells through Versions, current work, and viewport changes without scrolling", async () => {
  const cwd = await tempDir("dashboard-terminal-cells-"),
    ledgerPath = join(cwd, "ledger.jsonl");
  await writeFile(
    ledgerPath,
    recordLines({
      ledgerVersion: 3,
      ts: "2026-10-09T00:00:00.000Z",
      executionId: "exec:00000000-0000-4000-8000-000000000001",
      parentExecutionId: null,
      childId: "d0.1",
      event: "capability_decision",
      parentId: "d0",
      depth: 1,
      agentType: "review-with-a-long-previous-row",
      requested: ["tool:read"],
      parentGrant: ["tool:read"],
      effective: ["tool:read"],
      denied: [],
      clipped: [],
      gatedBlocked: [],
      blocked: false,
      executor: "process",
      taskDigest: "a".repeat(64),
    }),
  );
  const entry = new URL("../src/products/dashboard-cli.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { setImmediate as nextTurn } from "node:timers/promises";
    const { runDashboard } = await import(${JSON.stringify(entry)});
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true });
    process.stdout.columns = 42; process.stdout.rows = 16;
    const output = process.stdout.write.bind(process.stdout), frames = [];
    let onFrame;
    process.stdout.write = value => {
      if (String(value).startsWith("\\u001b[H") && onFrame) {
        const done = onFrame; onFrame = undefined; done(String(value));
      }
      return true;
    };
    process.stdin.setRawMode = value => { process.stdin.isRaw = value; return process.stdin; };
    process.stdin.resume = process.stdin.pause = () => process.stdin;
    async function draw(action) {
      const frame = new Promise(resolve => { onFrame = resolve; });
      action();
      const timeout = setTimeout(() => { throw Error("dashboard did not redraw"); }, 2000);
      frames.push({ width: process.stdout.columns, height: process.stdout.rows, text: await frame });
      clearTimeout(timeout);
      await nextTurn();
    }
    const key = name => process.stdin.emit("keypress", name, { name });
    let done;
    try {
      await draw(() => { done = runDashboard(["--ledger", ${JSON.stringify(ledgerPath)}, "--no-color"], {}); });
      await draw(() => key("v"));
      await draw(() => key("escape"));
      await draw(() => { process.stdout.columns = 80; process.stdout.rows = 24; process.emit("SIGWINCH"); });
      await draw(() => { process.stdout.columns = 42; process.stdout.rows = 10; key("v"); });
    } finally {
      process.emit("SIGTERM");
      await done;
    }
    assert.equal(process.stdin.isRaw, false);
    output(JSON.stringify(frames));
  `;
  const frames = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd,
      timeout: 15000,
      encoding: "utf8",
    }),
  ) as { width: number; height: number; text: string }[];
  const terminal = new TerminalCells();
  for (const [index, frame] of frames.entries()) {
    terminal.resize(frame.width, frame.height);
    terminal.write(frame.text);
    const expected = frame.text
      .replace(/\u001b\[[0-9;]*[HJKm]/g, "")
      .replace(/\r/g, "")
      .split("\n");
    assert.equal(expected.length, frame.height);
    assert.deepEqual(terminal.lines(), expected, `frame ${index}: visible cells must contain only this frame`);
    assert.equal(terminal.scrolls, 0, "painting the last row must not scroll the pane");
    assert.equal(terminal.row, frame.height - 1);
    if (index === 1 || index === 4) {
      assert.equal(terminal.lines()[2], "VERSIONS");
      assert.ok(
        terminal
          .lines()
          .slice(4, -2)
          .every((line) => line === ""),
        "old task rows must disappear",
      );
    } else assert.equal(terminal.lines()[2], "CURRENT WORK");
  }
});

test("consent instructions follow refreshed owner status and selected JEV route", async () => {
  const cwd = await tempDir("dashboard-jev-consent-"),
    ledgerPath = join(cwd, "ledger.jsonl");
  await writeFile(ledgerPath, "");
  const entry = new URL("../src/products/dashboard-cli.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { createServer } from "node:net";
    import { setImmediate as nextTurn } from "node:timers/promises";
    const { runDashboard } = await import(${JSON.stringify(entry)});
    const socketPath = ${JSON.stringify(join(cwd, "owner.sock"))};
    let jev = {available:true, enabled:false, pending:false, availability:"disabled"};
    const server = createServer(socket => {
      let input="";
      socket.on("data", bytes => {
        input+=bytes;
        if(!input.includes("\\n")) return;
        const request=JSON.parse(input);
        if(request.action==="set-jev") jev={available:true,enabled:false,pending:true,availability:"disabled"};
        socket.end(JSON.stringify({ok:true,rows:[],cost:null,auto:{enabled:false,source:"session"},pendingApprovals:[],
          settings:{editable:true,wallSeconds:21600,idleSeconds:900,wallSource:"startup",idleSource:"startup",
            descendants:8,reserved:0,maxDepth:2,perCall:8,jev}}));
      });
    });
    await new Promise(resolve=>server.listen(socketPath,resolve));
    Object.defineProperty(process.stdin,"isTTY",{value:true});
    Object.defineProperty(process.stdout,"isTTY",{value:true});
    process.stdout.columns=100;process.stdout.rows=28;
    let onFrame;
    process.stdout.write=value=>{
      if(String(value).startsWith("\\u001b[H") && onFrame){const accept=onFrame;onFrame=undefined;accept(String(value));}
      return true;
    };
    process.stdin.setRawMode=value=>{process.stdin.isRaw=value;return process.stdin;};
    process.stdin.resume=process.stdin.pause=()=>process.stdin;
    async function draw(action, pattern){
      const frame=new Promise(resolve=>{
        onFrame=function accept(value){if(pattern && !pattern.test(value)){onFrame=accept;return;}resolve(value);};
      });
      const timeout=setTimeout(()=>{throw Error("dashboard did not draw expected state");},3000);
      action();
      const value=await frame;clearTimeout(timeout);await nextTurn();return value;
    }
    const key=name=>process.stdin.emit("keypress",name,{name});
    let done;
    try{
      await draw(()=>{done=runDashboard(["--ledger",${JSON.stringify(ledgerPath)},"--no-color"],{
        PI_DADDY_DASHBOARD_SESSION_SOCKET:socketPath,PI_DADDY_DASHBOARD_SESSION_TOKEN:"fixture-token"});});
      await draw(()=>key("s"));
      await draw(()=>key("down"));
      const pending=await draw(()=>key("return"),/Complete JEV paid-call/);
      assert.match(pending,/JEV: waiting for consent/);
      jev={available:true,enabled:true,pending:false,availability:"ready",selectedProvider:"typesafe",selectedModel:"jev-latest",transport:"pi-classifier"};
      const enabled=await draw(()=>process.emit("SIGWINCH"),/JEV enabled; ready/);
      assert.doesNotMatch(enabled,/Complete JEV paid-call|waiting for consent/);
      assert.match(enabled,/Model: typesafe\\/jev-latest/);
      assert.match(enabled,/Via: pi-classifier/);
    }finally{
      process.emit("SIGTERM");await done;await new Promise(resolve=>server.close(resolve));
    }
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], { cwd, timeout: 12000, encoding: "utf8" });
});
