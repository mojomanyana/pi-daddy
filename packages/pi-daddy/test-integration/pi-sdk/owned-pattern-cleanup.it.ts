/** Actual Pi argv and Bash cleanup under the native owner, with an entirely local provider. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runOwnedChild } from "../../src/executors/owned-worker.ts";
import { MODEL, PROVIDER, FINAL } from "./scripted-provider.ts";

test("real Pi excludes the delegated cleanup pattern from its worker and helper argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pattern-cleanup-"));
  try {
    const agentDir = join(root, "agent"),
      owner = join(root, "owner");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "auth.json"), "{}");
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
    const selector = "forma-real-pi-" + randomUUID(),
      observations = join(root, "observations.json");
    const servicePath = join(root, "service.cjs"),
      cleanupPath = join(root, "cleanup.cjs");
    await writeFile(
      servicePath,
      `process.on('SIGTERM',()=>{process.send('TERM');process.exit(0)});process.send('ready');setInterval(()=>{},1000);`,
    );
    await writeFile(
      cleanupPath,
      `
const fs=require('node:fs'),cp=require('node:child_process'),{once}=require('node:events');
(async()=>{
 const selector=process.env.FORMA_SELECTOR;
 const identity=JSON.parse(fs.readFileSync(process.env.FORMA_OWNERSHIP,'utf8')).identity;
 const stat=pid=>fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ');
 const session=Number(stat(identity.helperPid)[3]);
 const service=cp.spawn(process.execPath,[process.env.FORMA_SERVICE,selector],{stdio:['ignore','ignore','inherit','ipc']});
 let serviceTerm=false;service.on('message',message=>{if(message==='TERM')serviceTerm=true});
 await once(service,'message');const closed=once(service,'close');
 const ancestors=[];let pid=service.pid;
 while(pid>1&&ancestors.length<32){ancestors.push(pid);if(pid===identity.helperPid)break;pid=Number(stat(pid)[1]);}
 if(session!==identity.helperPid||Number(stat(identity.workerPid)[3])!==session||ancestors.at(-1)!==identity.helperPid||!ancestors.includes(identity.workerPid))
   throw Error('Refusing cleanup without exact owned ancestry');
 // Pi Bash creates its own session. Both selected sessions must belong to this recorded tree.
 const serviceSession=Number(stat(service.pid)[3]);
 if(!ancestors.includes(serviceSession))throw Error('Refusing cleanup outside an owned session');
 const sessions=[...new Set([session,serviceSession])].join(',');
 const selected=cp.spawnSync('pgrep',['--session',sessions,'--full',selector],{encoding:'utf8',timeout:1000});
 if(selected.status!==0)throw Error('Missing service selection');
 const matched=selected.stdout.trim().split(/\\s+/).map(Number);
 if(matched.length!==1||matched[0]!==service.pid)throw Error('Refusing cleanup: selector matched beyond the exact fixture service');
 const helperArgv=fs.readFileSync('/proc/'+identity.helperPid+'/cmdline').toString().split('\\0').filter(Boolean);
 const workerArgv=fs.readFileSync('/proc/'+identity.workerPid+'/cmdline').toString().split('\\0').filter(Boolean);
 const killed=cp.spawnSync('pkill',['--echo','--signal','TERM','--session',sessions,'--full',selector],{encoding:'utf8',timeout:1000});
 if(killed.status!==0)throw Error('Fixture service cleanup failed');await closed;
 const observed={identity,selector,matched,helperArgv,workerArgv,sessions,ancestors,servicePid:service.pid,serviceTerm,
   serviceExit:service.exitCode,helperAlive:stat(identity.helperPid)[19]===identity.helperStartTicks,
   workerAlive:!!stat(identity.workerPid),pkill:{status:killed.status,signal:killed.signal,echo:killed.stdout}};
 fs.writeFileSync(process.env.FORMA_OBSERVATIONS,JSON.stringify(observed));process.stdout.write('local service cleanup complete');
})().catch(error=>{process.stderr.write(error.message);process.exit(1)});
`,
    );
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const cli =
      process.env.DADDY_TEST_PI_CLI ??
      fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    let stdout = "";
    const result = await runOwnedChild({
      executionId: "actual-pi-pattern",
      ownershipDir: owner,
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
        " Local fixture service cleanup selector: " + selector,
      ],
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        NO_COLOR: "1",
        TERM: "dumb",
        P07_BASH_COMMAND: quote(process.execPath) + " " + quote(cleanupPath),
        FORMA_SELECTOR: selector,
        FORMA_SERVICE: servicePath,
        FORMA_OWNERSHIP: join(owner, "ownership.json"),
        FORMA_OBSERVATIONS: observations,
      },
      timeoutMs: 15000,
      killGraceMs: 80,
      captureStdout: false,
      onObservation(stream, bytes) {
        if (stream === "stdout") stdout += Buffer.from(bytes).toString();
      },
    });
    assert.equal(result.code, 0);
    assert.equal(result.cleanup.state, "settled");
    const events = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert(
      events.some((event) => event.type === "tool_execution_end" && event.toolName === "bash" && !event.isError),
      JSON.stringify(events.filter((event) => event.type === "tool_execution_end")),
    );
    const terminal = events
      .filter((event) => event.type === "message_end" && event.message.role === "assistant")
      .at(-1).message;
    assert.equal(terminal.stopReason, "stop");
    assert.equal(terminal.content[0].text, FINAL);
    assert.equal(events.at(-1).type, "agent_settled");
    const observed = JSON.parse(await readFile(observations, "utf8"));
    assert.deepEqual(observed.matched, [observed.servicePid]);
    assert.equal(
      observed.helperArgv.some((arg: string) => arg.includes(selector)),
      false,
    );
    assert.equal(
      observed.workerArgv.some((arg: string) => arg.includes(selector)),
      false,
    );
    assert.deepEqual(observed.workerArgv, ["pi"]);
    assert.equal(observed.serviceTerm, true);
    assert.equal(observed.serviceExit, 0);
    assert.equal(observed.helperAlive, true);
    assert.equal(observed.workerAlive, true);
    if (process.env.DADDY_TEST_PATTERN_RECEIPT)
      await writeFile(
        process.env.DADDY_TEST_PATTERN_RECEIPT,
        JSON.stringify({ cli, observed, result, final: terminal, settledEvent: events.at(-1) }, null, 2),
        { flag: "wx" },
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
