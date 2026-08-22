# Probe — does routing attenuate by DESTINATION? (R-137, ADR-0035)

- **Date:** 2026-08-22
- **Environment:** Linux (WSL2), Node v24, real `git`, real util-linux `flock`.

## Why this exists

ADR-0035 made routing a capability, so a descendant may only name workspace ids it holds — and
`docs/probes/g36-workspace-attenuation` measured that working. It left the id → path mapping in a mutable
file, and its Context calls that file "operator-owned" as a **fact**, with nothing checking it.

R-137 was written from a code read plus a reviewer's report, and asserted "measured end to end". **It was not
measured by anything in this repository**, which working rule 5 says is the same as not measured — the entry
claimed evidence that did not exist. This probe is that evidence, and it exists so the registry-integrity ADR
has a baseline to measure a fix against.

## What it measures

Real Git worktrees, a real kernel `flock`, and the real production path — `planDelegation` →
`mergeChildEnv` → `loadWorkspaceRegistry` → `resolveWorkspace` → `acquireWorkspaceLease`:

1. a root grants a child `workspace:staging` plus `tool:write` — **not `bash`**, so this is inside
   ADR-0012's scope rather than its accepted escape — and the child holds nothing naming `prod`;
2. **the control:** whether that child can route its grandchild to `prod` by NAME;
3. whether the child, holding a write tool, can repoint the `staging` entry at the `prod` worktree;
4. whether `staging` then resolves to `prod`, and what marker file the grandchild's CWD contains;
5. whether the grandchild takes a real **exclusive write lease** on it.

Item 2 is what makes this a probe rather than a demonstration. Without it, "the child reached prod" would be
consistent with the capability check simply not working. With it, the check demonstrably works and what moved
is the thing the capability names.

```bash
node docs/probes/g37-registry-tamper/probe.mjs
```

## Result

Captured in [`transcript-2026-08-22.json`](transcript-2026-08-22.json):

| finding | value |
|---|---|
| `child_grant` | `tool:delegate,tool:read,tool:write,workspace:staging` |
| `child_holds_prod` | `false` |
| `control_route_to_prod_by_name` | **`WORKSPACE_NOT_AUTHORIZED`** |
| `route_to_staging_after_tamper` | **`NO REFUSAL`** |
| `staging_now_resolves_to` | **the prod worktree** |
| `grandchild_cwd_marker` | **`prod`** |
| `grandchild_write_lease` | **`write`** |

**CONFIRMED.** Routing attenuates by **id**, not by **destination**. A capability naming something the holder
can redefine constrains the name and not the thing.

## What this does not establish

- **That a model would do it.** No model runs. `workspace_id` is a model-facing parameter and `tool:write` is
  an ordinary grant, so the mechanism is reachable; whether an agent chooses it is not measured.
- **That the registry is the only such mapping.** This is one instance of a general shape — an authority whose
  meaning lives outside the grant. A future `check:<id>` or `context:<id>` would be the next.
- **Anything about a fix.** No integrity mechanism exists to exercise. A content pin was attempted and
  reverted (see R-137 for the four ways it was defeated), so this measures the gap only. When a fix lands,
  this probe should gain a refusal case and the control should stay green — a probe that only ever measures
  the defect stops being evidence once the defect is gone.
- **That it crosses a real process boundary.** Levels are modelled by passing the computed child environment
  forward in one process, which is what `mergeChildEnv` produces; no second `pi` re-reads it. Same limitation
  as g36, and worth restating rather than inheriting silently.
- **Anything about `bash`.** A child holding `bash` can write to any worktree regardless of routing —
  accepted, and measured separately in `docs/probes/g5-bash-escape`.
- **That file permissions would stop it.** They cannot: a governed child runs as the same uid as its parent.
  Ownership and mode guards were tried in this branch and removed for that reason among others.
- **Portability.** One Linux box, one `flock`, one Git version.
