# Probe — does workspace routing attenuate? (R-131, ADR-0035)

- **Date:** 2026-08-20
- **Environment:** Linux (WSL2), Node v24.14.0, real `git`, real util-linux `flock` 2.39.3.

## Why this exists

ADR-0035 proposes making workspace routing a capability so it attenuates. It was written **Proposed rather
than Accepted for one reason**: its escalation was derived from reading `run-delegation.ts`,
`workspace-runtime.ts` and `propagation.ts`, plus the absence of any authorisation check on that path — not
from a measurement.

R-26 is the same defect one namespace over: a root holding `tool:*` handed it to children until
"attenuation became meaningless below the root", and it was **found by a three-level transitivity test, not
in production**. A decision whose precedent was settled by a test should not be accepted on a code-read.
Rule 5, applied to this project's own reasoning.

## What it measures

Against real Git worktrees, a real kernel `flock`, and the **real production propagation path** —
`planDelegation` → `mergeChildEnv` → `loadWorkspaceRegistry` → `resolveWorkspace` →
`acquireWorkspaceLease`:

1. whether `PI_GRANTS_WORKSPACE_REGISTRY` is in `GRANT_ENV_KEYS` (the membership test that decides
   inheritance, quoted in `propagation.ts`'s own comment);
2. whether the registry therefore survives `mergeChildEnv` into a child's environment;
3. whether that child can **enumerate** workspace ids it was never granted;
4. whether planning a grandchild routed to `prod` — from a child routed to `staging`, using only inherited
   state — produces any refusal;
5. whether `prod` **resolves** and a **write lease** is granted to that grandchild;
6. whether the grandchild's initial CWD is genuinely `prod`, read back through a marker file committed in
   each worktree;
7. **the control:** whether the grant and depth attenuate through the *same* child environment.

Item 7 is why this is a probe rather than a demonstration. Without it, "the registry inherits" is a fact
about one variable. With it, the result is an **asymmetry**: two dimensions narrow and one does not, through
one code path, in one run.

No model runs, and no `pi` process is spawned. The escalation is a property of propagation and
authorisation, both of which are library code that can be driven directly — which also makes this probe free
to re-run in CI.

Run from the repository root:

```bash
node docs/probes/g36-workspace-attenuation/probe.mjs
```

## Result

Captured in [`transcript-2026-08-20.json`](transcript-2026-08-20.json):

| finding | value |
|---|---|
| `registry_in_grant_env_keys` | `false` |
| `registry_inherited_by_child` | **`true`** |
| `child_can_enumerate_workspaces` | `["prod", "staging"]` |
| `grandchild_refusal_code` | **`null`** |
| `grandchild_resolved_prod_root` | `true` |
| `grandchild_write_lease_on_prod` | **`"write"`** |
| `grandchild_cwd_marker` | **`"prod"`** |
| `control_grant_attenuated` | `true` |
| `control_depth_attenuated` | `true` |

**CONFIRMED.** A child routed to `staging`, holding nothing that names `prod`, planned a grandchild for
`prod` with no refusal, resolved it, took an exclusive **write** lease on it, and would start there — while
the grant narrowed from `read,write,delegate` to `read` and depth advanced 0 → 1 through the same child
environment.

This satisfies ADR-0035's stated blocking input.

## What this does not establish

- **That a model would do it.** No model runs here. The probe shows the mechanism permits the escalation,
  not that an agent chooses it. `workspace_id` being a model-facing tool parameter is what makes the
  question live, and that is a reading of the schema, not a measurement of behaviour.
- **That ADR-0035's fix works.** This measures the defect only. Nothing here exercises a `workspace:<id>`
  capability, because none exists yet — when it does, this probe should gain a fourth-level case showing the
  refusal, and the control should show the *same* asymmetry disappearing.
- **Anything about a real `pi` child.** No process is spawned. Step 6 reads the marker through the resolved
  root rather than from inside a live governed child, so it establishes "this is the directory the child
  would be given", not "a child was observed running there". The CWD wiring itself is covered by
  `docs/probes/g34-runtime-enforcement`.
- **That the escalation crosses a real process boundary.** Levels are modelled by passing the computed child
  environment forward in one process, which is exactly what `mergeChildEnv` produces — but a second `pi`
  process re-reading that environment is not observed here.
- **Anything about `bash`.** A child holding `bash` can write to any worktree regardless of routing, and
  that is measured separately and accepted (ADR-0012, `docs/probes/g5-bash-escape`). This probe is about the
  *record* asserting an authorisation, not about containment.
- **Any severity claim.** Whether "the ledger names a workspace the child never entered" outranks the
  accepted `bash` escape is an argument made in ADR-0035, not a result produced here.
- **Portability.** One Linux box, one `flock`, one Git version. The propagation half is pure JavaScript and
  should be platform-independent; the lease half is not, per ADR-0034's stated platform requirement.
