import assert from "node:assert/strict";
import { test } from "node:test";
import { frozenPersonalInvocation } from "../src/kernel/cache-personal-invocation.ts";
const base = { cwd: "/work", shell: "/bin/bash", command: "literal", timeoutMs: 1000 };
test("trusted invocation preserves environment enumeration and owns a frozen independent copy", () => {
  const env = { Z: "last", A: "first", M: "middle" };
  const copy = frozenPersonalInvocation({ ...base, env });
  assert.deepEqual(Object.entries(copy.env), Object.entries(env));
  assert.ok(Object.isFrozen(copy.env));
  env.Z = "changed";
  assert.equal(copy.env.Z, "last");
});
test("equal bindings in different environment orders remain distinct invocation identities", () => {
  const one = frozenPersonalInvocation({ ...base, env: { Z: "last", A: "first" } });
  const two = frozenPersonalInvocation({ ...base, env: { A: "first", Z: "last" } });
  assert.notEqual(JSON.stringify(one), JSON.stringify(two));
});
test("numeric environment keys retain object enumeration without lexically sorting other names", () => {
  const env = { "10": "ten", "2": "two", Z: "last", "01": "leading", A: "first", "4294967295": "nonindex" };
  assert.deepEqual(Object.keys(frozenPersonalInvocation({ ...base, env }).env), Object.keys(env));
});
test("invalid environment names and values still fail closed", () => {
  for (const env of [{ "": "bad" }, { "A=B": "bad" }, { A: "\0" }, { A: undefined }])
    assert.throws(
      () => frozenPersonalInvocation({ ...base, env: env as unknown as Record<string, string> }),
      /environment/,
    );
});
