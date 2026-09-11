# ADR-0063 — Retained work can nominate coverage without declared facts

**Status:** implemented on stacked C02/C04 continuation; not released.

The dashboard source job formerly required a separately retained facts file before it could call the harness signal adapter. That made real work unable to produce even the facts already present in its own projection without fixture/declaration setup.

A work observation may now carry `facts: null`. The host still archives/checkpoints exact work bytes and requires the independently supplied exact selection. It calls harness commit `127b349310dd8f28e5d6b12148a063fce66a77dd`, whose null-facts profile derives only scope/obligation/coverage. It explicitly invents no wait, deadline, violation, objective failure, prior acceptance or authority. Resulting cards remain silent and unaccepted.

The pinned dashboard harness fixture was refreshed byte-for-byte to that exact source commit. Red-first integration proves a work source creates a coverage case without a facts source or note and consumes zero attention. Richer repeat/checkpoint/reopen interpretation remains separate work.
