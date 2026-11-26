# Harvest decision benchmark

Should Daddy save this turn as a regression? This experiment compares the production fast-tier chat classifier with GitHub Copilot's `gpt-6-luna-decisions` through Pi's typed classifier API. It runs from the checkout and uses synthetic turns. The production configuration is read only.

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
