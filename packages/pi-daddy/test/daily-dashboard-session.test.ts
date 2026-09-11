import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyDashboardPaths } from "../extensions/daily-dashboard-session.ts";

test("production host state avoids reserved .pi paths and keeps the private socket bounded",()=>{
 const paths=dailyDashboardPaths("/workspace/project","fresh-id","/home/operator");
 assert.equal(paths.directory.includes("/.pi/"),false);assert.equal(paths.socketPath.includes("/.pi/"),false);assert.ok(Buffer.byteLength(paths.socketPath)<=100);
});
