// Serve the actual npm-pack artifact for Daddy while Pi installs the other packages from npm.
// The candidate may have a version which has never been published, or an existing version with different contents.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import release from "../src/products/ecosystem-release.json" with { type: "json" };

const [archive, packageRoot] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
assert.equal(pkg.name, "pi-daddy");
const profile = process.env.PI_CODING_AGENT_DIR;
assert.ok(profile, "Use a disposable Pi profile for the candidate setup");
mkdirSync(profile, { recursive: true });
const settings = join(profile, "settings.json");
const filters = { extensions: ["extensions/grants.ts"] };
writeFileSync(settings, JSON.stringify({ packages: [{ source: `npm:pi-daddy@${release.publicVersions["pi-daddy"]}`, ...filters }] }), {
  flag: "wx",
});
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
  const env = { ...process.env, npm_config_registry: origin, npm_config_cache: join(packageRoot, "..", "npm-cache") };
  const setup = spawn(process.execPath, [join(packageRoot, "dist", "cli.js"), "setup", "--preset", "auto"], {
    stdio: "inherit",
    env,
  });
  const [code] = await once(setup, "exit");
  assert.equal(code, 0, "The packed candidate must install successfully");
  const ecosystem = JSON.parse(readFileSync(join(profile, "ecosystem.json"), "utf8"));
  assert.equal(ecosystem.setupPreset.name, "session", "The installed Pi catalog must fall back to the session in an empty profile");
  assert.ok(downloaded, "Pi must download the candidate Daddy tarball");
  const configured = JSON.parse(readFileSync(settings, "utf8")).packages;
  assert.ok(configured.some((entry) => entry?.source === "npm:pi-daddy" &&
    JSON.stringify(entry.extensions) === JSON.stringify(filters.extensions)), "Setup must migrate a filtered pin in place");
  const update = spawn("pi", ["update", "--extensions"], { stdio: "inherit", env });
  const [updateCode] = await once(update, "exit");
  assert.equal(updateCode, 0, "Pi must be able to update the managed ecosystem");
} finally {
  registry.close();
}
