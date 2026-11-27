import { pilotCheckout } from "./pilot-checkouts.mjs";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repo = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
function hasBookieIdentity(path) {
  const stat = statSync(path, { bigint: true });
  return stat.isDirectory() && stat.ino > 0n && stat.birthtimeNs > 0n;
}
let workspace = repo;
if (!hasBookieIdentity(repo)) {
  const key = createHash("sha256").update(repo).digest("hex").slice(0, 16);
  workspace = join(homedir(), ".local", "share", "pi-daddy", "harvest-pilot", key);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  workspace = realpathSync(workspace);
  if (!hasBookieIdentity(workspace)) {
    throw Error("Bookie requires a directory with an inode and a creation time. Both candidate folders failed: " + repo + " and " + workspace);
  }
  console.error("Using a separate Bookie pilot workspace: " + workspace + "\nLive classifier source: " + repo);
}
const projectDir = join(workspace, ".pi");
const profile = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
const settings = (dir) => {
  const file = join(dir, "settings.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};
const user = settings(profile);
const project = settings(projectDir);
const packages = [...(project.packages ?? [])];
const source = (entry) => typeof entry === "string" ? entry : entry.source;
const localDaddy = workspace === repo ? "../packages/pi-daddy" : join(repo, "packages", "pi-daddy");
function identify(entry, base) {
  const s = source(entry);
  if (s.startsWith("npm:")) return s.slice(4).split("@")[0];
  if (/^(?:git:|https?:|ssh:)/.test(s)) return s.split("/").pop()?.replace(/\.git(?:@.*)?$|@[^/]*$/g, "");
  const manifest = join(resolve(base, s), "package.json");
  return existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).name : undefined;
}
const localScout = pilotCheckout("scout");
const bookie = pilotCheckout("bookie");
const localBookie = bookie && join(bookie, "packages", "pi-extension");
const release = JSON.parse(readFileSync(join(repo, "packages/pi-daddy/src/products/ecosystem-release.json"), "utf8"));
for (const name of release.normalCliInstalls) {
  const configured = [...packages.map((p)=>[p,projectDir]), ...(user.packages ?? []).map((p)=>[p,profile])];
  const candidate = name === "pi-scout-research" ? localScout : name === "pi-bookie" ? localBookie : undefined;
  if (candidate) {
    for (const [entry, dir] of configured) {
      if (identify(entry,dir) !== name || resolve(dir, source(entry)) === candidate) continue;
      const override = {source:source(entry), extensions:[], skills:[], prompts:[], themes:[]};
      const i = packages.findIndex(item=>source(item) === source(entry));
      if (i < 0) packages.push(override); else packages[i] = override;
    }
    if (!packages.some(entry=>resolve(projectDir,source(entry)) === candidate)) packages.push(candidate);
    continue;
  }
  if (name !== "pi-daddy") {
    if (!configured.some(([p,dir]) => identify(p,dir) === name)) packages.push("npm:" + name);
    continue;
  }
  // Exclude only the installed Daddy copy in this project. Other packages and user extensions keep their normal discovery.
  for (const [p,dir] of configured) {
    if (identify(p,dir) !== name || resolve(dir,source(p)) === resolve(projectDir,localDaddy)) continue;
    const current = packages.findIndex(e => source(e) === source(p));
    const override = {source:source(p), autoload:false, extensions:["-extensions/grants.ts"]};
    if (current < 0) packages.push(override);
    else packages[current] = {...(typeof packages[current] === "object" ? packages[current] : {}), ...override};
  }
  if (!packages.some(e=>resolve(projectDir, source(e))===resolve(projectDir,localDaddy))) packages.push(localDaddy);
}
if (JSON.stringify(project.packages) !== JSON.stringify(packages)) {
  mkdirSync(projectDir,{recursive:true});
  const temp = join(projectDir, ".pilot-" + randomUUID() + ".tmp");
  writeFileSync(temp,JSON.stringify({...project,packages},null,2)+"\n",{flag:"wx",mode:0o600});
  renameSync(temp,join(projectDir,"settings.json"));
}
if (process.argv.includes("--print-workspace")) console.log(workspace);
