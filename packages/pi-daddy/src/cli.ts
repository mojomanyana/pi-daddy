#!/usr/bin/env node
/**
 * `pi-daddy` — the command line, which today has exactly one subcommand.
 *
 * Thin on purpose: argv in, `discoverSkillPackages` + `planInit` + `applyInit`, report out. Every decision
 * lives in `./init.ts`, `./grant-env.ts` and `./skill-packages.ts` as functions that touch no argv and print
 * nothing, so the scaffolding is testable without running a process — the same split `extensions/grants.ts`
 * was cut along after four wiring bugs in a row lived in the part nothing could test.
 *
 * **`parseArgs` is exported and tested, which it was not** (R-79). This file shipped with zero tests and
 * promptly earned two of them: an entry-point guard that was false for every installed copy (R-73), and an
 * unknown-option check that exempted `argv[0]` whenever `--dir` was absent, so `pi-daddy init --Force`
 * was accepted in silence — the exact failure the check's own comment says it prevents.
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { UnsafeGrantError } from "./grant-env.ts";
import { applyInit, countDeclaring, planInit, type InitPlan } from "./init.ts";
import { discoverSkillPackages, type RefusedSkill, type SkillPackage } from "./skill-packages.ts";

const USAGE = `pi-daddy — capability governance for pi sub-agents

Usage:
  pi-daddy init [--force] [--dir <path>]   scaffold .pi/skills/ and .pi/grants.env from installed
                                           packages that declare skills (package.json "pi": {"skills": …})
  pi-daddy --help | --version

init copies each declared SKILL.md into .pi/skills/ and writes a grant naming exactly what those files
declare. It never chooses a ceiling: a skill declaring no \`allowed-tools\` is copied with a commented
placeholder and stays unspawnable until you fill it in. Capabilities that can change your machine
(bash, write, edit) are written COMMENTED — uncomment them deliberately. Review the files, then commit.

  --force   rewrite the SKILL.md copies that already exist. This DISCARDS any \`allowed-tools\` you added.
            It never rewrites .pi/grants.env — delete that file if you want it regenerated.`;

export interface ParsedArgs {
  command: "init" | "help" | "version";
  dir?: string;
  force: boolean;
  /** Non-empty means refuse: argv said something this program does not understand. */
  errors: string[];
}

/**
 * Parse argv. Pure, exported, and tested — argv handling is where both of this file's defects lived.
 *
 * Rule 8 throughout: an unrecognised option is refused rather than ignored, and `--dir` refuses a value
 * that looks like a flag, because `init --dir --force` used to scaffold into a directory named `--force`
 * with `force` simultaneously true.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  if (args.length === 0) return { command: "help", force: false, errors: ["no command"] };
  if (args.includes("--help") || args.includes("-h")) return { command: "help", force: false, errors: [] };
  if (args.includes("--version") || args.includes("-v")) return { command: "version", force: false, errors: [] };

  const [command, ...rest] = args;
  if (command !== "init") return { command: "help", force: false, errors: [`unknown command "${command}"`] };

  const errors: string[] = [];
  let dir: string | undefined;
  let force = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--dir") {
      const value = rest[i + 1];
      // A flag is not a path. Without this, `--dir --force` consumed the flag as the directory AND left
      // force on, then reported "nothing to scaffold" and exited 0 — the outcome this CLI's own comments
      // call the worst available failure for a scaffolding command.
      if (value === undefined || value.startsWith("-")) errors.push("--dir needs a path");
      else {
        dir = value;
        i += 1;
      }
    } else {
      // Was `rest.filter((a, i) => … && i !== dirIndex + 1)`, and with `--dir` absent `dirIndex` is -1, so
      // the exemption became `i !== 0` and the FIRST argument was never checked. `init --Force` therefore
      // parsed as a valid no-op run: it kept every file and exited 0, which is indistinguishable from a
      // deliberate second run. Found by a reviewer, not by a test, because this file had none.
      errors.push(`unknown option ${arg}`);
    }
  }

  return { command: "init", dir, force, errors };
}

/** Report a plan and what came of applying it. Returns the process exit code. */
async function init(cwd: string, force: boolean): Promise<number> {
  const packages = await discoverSkillPackages(cwd);
  if (packages.length === 0) {
    console.log(
      `pi-daddy init: no installed package under ${cwd}/node_modules declares skills\n` +
        `(a package.json "pi": {"skills": [...]} field). Nothing to scaffold.\n\n` +
        `  npm install principal-pi-skills   # seven skills; then re-run this`,
    );
    return 0;
  }

  let plan: InitPlan;
  try {
    plan = planInit(packages, cwd);
  } catch (error) {
    // R-78's backstop reaching the surface. Nothing is written: a grant that could mean something to a
    // shell is not a grant, and half-scaffolding a project would be worse than scaffolding none of it.
    if (error instanceof UnsafeGrantError) {
      console.error(`pi-daddy init: ${error.message}`);
      return 1;
    }
    throw error;
  }

  for (const pkg of packages) {
    const declaring = countDeclaring(plan.skills, `${pkg.name}@${pkg.version}`);
    console.log(
      `found ${pkg.name}@${pkg.version} — ${pkg.skills.length} skill(s), ` +
        `${declaring} declaring allowed-tools` +
        (pkg.unreadable.length > 0 ? `, ${pkg.unreadable.length} declared but unreadable (${pkg.unreadable.join(", ")})` : "") +
        // Counted on this line as well as named below it: a reader who stops at the first line must not
        // read "0 skill(s)" as "this package ships none".
        (pkg.refused.length > 0 ? `, ${pkg.refused.length} REFUSED` : ""),
    );
  }
  const refused = packages.flatMap((p) => p.refused.map((r) => ({ pkg: p, refusal: r })));
  for (const { pkg, refusal } of refused) console.error(reportRefusal(pkg, refusal));
  for (const collision of plan.collisions) console.log(`  skipped ${collision}`);

  // `--force` is destructive and says so at the moment it acts, not only in `--help` — which is the one
  // place the operator running the command is not reading.
  if (force) {
    const existing = plan.skills.length;
    console.log(
      `\n--force: rewriting up to ${existing} SKILL.md cop${existing === 1 ? "y" : "ies"} from the installed\n` +
        `packages. Any \`allowed-tools\` you wrote in them is DISCARDED. .pi/grants.env is never rewritten.`,
    );
  }

  const outcome = await applyInit(plan, { force });
  const short = (path: string) => relative(cwd, path) || path;
  for (const path of outcome.written) console.log(`wrote ${short(path)}`);
  for (const path of outcome.kept) console.log(`kept  ${short(path)} (already present — left exactly as it is)`);
  for (const failure of outcome.failed) console.error(`FAILED ${short(failure.path)}: ${failure.error}`);

  report(plan);
  // A refusal is a non-zero exit so CI can see it: a package that tried to write a capability into the
  // grant through a name or a declaration is a fact a build should be able to fail on.
  return outcome.failed.length > 0 || refused.length > 0 ? 1 : 0;
}

/** Say what was refused and what the fix is. Each reason has a different one. */
function reportRefusal(pkg: SkillPackage, refusal: RefusedSkill): string {
  const head = `REFUSED ${pkg.name}: ${JSON.stringify(refusal.subject)}`;
  switch (refusal.reason) {
    case "unsafe-name":
      return (
        `${head} cannot be governed — a definition name becomes a capability id in a comma-separated ` +
        `grant, a line in a file you source, and a path. Names must match [A-Za-z0-9][A-Za-z0-9._-]*.`
      );
    case "unsafe-capability":
      return (
        `${head} declares ${refusal.detail.join(", ")}, which cannot be written into a grant file — a ` +
        `capability id is tool:/skill:/agent:<name> or ext:<pkg>/<tool>. A quote or a separator here ` +
        `would end up in a file you are told to \`source\`.`
      );
    case "wildcard":
      return (
        `${head} declares ${refusal.detail.join(", ")} — that is root authority, not a description of what ` +
        `the skill needs, and a package may not hand it to itself. ${refusal.detail.includes("tool:*") ? "tool:* satisfies EVERY capability" : "agent:* authorises every definition on disk"}. ` +
        `Add it by hand to PI_GRANTS_GRANT if you genuinely mean it.`
      );
    case "not-utf8":
      return `${head} is not valid UTF-8, so it cannot be copied verbatim — pi-daddy will not rewrite its bytes.`;
  }
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

  if (plan.withheldCapabilities.size > 0) {
    const needed = [...plan.withheldCapabilities].map(([c, who]) => `${c} (${who.join(", ")})`).join(", ");
    console.log(
      `\nWITHHELD BY DEFAULT: ${needed}.\n` +
        `These can change your machine, so they are written COMMENTED in .pi/grants.env along with the\n` +
        `\`agent:\` ids of the definitions that need them. Uncomment deliberately — that is the decision.`,
    );
  }

  console.log(
    `\nLive grant (${plan.grant.length} capabilities): ${plan.grant.join(", ")}\n\n` +
      `  $EDITOR .pi/grants.env         # review it, then commit it\n` +
      `  source .pi/grants.env && pi    # /grants lists every definition and its verdict`,
  );
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.command === "version") {
    // Read from the manifest rather than pinned here: a version literal in code is one more place to
    // forget, and this package has already had a document claiming a version that never existed.
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(version);
    return 0;
  }

  if (parsed.errors.length > 0) {
    const stream = parsed.errors[0] === "no command" ? console.log : console.error;
    stream(parsed.errors[0] === "no command" ? USAGE : `pi-daddy: ${parsed.errors.join("; ")}\n\n${USAGE}`);
    return 1;
  }
  if (parsed.command === "help") {
    console.log(USAGE);
    return 0;
  }

  // ABSOLUTE, always. `readSkill` compares a resolved entry against the package directory, and a relative
  // `--dir` made that comparison false for every entry: every declared skill of every package was reported
  // "declared but unreadable", nothing was copied, a degenerate grants.env was written anyway, and the exit
  // code was 0 — while the message blamed the package for a defect in this line.
  return init(resolvePath(parsed.dir ?? process.cwd()), parsed.force);
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
