import assert from "node:assert/strict";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { dailyDashboardPaths, preparePrivateHostRoot } from "../extensions/daily-dashboard-session.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("production host state avoids reserved .pi paths and keeps the private socket bounded",()=>{
 const paths=dailyDashboardPaths("/workspace/project","fresh-id","/home/operator");
 assert.equal(paths.directory.includes("/.pi/"),false);assert.equal(paths.socketPath.includes("/.pi/"),false);assert.ok(Buffer.byteLength(paths.socketPath)<=100);
});

test("host setup creates only owner-private state and refuses unsafe or linked prior state",async()=>{
 const root=await tempDir("daily-host-state-"),fresh=join(root,"fresh"),unsafe=join(root,"unsafe"),linked=join(root,"linked");
 await preparePrivateHostRoot(fresh);
 await mkdir(unsafe,{mode:0o700});await chmod(unsafe,0o755);
 await assert.rejects(preparePrivateHostRoot(unsafe),/owner-private/);
 await symlink(fresh,linked);
 await assert.rejects(preparePrivateHostRoot(linked),/symbolic-link/);
});
