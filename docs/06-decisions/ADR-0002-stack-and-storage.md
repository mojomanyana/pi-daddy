# ADR-0002: Stack & Registry Storage — language and persistence

**Date:** 2026-08-08
**Status:** Proposed (OPEN — decide before G0)
**Driver:** Q-BASE-2, Q-WHERE-2, Q-HOW-3, assumptions A-07/A-08, risks R-08/R-09

## Context

Two decisions the blueprint makes by fiat that deserve evidence first:

1. **Language/framework:** directive 4 proposes Python + LangGraph/LlamaIndex + FastAPI. But the
   system is framed as a fork of an existing agent (Q-BASE-1); if that baseline is written in a
   different language, a Python orchestrator means two stacks for a small team (R-09). Default
   posture: the baseline's language wins unless A-08's capability scan names a real gap.
2. **Storage:** §3.1 mandates containerized Qdrant/Chroma + Redis. At MVP scale, embedded
   alternatives (sqlite-vec, LanceDB, in-process embeddings over tool definition files) may
   deliver the same recall with zero always-on infrastructure (Q-HOW-3, A-07). Containers also
   create a second copy of truth to keep in sync with tool definitions (R-07).

Blocked on: ~~Q-BASE-2 answer~~ (ANSWERED: TypeScript/Node ≥22.19), A-07 embedded-store spike, A-08
capability scan.

**Input (2026-08-09, research-scout) — the storage half is effectively decided; only the backend choice
remains open, and it should be deferred behind a swappable interface:**
- **Nothing here needs Docker.** The blueprint's containerized Qdrant/Redis has **no infrastructure
  justification at MVP scale**, and containers would violate Q-HOW-3 and the dev-loop-simplicity
  anti-metric while being adoption-zero for the OSS primary user.
- **But every embedded TS option is pre-1.0**, which is a real supply-chain risk for an installable
  package: `sqlite-vec` is 0.1.10-alpha.4 with the author warning of breaking storage-format changes
  until 1.0 (a Node-only hardening fork, `@photostructure/sqlite-vec` v1.1.1, exists);
  `@lancedb/lancedb` 0.33.0 is the most production-shaped (prebuilt binaries across Linux/macOS/Windows,
  ~425 dependents, used by Continue.dev) but still 0.x and adds a native-binary install step — the
  "npm install fails on my machine" failure class. **SQLite upstream's own Vec1 is announced but not
  released** (v0.7, no release as of the 2026-03-30 forum post) — a reason to keep the layer swappable,
  not a dependency.
- Bindings substrate is fine on pi's floor: `node:sqlite` `loadExtension()`/`allowExtension` landed in
  v22.13.0, available on Node ≥22.19 (`allowExtension` defaults to false).
- Local embeddings are viable and cheap: `transformers.js` runs ONNX `all-MiniLM-L6-v2` (384-dim, ~23MB;
  caps at 256 tokens, which is fine for tool descriptions).
- **The recommendation that falls out: a swappable index interface with a zero-dependency in-memory
  brute-force cosine baseline.** A few hundred tools is trivially brute-forceable — ANN is unnecessary at
  our scale — so no vector-store dependency should be adopted until A-05 shows brute-force cosine is
  insufficient. Note also the conflicting signal on index *type*: BM25 was the weakest retriever at 584
  tools (32.8% F1 vs 52.5% for embeddings), yet Anthropic's GA implementation deliberately ships regex and
  BM25. Index choice is scale-dependent and must be measured.
- Language: A-08's posture is confirmed by circumstance — pi provides the loop, provider abstraction,
  mounting seams, event bus, and cache-aware usage normalization in TS. A second language would forfeit
  all of it.

## Options considered

### Option 1 — Blueprint literal: Python services + Qdrant/Redis containers
Richest RAG ecosystem; but possibly two stacks (R-09), new always-on infra in the dev loop, and
the most moving parts before the thesis is proven (R-08 smell).

### Option 2 — Baseline's language + embedded/file-based index
Tool definitions stay the single source of truth; the index is a rebuildable cache; zero new
containers; one stack. Constraint: ecosystem must clear A-08's scan.

### Option 3 — Baseline's language + containers when actually needed
Start embedded; adopt Qdrant/Redis only at a measured scale or multi-consumer threshold, recorded
here as the trigger.

## Decision

_ (pending Q-BASE-2, A-07, A-08 evidence)

## Consequences

_

## Revisit trigger

Embedded index fails recall/latency at measured catalog scale (A-07 evidence), or a required
capability appears with no viable implementation in the chosen language (A-08 gap list).
