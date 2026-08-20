/**
 * Taking back authority a gate banked for an operation that was then refused.
 *
 * Split out of `./approvals.ts` only to stay under the 400-line module ceiling this project enforces
 * mechanically; `./approvals.ts` re-exports both names.
 */
import { revokeApproval } from "../src/approval-store.ts";
import type { Capability } from "../src/resolve.ts";
import { snapshotOf } from "./approvals.ts";
import type { GrantsSession } from "./session.ts";

/** One piece of authority a gate banked, and where it lives, so it can be undone. */
export interface BankedApproval {
  key: string;
  capability: Capability;
  subject: string;
  /** True when a 30-day entry reached the on-disk store, which outlives the process. */
  persisted: boolean;
  /**
   * False when this call did not CREATE the authority — it joined a dialog another delegation had already
   * opened, or the key was already standing from an earlier grant.
   *
   * Load-bearing: unbanking revoked by `capability@subject` with no ownership check, so one refused
   * delegation could destroy an approval a live sibling was running under. Two reachable shapes — a
   * joined gate (one human answer shared by concurrent waiters, each recording it as its own) and a
   * legacy-then-bound sequence, where a bound call re-prompts over a plain key that already exists and
   * then deletes both on refusal. Only what this call actually created may be taken back.
   */
  owned: boolean;
}

/**
 * Give back authority a gate banked for an operation that was then refused.
 *
 * Best-effort by necessity — the persisted store can be busy — but never silent: an approval that could
 * not be revoked is exactly the one an operator needs to know is still standing (R-113).
 */
export async function unbankApprovals(
  session: GrantsSession,
  ctx: { ui: { notify: (message: string) => void } },
  banked: BankedApproval[] | undefined,
): Promise<void> {
  if (!banked || banked.length === 0) return;
  const stranded: string[] = [];
  for (const entry of banked) {
    // Never take back authority this call did not create — see `owned`.
    if (!entry.owned) continue;
    session.sessionApprovals.delete(entry.key);
    session.sessionApprovalBindings.delete(entry.key);
    if (!entry.persisted) continue;
    const outcome = await revokeApproval(session.cwd, entry.key, (subject) => snapshotOf(session, subject), new Date());
    // `"absent"` is NOT proof the entry is gone. `revokeApproval` reports it when the key is missing from
    // the *valid* set, and `loadApprovals` excludes entries whose ceiling or body digest no longer
    // matches — those are still physically in the file and revive the moment they validate again. So an
    // entry that is merely stale reads as "nothing to revoke" and is silently left standing.
    if (outcome !== "revoked") stranded.push(entry.key);
  }
  // Children inherit from the published set, so it must shrink with the session state, not after it.
  session.publishChildEnv();
  if (stranded.length > 0) {
    ctx.ui.notify(
      `grants: this delegation was refused, but a stored approval for ${stranded.join(", ")} could not be ` +
      `revoked and still stands — remove it with \`/grants revoke\` if it was not intended.`,
    );
  }
}
