#!/usr/bin/env node
/**
 * `pi-daddy` — scaffolding and ledger maintenance.
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
import { UnsafeGrantError } from "./kernel/grant-env.ts";
import {
  applyInit,
  countDeclaring,
  planInit,
  type InitPlan,
  GITIGNORE_REINCLUDE_LINES,
  settingsIgnoredByGit,
} from "./governance/init.ts";
import { registeredWorkspaceIds } from "./kernel/workspace.ts";
import { explainDoubledNamespace } from "./kernel/catalog.ts";
import type { Capability } from "./kernel/resolve.ts";
import {
  discoverSkillPackages,
  skillPackageRoots,
  type RefusedSkill,
  type SkillPackage,
} from "./kernel/skill-packages.ts";
import { adoptLegacyEnvironment, legacyEnvironmentWarning } from "./kernel/env-names.ts";
import { PI_PROJECT_DIR, PROJECT_FILES, PROJECT_STATE_DIRNAME } from "./kernel/project-paths.ts";
import { repairLedger } from "./governance/record.ts";
import { importLegacyLedger } from "./governance/ledger.ts";

/** The reviewable record, as the operator sees it relative to the project (ADR-0076 PR 3c). */
const SETTINGS_REL = `${PI_PROJECT_DIR}/${PROJECT_STATE_DIRNAME}/${PROJECT_FILES.settings}`;

const USAGE = `pi-daddy — capability governance for pi sub-agents

Usage:
  pi-daddy init [--force] [--dir <path>]   prepare ${SETTINGS_REL} from enabled installed
                                           packages that declare skills (package.json "pi": {"skills": …})
  pi-daddy ledger repair <path> [--yes]   show the damaged tail of a ledger; --yes truncates it (ADR-0076)
  pi-daddy ledger import <source> <target> copy a pre-format ledger into the record format; the source is untouched
  pi-daddy --help | --version

init references skills already enabled in Pi at their installed or local paths. Legacy unregistered npm
skills are copied into .pi/skills/. It never chooses a ceiling: missing or unusable \`allowed-tools\`
stays unspawnable. Capabilities that can change your machine
(bash, write, edit) are written COMMENTED — uncomment them deliberately. Review the files, then commit.

  --force   rewrite legacy unregistered npm SKILL.md copies that already exist. This DISCARDS any \`allowed-tools\` you added.
            It never rewrites ${SETTINGS_REL} — delete that file if you want it regenerated.`;

export interface ParsedArgs {
  command: "init" | "ledger-repair" | "ledger-import" | "help" | "version";
  importTarget?: string;
  /** `ledger repair <path>`: the ledger file; `yes` applies, otherwise preview only. */
  ledgerPath?: string;
  yes?: boolean;
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

  const [command, ...tail] = args;
  if (command === "ledger") {
    // ADR-0076 PR 3d: `ledger repair <path> [--yes]` previews, --yes truncates; `ledger import <source> <target>`.
    const [verb, target, ...flags] = tail;
    if (verb === "import") {
      const [source, dest, ...extra] = tail.slice(1);
      if (!source || !dest || source.startsWith("-") || dest.startsWith("-") || extra.length)
        return { command: "help", force: false, errors: ["ledger import needs: <source> <target>"] };
      return { command: "ledger-import", force: false, errors: [], ledgerPath: source, importTarget: dest };
    }
    if (verb !== "repair" || !target || target.startsWith("-"))
      return {
        command: "help",
        force: false,
        errors: ["ledger needs: repair <path> [--yes] | import <source> <target>"],
      };
    const unknown = flags.filter((f) => f !== "--yes");
    if (unknown.length) return { command: "help", force: false, errors: [`unknown option "${unknown[0]}"`] };
    return { command: "ledger-repair", force: false, errors: [], ledgerPath: target, yes: flags.includes("--yes") };
  }
  if (command !== "init") return { command: "help", force: false, errors: [`unknown command "${command}"`] };
  const errors: string[] = [];
  let force = false;
  let dir: string | undefined;
  for (let i = 0; i < tail.length; i += 1) {
    const arg = tail[i];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--dir") {
      // A flag is never a path: `init --dir --force` used to scaffold into a directory named `--force`.
      const value = tail[i + 1];
      if (value === undefined || value.startsWith("-")) errors.push("--dir needs a path");
      else {
        dir = value;
        i += 1;
      }
    } else {
      errors.push(`unknown option ${arg}`);
    }
  }
  return { command: "init", dir, force, errors };
}

/** Report a plan and what came of applying it. Returns the process exit code. */
async function init(cwd: string, force: boolean): Promise<number> {
  const packages = await discoverSkillPackages(cwd);
  if (packages.length === 0) {
    // Names BOTH roots it looked in, and offers pi's own install command first. The previous message named
    // only `<cwd>/node_modules` and said "npm install …" — so an operator who had just run
    // `pi install npm:principal-pi-skills`, which installs to the agent root, was told to install a package
    // they had already installed (R-75).
    console.log(
      `pi-daddy init: no enabled configured skills or unregistered npm package declares skills (a package.json "pi": {"skills": [...]} ` +
        `field). Nothing to scaffold.\n\nLooked in:\n` +
        skillPackageRoots(cwd)
          .map((r) => `  ${r}\n`)
          .join("") +
        `\n  pi install npm:principal-pi-skills    # seven skills, and registers it with pi\n` +
        `  npm install principal-pi-skills      # or pin it in this project instead`,
    );
    return 0;
  }

  let plan: InitPlan;
  try {
    plan = planInit(packages, cwd, await registeredWorkspaceIds());
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
        (pkg.unreadable.length > 0
          ? `, ${pkg.unreadable.length} declared but unreadable (${pkg.unreadable.join(", ")})`
          : "") +
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
    const existing = plan.skills.filter((s) => !s.referenced).length;
    console.log(
      `\n--force: rewriting up to ${existing} SKILL.md cop${existing === 1 ? "y" : "ies"} from the installed\n` +
        `packages. Any \`allowed-tools\` you wrote in them is DISCARDED. settings.json is never rewritten.`,
    );
  }

  const outcome = await applyInit(plan, { force });
  const short = (path: string) => relative(cwd, path) || path;
  for (const skill of plan.skills.filter((s) => s.referenced))
    console.log(`using ${short(skill.sourcePath)} (enabled in Pi; no copy)`);
  for (const path of outcome.written) console.log(`wrote ${short(path)}`);
  for (const path of outcome.kept) console.log(`kept  ${short(path)} (already present — left exactly as it is)`);
  for (const failure of outcome.failed) console.error(`FAILED ${short(failure.path)}: ${failure.error}`);

  await report(plan);
  // A refusal is a non-zero exit so CI can see it: a package that tried to write a capability into the
  // grant through a name or a declaration is a fact a build should be able to fail on.
  return outcome.failed.length > 0 || refused.length > 0 ? 1 : 0;
}

/** Say what was refused and what the fix is. Each reason has a different one. */
/** Exported so the message an operator actually reads can be tested; `init` composes it, nothing else calls it. */
export function reportRefusal(pkg: SkillPackage, refusal: RefusedSkill): string {
  const head = `REFUSED ${pkg.name}: ${JSON.stringify(refusal.subject)}`;
  switch (refusal.reason) {
    case "unsafe-name":
      return (
        `${head} cannot be governed — a definition name becomes a capability id in a comma-separated ` +
        `grant, a line in a file you source, and a path. Names must match [A-Za-z0-9][A-Za-z0-9._-]*.`
      );
    case "unsafe-capability": {
      // The one shape of unsafe id that has a known cause worth naming: an `allowed-tools` entry written with a
      // capitalised namespace, which the bare-entry path prefixes a second time. `isSafeCapability` rejects the
      // extra colon, so this refusal — not the spawn refusal and not `planInit`'s cautions — is where a doubled
      // id actually reaches an operator. Measured: a package declaring `Tool:Read` never reaches `planInit`.
      const doubled = refusal.detail.map((id) => explainDoubledNamespace(id as Capability)).filter(Boolean);
      return (
        `${head} declares ${refusal.detail.join(", ")}, which cannot be written into a grant file — a ` +
        `capability id is tool:/skill:/agent:<name> or ext:<pkg>/<tool>. A quote or a separator here ` +
        `would end up in a file you are told to \`source\`.` +
        (doubled.length ? `\n  ${doubled.join("\n  ")}` : "")
      );
    }
    case "wildcard":
      return (
        `${head} declares ${refusal.detail.join(", ")} — that is root authority, not a description of what ` +
        `the skill needs, and a package may not hand it to itself. ${refusal.detail.includes("tool:*") ? "tool:* satisfies EVERY capability" : "agent:* authorises every definition on disk"}. ` +
        `Add it by hand to PI_DADDY_GRANT if you genuinely mean it.`
      );
    case "not-utf8":
      return `${head} is not valid UTF-8, so it cannot be copied verbatim — pi-daddy will not rewrite its bytes.`;
  }
}

/** What the operator has to do next, and what pi-daddy deliberately did not do for them. */
async function report(plan: InitPlan): Promise<void> {
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
        `to the grant in ${SETTINGS_REL}.`,
    );
  }

  if (plan.withheldCapabilities.size > 0) {
    const needed = [...plan.withheldCapabilities].map(([c, who]) => `${c} (${who.join(", ")})`).join(", ");
    console.log(
      `\nWITHHELD BY DEFAULT: ${needed}.\n` +
        `These can change your machine, so they are listed under \`withheld\` in settings.json along with the\n` +
        `\`agent:\` ids of the definitions that need them. Uncomment deliberately — that is the decision.`,
    );
  }

  // ROUTING, which had no line here at all — and `report()` is the output of the command the docs tell an
  // operator to run. Keeping `workspace:` ids out of `withheldCapabilities` (so the `/grants init` dialog
  // could not grant them off a package declaration) removed the ONLY thing this path said about a definition
  // that cannot be spawned: `needs-withheld` is not one of the cases handled above, so a routing package
  // produced a copied definition, an unusable grant, and total silence.
  //
  // The fix that caused it argued that "a breaking change whose migration is only discoverable by opening a
  // file is not much of a migration" — and then applied that to the in-session notify and not to the CLI.
  if (plan.routableWorkspaces.length > 0) {
    const blocked = plan.skills.filter((s) => s.withheld === "needs-withheld").map((s) => s.name);
    console.log(
      `\nROUTABLE WORKSPACES: ${plan.routableWorkspaces.join(", ")}.\n` +
        `Routing a child to one needs its id in PI_DADDY_GRANT (ADR-0035); without it the delegation is\n` +
        `refused WORKSPACE_NOT_AUTHORIZED. They are listed under \`routableWorkspaces\` in settings.json and never granted for\n` +
        `you — which worktree a child starts in is not something a package can declare.` +
        (blocked.length > 0
          ? `\nUntil you grant one, these cannot be spawned: ${blocked.join(", ")} — add the capability, then\n` +
            `their \`agent:\` ids.`
          : ""),
    );
  }

  console.log(
    `\nLive grant (${plan.grant.length} capabilities): ${plan.grant.join(", ")}\n\n` +
      ((await settingsIgnoredByGit(plan.settingsPath)) === true
        ? `  NOTE: git ignores ${SETTINGS_REL} (root .gitignore covers ${PI_PROJECT_DIR}/); add ${GITIGNORE_REINCLUDE_LINES.join(" and ")} to commit it\n`
        : "") +
      `  $EDITOR ${SETTINGS_REL}   # review it, then commit it\n` +
      `  pi                                   # /grants lists every definition and its verdict`,
  );
}

export async function main(argv: string[]): Promise<number> {
  const adoptedLegacy = adoptLegacyEnvironment(process.env);
  if (adoptedLegacy.length > 0) console.error(legacyEnvironmentWarning(adoptedLegacy));
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
  if (parsed.command === "ledger-import") {
    const source = resolvePath(process.cwd(), parsed.ledgerPath!),
      target = resolvePath(process.cwd(), parsed.importTarget!);
    const result = await importLegacyLedger(source, target);
    if (result.skipped === "source-missing") {
      console.error(`pi-daddy: no such file: ${source}`);
      return 1;
    }
    if (result.skipped === "target-exists") {
      console.error(`pi-daddy: ${target} already exists; import writes only into a new file`);
      return 1;
    }
    console.log(
      `pi-daddy: imported ${result.imported} record(s) from ${source} into ${target}; the source is untouched` +
        (result.stoppedAt !== null ? `. Stopped at unparsable source line ${result.stoppedAt}.` : "."),
    );
    return result.stoppedAt === null ? 0 : 1;
  }
  if (parsed.command === "ledger-repair") {
    const path = resolvePath(process.cwd(), parsed.ledgerPath!);
    const preview = await repairLedger(path, { apply: false });
    if (preview.missing) {
      console.error(`pi-daddy: no such file: ${path}`);
      return 1;
    }
    if (preview.preFormat) {
      console.error(
        `pi-daddy: ${path} predates the record format; repairing it would delete it whole. ` +
          `Run \`pi-daddy ledger import ${path} <target>\` instead. Nothing was changed.`,
      );
      return 1;
    }
    if (preview.dropped.length === 0) {
      console.log(`pi-daddy: ${path} is intact (${preview.keptLines} records); nothing to repair`);
      return 0;
    }
    // Line numbers and sizes only: a torn line can contain exactly the task text this program never prints.
    console.log(
      `pi-daddy: ${path} is damaged after record ${preview.keptLines}; ${preview.dropped.length} line(s) would be dropped:\n` +
        preview.dropped
          .map((line, i) => `  line ${preview.keptLines + i + 1}: ${Buffer.byteLength(line, "utf8")} bytes`)
          .join("\n"),
    );
    if (preview.droppedParseable > 0)
      console.log(
        `pi-daddy: WARNING — ${preview.droppedParseable} of those lines still parse as records. This looks like damage in the ` +
          `middle of the file, not a torn tail; repairing drops every record after it. Inspect before you truncate.`,
      );
    if (!parsed.yes) {
      console.log(
        "pi-daddy: preview only. Re-run with --yes to truncate the damaged tail; intact records are never rewritten.",
      );
      return 1;
    }
    const result = await repairLedger(path, { apply: true });
    console.log(`pi-daddy: dropped ${result.dropped.length} line(s); ${result.keptLines} records remain`);
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
