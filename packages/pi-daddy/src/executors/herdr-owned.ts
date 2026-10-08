/** Governed work runs in its own Herdr pane, under the same independently settling native owner as captured work. */
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedChildRunRequest, OwnedChildRunResult } from "./owned-worker.ts";
import type { CapturedWorkerIdentity } from "../kernel/captured-worker-contract.ts";
import {
  isCapturedWorkerIdentity,
  readCapturedWorkerReceipt,
  validateLiveWorker,
} from "../governance/captured-worker-record.ts";
import { defaultExec, parseReply, type HerdrExec } from "./herdr-cli.ts";
import { WORKER_SHA256 } from "./worker-artifact.ts";
import { wire } from "./herdr-wire.ts";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export interface HerdrOwnedOptions {
  exec?: HerdrExec;
  workspace?: string;
  keepPane?: boolean;
  onPane?: (paneId: string, tabId: string) => void;
  onDisplay?: (display: (text: string) => void) => void;
  /** Tests may select a freshly built launcher. Production always uses the packaged build. */
  launcherPath?: string;
}
export async function runHerdrOwned(
  request: OwnedChildRunRequest,
  options: HerdrOwnedOptions = {},
): Promise<OwnedChildRunResult> {
  const exec = options.exec ?? defaultExec;
  const directory = await mkdtemp(join(tmpdir(), "pd-herdr-"));
  const path = join(directory, "owner.sock"),
    token = randomUUID();
  const launcher =
    options.launcherPath ?? fileURLToPath(new URL("../../dist/executors/herdr-launcher.js", import.meta.url));
  const helper = fileURLToPath(new URL("../../native/linux-x64/worker", import.meta.url));
  let socket: Socket | undefined, send: ((value: unknown) => void) | undefined;
  let identity: CapturedWorkerIdentity | undefined, outcome: OwnedChildRunResult | undefined, error: string | undefined;
  let tabId: string | undefined,
    entered = false,
    done = false,
    authenticated = false;
  let finish!: () => void;
  const startupTimer = setTimeout(
    () => {
      fail("Herdr launcher did not connect before startup deadline");
      socket?.destroy();
      finish();
    },
    Math.min(request.timeoutMs ?? 10000, 10000),
  );
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const abort = () => {
    try {
      send?.({ type: "cancel" });
    } catch {}
  };
  const fail = (cause: unknown) => {
    error ??= String(cause);
    abort();
  };
  const server = createServer((candidate) => {
    if (socket) {
      candidate.destroy();
      return;
    }
    socket = candidate;
    send = wire(
      candidate,
      (message) => {
        if (!authenticated) {
          if (message?.type !== "hello" || message.token !== token) throw Error("Herdr launcher nonce mismatch");
          authenticated = true;
          clearTimeout(startupTimer);
          const {
            signal: _signal,
            onOwnership: _owner,
            onSpawn: _spawn,
            onOutput: _out,
            onObservation: _observation,
            onStreamEnd: _end,
            activityProbe: _probe,
            ...serializable
          } = request;
          send!({ type: "request", request: serializable });
          return;
        }
        if (message?.type === "ownership") {
          if (identity || !isCapturedWorkerIdentity(message.identity)) throw Error("ambiguous Herdr worker ownership");
          const actual = message.identity as CapturedWorkerIdentity;
          if (
            actual.executionId !== request.executionId ||
            actual.root !== request.cwd ||
            actual.helperSha256 !== WORKER_SHA256 ||
            actual.ownershipPath !== join(request.ownershipDir, "ownership.json")
          )
            throw Error("Herdr worker identity differs from requested execution");
          identity = actual;
          void (async () => {
            try {
              await validateLiveWorker(actual, helper);
              await request.onOwnership?.(actual);
              if (!done && !request.signal?.aborted && !error) {
                request.onSpawn?.(actual.workerPid);
                send!({ type: "start" });
              } else abort();
            } catch (cause) {
              fail(cause);
              abort();
            }
          })();
          return;
        }
        if (
          message?.type === "bytes" &&
          ["stdout", "stderr"].includes(message.stream) &&
          typeof message.data === "string"
        ) {
          if (
            !identity ||
            message.data.length > 90000 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)
          )
            throw Error("invalid Herdr output frame");
          try {
            request.onObservation?.(message.stream, Buffer.from(message.data, "base64"));
          } catch {}
          return;
        }
        if (message?.type === "stream-end" && ["stdout", "stderr"].includes(message.stream)) {
          try {
            request.onStreamEnd?.(message.stream);
          } catch {}
          return;
        }
        if (message?.type === "spawned" && identity && message.pid === identity.workerPid) {
          return;
        }
        if (message?.type === "result" && !outcome) {
          outcome = message.result;
          return;
        }
        if (message?.type === "failure") {
          fail(message.reason);
          return;
        }
        throw Error("invalid Herdr worker transport message");
      },
      fail,
    );
    options.onDisplay?.((text) => {
      if (authenticated && send) {
        for (let at = 0; at < text.length; at += 16000) send({ type: "display", text: text.slice(at, at + 16000) });
      }
    });
    candidate.on("close", finish);
  });
  const timeout = setTimeout(
    () => {
      fail("Herdr execution exceeded its transport deadline");
      socket?.destroy();
      finish();
    },
    (request.timeoutMs ?? 3600000) + Math.min(request.killGraceMs ?? 1500, 60000) + 7000,
  );
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    if (request.signal?.aborted || (request.hardDeadlineAt !== undefined && request.hardDeadlineAt <= Date.now()))
      return {
        code: null,
        text: "",
        truncated: false,
        timedOut: false,
        aborted: true,
        cleanup: { state: "not-started", reason: "cancelled before Herdr pane launch" },
      };
    const created = parseReply(
      await exec([
        "tab",
        "create",
        "--cwd",
        request.cwd,
        "--label",
        "pi-daddy governed child",
        "--no-focus",
        ...(options.workspace ? ["--workspace", options.workspace] : []),
      ]),
    );
    if (created.error) throw Error(created.error);
    const pane = created.result?.root_pane as { pane_id?: string; tab_id?: string } | undefined;
    tabId = pane?.tab_id;
    if (!pane?.pane_id || !tabId) throw Error("Herdr creation returned no exact pane/tab identity");
    options.onPane?.(pane.pane_id, tabId);
    if (error || request.signal?.aborted) throw Error(error ?? "cancelled before Herdr command launch");
    entered = true;
    const launchReply = await exec([
      "pane",
      "run",
      pane.pane_id,
      (options.keepPane ? "" : "exec ") + [process.execPath, launcher, path, token].map(quote).join(" "),
    ]);
    if (launchReply.code !== 0) throw Error(parseReply(launchReply).error ?? "Herdr pane launch failed");
    if (launchReply.stdout.trim()) {
      const launched = parseReply(launchReply);
      if (launched.error) throw Error(launched.error);
    }
    await completed;
    if (outcome?.cleanup?.state === "not-started" && !identity) return outcome;
    if (!outcome || !identity) throw Error(error ?? "Herdr launcher closed without a complete result/ownership");
    const receipt = await readCapturedWorkerReceipt(identity);
    if (!receipt) throw Error("Herdr worker supplied no independently verified cleanup receipt");
    return { ...outcome, cleanup: { state: "settled", identity, receipt }, ...(error ? { spawnError: error } : {}) };
  } catch (cause) {
    fail(cause);
    socket?.destroy();
    // Lost transport is never evidence of cleanup. Reconcile only the original bound receipt.
    let receipt = identity ? await readCapturedWorkerReceipt(identity) : null;
    const deadline = Date.now() + Math.min(request.killGraceMs ?? 1500, 60000) + 5500;
    while (identity && !receipt && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      receipt = await readCapturedWorkerReceipt(identity);
    }
    return {
      code: receipt?.workerCode ?? null,
      text: "",
      truncated: false,
      timedOut: false,
      aborted: Boolean(request.signal?.aborted),
      spawnError: error ?? String(cause),
      cleanup:
        identity && receipt
          ? { state: "settled", identity, receipt }
          : entered
            ? { state: "unknown", ...(identity ? { identity } : {}), reason: error ?? String(cause) }
            : { state: "not-started", reason: error ?? String(cause) },
    };
  } finally {
    done = true;
    clearTimeout(timeout);
    clearTimeout(startupTimer);
    request.signal?.removeEventListener("abort", abort);
    socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tabId && !options.keepPane) {
      const closed = parseReply(await exec(["tab", "close", tabId]));
      if (closed.error && !/tab .* not found|tab_not_found/.test(closed.error))
        console.error("pi-daddy: settled worker pane could not close:", closed.error);
    }
    await rm(directory, { recursive: true, force: true });
  }
}
