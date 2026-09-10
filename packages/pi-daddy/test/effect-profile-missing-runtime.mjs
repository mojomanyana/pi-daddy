import fs from "node:fs/promises";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { after } from "node:test";
const original = fs.lstat, create = net.createServer, servers = [];
fs.lstat = async function(path, ...args) {
  if (String(path) === "/usr/bin/bwrap") throw Object.assign(new Error("fixture missing bwrap prerequisite"), { code: "ENOENT" });
  return Reflect.apply(original, this, [path, ...args]);
};
net.createServer = function(...args) { const server = Reflect.apply(create, this, args); servers.push(server); return server; };
syncBuiltinESMExports();
after(async () => {
  if (!servers.length) return;
  const leaked = servers.filter(s => s.listening);
  console.log("NAMESPACE_FIXTURE_LIFETIME", JSON.stringify({ created: servers.length, leaked: leaked.length }));
  // Bound a broken regression too, AFTER recording the real lifetime assertion; not a success shim.
  await Promise.all(leaked.map(s => new Promise((resolve, reject) => s.close(e => e ? reject(e) : resolve()))));
});
