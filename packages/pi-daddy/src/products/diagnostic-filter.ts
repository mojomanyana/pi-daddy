/** Local diagnostic projection. Known private fields are omitted; free-text secret detection is heuristic. */
import { parseRetentionJson } from "../governance/retention-json.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const privateKey = new RegExp(
  "^(?:thinking|reasoning|reasoning_content|reasoning_details|encrypted_content|thoughtSignature|thinkingSignature|signature|" +
    "env|environment|environ|credentials?|authorization|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|secret)$",
  "i",
);
const privateType = /^(?:thinking|reasoning|redacted_thinking|reasoning_content|reasoning_details)$/i;
export interface DiagnosticFilterResult {
  bytes: Buffer;
  omissions: Record<string, number>;
}
export type DiagnosticFormat = "session" | "json" | "jsonl" | "text";

export function filterDiagnostic(bytes: Uint8Array, format: DiagnosticFormat): DiagnosticFilterResult {
  const omissions: Record<string, number> = {};
  const note = (reason: string) => (omissions[reason] = (omissions[reason] ?? 0) + 1);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const redact = (input: string): string => {
    let output = input.replace(
      /\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      () => {
        note("credential-pattern");
        return "[REDACTED]";
      },
    );
    output = output.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/<>"']+@/gi, (_match, scheme: string) => {
      note("credential-url-userinfo");
      return `${scheme}[REDACTED]@`;
    });
    output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, () => {
      note("credential-pattern");
      return "Bearer [REDACTED]";
    });
    output = output.replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)|API_KEY|TOKEN|PASSWORD|SECRET)(\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      (_match, key: string, separator: string) => {
        note("credential-assignment");
        return `${key}${separator}[REDACTED]`;
      },
    );
    return output;
  };
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 64) throw new Error("diagnostic nesting exceeds bounds");
    if (typeof value === "string") {
      // JSON embedded in a packet is a byte-bearing string. Keep it exactly when no redaction is needed.
      if (/^\s*[\[{]/.test(value)) {
        let parsed: unknown;
        try {
          parsed = parseRetentionJson(value, 16 * 1024 * 1024);
        } catch {
          return redact(value);
        }
        const filtered = clean(parsed, depth + 1);
        return JSON.stringify(filtered) === JSON.stringify(parsed) ? value : JSON.stringify(filtered);
      }
      return redact(value);
    }
    if (Array.isArray(value))
      return value.flatMap((item) => {
        if (object(item) && typeof item.type === "string" && privateType.test(item.type)) {
          note("private-reasoning");
          return [];
        }
        return [clean(item, depth + 1)];
      });
    if (!object(value)) return value;
    if (typeof value.type === "string" && privateType.test(value.type)) {
      note("private-reasoning");
      return null;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (privateKey.test(key) || /(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PASSWORD|SECRET)$/.test(key)) {
        note("private-field");
        continue;
      }
      result[key] = clean(item, depth + 1);
    }
    return result;
  };
  const pick = (value: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
  const session = (value: unknown): unknown => {
    if (!object(value)) throw new Error("invalid native session record");
    const envelope = pick(value, ["type", "id", "parentId", "timestamp"]);
    if (value.type === "session") return clean({ ...envelope, ...pick(value, ["version", "cwd", "parentSession"]) });
    if (value.type === "message" && object(value.message)) {
      const message = value.message;
      if (!["user", "assistant", "toolResult"].includes(String(message.role))) {
        note("unsupported-message");
        return { ...envelope, omitted: "unsupported-message" };
      }
      const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      if (!Array.isArray(content)) throw new Error("invalid native message content");
      const visible = content.flatMap((block: unknown) => {
        if (!object(block)) throw new Error("invalid native content block");
        if (block.type === "text" && typeof block.text === "string") return [pick(block, ["type", "text"])];
        if (block.type === "toolCall") return [pick(block, ["type", "id", "name", "arguments"])];
        note(typeof block.type === "string" && privateType.test(block.type) ? "private-reasoning" : "non-text-content");
        return [];
      });
      return clean({
        ...envelope,
        message: {
          ...pick(message, ["role", "toolCallId", "toolName", "isError", "provider", "model", "stopReason", "usage"]),
          content: visible,
        },
      });
    }
    if (["model_change", "thinking_level_change", "session_info"].includes(String(value.type)))
      return clean({ ...envelope, ...pick(value, ["provider", "modelId", "thinkingLevel", "name"]) });
    note("unsupported-session-entry");
    return clean({ ...envelope, omitted: "unsupported-session-entry" });
  };
  let output: string;
  if (format === "text") output = redact(text);
  else if (format === "json") output = JSON.stringify(clean(parseRetentionJson(text, 16 * 1024 * 1024))) + "\n";
  else {
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (format === "session") {
      const header = parseRetentionJson(lines[0] ?? "", 16 * 1024 * 1024);
      if (!object(header) || header.type !== "session" || header.version !== 3 || typeof header.id !== "string")
        throw new Error("expected native Pi session v3");
    }
    output =
      lines
        .map((line) => {
          const value = parseRetentionJson(line, 16 * 1024 * 1024);
          return JSON.stringify(format === "session" ? session(value) : clean(value));
        })
        .join("\n") + "\n";
  }
  return { bytes: Buffer.from(output), omissions };
}
