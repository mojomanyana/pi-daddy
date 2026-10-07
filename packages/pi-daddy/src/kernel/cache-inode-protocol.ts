/** Fixed-descriptor observation framing. A drained queue is NOT current-source or capture certification. */
export const INODE_MAX_OBJECTS = 4096;
export const INODE_MAX_FRAME = 640;
export const INODE_MASK = {
  MODIFY: 2,
  ATTRIB: 4,
  MOVED_FROM: 64,
  MOVED_TO: 128,
  CREATE: 256,
  DELETE: 512,
  DELETE_SELF: 1024,
  MOVE_SELF: 2048,
  UNMOUNT: 8192,
  OVERFLOW: 16384,
  IGNORED: 32768,
  ISDIR: 1073741824,
} as const;
export interface InodeWatch {
  index: number;
  wd: number;
  dev: string;
  ino: string;
  kind: "file" | "directory" | "symlink";
}
export interface InodeEvent {
  wd: number;
  mask: number;
  cookie: number;
  nameHex: string;
}
export type InodeFrame =
  | { kind: "ready"; count: number }
  | { kind: "watch"; object: InodeWatch }
  | { kind: "armed" }
  | ({ kind: "event" } & InodeEvent)
  | { kind: "drained"; seq: number }
  | { kind: "fault"; reason: string; errno: number };

const malformed = () => new Error("inode observation frame is malformed or incompatible");
function number(text: string, max: number, min = 0) {
  if (!/^(?:0|[1-9]\d*)$/.test(text)) throw malformed();
  const result = Number(text);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw malformed();
  return result;
}
function identity(text: string) {
  if (!/^(?:0|[1-9]\d*)$/.test(text) || text.length > 20 || BigInt(text) > 18446744073709551615n) throw malformed();
  return text;
}
export function parseInodeFrame(frame: string): InodeFrame {
  if (Buffer.byteLength(frame) > INODE_MAX_FRAME || !/^I1 [\x21-\x7e]+(?: [\x21-\x7e]+)*\n$/.test(frame))
    throw malformed();
  const fields = frame.slice(0, -1).split(" ");
  if (fields[1] === "READY" && fields.length === 3)
    return { kind: "ready", count: number(fields[2], INODE_MAX_OBJECTS, 1) };
  if (fields[1] === "ARMED" && fields.length === 2) return { kind: "armed" };
  if (
    fields[1] === "W" &&
    fields.length === 7 &&
    (fields[6] === "file" || fields[6] === "directory" || fields[6] === "symlink")
  )
    return {
      kind: "watch",
      object: {
        index: number(fields[2], INODE_MAX_OBJECTS - 1),
        wd: number(fields[3], 2147483647, 1),
        dev: identity(fields[4]),
        ino: identity(fields[5]),
        kind: fields[6],
      },
    };
  if (fields[1] === "E" && fields.length === 6) {
    const nameHex = fields[5] === "-" ? "" : fields[5];
    if (nameHex && (!/^(?:[a-f0-9]{2})+$/.test(nameHex) || nameHex.length > 510)) throw malformed();
    const bytes = Buffer.from(nameHex, "hex");
    if (bytes.includes(0) || bytes.includes(47)) throw malformed();
    return {
      kind: "event",
      wd: fields[2] === "-1" ? -1 : number(fields[2], 2147483647, 1),
      mask: number(fields[3], 4294967295, 1),
      cookie: number(fields[4], 4294967295),
      nameHex,
    };
  }
  if (fields[1] === "D" && fields.length === 3)
    return { kind: "drained", seq: number(fields[2], Number.MAX_SAFE_INTEGER, 1) };
  if (fields[1] === "F" && fields.length === 4 && /^[A-Z][A-Z_]{0,39}$/.test(fields[2]))
    return { kind: "fault", reason: fields[2], errno: number(fields[3], 4095) };
  throw malformed();
}
