# Task history, version 1

The in-process binding lets a producer offer a bounded status observation for
the task in which its operation began. Each package retains its authoritative
execution results. Consumers can inspect observations independently of the
producer's availability. Restoring a projection never dispatches a command.

## Publishing an observation

At operation entry the producer emits `pi.task-history.v1.bind` with
`{ version: 1, owner, cwd, sessionId?, accept }`. An admitted consumer calls
`accept(publish)` synchronously with a function bound to the current workspace,
task, revision and current access. Late or absent bindings have no effect.
The producer keeps this binding inside the operation and submits its result
to it. A task change, session change or revoked authorization can invalidate
publication. An old operation must never rebind its terminal observation to
whatever task is now selected.

The six required data fields and optional evidence selector are specified in `observation.schema.json`. The receiver
also bounds UTF-8 bytes, requires trimmed single-line text, excludes control
and formatting characters, and checks for known secret formats. Producers
send a short factual label, an operation identifier and status. Private note
bodies, transcripts, raw arguments and credentials stay out of these messages.
Two observations with the same task, owner, operation ID, kind and state must
have equal content to be idempotent. Changed content requires a distinct
recorded transition. Treat missing observations as missing coverage.

`producer.ts` is the reference optional binding. Independently released
packages can ship a matching copy. A publisher may refuse the write, throw or
reject. Producers still expose their original outcome through their native
entry points.

## Ownership and recovery

Only the component that owns a command admits and settles it after checking
current authority. The shared task selection allows a controller to request
work from that owner. Lifecycle notifications, dashboard clicks, imports and
timestamps do not establish execution or acceptance. Keep actual check
evidence and the owner's durable receipt when claiming an outcome.

## Admission, pause and cancellation

Scout, Harness and explicitly enabled JEV use `pi.task-dispatch.v1.bind`.
The producer supplies its owner, current session and working folder. The host
returns a function bound to the selected task and revision. A missing peer
preserves standalone operation. A bound host's refusal stops dispatch.
Concurrent callers share the owner's durable reservation for the task. Each
new operation ID can be admitted once; a completed native receipt can be
read without admission. The units are owner operations. An evaluation can
contain several provider calls; a task-attempt count cannot measure tokens,
cost or provider invocations.

Before starting new work, the owner asks the bound host to admit its operation
ID. The returned signal carries task cancellation. The owner reports observed
cleanup as settled, proven unstarted or unknown. Uncertain effects require
owner reconciliation. The optional native evidence selector identifies a
receipt within an owner's store. The owner still checks access on every read.

## Reading the dispatch journal

Bookie requests `pi.task-history.v1.replay` with its current session, working
folder, project, selected task, owner `pi-daddy`, exclusive `after` cursor and
a bounded page size. A single matching owner synchronously supplies a read
function. The function checks current access before and after reading. It
returns `after`, `next`, `more`, `events` and one `provenance` entry per
returned event. The provenance holds the native journal sequence and
`recordedAt` in UTC.

Root tasks can govern their children's aggregate allowance. The journal
filters each page for the selected task. A page with no visible entries can
advance the cursor over work that belongs to other tasks. The cursor refers
to the durable owner stream; it is independent of wall-clock order. Bookie
retains the page and cursor together, retains the original timestamp and
exposes indexing time separately. A replayed dispatch fact describes
admission, controls or observed cleanup. The product's execution owner still
holds the evidence for delivery or acceptance.
