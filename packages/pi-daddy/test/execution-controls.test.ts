import assert from "node:assert/strict";
import { test } from "node:test";
import { renderExecutionControls } from "../extensions/execution-controls.ts";

test("execution status reports the actual defaults without implying a model budget or training consent", () => {
  const text = renderExecutionControls(undefined, {}).join("\n");
  assert.match(text, /child wall 21600s \(default\)/);
  assert.match(text, /child idle 900s \(default\)/);
  assert.match(text, /approval   wait for human; no deadline/);
  assert.match(text, /transcripts off/);
  assert.match(text, /diagnostics off/);
  assert.match(text, /separate from JEV\/LoRA consent/);
});

test("status reports effective overrides, fallback and the captured native-session choice", () => {
  const text = renderExecutionControls("/private/native", {
    PI_DADDY_CHILD_TIMEOUT: "120",
    PI_DADDY_CHILD_IDLE_TIMEOUT: "0",
    PI_DADDY_APPROVAL_TIMEOUT: "30",
    PI_DADDY_EXECUTION_ARCHIVE: "/private/archive",
  }).join("\n");
  assert.match(text, /child wall 120s/);
  assert.match(text, /child idle 900s/);
  assert.match(text, /zero\/invalid uses default/);
  assert.match(text, /30s configured deadline/);
  assert.match(text, /transcripts opted in at "\/private\/native"/);
  assert.match(text, /check each result's retention status/);
  const invalid = renderExecutionControls("", { PI_DADDY_APPROVAL_TIMEOUT: "bad" }).join("\n");
  assert.match(invalid, /needed new prompt will refuse/);
  assert.match(invalid, /native session root is missing/);
});
