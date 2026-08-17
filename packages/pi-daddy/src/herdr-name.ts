/**
 * Naming a herdr agent: the grammar herdr enforces, and uniqueness it does not.
 *
 * Split out of `src/run-herdr.ts` at the 400-line ceiling, and a real seam: both rules below come from **herdr's
 * own validation and lifecycle**, not from anything this package decides. Two shipping defects lived here, and
 * both were invisible to every test because the unit fake accepts whatever name it is handed and the integration
 * suite never reaches a real herdr spawn. They surfaced from two real spawns against the live daemon.
 */

/** Monotonic within this process. See `uniqueAgentName`. */
let spawnSeq = 0;

/**
 * herdr's agent-name grammar, measured from its own rejection message.
 *
 * `agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_'
 * (1-32 characters)`.
 */
const AGENT_NAME_MAX = 32;

/**
 * Make a herdr agent name that is **valid** and cannot collide with a live one.
 *
 * **Validity is a separate, PRE-EXISTING defect, and it is the more serious half.** Callers build a name as
 * `${definition}-${childId}`, and a ledger child id is hierarchical — `d0.1`, `d0.1.2` (ADR-0008/F8). Those dots
 * are **not in herdr's grammar**, so `agent start review-d0.1 …` is rejected with `invalid_agent_name`. Every
 * `delegate({agent})` on the herdr path has therefore failed at `agent start` since the executor was written.
 *
 * Nothing could see it. The unit fake accepts any name it is handed, and the integration suite never reaches a
 * real herdr spawn — so both were green while the feature could not work. It surfaced only by running two real
 * spawns against the live daemon, which is the argument for doing that at all.
 *
 * **Measured, and a shipping defect without it.** herdr binds an agent name to its **tab**, and only closing
 * the tab frees the name: a second `agent start` with a name still held returns
 * `agent_name_taken: agent <name> is already used; … tab_id=…`. `herdr agent stop` does not exist (see
 * `cleanup`), so nothing else releases it.
 *
 * Callers build a name from the definition and the ledger child id — and for a plain blocking `delegate` that
 * id is **constant** (`d0.1`, index 0 of the session), so every delegation in a session asked for the same
 * name. That was harmless while the pane closed at the end of each call. Once ADR-0032 kept panes alive to
 * `agent_settled`, the **first** delegation of a turn worked and every later one failed with
 * `agent_name_taken`, on the executor ADR-0031 had just made the default.
 *
 * Uniquified HERE rather than at the call site, so no caller can forget: the constraint belongs to herdr, and
 * this module is the only thing that talks to herdr. The suffix is a counter rather than a random token so a
 * pane label stays readable and reproducible within a run.
 */
export function uniqueAgentName(base: string): string {
  spawnSeq += 1;
  const suffix = `-${spawnSeq}`;
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-") // dots from a child id, and anything else outside the grammar
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z]+/, ""); // must START with a lowercase letter, so a leading digit or dash goes
  // Truncated so the whole name fits, and trimmed of a trailing separator so the join stays readable. The
  // fallback covers a base that sanitises to nothing at all (a definition named entirely in non-Latin script).
  const room = AGENT_NAME_MAX - suffix.length;
  const head = cleaned.slice(0, room).replace(/[-_]+$/, "") || "agent";
  return `${head}${suffix}`;
}
