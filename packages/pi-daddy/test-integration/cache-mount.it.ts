/** Real PRIVATE user/mount-namespace qualification. No host mounts/capability installs/cache certification. */
import assert from "node:assert/strict";
import { execFile, ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, mock, test } from "node:test";
import { startSupervisedCache } from "../src/executors/cache-supervisor.ts";
import { readCacheOwner, cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { tempDir, cleanupTempDirs as removeTempDirs } from "../test/tmp.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
const known: CacheOwnerIdentity[] = [];
let binary: string;
let unresolvedNamespaces = 0;
async function verifyDead(identity: CacheOwnerIdentity) {
  const deadline = performance.now() + 1500;
  while (!(await cacheProcessTerminated(identity))) {
    if (performance.now() >= deadline)
      throw new Error(`mount qualification ownership unresolved; retain evidence: ${JSON.stringify(identity)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function cleanupTempDirs() {
  assert.equal(unresolvedNamespaces, 0, "mount namespace cleanup unresolved; retain fixtures");
  for (const identity of known) await verifyDead(identity);
  await removeTempDirs();
}
after(cleanupTempDirs);
before(async () => {
  if (!enabled) return;
  const root = await tempDir("cache-mount-binary-");
  binary = join(root, "mount-probe");
  await promisify(execFile)("cc", [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(new URL("./cache-mount-native.c", import.meta.url)),
    "-o",
    binary,
  ]);
});
interface Evidence {
  mode: string;
  stats: string[];
  bootId: string;
  beforeEqualsAfter: boolean;
  firstPoll: number | null;
  secondPoll: number | null;
  changedPoll: number | null;
  restoredPoll: number | null;
  changedView: boolean;
  oldViewUnchanged: boolean;
  namespaceChanged: boolean;
  beforeBlocks: number;
  changedBlocks: number | null;
  restoredBlocks: number | null;
  leaseValid: boolean | null;
  inodeControl: boolean | null;
  inodeQuietChanged: boolean | null;
  inodeQuietRestored: boolean | null;
  bytesUnchanged: boolean | null;
  userNamespace: string;
  mountNamespace: string;
}
function identity(stat: string, bootId: string): CacheOwnerIdentity {
  const end = stat.lastIndexOf(")"),
    fields = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/);
  assert.ok(end > 0 && fields.length >= 20);
  return { pid: Number(stat.slice(0, stat.indexOf(" "))), bootId, startTicks: fields[19] };
}
async function context() {
  return {
    user: String((await stat("/proc/self/ns/user", { bigint: true })).ino),
    mount: String((await stat("/proc/self/ns/mnt", { bigint: true })).ino),
    effectiveCaps: /^CapEff:\s+(\w+)$/m.exec(await readFile("/proc/self/status", "utf8"))![1],
  };
}
async function qualify(mode: string, fault?: string) {
  const hostContext = await context();
  assert.ok(process.getuid!() > 0, "qualification caller must not hold host root identity");
  assert.equal(BigInt("0x" + hostContext.effectiveCaps), 0n, "no initial-namespace capability is requested");
  let resultResolve: (reply: Evidence) => void = () => {},
    resultReject: (err: Error) => void = () => {};
  const result = new Promise<Evidence>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  void result.catch(() => {});
  let output = "",
    bytes = 0,
    terminal = false,
    failure: Error | undefined;
  unresolvedNamespaces++; // Startup itself can fail with unresolved ownership; do not delete its fixtures.
  const supervisor = await startSupervisedCache({
    owner: await readCacheOwner(process.pid),
    entry: new URL("./cache-mount-fixture.ts", import.meta.url),
    args: [binary, mode, ...(fault ? [fault] : [])],
    initializationMs: fault === "startup-hang" ? 100 : 3000,
    onData: (stream, chunk) => {
      try {
        bytes += chunk.length;
        if (bytes > 65536) throw new Error("mount fixture output exceeded bound");
        if (stream === "stderr") throw new Error(`mount fixture diagnostics: ${chunk}`);
        output += chunk.toString("utf8");
        let newline: number;
        while ((newline = output.indexOf("\n")) !== -1) {
          const value = JSON.parse(output.slice(0, newline));
          output = output.slice(newline + 1);
          if (value.error) throw new Error(`mount fixture error: ${value.error}`);
          if (terminal) throw new Error("mount fixture duplicate or post-terminal evidence");
          if (value.identity) {
            known.push(identity(value.identity, value.bootId));
            continue;
          }
          if (!Array.isArray(value.stats) || !value.stats.length || !value.bootId)
            throw new Error("mount fixture identity evidence absent");
          terminal = true;
          resultResolve(value);
        }
      } catch (err) {
        failure ??= err instanceof Error ? err : new Error(String(err));
        resultReject(failure);
      }
    },
  });
  const closed = new Promise<void>((resolve) => supervisor.process.once("close", () => resolve()));
  supervisor.process.stdin.write("GO\n");
  let timeout: NodeJS.Timeout | undefined;
  try {
    const reply = await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("mount qualification exceeded 8000ms")), 8000);
      }),
    ]);
    for (const stat of reply.stats)
      assert.equal(
        await cacheProcessTerminated(identity(stat, reply.bootId)),
        false,
        "subjects must be live before namespace teardown",
      );
    assert.equal(reply.mode, mode);
    assert.notEqual(
      reply.userNamespace,
      hostContext.user,
      "mutator's namespace-local capabilities must not be host authority",
    );
    assert.notEqual(reply.mountNamespace, hostContext.mount, "mutations must occur in a private mount view");
    console.log(`MOUNT_CANDIDATE ${JSON.stringify(reply)}`);
    return reply;
  } finally {
    clearTimeout(timeout);
    await supervisor.stop();
    let closeDeadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          closeDeadline = setTimeout(
            () => reject(new Error("mount fixture stream closure exceeded 1500ms; retain evidence")),
            1500,
          );
        }),
      ]);
    } finally {
      clearTimeout(closeDeadline);
    }
    for (const owner of known) await verifyDead(owner);
    unresolvedNamespaces--;
    assert.deepEqual(await context(), hostContext, "caller namespaces and effective authority must remain unchanged");
    if (failure) throw failure;
    if (output.length) throw new Error("mount fixture trailing incomplete frame");
  }
}

test("unresolved startup ownership prevents fixture deletion (REV-004)", { skip: !enabled }, async () => {
  const baseline = unresolvedNamespaces,
    realKill = ChildProcess.prototype.kill;
  let held: ChildProcess | undefined;
  const identities: CacheOwnerIdentity[] = [];
  mock.method(ChildProcess.prototype, "kill", function (this: ChildProcess) {
    held ??= this;
    assert.equal(this, held, "only the owned startup subject is intercepted");
    return false;
  });
  try {
    await assert.rejects(qualify("bind-undo", "startup-hang"), /termination unresolved/);
    assert.ok(held?.pid);
    async function capture(pid: number) {
      identities.push(await readCacheOwner(pid));
      const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim();
      if (children) for (const child of children.split(/\s+/)) await capture(Number(child));
    }
    await capture(held.pid);
    for (const owner of identities) assert.equal(await cacheProcessTerminated(owner), false);
    await assert.rejects(cleanupTempDirs(), /namespace cleanup unresolved/);
    assert.ok((await stat(binary)).isFile(), "unresolved ownership must retain fixture bytes");
  } finally {
    mock.restoreAll();
    if (held?.pid) {
      const closed = new Promise<void>((resolve) => held!.once("close", () => resolve()));
      if (!identities.length) identities.push(await readCacheOwner(held.pid));
      assert.equal(await cacheProcessTerminated(identities[0]), false);
      assert.equal(realKill.call(held, "SIGKILL"), true, "test recovery signals only its verified actual child");
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("mount startup control recovery unresolved; retain evidence")),
              1500,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      for (const owner of identities) await verifyDead(owner);
      unresolvedNamespaces = baseline; // Reset only AFTER independently owned test recovery proves death.
    }
  }
});

for (const fault of ["result-error", "result-overflow", "result-duplicate", "result-trailing"]) {
  test(`post-result ${fault} cannot be hidden by settled evidence (REV-001)`, { skip: !enabled }, async () => {
    await assert.rejects(qualify("bind-undo", fault), /mount fixture|mount qualification/);
  });
}

for (const fault of ["no-file-control", "no-parent-control"]) {
  test(`both direct watch controls are required: ${fault} (REV-002)`, { skip: !enabled }, async () => {
    await assert.rejects(qualify("cross-sb", fault), /control.*both/);
  });
}

test(
  "peer identity is captured before potentially blocking namespace setup (REV-003)",
  { skip: !enabled },
  async () => {
    const before = known.length;
    await assert.rejects(qualify("cross-sb", "peer-hang"), /exceeded 8000ms/);
    const subjects = known.slice(before);
    assert.equal(subjects.length, 2, "main AND blocked peer need actual pre-work death witnesses");
    assert.notEqual(subjects[0].pid, subjects[1].pid);
    for (const subject of subjects) assert.equal(await cacheProcessTerminated(subject), true);
  },
);

test(
  "mount bind/unmount undo returns original view but priority poll remembers history",
  { skip: !enabled },
  async () => {
    const e = await qualify("bind-undo");
    assert.equal(e.changedView, true);
    assert.equal(e.beforeEqualsAfter, true);
    assert.ok(e.firstPoll !== null);
    assert.ok(e.firstPoll & 2, "actual POLLPRI is required, not byte inequality");
    assert.equal(e.secondPoll, 0, "poll consumes the remembered event; quiet cannot erase dirty state");
  },
);
test("mount attribute change/undo is observed despite restored view bytes", { skip: !enabled }, async () => {
  const e = await qualify("flags-undo");
  assert.equal(e.changedView, true);
  assert.equal(e.beforeEqualsAfter, true);
  assert.ok(e.firstPoll !== null);
  assert.ok(e.firstPoll & 2);
  assert.equal(e.secondPoll, 0);
});
test(
  "shared superblock changes from another mount namespace can evade this namespace's poll",
  { skip: !enabled },
  async () => {
    const e = await qualify("cross-sb");
    assert.equal(e.namespaceChanged, true);
    assert.equal(e.changedView, true);
    assert.equal(typeof e.changedBlocks, "number");
    assert.equal(typeof e.restoredBlocks, "number");
    assert.notEqual(e.beforeBlocks, e.changedBlocks, "actual statvfs observation must change");
    assert.equal(e.beforeBlocks, e.restoredBlocks);
    assert.equal(e.beforeEqualsAfter, true);
    assert.equal(e.changedPoll, 0);
    assert.equal(e.restoredPoll, 0);
    assert.equal(e.leaseValid, true, "content lease does not close superblock metadata coverage");
    assert.equal(e.inodeControl, true, "actual chmod events must force the direct inode/parent channel first");
    assert.equal(e.inodeQuietChanged, true);
    assert.equal(e.inodeQuietRestored, true);
    assert.equal(e.bytesUnchanged, true, "metadata changes without altering guarded bytes");
  },
);
test("opened mountinfo retains old filesystem root across same-task chroot", { skip: !enabled }, async () => {
  const e = await qualify("root-view");
  assert.equal(e.namespaceChanged, false, "root can change without namespace identity changing");
  assert.equal(e.changedView, true);
  assert.equal(e.oldViewUnchanged, true);
  assert.equal(e.changedPoll, 0);
  assert.equal(e.beforeEqualsAfter, true);
});
test(
  "opened mountinfo stays on old namespace while same task moves to a changed view",
  { skip: !enabled },
  async () => {
    const e = await qualify("task-view");
    assert.equal(e.namespaceChanged, true);
    assert.equal(e.changedView, true);
    assert.equal(e.oldViewUnchanged, true);
    assert.equal(e.changedPoll, 0);
    assert.equal(e.beforeEqualsAfter, true);
  },
);
