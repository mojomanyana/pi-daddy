import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("terminal operator cancels a draft, then applies a one-request mode with combined emphases once", async () => {
  const cwd = await tempDir("dashboard-work-mode-terminal-");
  const ledgerPath = join(cwd, "ledger.jsonl");
  await writeFile(ledgerPath, "");
  const entry = new URL("../src/products/dashboard-cli.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { createServer } from "node:net";
    import { setImmediate as nextTurn } from "node:timers/promises";
    const { runDashboard } = await import(${JSON.stringify(entry)});
    const socketPath = ${JSON.stringify(join(cwd, "owner.sock"))};
    const owner = {sessionId:"owner",cwd:"/work",generation:"one"};
    let sequence=0;
    const edits=[];
    let workMode={available:true,inherited:false,selection:{mode:"standard",emphases:[]},active:{mode:"standard",emphases:[]}};
    const server=createServer(socket=>{
      let input="";
      socket.on("data",bytes=>{
        input+=bytes;
        if(!input.includes("\\n")) return;
        const request=JSON.parse(input);
        assert.equal(request.token,"fixture-token");
        if(request.action==="set-work-mode"){
          assert.deepEqual(request.expectedOwner,owner);
          edits.push(request);
          workMode={...workMode,nextRequest:request.selection};
        }
        socket.end(JSON.stringify({ok:true,...(request.action==="set-work-mode"?{workModeApplied:true}:{}),
          rows:[],cost:null,auto:{enabled:false,source:"session"},pendingApprovals:[],
          observation:{version:1,...owner,sequence:++sequence,observedAt:new Date().toISOString(),
            capture:{transcripts:false,diagnostics:false},resources:{scope:"owner-process",sampledAt:new Date().toISOString(),rssBytes:0,hostHealth:"unknown"},activity:[],artifacts:[],sources:[]},
          settings:{editable:true,wallSeconds:21600,idleSeconds:900,wallSource:"startup",idleSource:"startup",
            descendants:8,reserved:0,maxDepth:2,perCall:8,jev:{available:false,enabled:false,pending:false},workMode}}));
      });
    });
    await new Promise(resolve=>server.listen(socketPath,resolve));
    Object.defineProperty(process.stdin,"isTTY",{value:true});
    Object.defineProperty(process.stdout,"isTTY",{value:true});
    process.stdout.columns=110;process.stdout.rows=34;
    let onFrame;
    process.stdout.write=value=>{
      if(String(value).startsWith("\\u001b[H") && onFrame){const accept=onFrame;onFrame=undefined;accept(String(value));}
      return true;
    };
    process.stdin.setRawMode=value=>{process.stdin.isRaw=value;return process.stdin;};
    process.stdin.resume=process.stdin.pause=()=>process.stdin;
    async function draw(action,pattern){
      const frame=new Promise(resolve=>{
        onFrame=function accept(value){if(pattern&&!pattern.test(value)){onFrame=accept;return;}resolve(value);};
      });
      const timeout=setTimeout(()=>{throw Error("dashboard did not draw expected work mode state");},3000);
      action();const value=await frame;clearTimeout(timeout);await nextTurn();return value;
    }
    const key=name=>process.stdin.emit("keypress",name,{name});
    let done;
    try{
      await draw(()=>{done=runDashboard(["--ledger",${JSON.stringify(ledgerPath)},"--no-color"],{
        PI_DADDY_DASHBOARD_SESSION_SOCKET:socketPath,PI_DADDY_DASHBOARD_SESSION_TOKEN:"fixture-token"});},/Work mode/);
      await draw(()=>key("s"));
      await draw(()=>key("down"));
      await draw(()=>key("return"),/WORK MODE · draft/);
      await draw(()=>key("return"),/Ambitious/);
      await draw(()=>key("escape"),/Session: Standard/);
      assert.equal(edits.length,0,"cancel never sends a mode edit");
      await draw(()=>key("return"),/WORK MODE · draft/);
      await draw(()=>key("return"),/Ambitious/);
      await draw(()=>key("down"));
      await draw(()=>key("return"),/Next request only/);
      await draw(()=>key("down"));
      await draw(()=>key("return"),/\\[x\\] Faster delivery/);
      await draw(()=>key("down"));
      await draw(()=>key("down"));
      await draw(()=>key("return"),/\\[x\\] Deeper proof/);
      await draw(()=>key("down"));
      await draw(()=>key("down"));
      const applied=await draw(()=>key("return"),/Next request: Ambitious/);
      assert.match(applied,/Active now: Standard/);
      assert.match(applied,/Session: Standard/);
      assert.match(applied,/Permission Auto: OFF/);
      assert.equal(edits.length,1);
      assert.equal(edits[0].scope,"next-request");
      assert.deepEqual(edits[0].selection,{mode:"ambitious",emphases:["speed","depth"]});
    }finally{
      process.emit("SIGTERM");await done;await new Promise(resolve=>server.close(resolve));
    }
  `;
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd,
      timeout: 15000,
      encoding: "utf8",
    }),
  );
});
