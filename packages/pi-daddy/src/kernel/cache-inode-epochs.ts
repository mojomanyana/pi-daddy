/**
 * Processed-observation bookkeeping ONLY. Tickets do not certify current source, coherent acquisition,
 * complete filesystem coverage or eligibility. Fixed physical objects do not follow replaced pathnames;
 * directory coverage is immediate, not recursive. Epochs are not syscall counts (kernel coalescing is allowed).
 * Input and methods are trusted coordinator internals, not caller-supplied evidence or authority endpoints.
 */
import { INODE_MASK, INODE_MAX_OBJECTS, type InodeWatch, type InodeEvent } from "./cache-inode-protocol.ts";
export interface InodeObservationTicket {
  readonly observationTicket?: never;
}
const changes =
  INODE_MASK.MODIFY |
  INODE_MASK.ATTRIB |
  INODE_MASK.MOVED_FROM |
  INODE_MASK.MOVED_TO |
  INODE_MASK.CREATE |
  INODE_MASK.DELETE |
  INODE_MASK.DELETE_SELF |
  INODE_MASK.MOVE_SELF;
export class InodeEpochs {
  private readonly rows: Array<InodeWatch & { epoch: number }>;
  private readonly watches = new Map<number, Array<InodeWatch & { epoch: number }>>();
  private readonly tickets = new WeakMap<InodeObservationTicket, Array<{ index: number; epoch: number }>>();
  private reason: string | undefined;
  private readonly maxEpoch: number;
  constructor(objects: readonly InodeWatch[], maxEpoch = Number.MAX_SAFE_INTEGER) {
    this.maxEpoch = maxEpoch;
    if (!objects.length || objects.length > INODE_MAX_OBJECTS)
      throw new Error("inode observation object count is invalid");
    if (!Number.isSafeInteger(maxEpoch) || maxEpoch < 1) throw new Error("inode observation epoch bound is invalid");
    const physical = new Map<string, number>();
    this.rows = objects.map((entry, index) => {
      if (entry.index !== index) throw new Error("inode observation index is not contiguous");
      if (
        !Number.isSafeInteger(entry.wd) ||
        entry.wd < 1 ||
        entry.wd > 2147483647 ||
        !/^(?:0|[1-9]\d*)$/.test(entry.dev) ||
        !/^(?:0|[1-9]\d*)$/.test(entry.ino) ||
        !["file", "directory", "symlink"].includes(entry.kind)
      )
        throw new Error("inode observation identity is invalid");
      const row = { ...entry, epoch: 0 },
        aliases = this.watches.get(row.wd) ?? [];
      if (aliases.some((other) => other.dev !== row.dev || other.ino !== row.ino || other.kind !== row.kind))
        throw new Error("inode observation watch identity disagrees");
      const key = `${row.dev}:${row.ino}`,
        prior = physical.get(key);
      if (prior !== undefined && prior !== row.wd)
        throw new Error("inode observation physical identity has split watches");
      physical.set(key, row.wd);
      aliases.push(row);
      this.watches.set(row.wd, aliases);
      return row;
    });
  }
  get lossReason() {
    return this.reason;
  }
  manifest(): InodeWatch[] {
    return this.rows.map(({ epoch: _, ...entry }) => ({ ...entry }));
  }
  lose(reason: string) {
    this.reason ??= reason || "unspecified inode observation loss";
  }
  event(event: InodeEvent) {
    if (this.reason) throw new Error(`inode observation lost: ${this.reason}`);
    const fail = (reason: string): never => {
      this.lose(reason);
      throw new Error(`inode observation lost: ${reason}`);
    };
    if (event.mask & (INODE_MASK.OVERFLOW | INODE_MASK.UNMOUNT | INODE_MASK.IGNORED)) fail("kernel watch loss");
    const rows = this.watches.get(event.wd);
    if (!rows) fail("unknown watch descriptor");
    if (!(event.mask & changes) || event.mask & ~(changes | INODE_MASK.ISDIR)) fail("unknown event mask");
    const membership = INODE_MASK.CREATE | INODE_MASK.DELETE | INODE_MASK.MOVED_FROM | INODE_MASK.MOVED_TO;
    const self = INODE_MASK.MOVE_SELF | INODE_MASK.DELETE_SELF;
    const directory = rows![0].kind === "directory",
      named = event.nameHex.length > 0;
    // inotify deliberately strips ISDIR on MOVE_SELF/DELETE_SELF, even for directories.
    // Directory ATTRIB/MODIFY on self carry ISDIR; entry flags describe the entry, not its parent.
    if (
      (!directory && (named || event.mask & (membership | INODE_MASK.ISDIR))) ||
      (named && event.mask & self) ||
      (!named && event.mask & membership) ||
      (!named && event.mask & self && event.mask & INODE_MASK.ISDIR) ||
      (!named && directory && !(event.mask & self) && !(event.mask & INODE_MASK.ISDIR))
    )
      fail("incompatible watch type or event scope");
    if (rows!.some((row) => row.epoch === this.maxEpoch)) fail("epoch limit reached");
    for (const row of rows!) row.epoch++;
  }
  ticket(indices: readonly number[]): InodeObservationTicket {
    if (this.reason) throw new Error(`inode observation lost: ${this.reason}`);
    if (!indices.length || indices.length > this.rows.length || new Set(indices).size !== indices.length)
      throw new Error("inode observation ticket scope is invalid");
    const values = indices.map((index) => {
      if (!Number.isSafeInteger(index) || !this.rows[index])
        throw new Error("inode observation ticket asks for uncovered object");
      return { index, epoch: this.rows[index].epoch };
    });
    const handle = Object.freeze({});
    this.tickets.set(handle, values);
    return handle;
  }
  observationsUnchanged(ticket: InodeObservationTicket) {
    const values = this.tickets.get(ticket);
    if (!values) throw new Error("inode observation ticket is foreign or fabricated");
    return !this.reason && values.every((value) => this.rows[value.index].epoch === value.epoch);
  }
}
