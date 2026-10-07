/** Pi 1.0.4 current final: JSON settlement plus the exact persisted session active branch. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { BoundedReadCleanupError, readBoundedBytes } from "../kernel/bounded-read.ts";
const MAX_FINAL_BYTES = 4 * 1024 * 1024,
  MAX_LINE_BYTES = 32 * 1024 * 1024,
  MAX_SESSION_BYTES = 64 * 1024 * 1024;
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export type ChildFinal =
  | { state: "complete"; text: string; sessionId: string; messageId: string; leafId: string; sha256: string }
  | { state: "unavailable"; reason: string; diagnosticText?: string };
export class ChildFinalCapture {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private problem?: string;
  private sessionId?: string;
  private settled = false;
  private active = new Set<string>();
  private final?: Record<string, any>;
  private user?: Record<string, any>;
  private readonly onText?: (text: string) => void;
  private readonly onReadCleanup?: (error: BoundedReadCleanupError) => void;
  constructor(onText?: (text: string) => void, onReadCleanup?: (error: BoundedReadCleanupError) => void) {
    this.onText = onText;
    this.onReadCleanup = onReadCleanup;
  }
  observe(bytes: Buffer): void {
    if (this.problem) return;
    try {
      this.buffer += this.decoder.decode(bytes, { stream: true });
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw Error("protocol line exceeds capture bound");
        if (line.trim()) this.event(JSON.parse(line));
      }
      if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) throw Error("protocol line exceeds capture bound");
    } catch (error) {
      this.problem = String(error);
    }
  }
  private event(event: unknown): void {
    if (!object(event) || typeof event.type !== "string") throw Error("malformed protocol event");
    if (event.type === "session") {
      if (this.sessionId || typeof event.id !== "string" || event.version !== 3)
        throw Error("ambiguous session header");
      this.sessionId = event.id;
      return;
    }
    if (!this.sessionId) throw Error("protocol event precedes session identity");
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta" &&
      typeof event.assistantMessageEvent.delta === "string"
    ) {
      try {
        this.onText?.(event.assistantMessageEvent.delta);
      } catch {
        /* display is observational */
      }
    }
    if (["agent_start", "turn_start", "message_start", "message_update"].includes(event.type)) {
      this.settled = false;
      this.final = undefined;
    }
    if (event.type === "tool_execution_start") {
      this.settled = false;
      this.final = undefined;
      if (typeof event.toolCallId !== "string" || this.active.has(event.toolCallId))
        throw Error("ambiguous tool start");
      this.active.add(event.toolCallId);
    }
    if (event.type === "tool_execution_end") {
      this.settled = false;
      if (!this.active.delete(event.toolCallId)) throw Error("unmatched tool completion");
    }
    if (event.type === "message_end") {
      if (!object(event.message)) throw Error("malformed message end");
      this.settled = false;
      this.final = undefined;
      if (event.message.role === "user") {
        this.user = event.message;
        this.final = undefined;
        this.settled = false;
      }
      if (event.message.role === "assistant") {
        this.final = event.message;
        this.settled = false;
      }
    }
    if (event.type === "agent_settled") this.settled = true;
  }
  private visible(): string {
    if (!Array.isArray(this.final?.content)) return "";
    return this.final.content
      .filter((b: unknown) => object(b) && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
  }
  async finish(sessionPath: string, expectedSessionId?: string, readSession = readBoundedBytes): Promise<ChildFinal> {
    const unavailable = (reason: string): ChildFinal => ({
      state: "unavailable",
      reason,
      ...(this.visible() ? { diagnosticText: this.visible().slice(0, 8192) } : {}),
    });
    try {
      this.buffer += this.decoder.decode();
      if (this.buffer.trim()) throw Error("unterminated protocol record");
      if (this.problem) throw Error(this.problem);
      if (!this.sessionId || (expectedSessionId && this.sessionId !== expectedSessionId))
        throw Error("session identity mismatch");
      if (!this.settled || this.active.size) throw Error("current run is not settled");
      const final = this.final;
      if (
        !final ||
        !this.user ||
        final.stopReason !== "stop" ||
        !Array.isArray(final.content) ||
        final.content.some((b: unknown) => !object(b) || !["text", "thinking"].includes(b.type)) ||
        final.content.some((b: any) => b.type === "text" && typeof b.text !== "string")
      )
        throw Error("no eligible current terminal assistant message");
      const text = this.visible();
      if (!text || Buffer.byteLength(text) > MAX_FINAL_BYTES)
        throw Error("complete final is empty or exceeds capture bound");
      let path = sessionPath;
      if (expectedSessionId) {
        const names = (await readdir(sessionPath)).filter((n) => n.endsWith(`_${expectedSessionId}.jsonl`));
        if (names.length !== 1) throw Error("exact fork session is missing or ambiguous");
        path = join(sessionPath, names[0]);
      }
      const read = await readSession(path, { maxBytes: MAX_SESSION_BYTES, timeoutMs: 3000 });
      if (!read.ok) throw Error(`session read unavailable: ${read.detail}`);
      const source = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
      if (!source.endsWith("\n")) throw Error("incomplete session record");
      const entries = source
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const header = entries[0];
      if (!object(header) || header.type !== "session" || header.version !== 3 || header.id !== this.sessionId)
        throw Error("persisted session identity mismatch");
      const seen = new Set<string>();
      for (const entry of entries.slice(1)) {
        if (
          !object(entry) ||
          entry.type === "session" ||
          typeof entry.id !== "string" ||
          seen.has(entry.id) ||
          (entry.parentId !== null && !seen.has(entry.parentId))
        )
          throw Error("ambiguous session tree");
        seen.add(entry.id);
      }
      // Public SDK derives the active branch from the already bounded, validated in-memory bytes.
      const manager = SessionManager.inMemory(header.cwd, undefined, entries as FileEntry[]);
      const branch = manager.getBranch();
      const messages = branch.filter((e) => e.type === "message");
      const last = messages.at(-1),
        currentUser = messages.findLast((e) => e.message.role === "user");
      if (
        !last ||
        last.message.role !== "assistant" ||
        !isDeepStrictEqual(last.message, final) ||
        !currentUser ||
        !isDeepStrictEqual(currentUser.message, this.user)
      )
        throw Error("stream final does not match the current persisted branch and turn");
      return {
        state: "complete",
        text,
        sessionId: this.sessionId,
        messageId: last.id,
        leafId: manager.getLeafId()!,
        sha256: hash(text),
      };
    } catch (error) {
      if (error instanceof BoundedReadCleanupError) {
        if (!this.onReadCleanup) throw error;
        this.onReadCleanup(error);
      }
      return unavailable(String(error));
    }
  }
}
