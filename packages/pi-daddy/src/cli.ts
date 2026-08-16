#!/usr/bin/env node
/**
 * `pi-daddy` — the command line, which today has exactly one subcommand.
 *
 * Thin on purpose: argv in, `discoverSkillPackages` + `planInit` + `applyInit`, report out. Every decision
 * lives in `./init.ts` and `./skill-packages.ts` as functions that touch no argv and print nothing, so the
 * scaffolding is testable without running a process — the same split `extensions/grants.ts` was cut along
 * after four wiring bugs in a row lived in the part nothing could test.
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { applyInit, planInit, type InitPlan } from "./init.ts";
import { discoverSkillPackages } from "./skill-packages.ts";

const USAGE = `pi-daddy — capability governance for pi sub-agents

Usage:
  pi-daddy init [--force] [--dir <path>]   scaffold .pi/skills/ and .pi/grants.env from installed
                                           packages that declare skills (package.json "pi": {"skills": …})
  pi-daddy --help | --version

init copies each declared SKILL.md into .pi/skills/ and writes a grant naming exactly what those files
declare. It never chooses a ceiling: a skill declaring no \`allowed-tools\` is copied with a commented
placeholder and stays unspawnable until you fill it in. Review the files, then commit them.

  --force   rewrite files that already exist. This DISCARDS any \`allowed-tools\` you added.`;

/** Report a plan and what came of applying it. Returns the process exit code. */
async function init(cwd: string, force: boolean): Promise<number> {
  const packages = await discoverSkillPackages(cwd);
  if (packages.length === 0) {
    console.log(
      `pi-daddy init: no installed package under ${relative(process.cwd(), cwd) || "."}/node_modules declares\n` +
        `skills (a package.json "pi": {"skills": [...]} field). Nothing to scaffold.\n\n` +
        `  npm install principal-pi-skills   # seven skills; then re-run this`,
    );
    return 0;
  }

  const plan = planInit(packages, cwd);
  for (const pkg of packages) {
    const declaring = plan.skills.filter((s) => s.from === `${pkg.name}@${pkg.version}` && s.withheld === null).length;
    console.log(
      `found ${pkg.name}@${pkg.version} — ${pkg.skills.length} skill(s), ` +
        `${declaring} declaring allowed-tools` +
        (pkg.unreadable.length > 0 ? `, ${pkg.unreadable.length} declared but unreadable (${pkg.unreadable.join(", ")})` : "") +
        // Counted on this line as well as named below it: a reader who stops at the first line must not
        // read "0 skill(s)" as "this package ships none".
        (pkg.unsafe.length > 0 ? `, ${pkg.unsafe.length} REFUSED for an unusable name` : ""),
    );
    // Loud, not silent (rule 8). A refused name is either a broken package or an attempt to write a
    // capability into someone's grant, and both want an operator's attention rather than a shorter list.
    for (const name of pkg.unsafe) {
      console.error(
        `REFUSED ${pkg.name}: a skill named ${JSON.stringify(name)} cannot be governed — a definition name ` +
          `becomes a capability id in a comma-separated grant, a line in a file you source, and a path. ` +
          `Names must match [A-Za-z0-9][A-Za-z0-9._-]*.`,
      );
    }
  }
  for (const collision of plan.collisions) console.log(`  skipped ${collision}`);

  const outcome = await applyInit(plan, { force });
  const short = (path: string) => relative(cwd, path) || path;
  for (const path of outcome.written) console.log(`wrote ${short(path)}`);
  for (const path of outcome.kept) console.log(`kept  ${short(path)} (already present — --force rewrites it)`);
  for (const failure of outcome.failed) console.error(`FAILED ${short(failure.path)}: ${failure.error}`);

  report(plan);
  return outcome.failed.length > 0 ? 1 : 0;
}

/** What the operator has to do next, and what pi-daddy deliberately did not do for them. */
function report(plan: InitPlan): void {
  const undeclared = plan.skills.filter((s) => s.withheld === "undeclared");
  const patterned = plan.skills.filter((s) => s.withheld === "pattern");

  for (const caution of plan.cautions) console.log(`\nCAUTION: ${caution}`);
  for (const skill of patterned) console.log(`\nNOT SPAWNABLE: ${skill.name} ${skill.notes.join("; ")}`);

  if (undeclared.length > 0) {
    console.log(
      `\n${undeclared.length} skill(s) declare no allowed-tools and cannot be spawned until they do: ` +
        `${undeclared.map((s) => s.name).join(", ")}.\n` +
        `Each copy carries a commented \`allowed-tools:\` line. pi-daddy does not choose ceilings — that\n` +
        `decision is what you review and commit, so it is yours to write. Then add each \`agent:<name>\`\n` +
        `to PI_GRANTS_GRANT in .pi/grants.env.`,
    );
  }

  console.log(
    `\nGrant written (${plan.grant.length} capabilities): ${plan.grant.join(", ")}\n\n` +
      `  $EDITOR .pi/grants.env         # review it, then commit it\n` +
      `  source .pi/grants.env && pi    # /grants lists every definition and its verdict`,
  );
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return args.length === 0 ? 1 : 0;
  }
  if (args.includes("--version") || args.includes("-v")) {
    // Read from the manifest rather than pinned here: a version literal in code is one more place to
    // forget, and this package has already had a document claiming a version that never existed.
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(version);
    return 0;
  }

  const [command, ...rest] = args;
  if (command !== "init") {
    console.error(`pi-daddy: unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }

  const dirIndex = rest.indexOf("--dir");
  const dir = dirIndex === -1 ? process.cwd() : rest[dirIndex + 1];
  if (dirIndex !== -1 && !dir) {
    console.error("pi-daddy init: --dir needs a path");
    return 1;
  }
  const unknown = rest.filter((a, i) => a.startsWith("-") && a !== "--force" && a !== "--dir" && i !== dirIndex + 1);
  if (unknown.length > 0) {
    // Rule 8: an unrecognised flag is refused rather than ignored. A typo'd `--force` that silently did
    // nothing would be indistinguishable from a run that kept every file on purpose.
    console.error(`pi-daddy init: unknown option ${unknown.join(", ")}\n\n${USAGE}`);
    return 1;
  }

  return init(dir, rest.includes("--force"));
}

/**
 * Only when run as a program. Importing this module (the tests do) must not execute anything.
 *
 * `realpathSync` is load-bearing and was found by the smoke test, not by reasoning: npm installs a bin as a
 * **symlink** at `node_modules/.bin/pi-daddy`, so `process.argv[1]` is the link while `import.meta.url` is
 * the file it points at. Comparing them directly made `npx pi-daddy init` print nothing at all and exit 0 —
 * the worst available failure for a scaffolding command, since "it did nothing" reads as "there was
 * nothing to do".
 */
const invokedDirectly = (() => {
  try {
    return process.argv[1] ? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href : false;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  process.exitCode = await main(process.argv);
}
