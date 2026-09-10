# ADR-0053: Coherent cancellation readback and exception-safe test lifetimes

Status: implemented locally; overall review/acceptance pending
Date: 2026-09-08

## Evidence

Preserve the P17D unchanged56/1 baseline and retained/inconclusive removal hypothesis, the
CI34199801885 prolonged tests, and producer diagnosis receipt bee64826057e18b189972bf65e38f7765271125c4b14bfdc29e1de383154b852.
The authorized P15 publication triggered existing workflow concurrency cancellation; there was no
manual CI cancellation/retry. An old hygiene test deleted its own new fixture despite KEEP_TMP;
that historical caveat is not rewritten.

Missing bwrap threw after a namespace fixture opened a TCP listener but before its finally block.
Cancellation durably recorded a request and aborted an original worker, then an unlocked readback
raced real settlement. The read failed after the effect. Neither failure demonstrated no effect.

## Decision

Cancellation readback uses the existing experiment transaction and resource control snapshot locks.
It does not await shadow completion, judge work or grant new authority. Required lock/read/close failures
still reject. Public inspect/reconcile remain unlocked, fallible, read-only consistency checks. Exact
duplicate cancellation remains readback-only; no new abort, execution, refund or guessed handle.
Independent primary and owned completion lifetimes are unchanged. No P17D projection removal is applied.

The namespace fixture registers listener teardown before prerequisite setup. A separate ordinary child
regression injects the actual missing-prerequisite failure, checks the real listener is closed and still
requires the namespace test to fail. Its fallback closes only a broken regression's owned listener after
recording failure, preventing the regression itself from hanging.

Register the existing cleanup helper in the eleven omitted suites; KEEP_TMP still preserves their fixtures.
The hygiene test exercises default deletion only in a separate process owning fresh fixtures, restores its
caller's retention setting, and does not delete an explicitly retained fixture. Native fixture module
resolution is module-relative rather than CWD-relative; the staged CommonJS executable explicitly uses .cjs.
No historical paths are cleaned. No install, package lifecycle or CI retry is needed for these repairs.

## Verification and limits

An ordinary regression failed before the cancellation repair, then passes while coordinating actual
settlement fsync and contested control locks. A separate forced append still makes ordinary inspect reject.
All1078 ordinary tests passed from package CWD using explicitly linked retained tools and private
HOME/TMPDIR/agent/XDG with KEEP_TMP; prior1012/63 and narrower failures remain evidence. A nested-test
NODE_TEST_CONTEXT fixture error was diagnosed and fixed by creating an independent child test context.
Missing runtime prerequisites remain real CI failures, not qualified namespace evidence. No live pi/Herdr,
authenticated host authority, global resource/crash recovery or full factory acceptance is claimed.
