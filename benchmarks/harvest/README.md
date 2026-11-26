# Harvest decision benchmark

Should Daddy save this turn as a regression? This experiment compares the production fast-tier chat classifier with GitHub Copilot's `gpt-6-luna-decisions` through Pi's typed classifier API. It runs from the checkout and uses synthetic turns. The production configuration is read only.

## Verify the local ecosystem

If `/bookie-capture sync` reports `Producer reference unavailable`, use `/ecosystem-status capture` in that Pi session. The pilot checks the first page of Daddy's stored results and requests the latest reference for the current branch, if present. The status shows the producer reply or timeout. Bookie registration is a separate step.

Keep the matching Scout feature checkout beside this repository as `pi-harvest-scout`. Use the two local candidates together until both changes ship. With the Pi ecosystem installed, run the following in WSL from this checkout:

```sh
bash benchmarks/harvest/check-ecosystem.sh --live
```

The offline checks build the panel, exercise settings and recovery, then start a fresh Pi and reopen a saved fixture session with the five packages. The live option tests the selected decision classifier once with synthetic data and opens the pilot with one combined request to exercise research, review, memory lookup and Harness discovery. A partial Scout brief is reported as partial. The live request uses your configured providers. For the full Daddy and Scout suites and Daddy's SDK integration checks, add `--full`. Omit `--live` for offline checks only.

## Try the full Pi session

To try the classifier settings in the full Pi ecosystem, run this from the checkout:

```sh
bash benchmarks/harvest/try-settings.sh
```

The launcher opens Pi in this project, loads the local Daddy with the normal package profile, and supplies missing ecosystem packages in project settings. It defaults Daddy Auto on for this session and its descendants and exposes group and chain delegation. Set `PI_DADDY_AUTO_MODE=0` before launching to use manual approvals. Your existing environment overrides take precedence. After startup, `/ecosystem-status` checks component registration and `/grants` shows which specialists can run. For a Bookie task, use a project directory outside the Pi agent directory and its ancestors. Use `/bookie-task status` to check project enrollment.

If Bookie reports “Task operation unavailable”, run `/ecosystem-status bookie` in the same Pi terminal. It checks project trust, Daddy’s project-memory permission, directory identity and permissions, Node capabilities, and the installed Bookie package’s enrollment result. It reads metadata without opening a task or changing the vault. An `absent` result means Bookie found no enrollment for that folder.

Some WSL mounts return zero for the checkout’s creation time. In that case the launcher creates a separate pilot workspace under `~/.local/share/pi-daddy/harvest-pilot/`, checks its directory identity, and starts Pi there. Later launches from the same checkout reuse that workspace and its Bookie project. The classifier still loads directly from the original checkout. Use its printed source path for code reviews. Bookie task selection is scoped to the new workspace.

## Compare OpenRouter decision models

Use Node 24 and the exact IDs from OpenRouter's decision catalog. This runner calls the Decisions API directly. It accepts any listed model that answers a yes/no question. It needs only an OpenRouter key for the live pass. The list is public. The check verifies each catalog entry and the presence of the key. The first inference verifies account access.

```sh
node benchmarks/harvest/openrouter.mjs --list
node benchmarks/harvest/openrouter.mjs --check typesafe/jev-1.14 openai/gpt-6-luna-decisions jaredpalmer/kev-4b
node benchmarks/harvest/openrouter.mjs --live typesafe/jev-1.14 openai/gpt-6-luna-decisions jaredpalmer/kev-4b
```

Export `OPENROUTER_API_KEY` in your shell before checking or running. Kev 4B is a LoRA-based model. You can substitute another catalog entry such as `cloudflare/clef-flash` or add it as a fourth model. The runner rotates model order on successive eligible turns. It uses the same corpus, eligibility gate, turn digest, Boolean question and threshold as the Pi experiment. It records the selected and returned model IDs, per-case probabilities, latency, supplied cost, and a partial report on a request failure. A full run sends 55 requests per model.

## Fixed-threshold holdout

Run `bash benchmarks/harvest/run-holdout.sh` for the fresh 60-turn synthetic corpus. Jev uses 0.53, Luna uses 0.65 and Kev uses 0.50. The 30 new tasks each have two labeled outcomes in shuffled order. Both outcomes of a task have the same gate signal. Two tasks have no gate signal, leaving 56 eligible turns and 168 paid calls. Two positive cases are unreachable at any threshold. Labels and case IDs stay local. The wrapper writes a new report in the parent of the checkout, which is shared with WSL in this workspace.

## Run

Use Node 24 and Pi 1.6.1 or later in the profile you want to measure. Run from the project whose session model you intend to use. A full pass makes 55 requests to each provider and can consume usage on both accounts.

```sh
node benchmarks/harvest/run.mjs --check
node benchmarks/harvest/run.mjs --live
```

The first command resolves both models without sending turns. Check the reported baseline model, especially when your fast tier falls back to the session. The runner loads Pi's built-in providers and your profile's model catalog with package extensions disabled. Use Pi's `/login` for GitHub Copilot if the profile has no Copilot session. The profile also needs an available chat model that can turn thinking off. The live command writes a local JSON report at the path printed at startup. A provider failure stops further pairs and the report marks the observed run as partial.

## What is measured

The 60 frozen, hand-labeled cases contain 30 save and 30 skip decisions. Each of 30 tasks has two different outcomes, including actual agent mistakes, a corrected environment, ordinary edits, or a changed user preference. Daddy's existing signal filter sends 29 positives and 26 negatives to the classifiers. H48 is a visible defect without a first-stage signal. Both end-to-end scores count that miss.

Each eligible turn uses Daddy's production redaction and clipping code. Case IDs and expected labels are local to scoring. The baseline uses Daddy's production prompt, JSON parsing and confidence cutoff. Luna receives the same turn digest as structured state and a Boolean question. We preselect a save threshold of 0.75 for Luna's reported probability. Its probability and the chat model's self-reported confidence have different meanings. Call order alternates across pairs.

The report lists misses, false saves and disagreement IDs. Look up those IDs in `cases.jsonl` to inspect the actual turns. Invalid chat responses include replies that violate the requested JSON schema even when Daddy recovers a decision from them. Invalid Luna probabilities fail closed. Median and p95 latency use successful, schema-valid calls and report their sample size. Cost totals indicate how many calls supplied billed or estimated USD. Missing usage stays unknown. A zero catalog estimate does not measure Copilot subscription credits.

Retain the current classifier unless a complete run preserves detection and demonstrates a meaningful benefit in false saves, reliability, latency or observable cost. Inspect disagreements before changing the decision policy. This small balanced corpus tests the save decision only. It does not establish production prevalence or validate generation of scenario names and reasons.

## Offline control

```sh
node --test benchmarks/harvest/benchmark.test.mjs
```

The controls check identical model-facing digests, alternating order, scoring, invalid responses and missing cost data using deterministic adapters. Their outcomes are not provider measurements.
