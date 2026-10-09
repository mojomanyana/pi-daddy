/** Packaged pane entrypoint. Parent liveness is a private socket, native worker liveness is its control pipe. */
import { stat } from "node:fs/promises";
import { processTreeActivity } from "./process-activity.ts";
import { createConnection } from "node:net";
import { runOwnedChild, type OwnedChildRunRequest } from "./owned-worker.ts";
import { wire } from "./herdr-wire.ts";
import { herdrAgentDisplay } from "./herdr-agent-display.ts";
export async function launchHerdrWorker(socketPath: string, token: string): Promise<void> {
  const socket = createConnection(socketPath);
  const abort = new AbortController();
  let started = false,
    authenticated = false,
    terminalUi = false,
    acknowledge: (() => void) | undefined,
    rejectGate: ((error: Error) => void) | undefined;
  const lost = (error: Error) => {
    abort.abort();
    rejectGate?.(error);
  };
  socket.on("close", () => lost(Error("Herdr coordinator connection closed")));
  const send = wire(
    socket,
    (message) => {
      if (message?.type === "cancel") {
        abort.abort();
        rejectGate?.(Error("Herdr coordinator cancelled startup"));
        return;
      }
      if (message?.type === "start" && authenticated) {
        acknowledge?.();
        acknowledge = undefined;
        rejectGate = undefined;
        return;
      }
      if (message?.type === "display" && authenticated && typeof message.text === "string") {
        if (!terminalUi) process.stdout.write(message.text);
        return;
      }
      if (message?.type !== "request" || started) {
        lost(Error("invalid Herdr coordinator request"));
        socket.destroy();
        return;
      }
      started = true;
      authenticated = true;
      const request = message.request as OwnedChildRunRequest & { sessionPath?: string };
      terminalUi = request.terminalUi === true;
      let childPid: number | undefined;
      const display = herdrAgentDisplay(message.display);
      let settled = false;
      void (async () => {
        const wasRaw = process.stdin.isRaw;
        try {
          if (terminalUi && process.stdin.isTTY) process.stdin.setRawMode(true);
          const result = await runOwnedChild({
            ...request,
            signal: abort.signal,
            activityProbe: async () => {
              const file = request.sessionPath
                ? await stat(request.sessionPath)
                    .then((s) => String(s.size) + ":" + s.mtimeMs)
                    .catch(() => undefined)
                : undefined;
              const tree = childPid === undefined ? undefined : await processTreeActivity(childPid);
              return file === undefined && tree === undefined ? undefined : String(file) + "|" + tree;
            },
            onOwnership: (identity) =>
              new Promise<void>((resolve, reject) => {
                acknowledge = resolve;
                rejectGate = reject;
                if (abort.signal.aborted) {
                  reject(Error("Herdr coordinator unavailable before ownership gate"));
                  return;
                }
                send({ type: "ownership", identity });
              }),
            onObservation: (stream, bytes) => {
              try {
                const input = Buffer.from(bytes);
                for (let offset = 0; offset < input.length; offset += 65536)
                  send({ type: "bytes", stream, data: input.subarray(offset, offset + 65536).toString("base64") });
              } catch (error) {
                lost(error instanceof Error ? error : Error(String(error)));
              }
            },
            onStreamEnd: (stream) => {
              try {
                send({ type: "stream-end", stream });
              } catch {}
            },
            onSpawn: (pid) => {
              childPid = pid;
              void display.working();
              send({ type: "spawned", pid });
              if (!terminalUi) process.stdout.write("pi-daddy: governed child running\n");
            },
          });
          settled = result.cleanup.state === "settled" || result.cleanup.state === "not-started";
          // Mark only this owned terminal as settled; this is cosmetic, not process or sidebar authority.
          // Unknown cleanup keeps its existing title, and a killed launcher cannot reset it.
          if (terminalUi && settled) process.stdout.write("\x1b]0;Task settled\x07");
          const displayReleased = await display.finish(settled);
          if (!socket.destroyed) {
            send({ type: "result", result, displayReleased: settled && displayReleased });
            socket.end();
          }
          process.stdout.write("\npi-daddy: " + result.cleanup.state + "\n");
        } catch (error) {
          await display.finish(settled);
          if (!socket.destroyed) {
            try {
              send({ type: "failure", reason: String(error) });
            } finally {
              socket.end();
            }
          }
        } finally {
          try {
            if (terminalUi && process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
          } catch {
            // A lost pane cannot be restored; native cleanup remains independently recorded.
          }
        }
      })();
    },
    lost,
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      try {
        send({ type: "hello", token });
      } catch (error) {
        reject(error);
      }
    });
    socket.once("close", resolve);
    socket.once("error", reject);
  });
}
if (/herdr-launcher\.(?:js|ts)$/.test(process.argv[1] ?? "")) {
  const [, , path, token] = process.argv;
  if (!path || !token) throw Error("Herdr launcher requires its private socket and nonce");
  await launchHerdrWorker(path, token);
}
