/** LC-004/012/013: launcher exit, cancellation and time limits never discharge unknown namespace ownership.
 * Trusted explicit ports force the physical cleanup boundary without patching Node/global methods.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileHandle } from "node:fs/promises";
import { CacheNamespaceCleanupError } from "../src/executors/cache-namespace-death.ts";
import {
  CacheSupervisorCleanup,
  CacheSupervisorTerminationError,
  retainedCacheSupervisorCleanups,
} from "../src/executors/cache-supervisor-cleanup.ts";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
  const acquisition = deferred<{ closed: boolean; handle: { close(): Promise<void> } }>(),
    launcher = deferred<void>(),
    waiting = deferred<void>();
  let dead = false,
    closes = 0,
    closeFault = false,
    observationFault = false,
    signals = 0,
    cancels = 0;
  const timers = new Map<number, () => void>();
  const namespace = {
    closed: false,
    handle: {
      close: async () => {
        closes++;
        if (closeFault) throw Error("first descriptor close fault");
      },
    },
  };
  let controller: CacheSupervisorCleanup<typeof namespace>;
  controller = new CacheSupervisorCleanup({
    acquire: () => acquisition.promise,
    launcherStopped: launcher.promise,
    spawnRefused: () => false,
    cancelAdmission: () => {
      cancels++;
    },
    stopLauncher: () => {
      signals++;
    },
    forceLauncher: () => {
      signals++;
    },
    terminated: async () => {
      if (observationFault) throw Error("unknown task termination");
      return dead;
    },
    wait: () => waiting.promise,
    timer: (callback, ms) => {
      timers.set(ms, callback);
      return () => {
        timers.delete(ms);
      };
    },
  });
  return {
    controller,
    namespace,
    acquisition,
    launcher,
    waiting,
    timers,
    dead: () => {
      dead = true;
    },
    closeFault: (value: boolean) => {
      closeFault = value;
    },
    observationFault: (value: boolean) => {
      observationFault = value;
    },
    counts: () => ({ closes, signals, cancels }),
  };
}
test("launcher exit cannot certify death; all-task death and actual descriptor close are joined", async () => {
  const f = fixture();
  f.acquisition.resolve(f.namespace);
  f.launcher.resolve();
  let settled = false;
  const stopping = f.controller.stop().then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false, "namespace tasks still alive after launcher exit");
  assert.equal(f.counts().closes, 0);
  f.dead();
  f.waiting.resolve();
  await stopping;
  assert.equal(f.counts().closes, 1);
  assert.equal(f.namespace.closed, true);
});
test("cancellation joins pending acquisition even after launcher exit", async () => {
  const f = fixture();
  f.launcher.resolve();
  f.dead();
  let settled = false;
  const stopping = f.controller.stop().then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  f.acquisition.resolve(f.namespace);
  await stopping;
  assert.equal(f.counts().closes, 1);
});
test("deadline retains a late acquired descriptor until explicit retry, and original stop stays failed", async () => {
  const f = fixture();
  f.launcher.resolve();
  f.dead();
  const stopping = f.controller.stop();
  await tick();
  assert.ok(f.timers.has(1500), "cleanup must retain its existing 1500ms deadline even during acquisition");
  f.timers.get(1500)!();
  await assert.rejects(stopping, /termination unresolved after 1500ms/);
  f.acquisition.resolve(f.namespace);
  await tick();
  assert.equal(f.namespace.closed, false);
  assert.equal(f.counts().closes, 0);
  await f.controller.retryCleanup();
  assert.equal(f.namespace.closed, true);
  assert.equal(f.counts().closes, 1);
  assert.equal(f.controller.stop(), stopping);
  await assert.rejects(f.controller.stop(), /termination unresolved/);
});
test("deadline during descriptor close joins its late completion without duplicate ownership on retry", async () => {
  const f = fixture(),
    closing = deferred<void>();
  let closes = 0;
  f.namespace.handle.close = async () => {
    closes++;
    await closing.promise;
  };
  f.acquisition.resolve(f.namespace);
  f.launcher.resolve();
  f.dead();
  const stopping = f.controller.stop();
  await tick();
  assert.equal(closes, 1);
  f.timers.get(1500)!();
  await assert.rejects(stopping, /termination unresolved after 1500ms/);
  const retry = f.controller.retryCleanup();
  await tick();
  assert.equal(closes, 1, "late close remains the original charged owner");
  closing.resolve();
  await retry;
  assert.equal(closes, 1);
  assert.equal(f.namespace.closed, true);
  await assert.rejects(stopping, /termination unresolved/);
});
test("descriptor close failure arriving after deadline remains detectable and retained for retry", async () => {
  const f = fixture(),
    closing = deferred<void>(),
    failure = Error("late descriptor close failed");
  let closes = 0;
  f.namespace.handle.close = async () => {
    if (++closes === 1) await closing.promise;
  };
  f.acquisition.resolve(f.namespace);
  f.launcher.resolve();
  f.dead();
  const stopping = f.controller.stop();
  await tick();
  f.timers.get(1500)!();
  await assert.rejects(stopping, /termination unresolved after 1500ms/);
  closing.reject(failure);
  await tick();
  assert.equal(
    f.controller.retainedOwners.lastCleanupFailure,
    failure,
    "late physical failures must not disappear behind deadline",
  );
  assert.equal(f.controller.retainedOwners.namespace, f.namespace);
  await f.controller.retryCleanup();
  assert.equal(closes, 2);
  assert.equal(f.namespace.closed, true);
  await assert.rejects(stopping, /termination unresolved after 1500ms/);
});
test("deadline with living namespace tasks never closes or certifies cleanup", async () => {
  const f = fixture();
  f.acquisition.resolve(f.namespace);
  f.launcher.resolve();
  const stopping = f.controller.stop();
  await tick();
  f.timers.get(1500)!();
  await assert.rejects(stopping, /termination unresolved after 1500ms/);
  assert.equal(f.counts().closes, 0);
  f.dead();
  f.waiting.resolve();
  await f.controller.retryCleanup();
  assert.equal(f.namespace.closed, true);
  await assert.rejects(stopping, /termination unresolved/);
});
test("first close failure remains loud and owned; only explicit retry may close again", async () => {
  const f = fixture();
  f.acquisition.resolve(f.namespace);
  f.launcher.resolve();
  f.dead();
  f.closeFault(true);
  const stopping = f.controller.stop();
  await assert.rejects(stopping, /descriptor close fault/);
  assert.equal(f.counts().closes, 1);
  assert.equal(f.namespace.closed, false);
  assert.ok(retainedCacheSupervisorCleanups().includes(f.controller), "failed owners cannot become GC-close");
  await assert.rejects(stopping, (error: unknown) => {
    assert.ok(error instanceof CacheSupervisorTerminationError);
    assert.equal(error.retainedOwners.namespace, f.namespace, "failure carries inspectable actual cleanup ownership");
    return true;
  });
  f.closeFault(false);
  await tick();
  assert.equal(f.counts().closes, 1);
  await f.controller.retryCleanup();
  assert.equal(f.counts().closes, 2);
  assert.equal(f.namespace.closed, true);
  assert.equal(retainedCacheSupervisorCleanups().includes(f.controller), false);
  await assert.rejects(f.controller.stop(), /descriptor close fault/);
});
test("unknown termination retains its descriptor and does not become no process", async () => {
  const f = fixture();
  f.acquisition.resolve(f.namespace);
  f.launcher.resolve();
  f.observationFault(true);
  await assert.rejects(f.controller.stop(), /unknown task termination/);
  assert.equal(f.counts().closes, 0);
  assert.equal(f.namespace.closed, false);
  f.observationFault(false);
  f.dead();
  await f.controller.retryCleanup();
  assert.equal(f.namespace.closed, true);
  await assert.rejects(f.controller.stop(), /unknown task termination/);
});
test("late observer failure retains its failed descriptor; release cannot certify unknown namespace death", async () => {
  const f = fixture();
  f.launcher.resolve();
  let closes = 0;
  const handle = {
    close: async () => {
      closes++;
    },
  } as FileHandle;
  const stopping = f.controller.stop();
  await tick();
  f.timers.get(1500)!();
  await assert.rejects(stopping, /termination unresolved after 1500ms/);
  f.acquisition.reject(new CacheNamespaceCleanupError([Error("observation failed"), Error("close failed")], handle));
  await tick();
  assert.equal(f.controller.retainedOwners.failedHandle, handle);
  assert.equal(closes, 0);
  await assert.rejects(f.controller.retryCleanup(), /namespace descriptor cleanup unresolved/);
  assert.equal(closes, 1);
  assert.equal(f.controller.retainedOwners.failedHandle, undefined);
  assert.ok(f.controller.retainedOwners.unknownAcquisition, "descriptor release is not task termination proof");
  assert.ok(retainedCacheSupervisorCleanups().includes(f.controller));
  await assert.rejects(stopping, /termination unresolved after 1500ms/);
});
test("missing namespace identity fails closed even when launcher already exited", async () => {
  const f = fixture();
  f.launcher.resolve();
  f.acquisition.reject(Error("namespace identity unavailable"));
  await assert.rejects(f.controller.stop(), /namespace identity unavailable/);
  assert.equal(f.counts().closes, 0);
  await assert.rejects(f.controller.retryCleanup(), /namespace identity unavailable/);
});
test("shutdown is memoized before reentrant admission cancellation and launcher callbacks", async () => {
  const acquisition = deferred<{ closed: boolean; handle: { close(): Promise<void> } }>();
  let controller!: CacheSupervisorCleanup<Awaited<typeof acquisition.promise>>,
    nested: Promise<void> | undefined,
    signals = 0;
  controller = new CacheSupervisorCleanup({
    acquire: () => acquisition.promise,
    launcherStopped: Promise.resolve(),
    spawnRefused: () => false,
    cancelAdmission: () => {
      nested = controller.stop();
    },
    stopLauncher: () => {
      signals++;
      assert.equal(controller.stop(), nested);
    },
    forceLauncher: () => {},
    terminated: async () => true,
    wait: async () => {},
    timer: () => () => {},
  });
  const stopping = controller.stop();
  assert.equal(nested, stopping);
  acquisition.resolve({ closed: false, handle: { close: async () => {} } });
  await stopping;
  assert.equal(signals, 1);
});
test("admission cancellation fault cannot skip independent process/resource cleanup", async () => {
  let closes = 0;
  const controller = new CacheSupervisorCleanup({
    acquire: async () => ({
      closed: false,
      handle: {
        close: async () => {
          closes++;
        },
      },
    }),
    launcherStopped: Promise.resolve(),
    spawnRefused: () => false,
    cancelAdmission: () => {
      throw Error("admission close fault");
    },
    stopLauncher: () => {},
    forceLauncher: () => {},
    terminated: async () => true,
    wait: async () => {},
    timer: () => () => {},
  });
  await assert.rejects(controller.stop(), /admission close fault/);
  assert.equal(closes, 1, "faults do not skip independent physical owners");
  await controller.retryCleanup();
  await assert.rejects(controller.stop(), /admission close fault/);
});
test("only independently certified spawn refusal discharges missing namespace identity", async () => {
  const controller = new CacheSupervisorCleanup({
    acquire: async () => {
      throw Error("spawn refused");
    },
    launcherStopped: Promise.resolve(),
    spawnRefused: () => true,
    cancelAdmission: () => {},
    stopLauncher: () => {},
    forceLauncher: () => {},
    terminated: async () => {
      assert.fail("no namespace was spawned");
    },
    wait: async () => {},
    timer: () => () => {},
  });
  await controller.stop();
});
