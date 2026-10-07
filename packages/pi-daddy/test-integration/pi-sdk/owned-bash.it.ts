/** Real stable Pi Bash execution under the packaged native owner; no remote model. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { connect } from "node:net";
import { runOwnedChild } from "../../src/executors/owned-worker.ts";
import { FINAL, MODEL, PROVIDER } from "./scripted-provider.ts";
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
for (const mode of ["ordinary", "detached", "late-fork", "resistant-preview-server"])
  test(`real Pi Bash worker ownership: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-owned-bash-"));
    try {
      const agentDir = join(root, "agent");
      await mkdir(agentDir);
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultProjectTrust: "always",
          enableAnalytics: false,
          enableInstallTelemetry: false,
          retry: { enabled: false },
          compaction: { enabled: false },
          cacheWarming: "off",
        }),
      );
      const marker = join(root, "workers");
      const record = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,start:fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19]})+'\\n');`;
      const late = record + "setInterval(()=>{},1000)";
      const daemon =
        record +
        (mode === "late-fork"
          ? `let done=false;process.on('SIGTERM',()=>{if(done)return;done=true;require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(late)}],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>process.exit(0),40)});`
          : "") +
        "setInterval(()=>{},1000)";
      let command =
        mode === "ordinary"
          ? "printf fixture"
          : quote(process.execPath) +
            " -e " +
            quote(
              `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>process.exit(0),150)`,
            );
      if (mode === "resistant-preview-server") {
        const daemon = String.raw`const fs=require('node:fs');const server=require('node:http').createServer((_req,res)=>res.end('preview-ready'));
          process.on('SIGTERM',()=>fs.appendFileSync(${JSON.stringify(join(root, "term-seen"))},'TERM\n'));
          server.listen(0,'127.0.0.1',()=>fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,
            start:fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19],port:server.address().port})+'\n'));`;
        command =
          quote(process.execPath) +
          " -e " +
          quote(`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{detached:true,stdio:'ignore'}).unref();
          setTimeout(()=>{const record=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(marker)},'utf8'));
          require('node:http').get({hostname:'127.0.0.1',port:record.port},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>process.exit(body==='preview-ready'?0:1));});},150);`);
      }
      const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
      let stdout = "";
      const result = await runOwnedChild({
        executionId: "pi-bash-" + mode,
        ownershipDir: join(root, "owner"),
        cwd: root,
        command: process.execPath,
        args: [
          cli,
          "--no-session",
          "--no-extensions",
          "-e",
          fileURLToPath(new URL("./owned-bash-extension.ts", import.meta.url)),
          "--no-mcp",
          "--no-skills",
          "--no-prompt-templates",
          "--tools",
          "bash",
          "--mode",
          "json",
          "--provider",
          PROVIDER,
          "--model",
          MODEL,
          "--thinking",
          "high",
          "local fixture",
        ],
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: root,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          P07_BASH_COMMAND: command,
          NO_COLOR: "1",
          TERM: "dumb",
        },
        timeoutMs: 10000,
        killGraceMs: 80,
        captureStdout: false,
        onObservation(stream, bytes) {
          if (stream === "stdout") stdout += Buffer.from(bytes).toString();
        },
      });
      assert.equal(result.code, 0);
      assert.equal(result.cleanup.state, "settled");
      assert.equal(result.text, "");
      const events = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.ok(
        events.some((event) => event.type === "tool_execution_end" && event.toolName === "bash" && !event.isError),
      );
      const terminal = events
        .filter((event) => event.type === "message_end" && event.message.role === "assistant")
        .at(-1).message;
      assert.equal(terminal.stopReason, "stop");
      assert.equal(terminal.content[0].text, FINAL);
      assert.equal(events.at(-1).type, "agent_settled");
      if (mode !== "ordinary") {
        const records = (await readFile(marker, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.ok(records.length >= (mode === "late-fork" ? 2 : 1));
        if (mode === "resistant-preview-server") {
          assert.match(await readFile(join(root, "term-seen"), "utf8"), /TERM/);
          const closed = await new Promise<boolean>((resolve) => {
            const socket = connect({ host: "127.0.0.1", port: records[0].port });
            socket.on("connect", () => {
              socket.destroy();
              resolve(false);
            });
            socket.on("error", (error) => {
              resolve((error as NodeJS.ErrnoException).code === "ECONNREFUSED");
            });
            socket.setTimeout(500, () => {
              socket.destroy();
              resolve(false);
            });
          });
          assert.equal(closed, true, "preview listener remains after qualified cleanup");
        }
        for (const worker of records) {
          const stat = await readFile(`/proc/${worker.pid}/stat`, "utf8").catch(() => "");
          assert.ok(!stat || stat.split(") ")[1].split(" ")[19] !== worker.start, "actual Pi Bash descendant remains");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
