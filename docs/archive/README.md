# Archive — superseded material, kept as evidence

**Nothing in this directory is current.** Where anything here disagrees with `docs/SPEC.md`, an ADR in
`docs/06-decisions/`, or the code, **it is wrong** and the other source is right.

It is kept rather than deleted for one reason: **this project has reversed itself five times, and every
reversal was catchable because the prior reasoning was written down.** ADR-0004 was superseded, ADR-0005
parked then superseded, ADR-0006's magnitude claim falsified by measurement, ADR-0011 amended after live
verification, ADR-0013 superseded by ADR-0016. Most recently ADR-0015 exists *only* because a defect (R-28)
invalidated the evidence ADR-0013 had relied on — a catch that is impossible if the evidence was thrown
away. Deleting a superseded document is cheap right up to the moment somebody asks "why did we rule that
out?", and then it is unrecoverable.

**Do not edit these files to match today.** A register entry describes what was believed **on its date**;
updating it makes the record lie about what was known when. That includes the retired name "DTCM" and every
claim later falsified — those mentions *are* the evidence.

## What is in here, and why it stopped being current

| Path | What it was | Why it is archived |
| :--- | :--- | :--- |
| `01-discovery.md` | The question bank that drove discovery | Its BASELINE questions serve the token-economics thesis **ADR-0007 retired**. Q-WHY-1 and Q-WHAT-1 carry the RE-ANSWERED blocks from the reframe. |
| `02-assumptions.md` | Assumptions register A-01…A-16 | Mostly cost/cache assumptions for the same retired thesis. A-14 (are deferred tool definitions billed?) was deferred **by decision**, not neglect. |
| `04-landscape.md` | Build-vs-leverage survey | Two matrices, the first of which surveys the wrong shelf — it compares context-management tools, not capability-governance ones. |
| `05-metrics.md` | Measurement plan | M1/M2 were cost metrics; **ADR-0007 retired them**. |
| `ROADMAP.md` | Phase plan D0→G0→D1→G1→D2 | Obsolete. Two packages shipped under recorded gate waivers and the gate skills were removed. |
| `gate-reports/` | The G0 verdict and baseline report | The phase-gate programme is retired. G0's verdict — that the cost thesis **failed** — is the reason ADR-0007 exists, so this is the most historically load-bearing file here. |
| `reviews/` | Two independent whole-codebase reviews + aggregate | All twelve finding groups closed. Still the best single explanation of *why* several defences exist. |
| `specs/` | The capability-governance and approval designs | Both self-declared superseded by later ADRs, which is why they were archived rather than updated. |
| `plans/` | A 1,950-line implementation plan | Completed. The code and its tests are the truth now. |
| `GETTING-STARTED.md` | The original workspace tour | Opened by telling the reader to start somewhere else, and described a project with "zero implementation code, by design". `docs/SPEC.md` plus the root `README.md` replace it. |
| `proposals/` | An upstream `tools` parameter for pi-subagents | **Dead** by ADR-0016: this package no longer depends on pi-subagents, so the parameter it asked for would change nothing here. Never filed. |

## Where current information lives

- **`docs/SPEC.md`** — what the product does, how, and what it deliberately does not. Start here.
- **`docs/06-decisions/`** — the decisions, including the superseded ones (marked in their Status lines).
- **`docs/03-risks.md`** — live risk register. R-25 onward are current; earlier entries belong to the
  retired thesis and are marked.
- **`docs/probes/`** — measurement evidence, all run against real software, each with a "what this does not
  establish" section.
- **`docs/SESSION-LOG.md`** — state and next actions, newest first.
