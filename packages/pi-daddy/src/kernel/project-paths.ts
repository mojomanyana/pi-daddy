/**
 * Every filesystem location this package owns, in one place (ADR-0076 PR 3c).
 *
 * Project state lives under `<cwd>/.pi/pi-daddy/`; user state under `<agent dir>/pi-daddy/`. Before this
 * module there were eight project locations under `.pi/` and three user directories under the agent dir,
 * each spelled at its call site. `test/project-paths.test.ts` forces the rule: no shipped module outside
 * this one may spell `.pi`.
 *
 * `settings.json` is the one committable file in the project directory: `pi-daddy init` writes it as the
 * reviewable record of what a project's ceiling is and why. Everything else there is private runtime state,
 * and init writes a `.gitignore` beside it that says so.
 *
 * The user-level stores moved here without migration (operator decision, 2026-09-21, following ADR-0020):
 * a session that finds the old location and not the new one reports the old path and asks for `/grants init`
 * or a fresh approval, rather than copying authority from one place to another.
 */
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";

/** pi's own per-project directory. Ours is a subdirectory of it. */
export const PI_PROJECT_DIR = ".pi";
export const PROJECT_STATE_DIRNAME = "pi-daddy";

export function piProjectDir(cwd: string): string {
  return join(resolve(cwd), PI_PROJECT_DIR);
}

/** `<cwd>/.pi/pi-daddy` — every project-scoped file this package writes. */
export function projectStateDir(cwd: string): string {
  return join(piProjectDir(cwd), PROJECT_STATE_DIRNAME);
}

export const PROJECT_FILES = Object.freeze({
  settings: "settings.json",
  gitignore: ".gitignore",
  ledger: "grants.jsonl",
  activityTimeline: "activity.jsonl",
});

export const projectSettingsPath = (cwd: string) => join(projectStateDir(cwd), PROJECT_FILES.settings);
export const projectGitignorePath = (cwd: string) => join(projectStateDir(cwd), PROJECT_FILES.gitignore);
export const projectLedgerPath = (cwd: string) => join(projectStateDir(cwd), PROJECT_FILES.ledger);
export const activityTimelinePath = (cwd: string) => join(projectStateDir(cwd), PROJECT_FILES.activityTimeline);

/** The `.gitignore` init writes inside the project state directory: settings is committable, nothing else is. */
export const PROJECT_GITIGNORE_CONTENT = `# Written by pi-daddy init. Only settings.json is meant to be committed; the rest is private runtime state.
*
!.gitignore
!settings.json
`;

/** Is this path inside pi's per-project directory of any project? The private controller journals refuse such paths. */
export function isUnderPiProjectDir(path: string): boolean {
  return path.split(/[\\/]/).includes(PI_PROJECT_DIR);
}

/** `$PI_CODING_AGENT_DIR`, or pi's default `~/.pi/agent`. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PI_CODING_AGENT_DIR?.trim();
  return explicit ? explicit : join(homedir(), PI_PROJECT_DIR, "agent");
}

/** `<agent dir>/pi-daddy` — every user-scoped file this package writes. */
export function userStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), PROJECT_STATE_DIRNAME);
}

export const USER_DIRS = Object.freeze({
  grants: "grants",
  approvals: "approvals",
  workspaceLeases: "workspace-leases",
  /** ADR-0042 follow-up: which registry ids this operator has accepted. Keyed by REGISTRY, not by project. */
  workspaces: "workspaces",
});

/**
 * `<slug>-<16 hex>.json`: the basename keeps the directory legible, the hash makes it unambiguous, since two
 * checkouts can share a basename. 64 bits, not the 24 this once shipped with (R-41).
 */
export function projectFileName(cwd: string): string {
  const slug = (basename(cwd) || "root").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  const hash = createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, 16);
  return `${slug}-${hash}.json`;
}

export const grantStorePath = (cwd: string, env?: NodeJS.ProcessEnv) =>
  join(userStateDir(env), USER_DIRS.grants, projectFileName(cwd));
export const approvalsPath = (cwd: string, env?: NodeJS.ProcessEnv) =>
  join(userStateDir(env), USER_DIRS.approvals, projectFileName(cwd));
/**
 * Where the accepted id set for one registry lives.
 *
 * Keyed by the registry path rather than by `cwd`, because accepting an id is a statement about the
 * OPERATOR'S registry and not about a project: two checkouts sharing a registry share the decision, and
 * re-accepting per project would be a prompt with no new information in it.
 */
export const acceptedWorkspacesPath = (registryPath: string, env?: NodeJS.ProcessEnv) =>
  join(userStateDir(env), USER_DIRS.workspaces, projectFileName(registryPath));

export const workspaceLeasesDir = (env?: NodeJS.ProcessEnv) => join(userStateDir(env), USER_DIRS.workspaceLeases);

/** Where the same stores lived before ADR-0076 PR 3c. Reported when found, never read (ADR-0020 precedent). */
export const legacyUserGrantStorePath = (cwd: string, env?: NodeJS.ProcessEnv) =>
  join(agentDir(env), "grants", projectFileName(cwd));
export const legacyUserApprovalsPath = (cwd: string, env?: NodeJS.ProcessEnv) =>
  join(agentDir(env), "grants-approvals", projectFileName(cwd));
export const legacyProjectLedgerPath = (cwd: string) => join(piProjectDir(cwd), "grants.jsonl");
export const legacyGrantEnvPath = (cwd: string) => join(piProjectDir(cwd), "grants.env");
