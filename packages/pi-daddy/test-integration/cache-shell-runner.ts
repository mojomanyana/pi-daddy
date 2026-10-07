/** Trusted qualification entry: runs stock SDK/CLI beneath the existing namespace lifetime guard. */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { finishShellObserverWitness } from "./cache-shell-observer.ts";

interface Invocation {
  executable: string;
  args: string[];
  env: Record<string, string>;
  rpcPrompt?: string;
  abortOnOutput?: boolean;
  observerWitness?: string;
}

export async function startCacheProcess(args: string[]): Promise<void> {
  const invocation = JSON.parse(args[0]) as Invocation;
  setInterval(() => {}, 1000);
  setImmediate(() => {
    const child = spawn(invocation.executable, invocation.args, {
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0,
      overflow = false,
      controlError = "",
      pending = "",
      aborted = false;
    const decoder = new StringDecoder("utf8");
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      if (published) return;
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    };
    let published = false;
    const publish = async (code: number | null, signal: string | null, running: boolean) => {
      if (published) return;
      published = true;
      let observerWitness;
      if (invocation.observerWitness) {
        try {
          observerWitness = await finishShellObserverWitness(invocation.observerWitness);
        } catch (error) {
          controlError = `${controlError ? controlError + "; " : ""}fixture observer: ${String(error)}`;
        }
      }
      process.stdout.write(
        JSON.stringify({
          kind: "shell-fixture",
          code,
          signal,
          running,
          observerWitness,
          overflow,
          controlError,
          aborted,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }) + "\n",
      );
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (published) return;
      collect(stdout, chunk);
      if (!invocation.abortOnOutput) return;
      pending += decoder.write(chunk);
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let event: { type?: string };
        try {
          const parsed: unknown = JSON.parse(line);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !("type" in parsed) ||
            typeof parsed.type !== "string" ||
            !parsed.type
          )
            throw new Error("expected a non-null RPC event object with a type");
          event = { type: parsed.type };
        } catch (error) {
          controlError = `fixture RPC protocol: ${String(error)}`;
          child.kill("SIGKILL");
          return;
        }
        if (!aborted && event.type === "tool_execution_update" && line.includes("STARTED")) {
          aborted = true;
          child.stdin.write(JSON.stringify({ type: "abort", id: "fixture-abort" }) + "\n");
        } else if (aborted && event.type === "agent_settled") {
          // Publish a nonterminal observation. Pi stays LIVE until the caller has checked
          // command descendants: no Pi signal handler/namespace teardown can mask abort failure.
          void publish(null, null, true);
          return;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", (error) => {
      controlError = error.message;
    });
    child.on("error", (error) => {
      controlError = error.message;
    });
    child.once("close", (code, signal) => {
      void publish(code, signal, false);
    });
    if (invocation.rpcPrompt)
      child.stdin.write(JSON.stringify({ type: "prompt", id: "fixture-prompt", message: invocation.rpcPrompt }) + "\n");
    else child.stdin.end();
  });
}
