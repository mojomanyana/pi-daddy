/** Bounded local framing; this channel carries private execution input only between its two owners. */
import type { Socket } from "node:net";
export const HERDR_WIRE_LIMIT = 8 * 1024 * 1024;
export function wire(socket: Socket, receive: (value: any) => void, failed: (error: Error) => void) {
  let pending = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fail = (error: unknown) => {
    failed(error instanceof Error ? error : new Error(String(error)));
    socket.destroy();
  };
  socket.on("data", (bytes) => {
    try {
      pending += decoder.decode(bytes, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        if (Buffer.byteLength(pending.slice(0, end)) > HERDR_WIRE_LIMIT)
          throw Error("Herdr transport record exceeds bound");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        receive(JSON.parse(line));
      }
      if (Buffer.byteLength(pending) > HERDR_WIRE_LIMIT) throw Error("Herdr transport record exceeds bound");
    } catch (error) {
      fail(error);
    }
  });
  socket.on("end", () => {
    try {
      pending += decoder.decode();
      if (pending) throw Error("Herdr transport record is incomplete");
    } catch (error) {
      fail(error);
    }
  });
  socket.on("error", (error) => failed(error));
  return (value: unknown) => {
    const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > HERDR_WIRE_LIMIT || socket.writableLength > HERDR_WIRE_LIMIT * 2)
      throw Error("Herdr transport buffering exceeds bound");
    if (socket.destroyed || !socket.writable) throw Error("Herdr transport is closed");
    socket.write(text);
  };
}
