import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { test } from "node:test";
import { captureStatus } from "./capture-status.mjs";

test("capture check reads the current branch reference and reports the producer refusal without exposing contents", async () => {
  const cwd = realpathSync("."), sessionId = "fixture";
  const reference = { owner: { cwd, sessionId }, operationId: "review" };
  const entry = { type: "custom", customType: "pi-daddy:operation-artifact:v1", data: reference };
  const ctx = { cwd, isProjectTrusted: () => true, sessionManager: {
    getSessionId: () => sessionId, getBranch: () => [entry, { ...entry, data: { owner: {cwd,sessionId:"old"} } }],
  }};
  let closed = false;
  const scan = () => ({ next: () => ({references:[],uncertain:0,issues:0}), close() {closed = true;} });
  const pi = { events: { emit(channel, request) {
    if (channel === "pi-daddy:runtime-snapshot:v1") {
      assert.equal(request.sessionId,sessionId);
      assert.equal(request.cwd,cwd);
      request.reply({version:1,requestId:request.requestId,sessionId:"",cwd:"",reason:"Error: another live runtime owns this Pi session"});
      return;
    }
    assert.equal(channel, "pi-daddy:operation-artifacts:v1");
    assert.equal(request.action,"read");
    assert.equal(request.reference,reference);
    request.reply({...request, ok:false, code:"owner-unavailable", reason:"private details"});
  }}};
  const message = await captureStatus(pi,ctx,"fixture",scan);
  assert.equal(closed,true);
  assert.match(message,/latest branch reference: owner-unavailable/);
  assert.match(message,/another process held this session/);
  assert.doesNotMatch(message,/private details/);
});

test("no event or scan is attempted for an untrusted workspace", async () => {
  assert.match(await captureStatus({}, {isProjectTrusted:()=>false}, "", assert.fail), /trusted workspace/);
});
