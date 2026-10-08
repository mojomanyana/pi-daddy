import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import grantsExtension from "../extensions/grants.ts";
import { grantsCommand } from "../extensions/grants-command.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { initializeSessionAutoMode, closeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import { readRecords } from "../src/governance/record.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("registered Auto command shares audited owner controls and OFF remains available without definitions", async () => {
  const session = createGrantsSession(undefined);
  session.ownerBound = true;
  session.cwd = await tempDir("grants-auto-command-");
  session.ledgerPath = join(session.cwd, "ledger.jsonl");
  let definitionReads = 0;
  session.ensureDefinitions = async () => {
    definitionReads++;
    throw Error("definitions unavailable");
  };
  await initializeSessionAutoMode(session, {}, "command-owner");
  let command: typeof grantsCommand | undefined;
  grantsExtension(
    {
      on() {},
      registerTool() {},
      registerCommand(name: string, value: typeof grantsCommand) {
        if (name === "grants") command = value;
      },
    } as never,
    session,
  );
  const notices: string[] = [];
  const ctx = {
    ui: {
      notify(text: string) {
        notices.push(text);
      },
    },
  };
  try {
    assert.match(command!.description, /auto \[on\|off\]/);
    await command!.handler("auto", ctx);
    assert.match(notices.at(-1)!, /Auto OFF \(default/);
    await command!.handler("auto on", ctx);
    assert.equal(await session.autoMode!.admit(), true);
    assert.match(notices.at(-1)!, /Auto ON \(session/);
    for (const invalid of ["auto maybe", "auto off extra"]) {
      await command!.handler(invalid, ctx);
      assert.match(notices.at(-1)!, /no permission setting changed/);
      assert.equal(await session.autoMode!.admit(), true);
    }
    await command!.handler("auto off", ctx);
    assert.equal(await session.autoMode!.admit(), false);
    assert.equal(definitionReads, 0);
    assert.equal(session.sessionApprovals.size, 0);
    const events = readRecords(await readFile(session.ledgerPath, "utf8")).records;
    assert.deepEqual(
      events.map((record) => (record.body as { autoMode: { enabled: boolean; source: string } }).autoMode.enabled),
      [true, false],
    );
    await closeSessionAutoMode(session);
    await command!.handler("auto on", ctx);
    assert.match(notices.at(-1)!, /not confirmed.*unavailable/);
  } finally {
    await closeSessionAutoMode(session);
  }
});

test("direct Auto handler refuses mutation without an injected owner capability", async () => {
  let notice = "";
  await grantsCommand.handler("auto on", {
    grants: {},
    ui: {
      notify(text: string) {
        notice = text;
      },
    },
  });
  assert.match(notice, /controls are unavailable/);
});
