import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { normaliseCorrelation, type CorrelationMetadata } from "./correlation.ts";
import {
  appendLedgerEvent,
  buildWorkspaceLeaseEvent,
  type CheckReceiptLedgerEvent,
  LEDGER_VERSION,
} from "./ledger.ts";
import { computeGitCandidateIdentity } from "./git-identity.ts";
import { runChild } from "./run-child.ts";
import { GovernanceRefusal, refusal } from "./refusals.ts";
import {
  acquireWorkspaceLease,
  defaultWorkspaceLeaseDir,
  type ValidatedWorkspace,
  type WorkspaceAccess,
  leaseAcquisitionOutcome,
} from "./workspace.ts";

export interface CheckDefinition {
  /** Absolute operator-owned executable. PATH lookup is deliberately not part of the contract. */
  executable: string;
  /** Exact argv elements. Never a shell command string. */
  argv: string[];
  /** Fixed non-sensitive environment values. */
  env?: Record<string, string>;
  /** Explicit inherited names. Sensitive names are still removed. */
  inherit_env?: string[];
  timeout_ms?: number;
  max_output_bytes?: number;
  /** Checks are assumed capable of writing unless the operator declares read. */
  workspace_access?: WorkspaceAccess;
}

export interface CheckRegistry {
  version: 1;
  checks: Record<string, CheckDefinition>;
}

export interface CheckReceipt {
  schema_version: "1.0";
  receipt_id: string;
  check_id: string;
  executable: string;
  executable_sha256: string;
  argv: string[];
  argv_sha256: string;
  cwd: string;
  cwd_sha256: string;
  started_at: string;
  ended_at: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  aborted: boolean;
  truncated: boolean;
  output_sha256: string;
  workspace_id: string;
  workspace_access: WorkspaceAccess;
  head_sha: string;
  tree_sha: string;
  correlation?: CorrelationMetadata;
}

const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|PRIVATE_KEY|API_KEY)(?:_|$)|^PI_GRANTS_|^(?:AWS|GITHUB|GITLAB|AZURE|GOOGLE)_/i;

export function buildCheckEnvironment(
  definition: CheckDefinition,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of definition.inherit_env ?? []) {
    if (!SAFE_ENV_NAME.test(name) || SENSITIVE_ENV_NAME.test(name)) continue;
    if (inherited[name] !== undefined) env[name] = inherited[name];
  }
  for (const [name, value] of Object.entries(definition.env ?? {})) {
    if (!SAFE_ENV_NAME.test(name) || SENSITIVE_ENV_NAME.test(name)) continue;
    env[name] = value;
  }
  return env;
}

function validateDefinition(checkId: string, value: CheckDefinition | undefined): CheckDefinition {
  if (!value) {
    throw new GovernanceRefusal(refusal(
      "CHECK_NOT_CONFIGURED", `check ${JSON.stringify(checkId)} is not present in operator-owned configuration`, { check_id: checkId },
    ));
  }
  if (!isAbsolute(value.executable) || !Array.isArray(value.argv) || value.argv.some((item) => typeof item !== "string")) {
    throw new GovernanceRefusal(refusal(
      "CHECK_CONFIGURATION_INVALID", `check ${JSON.stringify(checkId)} requires an absolute executable and argv string array`,
      { check_id: checkId },
    ));
  }
  for (const bound of [value.timeout_ms, value.max_output_bytes]) {
    if (bound !== undefined && (!Number.isInteger(bound) || bound <= 0)) {
      throw new GovernanceRefusal(refusal(
        "CHECK_CONFIGURATION_INVALID", `check ${JSON.stringify(checkId)} has a non-positive runtime bound`, { check_id: checkId },
      ));
    }
  }
  return value;
}

function receiptId(receipt: Omit<CheckReceipt, "receipt_id">): string {
  return createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
}

export async function runNamedCheck(input: {
  checkId: string;
  registry: CheckRegistry;
  workspace: ValidatedWorkspace;
  correlation?: CorrelationMetadata;
  inheritedEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  leaseDir?: string;
  ledgerPath?: string;
}): Promise<{
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  receipt: CheckReceipt;
}> {
  if (input.registry?.version !== 1 || !input.registry.checks || typeof input.registry.checks !== "object") {
    throw new GovernanceRefusal(refusal("CHECK_CONFIGURATION_INVALID", "check registry must contain {version:1, checks:{...}}"));
  }
  const definition = validateDefinition(input.checkId, input.registry.checks[input.checkId]);
  let executable: string;
  try {
    executable = await realpath(definition.executable);
    if (!(await stat(executable)).isFile()) throw new Error("not a file");
  } catch (error) {
    throw new GovernanceRefusal(refusal(
      "CHECK_CONFIGURATION_INVALID", `check ${JSON.stringify(input.checkId)} executable is not a real file (${String(error)})`,
      { check_id: input.checkId },
    ));
  }

  const argvSha256 = createHash("sha256").update(JSON.stringify(definition.argv), "utf8").digest("hex");
  const cwdSha256 = createHash("sha256").update(input.workspace.root, "utf8").digest("hex");
  const access = definition.workspace_access ?? "write";
  // Evidence checks coordinate exclusively so their pre/post candidate identities cannot overlap another
  // governed writer. `access` still records what the configured executable is intended to do.
  const leaseAccess: WorkspaceAccess = "write";
  const ownerId = `check:${input.checkId}:${randomUUID()}`;
  const correlation = normaliseCorrelation(input.correlation);
  let lease: Awaited<ReturnType<typeof acquireWorkspaceLease>> | undefined;
  let stagedDir: string | undefined;
  let releaseReason = "failed";
  try {
    try {
      lease = await acquireWorkspaceLease({
        workspace: input.workspace, access: leaseAccess, leaseDir: input.leaseDir ?? defaultWorkspaceLeaseDir(),
        ownerId, signal: input.signal,
      });
    } catch (error) {
      if (input.ledgerPath) await appendLedgerEvent(
        { path: input.ledgerPath, strict: true },
        buildWorkspaceLeaseEvent({
          childId: ownerId, workspaceId: input.workspace.workspaceId, root: input.workspace.root, access: leaseAccess,
          outcome: "refused",
          correlation, now: new Date(),
          ...(error instanceof GovernanceRefusal
            ? { refusal: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
            : {}),
        }),
      );
      throw error;
    }
    if (input.ledgerPath) {
      try {
        await appendLedgerEvent(
          { path: input.ledgerPath, strict: true },
          buildWorkspaceLeaseEvent({
            childId: ownerId, workspaceId: input.workspace.workspaceId, root: input.workspace.root, access: leaseAccess,
            outcome: leaseAcquisitionOutcome(leaseAccess, lease.recovered), recovered: lease.recovered,
            correlation, now: new Date(),
          }),
        );
      } catch (error) {
        await lease.release("ledger-failed");
        lease = undefined;
        throw error;
      }
    }

    const before = await computeGitCandidateIdentity(input.workspace);
    for (const [name, supplied, actual] of [
      ["head_sha", correlation?.head_sha, before.headSha], ["tree_sha", correlation?.tree_sha, before.treeSha],
    ] as const) {
      if (supplied && supplied !== actual) throw new GovernanceRefusal(refusal(
        "CHECK_IDENTITY_MISMATCH", `check ${JSON.stringify(input.checkId)} ${name} does not match the validated workspace`,
        { check_id: input.checkId, supplied, actual },
      ));
    }
    const executableBytes = await readFile(executable);
    const executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
    stagedDir = await mkdtemp(join(tmpdir(), "pi-daddy-check-exec-"));
    const stagedExecutable = join(stagedDir, basename(executable));
    await writeFile(stagedExecutable, executableBytes, { mode: 0o700 });
    await chmod(stagedExecutable, 0o700);
    const leaseAbort = new AbortController();
    let leaseLost = false;
    lease.lost.then(() => { leaseLost = true; leaseAbort.abort(); });
    const checkSignal = input.signal ? AbortSignal.any([input.signal, leaseAbort.signal]) : leaseAbort.signal;
    const started = new Date();
    const result = await runChild({
      command: "setpriv", args: ["--pdeathsig", "KILL", "--", stagedExecutable, ...definition.argv],
      env: buildCheckEnvironment(definition, input.inheritedEnv), cwd: input.workspace.root,
      signal: checkSignal, timeoutMs: definition.timeout_ms, maxOutputBytes: definition.max_output_bytes,
      onSpawn: (pid) => lease!.attachProcess(pid),
    });
    const ended = new Date();
    releaseReason = input.signal?.aborted ? "cancelled" : result.timedOut ? "timeout" : result.aborted ? "failed" : "completed";
    if (result.spawnError) throw new GovernanceRefusal(refusal(
      "EXECUTOR_UNAVAILABLE", `check ${JSON.stringify(input.checkId)} could not start its constrained executor`,
      { check_id: input.checkId },
    ));
    if (leaseLost) throw new GovernanceRefusal(refusal(
      "WORKSPACE_LEASE_STALE", `check ${JSON.stringify(input.checkId)} lost its workspace lease while running`,
      { check_id: input.checkId },
    ));
    const after = await computeGitCandidateIdentity(input.workspace);
    if (leaseLost) throw new GovernanceRefusal(refusal(
      "WORKSPACE_LEASE_STALE", `check ${JSON.stringify(input.checkId)} lost its workspace lease before receipt`,
      { check_id: input.checkId },
    ));
    if (before.headSha !== after.headSha || before.treeSha !== after.treeSha) {
      throw new GovernanceRefusal(refusal(
        "CHECK_IDENTITY_MISMATCH", `check ${JSON.stringify(input.checkId)} workspace changed while it ran`,
        { check_id: input.checkId },
      ));
    }
    // The candidate is now measured and the process is dead. End the lease before writing the receipt so
    // lease loss cannot race a blocked ledger append and leave behind evidence from an unprotected run.
    await lease.release(releaseReason);
    lease = undefined;
    if (leaseLost) throw new GovernanceRefusal(refusal(
      "WORKSPACE_LEASE_STALE", `check ${JSON.stringify(input.checkId)} lost its workspace lease before receipt`,
      { check_id: input.checkId },
    ));
    if (input.ledgerPath) await appendLedgerEvent(
      { path: input.ledgerPath, strict: true },
      buildWorkspaceLeaseEvent({
        childId: ownerId, workspaceId: input.workspace.workspaceId, root: input.workspace.root, access: leaseAccess,
        outcome: releaseReason === "timeout" ? "timeout" : "released", releaseReason, correlation, now: new Date(),
      }),
    );
    const body: Omit<CheckReceipt, "receipt_id"> = {
      schema_version: "1.0", check_id: input.checkId, executable, executable_sha256: executableSha256,
      argv: [...definition.argv], argv_sha256: argvSha256, cwd: input.workspace.root, cwd_sha256: cwdSha256,
      started_at: started.toISOString(), ended_at: ended.toISOString(), exit_code: result.code,
      signal: result.signal ?? null, timed_out: result.timedOut, aborted: result.aborted, truncated: result.truncated,
      output_sha256: createHash("sha256").update(result.text, "utf8").digest("hex"),
      workspace_id: input.workspace.workspaceId, workspace_access: access,
      head_sha: before.headSha, tree_sha: before.treeSha, ...(correlation ? { correlation } : {}),
    };
    const receipt: CheckReceipt = { receipt_id: receiptId(body), ...body };
    if (input.ledgerPath) {
      const event: CheckReceiptLedgerEvent = {
        ledgerVersion: LEDGER_VERSION, event: "check_receipt", ts: ended.toISOString(), childId: ownerId,
        receiptId: receipt.receipt_id, workspaceId: input.workspace.workspaceId, checkId: input.checkId,
        treeSha: receipt.tree_sha, ...(correlation ? { correlation } : {}),
      };
      await appendLedgerEvent({ path: input.ledgerPath, strict: true }, event);
    }
    return { output: result.text, exitCode: result.code, signal: result.signal ?? null, receipt };
  } finally {
    if (stagedDir) await rm(stagedDir, { recursive: true, force: true });
    if (lease) {
      await lease.release(releaseReason);
      if (input.ledgerPath) await appendLedgerEvent(
        { path: input.ledgerPath, strict: true },
        buildWorkspaceLeaseEvent({
          childId: ownerId, workspaceId: input.workspace.workspaceId, root: input.workspace.root, access: leaseAccess,
          outcome: releaseReason === "timeout" ? "timeout" : "released", releaseReason, correlation, now: new Date(),
        }),
      );
    }
  }
}
