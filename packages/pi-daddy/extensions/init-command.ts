/**
 * `/grants init` — the one command in this package that writes.
 *
 * Split out of `extensions/grants.ts` when the file-size guard refused it, and the seam is the right one:
 * `grants.ts` is wiring, and this is a decision procedure that asks a human questions and stores the
 * answer. Keeping it here means the file that registers hooks stays readable, which is the property the
 * guard exists to defend — every wiring bug this package has had lived in that file.
 */

import { discoverSkillPackages } from "../src/skill-packages.ts";
import { applyInit, planInit } from "../src/init.ts";
import { registeredWorkspaceIds } from "../src/workspace.ts";
import { saveGrant, grantStorePath } from "../src/grant-store.ts";
import { expandSubsumed, SUBSUMPTION, type Capability } from "../src/resolve.ts";
import type { GrantsSession } from "./session.ts";

/**
 * `/grants init` — scaffold, ask about what is withheld, store it outside the workspace, apply it now.
 *
 * **The dialog covers the withheld capabilities and nothing else** (ADR-0030). Asking about all of them
 * would be a dozen questions for a first run, and this project has a name for what that produces: R-25,
 * where the operator learns to click through and the control becomes decorative. The read-only capabilities
 * a skill declares are already bounded by the ceiling its author wrote and by pi's `--tools`; the ones that
 * can change the machine are the decision, so they are the question.
 *
 * A refusal is not a failure. Answering *no* to `tool:bash` leaves four definitions unspawnable and says so
 * — that is the same outcome `pi-daddy init` writes by default, reached deliberately rather than by
 * omission.
 */
export async function runInit(
  session: GrantsSession,
  ctx: any,
  /**
   * Reload definitions and the catalog, and re-describe the delegation tools.
   *
   * **Without this the grant goes live and the definitions do not** — `session.definitions` and the catalog
   * are read at `session_start`, which is before `init` wrote a single file, so a session would hold
   * `agent:review` while believing no definition of that name exists. `/grants` showed `0 skill,
   * 0 agent-type` and no verdicts, and the model would have been told `Available: none` — R-39 exactly,
   * reintroduced by a feature whose whole selling point is "no restart". Found by running it.
   */
  refresh: () => Promise<void>,
): Promise<void> {
  const packages = await discoverSkillPackages(ctx.cwd);
  if (packages.length === 0) {
    ctx.ui.notify(
      "grants: no packages declaring skills found in node_modules. Install one — e.g. " +
        "`npm i principal-pi-skills` — then run /grants init again.",
      "warning",
    );
    return;
  }

  const plan = planInit(packages, ctx.cwd, await registeredWorkspaceIds());
  const outcome = await applyInit(plan);
  const lines = [
    `grants: ${plan.skills.length} definition(s) from ${packages.map((p) => `${p.name}@${p.version}`).join(", ")}`,
    `  wrote ${outcome.written.length}, kept ${outcome.kept.length} already present` +
      `${outcome.failed.length > 0 ? `, ${outcome.failed.length} FAILED` : ""}`,
  ];
  for (const f of outcome.failed) lines.push(`    ${f.path}: ${f.error}`);

  // The grant `init` would have written to `.pi/grants.env`: read-only, nothing that can change the
  // machine. Everything below is added to it only by an explicit yes.
  const grant = new Set<Capability>(plan.grant);
  const granted: string[] = [];
  const declined: string[] = [];
  /** Withheld capabilities a previous *yes* already conferred, so no question was asked about them. */
  const alreadyConferred: string[] = [];

  for (const [capability, neededBy] of plan.withheldCapabilities) {
    // **Do not ask a question whose answer cannot matter.** `tool:bash` subsumes `write`, `edit` and
    // `edit-diff` (`SUBSUMPTION`, `src/resolve.ts`), so once bash is granted those are already conferred.
    // The first version asked anyway: an operator could answer *no* to `tool:write`, watch `/grants` allow
    // `build` with `tool:write`, and reasonably conclude the dialog was decorative. It was — that is R-47's
    // shape, a control that appears to do something and does not, inside a control built to prevent it.
    //
    // Reported rather than silently skipped, because "you already granted this" is the useful sentence and
    // silence is what made it confusing.
    if (expandSubsumed([...grant]).includes(capability)) {
      alreadyConferred.push(`${capability} (via ${subsumedBy([...grant], capability) ?? "a granted capability"})`);
      for (const name of neededBy) grant.add(`agent:${name}` as Capability);
      continue;
    }
    // The consequence sentence is per capability, and it reads the gate **in effect for this session** —
    // `session.gated`, which is `PI_GRANTS_GATED` when the operator set it and `DEFAULT_GATED` otherwise.
    //
    // The first version read `DEFAULT_GATED` directly, which is the compile-time constant `["tool:bash"]`, and
    // `tool:bash` is consumed by the branch above — so the branch was **unreachable in every configuration**,
    // and with `PI_GRANTS_GATED="tool:bash,tool:write"` (the value `renderGrantEnv` itself suggests) the
    // dialog still printed the exact false sentence the fix claimed to remove. Dead code beside a claim that
    // it worked, which is this project's failure mode, in the commit correcting that failure mode.
    // No subsumption closure here, and the absence is deliberate. A `|| SUBSUMPTION[capability]…` disjunct was
    // added and is **dead in every configuration**: `SUBSUMPTION` has one key, `tool:bash`, and `tool:bash` is
    // consumed by the ternary below before `gatedAtSpawn` is ever read. Two reviewers and a mutation confirmed
    // it changed no result — dead code beside a claim that it worked, in the hunk whose comment denounces
    // exactly that. A second `SUBSUMPTION` entry is the moment to add it back.
    const gatedAtSpawn = session.gated.includes(capability);
    const answer = await ctx.ui.select(
      `grants: grant ${capability} to sub-agents?\n  needed by: ${neededBy.join(", ")}\n` +
        `  this can change your machine — ` +
        (capability === "tool:bash"
          ? "and bash also confers write and edit"
          : gatedAtSpawn
            ? "a human is still asked at spawn time"
            : "it is not gated, so no dialog at spawn time"),
      ["No", "Yes"],
    );
    if (answer === "Yes") {
      grant.add(capability);
      granted.push(capability);
      // The `agent:` ids too: a definition authorised but unable to receive what it declares would be
      // allowed to run and then refused, which is a worse answer than not being authorised (ADR-0029).
      for (const name of neededBy) grant.add(`agent:${name}` as Capability);
    } else {
      declined.push(`${capability} (${neededBy.join(", ")})`);
    }
  }

  const finalGrant = [...grant].sort();
  const saved = await saveGrant(ctx.cwd, finalGrant);
  if (saved !== "saved") {
    lines.push(
      `  NOT STORED — ${saved === "busy" ? "another session holds the grant store" : "the store could not be written"}. ` +
        `Nothing was changed; this session's grant is unchanged. Retry, or export PI_GRANTS_GRANT yourself.`,
    );
    ctx.ui.notify(lines.join("\n"), "error");
    return;
  }

  // Live, without a restart — the whole point of the store. Only after a successful write, so what runs and
  // what is recorded cannot disagree.
  session.adoptGrant(finalGrant);
  // Order matters: the grant first, then the reload, because `refreshSpawnable` filters the definitions it
  // advertises through `maySpawnDefinition` against the grant the session now holds.
  await refresh();

  lines.push(`  stored at ${grantStorePath(ctx.cwd)} — outside this project, so no child can rewrite it`);
  if (granted.length > 0) lines.push(`  GRANTED: ${granted.join(", ")}`);
  if (alreadyConferred.length > 0) {
    lines.push(`  ALREADY CONFERRED, not asked about: ${alreadyConferred.join(", ")}`);
  }
  if (declined.length > 0) lines.push(`  withheld: ${declined.join("; ")}`);
  // Routing is LISTED, never granted (ADR-0028) — so the operator has to be told it exists, or the listing is
  // invisible to anyone running `/grants init` in-session rather than reading the generated file. 0.19.0 made
  // `workspace:<id>` mandatory for routing, so this is also the migration hint, and a breaking change whose
  // migration is only discoverable by opening a file is not much of a migration.
  if (plan.routableWorkspaces.length > 0) {
    lines.push(
      `  ROUTABLE WORKSPACES, listed and NOT granted: ${plan.routableWorkspaces.join(", ")}`,
      `    routing a child to one needs its id in the grant (ADR-0035); add the ones this project may use to ` +
        `${plan.grantEnvPath}. Which worktree a child starts in is not something a package can declare for you.`,
    );
  }
  lines.push(`  live now (${finalGrant.length} capabilities) — no restart. /grants shows the verdicts.`);
  ctx.ui.notify(lines.join("\n"), "info");
}

/** Which held capability confers `capability`, for a message that names the cause rather than the effect. */
function subsumedBy(held: Capability[], capability: Capability): Capability | null {
  for (const h of held) if ((SUBSUMPTION[h] ?? []).includes(capability)) return h;
  return null;
}
