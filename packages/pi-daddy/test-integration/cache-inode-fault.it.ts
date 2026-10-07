/** Synthetic hash-approved protocol adversaries, NOT production admission/source witnesses. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { startInodeObserver } from "../src/executors/cache-inode-observer.ts";
import { readCacheOwner, cacheProcessTerminated, type CacheOwnerIdentity } from "../src/kernel/cache-owner.ts";
import { tempDir, cleanupTempDirs as removeTempDirs } from "../test/tmp.ts";
const enabled = process.env.PI_DADDY_IT_CACHE === "1";
const known: CacheOwnerIdentity[] = [];
async function cleanupTempDirs() {
  for (const identity of known)
    assert.equal(await cacheProcessTerminated(identity), true, "unresolved synthetic observer; evidence retained");
  await removeTempDirs();
}
after(cleanupTempDirs);
async function adversary(scenario: string, aliases = false, failedArm = false) {
  const dir = await tempDir("cache-inode-fault-"),
    marker = join(dir, "pid"),
    source = join(dir, "adversary.c"),
    binary = join(dir, "adversary");
  const startup = aliases ? "if(i==3)wd=2;" : "";
  await writeFile(
    source,
    `
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc,char **argv){
 FILE *marker=fopen(${JSON.stringify(marker)},"w");if(!marker)return 72;
 fprintf(marker,"%ld",(long)getpid());fclose(marker);usleep(200000);
 setvbuf(stdout,0,${failedArm ? "_IOFBF" : "_IOLBF"},4096);printf("I1 READY %d\\n",argc-2);
 for(int i=2;i<argc;i++){int fd,kind,wd=1;unsigned long long dev,ino;
 if(sscanf(argv[i],"%d:%llu:%llu:%d",&fd,&dev,&ino,&kind)!=4)return 73;
 ${startup}printf("I1 W %d %d %llu %llu %s\\n",i-2,wd,dev,ino,kind==1?"file":"directory");}
 ${failedArm ? 'fputs("I1 ARMED\\nI1 F LOSS 0\\n",stdout);fflush(stdout);return 0;' : 'puts("I1 ARMED");'}char first[64],second[64];
 if(!fgets(first,sizeof first,stdin))return 0;
 ${scenario}
 while(fgets(first,sizeof first,stdin)){}return 0;
}
`,
  );
  await promisify(execFile)("cc", ["-static", "-O2", source, "-o", binary]);
  const sha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  const inputPath = join(dir, "input");
  await writeFile(inputPath, "input");
  const input = await open(inputPath, "r"),
    info = await input.stat({ bigint: true });
  const objects = [{ fd: input.fd, info }];
  if (aliases) objects.push({ fd: input.fd, info });
  const admission = startInodeObserver({ binary, sha256, owner: await readCacheOwner(process.pid), objects }).then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );
  let identity: CacheOwnerIdentity | undefined;
  try {
    const deadline = performance.now() + 1500;
    while (!identity && performance.now() < deadline) {
      try {
        identity = await readCacheOwner(Number(await readFile(marker, "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (!identity) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(identity, "actual native identity must be captured before its admission finishes");
    known.push(identity);
    return { input, identity, admission };
  } catch (err) {
    const settled = await admission;
    if ("value" in settled) await settled.value.stop();
    await input.close();
    throw err;
  }
}

test(
  "ARMED followed by terminal evidence in the same chunk refuses admission (REV-004)",
  { skip: !enabled },
  async () => {
    const f = await adversary("(void)second;", false, true);
    const admitted = await f.admission;
    try {
      assert.ok("error" in admitted, "readiness cannot mask already-processed terminal failure");
      if ("error" in admitted) assert.match(admitted.error.message, /native refusal/);
      assert.equal(await cacheProcessTerminated(f.identity), true);
    } finally {
      if ("value" in admitted) await admitted.value.stop();
      await f.input.close();
    }
  },
);

test("split physical alias WD refuses Node admission and proves cleanup (REV-001)", { skip: !enabled }, async () => {
  const f = await adversary("(void)second;", true);
  const admitted = await f.admission;
  try {
    assert.ok("error" in admitted, "split watch identity must not be admitted");
    if ("error" in admitted) assert.match(admitted.error.message, /identity/);
    assert.equal(await cacheProcessTerminated(f.identity), true);
  } finally {
    if ("value" in admitted) await admitted.value.stop();
    await f.input.close();
  }
});

test(
  "out-of-order drain ACK permanently loses tickets and settles both pending interests (REV-002)",
  { skip: !enabled },
  async () => {
    const f = await adversary(
      'if(!fgets(second,sizeof second,stdin))return 0; puts("I1 D 2"); puts("I1 E 1 4 0 -"); puts("I1 D 1");',
    );
    const admitted = await f.admission;
    assert.ok("value" in admitted);
    const observer = admitted.value;
    try {
      const ticket = observer.ticket([0]);
      const replies = await Promise.allSettled([observer.drain(), observer.drain()]);
      assert.deepEqual(
        replies.map((reply) => reply.status),
        ["rejected", "rejected"],
      );
      await observer.faulted;
      assert.equal(observer.observationsUnchanged(ticket), false);
      assert.equal(await cacheProcessTerminated(f.identity), true);
    } finally {
      await observer.stop();
      await f.input.close();
    }
  },
);

for (const [name, evidence] of [
  ["incompatible file membership (REV-003)", 'puts("I1 E 1 256 0 61");puts("I1 D 1");'],
  ["unknown watch", 'puts("I1 E 999 4 0 -");puts("I1 D 1");'],
  ["overflow", 'puts("I1 E -1 16384 0 -");puts("I1 D 1");'],
  ["ignored", 'puts("I1 E 1 32768 0 -");puts("I1 D 1");'],
  ["unmount", 'puts("I1 E 1 8192 0 -");puts("I1 D 1");'],
  ["unknown ACK", 'puts("I1 D 2");'],
  ["truncated EOF", 'fputs("I1 E 1",stdout);fflush(stdout);return 0;'],
  ["oversized framing", "for(int n=0;n<700;n++)putchar(65);putchar(10);"],
] as const)
  test(`${name} faults and verifies native death BEFORE caller cleanup`, { skip: !enabled }, async () => {
    const f = await adversary(evidence);
    const admitted = await f.admission;
    assert.ok("value" in admitted);
    const observer = admitted.value;
    try {
      const ticket = observer.ticket([0]);
      await assert.rejects(observer.drain(), /inode observation/);
      await observer.faulted;
      assert.equal(observer.observationsUnchanged(ticket), false);
      assert.equal(await cacheProcessTerminated(f.identity), true);
    } finally {
      await observer.stop();
      await f.input.close();
    }
  });
