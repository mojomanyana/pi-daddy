import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CacheShellRequestDecoder,
  cacheShellOutput,
  cacheShellExit,
  cacheShellSignal,
} from "../src/kernel/cache-shell-protocol.ts";
function request(
  fields = {
    shell: "/bin/bash",
    cwd: "/tmp",
    args: ["-c", "printf '雪\\n'"],
    environment: ["B=two", "A=one", "EMPTY="],
  },
) {
  const integer = (value: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value);
    return b;
  };
  const text = (value: string) => {
    const b = Buffer.from(value);
    return Buffer.concat([integer(b.length), b]);
  };
  const body = Buffer.concat([
    text(fields.shell),
    text(fields.cwd),
    integer(fields.args.length),
    ...fields.args.map(text),
    integer(fields.environment.length),
    ...fields.environment.map(text),
  ]);
  return Buffer.concat([Buffer.from("CS1\0"), integer(body.length), body]);
}
test("native shell request codec preserves effective invocation boundaries and ordered environment", () => {
  const decoder = new CacheShellRequestDecoder(),
    encoded = request();
  let result;
  for (const byte of encoded) result = decoder.feed(Buffer.from([byte])) ?? result;
  assert.deepEqual(result, {
    shell: "/bin/bash",
    cwd: "/tmp",
    args: ["-c", "printf '雪\\n'"],
    environment: ["B=two", "A=one", "EMPTY="],
  });
  assert.throws(() => decoder.feed(Buffer.from("G")), /request already complete/);
});
test("native request limits, invalid text, duplicates and incompatible shapes are refusals", () => {
  for (const fields of [
    { shell: "bash", cwd: "/tmp", args: ["-c", "x"], environment: [] },
    { shell: "/bin/bash", cwd: "tmp", args: ["-c", "x"], environment: [] },
    { shell: "/bin/bash", cwd: "/tmp", args: ["-l"], environment: [] },
    { shell: "/bin/bash", cwd: "/tmp", args: ["-c", "x".repeat(65537)], environment: [] },
    { shell: "/bin/bash", cwd: "/tmp", args: ["-c", "x"], environment: ["A=1", "A=2"] },
    { shell: "/bin/bash", cwd: "/tmp", args: ["-c", "x"], environment: ["=x"] },
    { shell: "/bin/bash", cwd: "/tmp", args: ["-c", "x"], environment: ["NOT_A_BINDING"] },
    { shell: "/bin/bash", cwd: "/tmp", args: ["-c", "x"], environment: ["X=\0"] },
  ])
    assert.throws(() => new CacheShellRequestDecoder().feed(request(fields)), /shell request/);
  for (const input of [
    Buffer.from("CS2\0\0\0\0\0"),
    Buffer.from("CS1\0\xff\xff\xff\xff"),
    Buffer.concat([request(), Buffer.from("x")]),
  ])
    assert.throws(() => new CacheShellRequestDecoder().feed(input), /shell request/);
  const bad = request();
  bad[12] = 0xff;
  assert.throws(() => new CacheShellRequestDecoder().feed(bad), /shell request/);
});
test("failed request decoders are terminal and never reinterpret later bytes", () => {
  const decoder = new CacheShellRequestDecoder();
  assert.throws(() => decoder.feed(Buffer.from("CS2\0\0\0\0\0")), /shell request/);
  assert.throws(() => decoder.feed(request()), /request already complete/);
});
test("shell response encoders preserve raw byte channels and validate terminal status", () => {
  assert.deepEqual(cacheShellOutput("stdout", Buffer.from([0, 255, 10])), Buffer.from([79, 0, 0, 0, 3, 0, 255, 10]));
  assert.deepEqual(cacheShellOutput("stderr", Buffer.from("x")), Buffer.from([69, 0, 0, 0, 1, 120]));
  assert.deepEqual(cacheShellExit(7), Buffer.from([88, 0, 0, 0, 7]));
  assert.deepEqual(cacheShellSignal(15), Buffer.from([83, 0, 0, 0, 15]));
  for (const value of [-1, 256, 1.5, NaN]) assert.throws(() => cacheShellExit(value), /exit/);
  for (const value of [0, 19, 64, 1.5]) assert.throws(() => cacheShellSignal(value), /signal/);
  assert.throws(() => cacheShellOutput("stdout", Buffer.alloc(0)), /chunk/);
  assert.throws(() => cacheShellOutput("stderr", Buffer.alloc(4097)), /chunk/);
});
