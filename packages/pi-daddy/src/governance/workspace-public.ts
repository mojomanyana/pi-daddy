/**
 * The `pi-daddy/workspace` subpath, kept whole across ADR-0076's layering. Routing (registry, validation,
 * `workspace:<id>` resolution) lives in the kernel; the governed-writer lease lives in governance. Consumers
 * imported both from one subpath before the split and still can, from this file, without the kernel having
 * to import a store. PR 3 of ADR-0076 collapses the export map; this file goes with it.
 */
export * from "../kernel/workspace.ts";
export {
  acquireWorkspaceLease,
  ENV_WORKSPACE_LEASE_DIR,
  defaultWorkspaceLeaseDir,
  leaseAcquisitionOutcome,
  leaseReleaseLedgerOutcome,
  type LeaseReleaseOutcome,
  type WorkspaceLease,
} from "./workspace-lease.ts";
