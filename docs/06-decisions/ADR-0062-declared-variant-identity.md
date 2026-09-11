# ADR-0062 — Declared variant identity on ordinary attempts

**Status:** implemented on the stacked post-merge C04 branch; not released.

Ordinary `delegate_all` already launches isolated children concurrently with independent model requests, but the work-v4 join discarded their variant identity. Use caller-declared correlation `context_id` as the occurrence's non-authoritative `variantId`; retain requested model and effort only when the actual delegation argv carries them. Out-of-grammar labels remain digest-labelled.

A fresh bounded live occurrence launched Sol and Terra children together. Starting observations were 26ms apart and both execution windows overlapped; separate outputs and execution IDs were retained and the dashboard showed two attempts. The model tool schema did not expose thinking, so actual tool arguments omitted it and evidence records effort unknown. This validates a two-model concurrent slice only—not thinking-level variants, primary/shadow independence, quality, acceptance or complete accounting beyond the observed four responses.
