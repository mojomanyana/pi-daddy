/** Herdr sidebar observations only; never permission, execution or settlement authority. */
import { createConnection } from "node:net";
export interface HerdrAgentDisplay {
  source: string;
  role: string;
}
/** The pane launcher owns these reports, so coordinator loss still reaches native cleanup and release. */
export function herdrAgentDisplay(display: HerdrAgentDisplay, env: NodeJS.ProcessEnv = process.env) {
  let pending = Promise.resolve(false);
  const socketPath = env.HERDR_SOCKET_PATH,
    paneId = env.HERDR_PANE_ID;
  function publish(method: string, extra: Record<string, unknown>, seq: number): Promise<boolean> {
    pending = pending.then(async () => {
      if (env.HERDR_ENV !== "1" || !socketPath || !paneId) return false;
      const request = {
        id: display.source + ":" + seq,
        method,
        params: { pane_id: paneId, source: display.source, agent: "pi", seq, ...extra },
      };
      const delivered = await new Promise<boolean>((resolve) => {
        let finished = false,
          buffer = "";
        const socket = createConnection(socketPath);
        const finish = (ok: boolean) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), 750);
        socket.on("error", () => finish(false));
        socket.on("end", () => finish(false));
        socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
        socket.on("data", (bytes) => {
          buffer += bytes.toString();
          if (buffer.length > 16384) return finish(false);
          const end = buffer.indexOf("\n");
          if (end < 0) return;
          try {
            const reply = JSON.parse(buffer.slice(0, end));
            finish(reply.id === request.id && !reply.error && reply.result !== undefined);
          } catch {
            finish(false);
          }
        });
      }).catch(() => false);
      if (!delivered) console.error("pi-daddy: Herdr agent sidebar report unavailable");
      return delivered;
    });
    return pending;
  }
  return {
    working: () => {
      void publish("pane.report_agent", { state: "working" }, 1);
      // Metadata has its own sequence namespace and is visible only while our exact lifecycle source owns the pane.
      return publish(
        "pane.report_metadata",
        {
          applies_to_source: display.source,
          title: display.role,
          display_agent: "Pi / " + display.role,
        },
        1,
      );
    },
    finish: (settled: boolean) =>
      settled
        ? publish("pane.release_agent", {}, 2)
        : publish("pane.report_agent", { state: "unknown", message: "Native cleanup is unverified" }, 2),
  };
}
