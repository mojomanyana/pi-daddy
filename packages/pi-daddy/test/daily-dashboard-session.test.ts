import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { createDailyDashboardSession, dailyDashboardPaths, preparePrivateHostRoot } from "../extensions/daily-dashboard-session.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

test("production host state avoids reserved .pi paths and keeps the private socket bounded",()=>{
 const paths=dailyDashboardPaths("/workspace/project","fresh-id","/home/operator");
 assert.equal(paths.directory.includes("/.pi/"),false);assert.equal(paths.socketPath.includes("/.pi/"),false);assert.ok(Buffer.byteLength(paths.socketPath)<=100);
});

test("existing or partial daily host IDs refuse before bridge startup and preserve their bytes",async()=>{
 const root=await tempDir("daily-host-reuse-"),cwd="/workspace/project",id="partial-id",paths=dailyDashboardPaths(cwd,id,root);await mkdir(paths.directory,{recursive:true,mode:0o700});const marker=paths.directory+"/partial";await writeFile(marker,"preserve");
 const session=createDailyDashboardSession({ordinary:()=>({} as never),declared:()=>({} as never),rebind:()=>{},cwd:()=>cwd,env:{},author:"operator",home:root});
 await assert.rejects(session.run(id),/preserved state; choose a fresh host ID/);
 assert.equal(await readFile(marker,"utf8"),"preserve");
});

test("host setup creates only owner-private state and refuses unsafe or linked prior state",async()=>{
 const root=await tempDir("daily-host-state-"),fresh=join(root,"fresh"),unsafe=join(root,"unsafe"),linked=join(root,"linked");
 await preparePrivateHostRoot(fresh);
 await mkdir(unsafe,{mode:0o700});await chmod(unsafe,0o755);
 await assert.rejects(preparePrivateHostRoot(unsafe),/owner-private/);
 await symlink(fresh,linked);
 await assert.rejects(preparePrivateHostRoot(linked),/symbolic-link/);
});
