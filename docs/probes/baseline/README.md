# Probe — `baseline` (retrospective session capture)

**What it measures.** B1 inputs (which tools exist and which are ever used), B3 (tokens per
session), B6 (cost per session), B9 (distinct tools used per session), the `C` term for A-02's
break-even inequality (per-request prompt size), and the observed prompt-cache behaviour — all from
**pi session records that already exist on disk**. No instrumentation, no agent-loop changes, no API
calls, no cost.

**Why it exists.** ADR-0004 makes measurement the near-term deliverable, and `05-metrics.md` §2a
orders the cheap kill tests first. This probe turned out to answer the cheapest one (Gate 0) outright.

**How to rerun.**

```bash
python3 docs/probes/baseline/session_stats.py                 # defaults to ~/.pi/agent/sessions
python3 docs/probes/baseline/session_stats.py /path/to/sessions
```

Requires only Python 3 (stdlib). Read-only: it never writes to the session directory.

**Environment when first run (2026-08-09).** pi **0.83.0** (`@earendil-works/pi-coding-agent`, npm
global), Node v24.14.0, `defaultProvider: openai-codex`, `defaultModel: gpt-5.6-sol`,
`defaultThinkingLevel: max`. Installed packages per `~/.pi/agent/settings.json`:
`git:github.com/mojomanyana/skill-harness`, `npm:pi-powerline-footer`,
`npm:@juicesharp/rpiv-ask-user-question`, `npm:pi-web-access`, `npm:@tintinweb/pi-subagents`, plus a
local extension `herdr-agent-state.ts` and a local `subagent` extension. 82 session files, 46 project
scopes, 4,002 message entries.

**Results:** see `docs/archive/gate-reports/baseline-2026-08-09.md`. Headline: catalog ≈ 20 tools, only 11
ever used, 98.1% of all 1,956 tool calls are four tools, p90 distinct-tools-per-session = 4, and the
prompt cache is read 114× more than it is written.

## Caveats — read before citing any number from this probe

1. **Single catalog, and it is the author's own** — this is exactly the overfit R-13 warns about. It
   says nothing about what an OSS pi user's catalog looks like (Q-WHO-1's primary user).
2. **It is retrospective**, so it reflects tools *used*, not tools *available*. A tool never called
   might still have been mounted and paid for on every request — which is the point, but it means B1
   (catalog size) is derived from package inspection, not from this script.
3. **Absence of `active_tools_change` entries proves nothing about A-11.** No extension in this setup
   calls `setActiveTools()`, so the entry would not be written either way. A-11 still needs its own
   active probe. Note also the version skew: installed pi is 0.83.0 while the source read for A-11 was
   `main` (~0.84.1).
4. **`skill_check_run` came from a project-local extension**, not from the globally installed
   packages — so per-project extensions add to the catalog in ways a global inventory misses.
5. Single-turn sessions (p50 user turns = 1) make the churn fraction `c` ill-defined for a large part
   of the corpus; treat the `c`-dependent arithmetic as an upper bound on the case for mounting.
