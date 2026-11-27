import { constants } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function contains(parent, child) {
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

// Bookie checks the workspace identity and the permissions of its own directories.
// Report filesystem metadata only. The installed package checks its enrollment.
export async function bookieStatus(pi, ctx, sdkPaths) {
  const lines = [];
  const trusted = ctx.isProjectTrusted?.() === true;
  const id = ctx.sessionManager?.getSessionId();
  lines.push("Project trusted: " + trusted, "Pi mode: " + ctx.mode);
  if (!trusted || !ctx.hasUI || ctx.mode !== "tui") return lines;
  let owner = false;
  pi.events.emit("pi-daddy:request-project-memory-owner-v1", {
    version: 1, cwd: ctx.cwd, sessionId: id,
    reply(lease) {
      owner = lease?.sessionId === id && lease.cwd === ctx.cwd && lease.isCurrent?.() === true;
    },
  });
  lines.push("Daddy granted project memory to this session: " + owner);
  const entry = pi.getCommands().find(c => c.name === "bookie-task")?.sourceInfo?.path;
  const { getAgentDir, getPackageDir } = sdkPaths ?? await import("@earendil-works/pi-coding-agent");
  return lines.concat(await storageStatus(ctx.cwd, getAgentDir(), entry, getPackageDir()));
}

async function storageStatus(workspace, agent, entry, sdk) {
  const lines = [];
  const uid = process.getuid?.();
  let cwd, profile;
  try {
    [cwd, profile] = await Promise.all([realpath(workspace), realpath(agent)]);
    if (contains(cwd, profile) || contains(profile, cwd)) {
      lines.push("Bookie rejects this workspace because its directory overlaps the Pi agent directory.");
      return lines;
    }
  } catch (error) {
    lines.push("Resolving the workspace or Pi profile failed (" + (error.code || "unknown") + ").");
    return lines;
  }
  for (const [label, path, mask, optional] of [
    ["workspace", cwd, 0, false], ["Pi agent directory", profile, 0o022, false],
    ["Bookie memory directory", join(profile, "bookie-project-memory"), 0o077, true],
    ["Bookie enrollment directory", join(profile, "bookie-task-enrollments"), 0o077, true],
  ]) {
    try {
      const st = await lstat(path, { bigint: true });
      const issues = [];
      if (!st.isDirectory()) issues.push("expected a directory");
      if (st.ino <= 0n) issues.push("missing inode");
      if (st.birthtimeNs <= 0n) issues.push("missing creation time");
      if (mask && uid !== undefined) {
        if (st.uid !== BigInt(uid)) issues.push("different owner");
        if ((st.mode & BigInt(mask)) !== 0n) issues.push("permissions " + (st.mode & 0o777n).toString(8));
      }
      if (issues.length) {
        lines.push("Bookie directory check failed for " + label + " (" + issues.join(", ") + ").");
        return lines;
      }
    } catch (error) {
      if (optional && error.code === "ENOENT") continue;
      lines.push("Inspecting " + label + " failed (" + (error.code || "unknown") + ").");
      return lines;
    }
  }
  lines.push("Directory identity and permissions: passed");
  lines.push("Node supports O_NOFOLLOW for Bookie vault creation: " + (typeof constants.O_NOFOLLOW === "number"));
  try {
    const sqlite = await import("node:sqlite");
    lines.push("Node SQLite available: " + (typeof sqlite.DatabaseSync === "function"));
  } catch {
    lines.push("Node SQLite available: false");
  }
  if (entry && sdk && isAbsolute(entry)) {
    try {
      // The released package registers src/index.ts. Pi may report its containing directory.
      const src = (await lstat(entry)).isDirectory() ? entry : dirname(entry);
      const require = createRequire(join(sdk, "package.json"));
      const { createJiti } = require("jiti");
      const loader = createJiti(entry, {
        alias: { "@earendil-works/pi-coding-agent": join(sdk, "dist", "index.js") },
        fsCache: false,
      });
      const { taskEnrollment } = await loader.import(join(src, "managed-vault.ts"));
      lines.push("Bookie enrollment: " + await taskEnrollment(cwd, profile));
      return lines;
    } catch (error) {
      lines.push("Bookie enrollment probe: " + (error.code || error.name || "unknown"));
    }
  }
  lines.push("Bookie enrollment: could not query this installed package");
  return lines;
}

async function shellSdkRoot(repo) {
  // Pi's npm executable normally links into the SDK package. The pilot checkout
  // also has a pinned SDK for installations that launch Pi through a wrapper.
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    let path;
    try { path = dirname(await realpath(join(dir, "pi"))); } catch { continue; }
    while (dirname(path) !== path) {
      try {
        if (JSON.parse(await readFile(join(path, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return path;
      } catch { /* No package manifest at this level. */ }
      path = dirname(path);
    }
  }
  return join(repo, "node_modules", "@earendil-works", "pi-coding-agent");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  const agent = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
  const entry = join(agent, "npm", "node_modules", "pi-bookie", "src", "index.ts");
  console.log("Bookie storage check (Ubuntu/terminal profile)\nWorkspace: " + workspace);
  console.log((await storageStatus(workspace, agent, entry, await shellSdkRoot(workspace))).join("\n"));
}
