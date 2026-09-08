# Bounded successor selection v2

`intent-request-v2` permits ONLY `action: "revise-selection"`. The other fields/limits are v1's exact
request ID, budget digest, expected revision/selection, proposed events, new selection and priorities.
`request.schema.json` embeds the exact v1 P01 definitions. V1 wire semantics/schema remain unchanged;
v1 cannot carry this action and v2 cannot relabel v1 actions. Old controllers reject the new action.

This uses the SAME `budget.intentControls(authority)` request/inspect/reconcile methods and existing
P01 work store. No second revision/application database. The existing dashboard `intent` and
`intent-reconcile` operations accept the validated native request, with independent whole-host/native
approval and current journal-tip/selection CAS. Physical source identity, original active reservations,
non-expiring locks and pending application barriers remain load-bearing.

Unlike revise-scope, a real goal/node/obligation/artifact successor does not require a fictitious scope
successor. Every changed selected revision must be the direct successor of the previously selected
revision; at least one must change. The new snapshot must resolve the complete exact P01 selection.
Entity inventory, owner, scope membership, parent/dependency topology, exact policy references and policy
content are fixed; permitted effects cannot expand. No general topology/entity/policy application is
claimed. An opaque new policy content digest is not proof of safe narrowing and is still refused.

Real P01 builders validate every proposed event. Required append/sync/close/accounting failure rejects,
even with complete prefix bytes. Duplicate request reads pending state; only explicit independently
approved reconciliation revalidates and applies missing events, and append-once never repeats an exact
retained event. Torn/conflicting/replaced/locked unknown state is not repaired. No charges or acceptance
are transferred; new evidence/authority is independently required for new claims.

Ordinary tests exercise actual goal/obligation successor application without a scope revision, the genuine
dashboard path, schema compatibility, owner/effect expansion refusals despite approval, denied/stale CAS,
original-permit busy barrier and actual work sync failure/reconnect/reconciliation. Other structural kinds
share the validator but are not a deployed task/model/policy qualification. Source through6212b9d is public draft PR35; later ordinary-boundary amendments remain
local-only. Original overall CHANGES-REQUESTED is unchanged. An attached ordinary host now queues busy
direction in its existing journal and holds original new-child admission until explicit reconciliation
and successful native/final-host acknowledgement. This does not add generic entity/topology/policy
operations or turn their unspecified broader wording into new implementation scope.
