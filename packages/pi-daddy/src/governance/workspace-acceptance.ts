/**
 * Which workspace ids the operator has accepted — the id SET, which the destination pin does not cover.
 *
 * **The escalation this closes, measured 2026-09-22.** ADR-0042 bound what an id MEANS; it says nothing about
 * which ids exist. The registry is an ordinary file and a governed child holding `tool:write` inherits its
 * path, so a child can append an entry of its own. The pin stops that id resolving in the session that added
 * it — there is no pin entry for it — and stops nothing afterwards: the NEXT root session mints a pin from the
 * tampered registry, the catalog lists the new id, and `workspace:*` admits any id at all. Measured end to end:
 * `catalog ['workspace:evil','workspace:good']`, `pinned ['good','evil']`, routed into the child's own
 * directory, with no operator action anywhere.
 *
 * So the id set needs the same treatment the grant got: **recorded outside the workspace, where a governed
 * child cannot reach it.** This lives beside the grant store and the approvals, in pi's agent directory, for
 * the reason `grant-store.ts` gives about itself — a ceiling a governed child can rewrite is not a ceiling.
 *
 * **Trust on first use, said out loud.** A machine that has never accepted anything accepts what the registry
 * holds the first time and writes it down. The alternative — refuse everything until the operator accepts —
 * would break every existing setup on upgrade to enforce a decision the operator has effectively already made
 * by writing the file. What matters is that ADDITIONS afterwards are visible, and they are. The first
 * acceptance is announced rather than silent, because a security control that installs itself quietly is one
 * nobody knows they have.
 *
 * Keyed by registry path, not by project: accepting an id is a statement about the operator's registry.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acceptedWorkspacesPath } from "../kernel/project-paths.ts";

export interface AcceptedWorkspaces {
  /** Ids the operator has accepted for this registry. */
  accepted: string[];
  /** True when this call created the record — trust on first use, which the caller must report. */
  firstUse: boolean;
  /** Registry ids that are NOT accepted, so they can be named and refused. */
  unaccepted: string[];
}

interface StoredAcceptance {
  version: 1;
  registry: string;
  accepted: string[];
}

function parse(text: string): StoredAcceptance | null {
  let parsed: Partial<StoredAcceptance>;
  try {
    parsed = JSON.parse(text) as Partial<StoredAcceptance>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.version !== 1 || typeof parsed.registry !== "string") return null;
  if (!Array.isArray(parsed.accepted) || !parsed.accepted.every((id) => typeof id === "string" && id.length > 0))
    return null;
  return { version: 1, registry: parsed.registry, accepted: parsed.accepted };
}

/**
 * Compare a registry's ids against what has been accepted, creating the record on first use.
 *
 * **A malformed record accepts nothing** rather than falling back to the registry. It is the same direction
 * `grant-store.ts` takes for a malformed grant, and for the same reason: the file is the record of a decision,
 * so an unreadable one means the decision is unknown, not that anything goes.
 */
export async function reconcileAcceptedWorkspaces(
  registryPath: string,
  registryIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcceptedWorkspaces> {
  const path = acceptedWorkspacesPath(registryPath, env);
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) {
    const accepted = [...registryIds].sort();
    await write(path, { version: 1, registry: registryPath, accepted });
    return { accepted, firstUse: true, unaccepted: [] };
  }
  const stored = parse(text);
  // Malformed: accept nothing, and the caller says so. Not "accept everything", which would make corrupting
  // one byte of this file the way to bypass it.
  const accepted = stored ? stored.accepted : [];
  const allowed = new Set(accepted);
  return {
    accepted,
    firstUse: false,
    unaccepted: [...registryIds].filter((id) => !allowed.has(id)).sort(),
  };
}

/** Accept the registry's current ids, replacing what was accepted before. `/grants` drives this. */
export async function acceptWorkspaces(
  registryPath: string,
  registryIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const accepted = [...new Set(registryIds)].sort();
  await write(acceptedWorkspacesPath(registryPath, env), { version: 1, registry: registryPath, accepted });
  return accepted;
}

/** Atomic, for the reason every other store here is: a half-written record reads as a narrower decision. */
async function write(path: string, body: StoredAcceptance): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}
