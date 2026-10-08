import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { parseAutoModeDefault, parseAutoModeRef } from "../src/kernel/auto-mode.ts";
import { connectAutoMode, createAutoModeAuthority } from "../src/governance/auto-mode-policy.ts";

test("Auto defaults are strict and malformed owner references never create a new root", () => {
  assert.deepEqual(parseAutoModeDefault(undefined), { enabled: false, source: "default" });
  assert.deepEqual(parseAutoModeDefault("0"), { enabled: false, source: "environment" });
  assert.deepEqual(parseAutoModeDefault("1"), { enabled: true, source: "environment" });
  for (const raw of ["", "true", "01", " 1", "off"])
    assert.throws(() => parseAutoModeDefault(raw), /PI_DADDY_AUTO_MODE/);
  for (const raw of [
    "",
    "null",
    "{}",
    JSON.stringify({ socketPath: "/tmp/x", token: ["a".repeat(48)], ownerId: "b".repeat(32) }),
    JSON.stringify({ socketPath: "/tmp/x", token: "a".repeat(48), ownerId: ["b".repeat(32)] }),
    JSON.stringify({ socketPath: "/tmp/x", token: "a".repeat(48), ownerId: "b".repeat(32), enabled: true }),
  ])
    assert.throws(() => parseAutoModeRef(raw), /PI_DADDY_AUTO_MODE_REF/);
});

test("an already-running descendant consults live ON/OFF state at each admission", async () => {
  const authority = await createAutoModeAuthority({ enabled: false, source: "default" });
  const moduleUrl = new URL("../src/governance/auto-mode-policy.ts", import.meta.url).href;
  const script = `import { connectAutoMode } from ${JSON.stringify(moduleUrl)};
    import { createInterface } from 'node:readline';
    const reader=connectAutoMode(JSON.parse(process.argv[1]));
    for await (const line of createInterface({input:process.stdin})) {
      if(line==='quit')break;
      console.log(JSON.stringify(await reader.admit()));
    }
    await reader.close();`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", script, JSON.stringify(authority.reference)],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const admit = async () => {
    const next = once(lines, "line");
    child.stdin.write("admit\n");
    return JSON.parse((await next)[0]);
  };
  try {
    assert.equal(await admit(), false);
    authority.set(true, "session");
    assert.equal(await admit(), true);
    authority.set(false, "session");
    assert.equal(await admit(), false);
    authority.set(true, "session");
    assert.equal(await admit(), true);
    child.stdin.end("quit\n");
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
  } finally {
    child.kill();
    lines.close();
    await authority.close();
  }
});

test("read token cannot change policy; a waiter wakes on ON and OFF is re-read", async () => {
  const authority = await createAutoModeAuthority({ enabled: false, source: "default" });
  const reader = connectAutoMode(authority.reference);
  const cancel = new AbortController();
  try {
    const waiting = reader.waitEnabled(cancel.signal);
    // Another client request proves the owner is handling connections before we toggle.
    assert.equal((await reader.read()).enabled, false);
    authority.set(true, "session");
    await waiting;
    authority.set(false, "session");
    assert.equal(await reader.admit(), false);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(authority.reference.socketPath);
      let bytes = "";
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        bytes += chunk;
      });
      socket.once("end", () => resolve(bytes));
      socket.once("connect", () =>
        socket.write(JSON.stringify({ ...authority.reference, action: "set", enabled: true }) + "\n"),
      );
    });
    assert.equal(JSON.parse(response).ok, false);
    assert.equal(await reader.admit(), false);
    const foreign = connectAutoMode({ ...authority.reference, token: "0".repeat(48) });
    await assert.rejects(foreign.admit(), /Unauthorized/);
    await foreign.close();
  } finally {
    cancel.abort();
    await reader.close();
    await authority.close();
  }
});

test("pending dialogs follow actual registration, cancellation and owner closure fail closed", async () => {
  const authority = await createAutoModeAuthority({ enabled: false, source: "default" });
  const reader = connectAutoMode(authority.reference);
  try {
    const remove = authority.trackPending({ id: "prompt-1", subject: "build", capability: "tool:bash" });
    assert.deepEqual(
      (await reader.read()).pendingApprovals.map((x) => x.id),
      ["prompt-1"],
    );
    remove();
    assert.deepEqual((await reader.read()).pendingApprovals, []);
    const cancel = new AbortController();
    const waiting = reader.waitEnabled(cancel.signal);
    cancel.abort();
    await assert.rejects(waiting, /aborted/);
    await assert.rejects(reader.admit(cancel.signal), /aborted/);
    const ownerWait = reader.waitEnabled(new AbortController().signal);
    const rejected = assert.rejects(ownerWait, /unavailable/);
    await authority.close();
    await rejected;
    await assert.rejects(reader.admit(), /unavailable/);
  } finally {
    await reader.close();
    await authority.close();
  }
});
