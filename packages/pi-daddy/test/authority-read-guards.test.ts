import assert from "node:assert/strict";
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBoundedTextSync, unresolvedSyncReadCleanups } from "../src/kernel/bounded-read-sync.ts";
import { BoundedReadCleanupError } from "../src/kernel/bounded-read.ts";
import { readSkillPackage } from "../src/kernel/skill-packages.ts";
import { resolveSkillResources } from "../src/kernel/skill-resources.ts";
import { reconcileAcceptedWorkspaces } from "../src/governance/workspace-acceptance.ts";
import { acceptedWorkspacesPath } from "../src/kernel/project-paths.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
after(cleanupTempDirs);

test("setup refuses damaged package metadata rather than treating it as no package", async () => {
  const cwd = await tempDir("metadata-damage-");
  await writeFile(join(cwd, "package.json"), Buffer.from('{"name":"a\xff","pi":{"skills":["reader"]}}', "latin1"));
  await assert.rejects(readSkillPackage(cwd), /utf.?8/i);
  await writeFile(join(cwd, "package.json"), "broken");
  await assert.rejects(readSkillPackage(cwd), /JSON/);
});

test("Pi resource settings distinguish absent defaults from damaged, nonregular and oversized input", async () => {
  const cwd = await tempDir("settings-read-");
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await tempDir("settings-agent-");
  try {
    assert.ok(await resolveSkillResources(cwd));
    await mkdir(join(cwd, ".pi"));
    const path = join(cwd, ".pi", "settings.json");
    await writeFile(path, Buffer.from('{"unused":"\xff"}', "latin1"));
    await assert.rejects(resolveSkillResources(cwd), /utf.?8/i);
    await writeFile(path, " ".repeat(1024 * 1024 + 1));
    await assert.rejects(resolveSkillResources(cwd), /large|limit/i);
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
  }
});

test("workspace acceptance damage never triggers first-use replacement", async () => {
  const cwd = await tempDir("acceptance-damage-");
  const env = { PI_CODING_AGENT_DIR: cwd };
  const path = acceptedWorkspacesPath(join(cwd, "registry.json"), env);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, Buffer.from('{"version":1,"registry":"x","accepted":["\xff"]}', "latin1"));
  await assert.rejects(reconcileAcceptedWorkspaces(join(cwd, "registry.json"), ["evil"], env), /utf.?8/i);
});

test("synchronous reads reject FIFO, growth, replacement and invalid UTF-8 on the held descriptor", async () => {
  const cwd = await tempDir("sync-read-");
  const path = join(cwd, "file");
  const io = { open: openSync, close: closeSync, stat: fstatSync, read: readSync, realpath: realpathSync };
  const fifo = join(cwd, "fifo");
  execFileSync("mkfifo", [fifo]);
  assert.throws(() => readBoundedTextSync(fifo, { maxBytes: 10 }), /regular file/);
  await writeFile(path, "a");
  assert.throws(
    () =>
      readBoundedTextSync(path, { maxBytes: 3 }, {
        ...io,
        stat(fd: number) {
          const original = fstatSync(fd);
          writeFileSync(path, "abcdef");
          return original;
        },
      } as never),
    /grew/,
  );
  assert.throws(
    () =>
      readBoundedTextSync(
        path,
        { maxBytes: 20, confinedRoot: cwd },
        {
          ...io,
          realpath: () => "/outside/file",
        },
      ),
    /outside/,
  );
  await writeFile(path, Buffer.from([0xff]));
  assert.throws(() => readBoundedTextSync(path, { maxBytes: 10 }), /UTF-8/);
  await writeFile(path, "a€z");
  assert.deepEqual(readBoundedTextSync(path, { maxBytes: 3, prefix: true }).text, "a");
  await writeFile(path, "�");
  assert.equal(readBoundedTextSync(path, { maxBytes: 3 }).text, "�");
});

test("sync close failure stays explicitly owned and never retries a possibly recycled numeric descriptor", async () => {
  const cwd = await tempDir("sync-close-");
  const path = join(cwd, "file");
  await writeFile(path, "a");
  let fd = -1;
  let failure: BoundedReadCleanupError | undefined;
  try {
    assert.throws(
      () =>
        readBoundedTextSync(
          path,
          { maxBytes: 10 },
          {
            open: (name, flags) => {
              fd = openSync(name, flags);
              return fd;
            },
            close: () => {
              throw false;
            },
            stat: fstatSync,
            read: readSync,
            realpath: realpathSync,
          },
        ),
      (error) => {
        assert.ok(error instanceof BoundedReadCleanupError);
        failure = error;
        assert.equal(error.cause, false);
        return true;
      },
    );
    assert.ok(unresolvedSyncReadCleanups().includes(failure!));
    await assert.rejects(failure!.cleanup(), (error) => error === failure);
    assert.ok(fstatSync(fd).isFile());
  } finally {
    if (fd !== -1) closeSync(fd); // Test owns injected failure; production never infers retry safety.
  }
});

test("actual session runtime settings refuse invalid bytes while missing settings retain defaults", async () => {
  const cwd = await tempDir("session-settings-read-");
  const oldCwd = process.cwd();
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await tempDir("session-settings-agent-");
  process.chdir(cwd);
  try {
    assert.ok(createGrantsSession(undefined).maxDepth > 0);
    await mkdir(join(cwd, ".pi", "pi-daddy"), { recursive: true });
    const path = join(cwd, ".pi", "pi-daddy", "settings.json");
    await writeFile(path, Buffer.from('{"defaults":{"model":"provider/a\xff"}}', "latin1"));
    assert.equal(createGrantsSession(undefined).maxDepth, 0);
    const fifo = join(cwd, "bad-settings");
    execFileSync("mkfifo", [fifo]);
    assert.throws(() => readBoundedTextSync(fifo, { maxBytes: 1024 }), /regular file/);
  } finally {
    process.chdir(oldCwd);
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
  }
});
