import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

function run(input) {
  const result = spawnSync(process.execPath, ["public-notice.cjs"], { input, encoding: "utf8", timeout: 5000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, "The exporter must exit normally");
  return result;
}

const first = `Library opens at ten: ${randomUUID()}`;
const second = `Uszoda zárva — ${randomUUID()}`;
for (const notice of [
  { message: first, staffNote: "private fixture A" },
  { staffNote: "private fixture B", message: second },
]) {
  const result = run(JSON.stringify(notice));
  assert.equal(result.status, 0, "A valid notice must succeed");
  assert.ok(
    result.stdout === notice.message + "\n" || result.stdout === notice.message + "\r\n",
    "Expected the supplied message followed by exactly one line ending",
  );
}

for (const [name, input] of [
  ["malformed JSON", "{"],
  ["missing message", JSON.stringify({ staffNote: "private fixture C" })],
  ["non-string message", JSON.stringify({ message: 123 })],
  ["empty message", JSON.stringify({ message: "" })],
  ["LF in message", JSON.stringify({ message: "First\nSecond" })],
  ["CR in message", JSON.stringify({ message: "First\rSecond" })],
  ["CRLF in message", JSON.stringify({ message: "First\r\nSecond" })],
]) {
  const result = run(input);
  assert.ok(Number.isInteger(result.status) && result.status !== 0, `${name} must fail`);
  assert.equal(result.stdout, "", `${name} must leave stdout empty`);
}

console.log("Passed all public-notice checks.");
