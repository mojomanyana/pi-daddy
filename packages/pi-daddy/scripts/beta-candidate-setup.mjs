// Serve the actual npm-pack artifact for Daddy while Pi installs the other packages from npm.
// The candidate may have a version which has never been published, or an existing version with different contents.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [archive, packageRoot] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
assert.equal(pkg.name, "pi-daddy");
const bytes = readFileSync(archive);
const tarPath = "/pi-daddy/-/candidate.tgz";
const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
let downloaded = false;
const registry = createServer((req, res) => {
  if (req.url === tarPath) {
    downloaded = true;
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
    res.end(bytes);
  } else if (req.url === "/pi-daddy") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      name: pkg.name,
      "dist-tags": { latest: pkg.version },
      versions: { [pkg.version]: { ...pkg, dist: { integrity, tarball: origin + tarPath } } },
    }));
  } else {
    res.writeHead(302, { Location: "https://registry.npmjs.org" + req.url });
    res.end();
  }
});
registry.listen(0, "127.0.0.1");
await once(registry, "listening");
const origin = `http://127.0.0.1:${registry.address().port}`;
try {
  const setup = spawn(process.execPath, [join(packageRoot, "dist", "cli.js"), "setup"], {
    stdio: "inherit",
    env: { ...process.env, npm_config_registry: origin, npm_config_cache: join(packageRoot, "..", "npm-cache") },
  });
  const [code] = await once(setup, "exit");
  assert.equal(code, 0, "The packed candidate must install successfully");
  assert.ok(downloaded, "Pi must download the candidate Daddy tarball");
} finally {
  registry.close();
}
