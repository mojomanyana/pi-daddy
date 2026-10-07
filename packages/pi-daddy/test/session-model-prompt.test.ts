import assert from "node:assert/strict";
import { open, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { BoundedReadCleanupError, readBoundedFile } from "../src/kernel/bounded-read.ts";
import grantsExtension from "../extensions/grants.ts";
import {
  createGrantsSession,
  assertDiscoveryHealthy,
  retainDiscoveryCleanupFailure,
  type GrantsSession,
} from "../extensions/session.ts";
import type { ReloadLifecycle } from "../extensions/reload-environment.ts";
import { after, test } from "node:test";
import { changeSessionModels, type SessionModelPromptState } from "../extensions/session-model-prompt.ts";
import { readRecords } from "../src/governance/record.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const EPISODE = "episode:00000000-0000-4000-8000-0000000000f1";

async function state(mode: "ask" | "never" = "ask"): Promise<SessionModelPromptState> {
  const dir = await tempDir("session-model-prompt-");
  return {
    episodeId: EPISODE,
    ledgerPath: `${dir}/grants.jsonl`,
    definitions: new Map([
      ["review", { name: "review" }],
      ["build", { name: "build" }],
    ]),
    definitionRuntimeSettings: {
      defaults: { model: "global/model", thinking: "low" },
      definitions: new Map([["review", { model: "definition/model", thinking: "medium" }]]),
    },
    definitionRuntimeOverrides: new Map(),
  };
}

async function events(value: SessionModelPromptState): Promise<any[]> {
  const parsed = readRecords(await readFile(value.ledgerPath!, "utf8"));
  assert.equal(parsed.damage, null);
  return parsed.records.map((record) => record.body);
}

test("change accepts per-definition and all edits into the session map", async () => {
  const value = await state();
  await changeSessionModels(value, {
    hasUI: true,
    input: async () => "all openai-codex:gpt-5.6-sol high\nreview anthropic:claude-opus-4-6 xhigh",
    notify: () => {},
  });
  assert.deepEqual(
    [...value.definitionRuntimeOverrides],
    [
      ["build", { model: "openai-codex/gpt-5.6-sol", thinking: "high" }],
      ["review", { model: "anthropic/claude-opus-4-6", thinking: "xhigh" }],
    ],
  );
  assert.equal((await events(value))[0].outcome, "changed");
});

test("invalid edits are rejected with valid values and cannot spawn past the prompt", async () => {
  const value = await state();
  const answers = ["review bad-model turbo", "review anthropic:claude-opus-4-6 high"];
  const notices: string[] = [];
  await changeSessionModels(value, {
    hasUI: true,
    input: async () => answers.shift(),
    notify: (message) => notices.push(message),
  });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /off, minimal, low, medium, high, xhigh, max/);
  assert.deepEqual(value.definitionRuntimeOverrides.get("review"), {
    model: "anthropic/claude-opus-4-6",
    thinking: "high",
  });
});

test("manual model controls skip UI when unavailable and record kept defaults", async () => {
  const value = await state();
  await changeSessionModels(value, {
    hasUI: false,
    input: async () => assert.fail("unavailable UI must not prompt"),
    notify: () => {},
  });
  assert.equal((await events(value))[0].outcome, "kept");
});

test("manual editor refuses damaged and invalid UTF-8 history before showing or changing choices", async () => {
  for (const bytes of ["not-json\n", Buffer.from([0xff, 0x0a])]) {
    const value = await state();
    await writeFile(value.ledgerPath!, bytes);
    let prompts = 0;
    await assert.rejects(
      changeSessionModels(value, {
        hasUI: true,
        input: async () => {
          prompts++;
          return "";
        },
        notify() {},
      }),
    );
    assert.equal(prompts, 0);
    assert.equal(value.definitionRuntimeOverrides.size, 0);
    assert.deepEqual(await readFile(value.ledgerPath!), Buffer.from(bytes));
  }
});

test("manual editor refuses oversized history and a directory instead of treating them as missing", async () => {
  const value = await state(),
    handle = await open(value.ledgerPath!, "w");
  try {
    await handle.truncate(64 * 1024 * 1024 + 1);
  } finally {
    await handle.close();
  }
  const ui = { hasUI: true, input: async () => assert.fail("unreadable history must not prompt"), notify() {} };
  await assert.rejects(changeSessionModels(value, ui), /history.*unavailable/);
  value.ledgerPath = await tempDir("model-history-directory-");
  await assert.rejects(changeSessionModels(value, ui), /history.*unavailable/);
});

test("manual history FIFO is refused under an outer process deadline", async (t) => {
  if (process.platform !== "linux") return t.skip("POSIX FIFO fixture");
  const value = await state();
  execFileSync("mkfifo", [value.ledgerPath!]);
  const module = new URL("../extensions/session-model-prompt.ts", import.meta.url).href;
  const script = `import {changeSessionModels} from ${JSON.stringify(module)};
const state={episodeId:'${EPISODE}',ledgerPath:${JSON.stringify(value.ledgerPath)},definitions:new Map(),definitionRuntimeSettings:{defaults:{},definitions:new Map()},definitionRuntimeOverrides:new Map()};
try {await changeSessionModels(state,{hasUI:true,input:async()=>{throw Error('UI must not be reached')},notify(){}}); process.exitCode=1;}
catch(e){if(!e.message.includes('history unavailable'))throw e;console.log('FIFO refused');}`;
  assert.match(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 }),
    /FIFO refused/,
  );
});

test("manual model dialog cannot write choices after its initiating owner is replaced", async () => {
  const value = await state();
  let healthy = true;
  await assert.rejects(
    changeSessionModels(
      value,
      {
        hasUI: true,
        input: async () => {
          healthy = false;
          return "all local:model high";
        },
        notify() {},
      },
      {
        assertHealthy: () => {
          if (!healthy) throw Error("owner replaced");
        },
      },
    ),
    /owner replaced/,
  );
  assert.equal(value.definitionRuntimeOverrides.size, 0);
  await assert.rejects(readFile(value.ledgerPath!), { code: "ENOENT" });
});

test("manual history close failure retains exact capability only on its initiating owner", async () => {
  for (const replace of [false, true]) {
    const value = await state();
    await writeFile(value.ledgerPath!, "");
    const initial: ReloadLifecycle = { root: {} };
    const session = { reloadLifecycle: initial, catalogReady: Promise.resolve({}) } as GrantsSession;
    let fail = true,
      held: Awaited<ReturnType<typeof open>> | undefined;
    const read: typeof readBoundedFile = (path, limits) =>
      readBoundedFile(path, limits, {
        open: async (name, flags) => (held = await open(name, flags)),
        read: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: async (handle) => {
          if (fail) {
            fail = false;
            if (replace) session.reloadLifecycle = { root: {} };
            throw Error("close failed");
          }
          await handle.close();
        },
      });
    let error: BoundedReadCleanupError | undefined;
    await assert.rejects(
      changeSessionModels(
        value,
        { hasUI: true, input: async () => assert.fail("must not prompt"), notify() {} },
        {
          read,
          assertHealthy: () => assertDiscoveryHealthy(session, initial),
          onReadCleanup: (failure) => retainDiscoveryCleanupFailure(session, failure, initial),
        },
      ),
      (failure) => {
        assert.ok(failure instanceof BoundedReadCleanupError);
        error = failure;
        return true;
      },
    );
    assert.equal(initial.discoveryCleanupFailure, error);
    assert.ok((await held!.stat()).isFile());
    await error!.cleanup();
    await assert.rejects(held!.stat());
    assert.equal(initial.discoveryCleanupFailure, error, "physical recovery never rewrites failed outcome");
    if (replace) {
      assert.equal(session.discoveryCleanupFailure, undefined);
      assertDiscoveryHealthy(session);
    } else
      assert.throws(
        () => assertDiscoveryHealthy(session),
        (failure) => failure === error,
      );
  }
});

test("registered grants models command binds edits to the initiating session lifecycle", async () => {
  const value = await state();
  const session = createGrantsSession(undefined, { root: {} });
  Object.assign(session, value);
  const commands = new Map<string, any>();
  grantsExtension(
    {
      on() {},
      registerTool() {},
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
    } as never,
    session,
  );
  let prompts = 0;
  await assert.rejects(
    commands.get("grants").handler("models", {
      hasUI: true,
      ui: {
        input: async () => {
          prompts++;
          session.reloadLifecycle = { root: {} };
          return "all local:model high";
        },
        notify: () => assert.fail("replaced owner must not publish success"),
      },
    }),
    /owner replaced/,
  );
  assert.equal(prompts, 1);
  assert.equal(session.definitionRuntimeOverrides.size, 0);
  await assert.rejects(readFile(value.ledgerPath!), { code: "ENOENT" });
});
