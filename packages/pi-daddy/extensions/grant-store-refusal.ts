import { digestTask } from "../src/correlation.ts";
import { newExecutionId } from "../src/execution-id.ts";
import { appendRecord, buildRecord } from "../src/ledger.ts";
import { WILDCARD } from "../src/pi-tools.ts";
import { refusal } from "../src/refusals.ts";
import type { GrantsSession } from "./session.ts";

interface RefusalUI {
  notify(message: string, level: "error"): void;
}

/** Make invalid project state both visible and durable without allowing any child to start. */
export async function reportGrantStoreRefusal(session: GrantsSession, ui: RefusalUI): Promise<void> {
  if (!session.grantStoreRefusal) return;
  const { reason, path } = session.grantStoreRefusal;
  const message = `grants: stored grant ${path} is ${reason}; this session is refused with an empty grant. ` +
    `Repair or remove the store, then restart pi.`;
  ui.notify(message, "error");
  if (!session.ledgerPath) return;
  try {
    await appendRecord(
      { path: session.ledgerPath, strict: true },
      buildRecord({
        executionId: newExecutionId(), parentExecutionId: null,
        parentId: session.ownSpawnId, childId: `grant-store@${session.ownSpawnId}`,
        depth: session.depth, agentType: "grant-store", requested: [WILDCARD], parentGrant: [],
        result: { effective: [], denied: [WILDCARD], clipped: [], gatedBlocked: [], universal: [], subsumedBy: [] },
        blocked: true, reason: message,
        refusal: refusal("GRANT_STORE_INVALID", message, { reason }),
        executor: session.executor.kind, taskDigest: digestTask("grant-store-load"), now: new Date(),
      }),
    );
  } catch (error) {
    ui.notify(`grants: the stored-grant refusal could not be ledgered (${String(error)}); the session remains refused.`, "error");
  }
}
