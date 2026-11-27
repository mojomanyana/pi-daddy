import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { openOperationArtifactScan } from "../../packages/pi-daddy/src/governance/operation-artifact-scan.ts";

// The artifact bridge uses one refusal for several owner checks. The runtime
// snapshot can identify a failed bind without exposing private paths or IDs.
function explainOwner(pi, cwd, sessionId) {
  const requestId = randomUUID();
  return new Promise(resolve => {
    const finish = message => { clearTimeout(timer); resolve(message); };
    const timer = setTimeout(() => finish("Daddy did not answer the runtime status check."), 1500);
    try {
      pi.events.emit("pi-daddy:runtime-snapshot:v1", { version: 1, requestId, cwd, sessionId, reply(snapshot) {
        if (snapshot?.version !== 1 || snapshot.requestId !== requestId)
          return finish("The runtime status reply could not be matched to this check.");
        if ((snapshot.sessionId && snapshot.sessionId !== sessionId) || (snapshot.cwd && snapshot.cwd !== cwd))
          return finish("Daddy is bound to a different session or workspace.");
        const reason = String(snapshot.reason ?? "").replace(/^Error: /, "");
        if (reason === "another live runtime owns this Pi session" || reason === "prior runtime owner is still alive")
          return finish("Daddy could not take ownership at startup because another process held this session.");
        if (reason === "runtime ownership lock timed out")
          return finish("Daddy timed out acquiring the session lock at startup.");
        if (reason === "invalid runtime journal identity" || reason === "invalid runtime journal execution")
          return finish("Daddy rejected the saved execution journal during startup.");
        if (/^runtime (lock is not a private ordinary file|settlement root must (be private|not contain symlinks))$/.test(reason))
          return finish("Daddy rejected the permissions or location of its runtime storage.");
        if (reason === "runtime settlement requires Linux x64") return finish(reason + ".");
        if (reason === "runtime owner is not ready") return finish("An unbound Daddy instance replied. Use /reload in this Pi session, then /bookie-capture sync.");
        if (snapshot.sessionId === sessionId && snapshot.cwd === cwd && snapshot.ownerScope)
          return finish("Daddy reported a matching runtime owner on the follow-up check.");
        return finish("Daddy did not establish the runtime owner. The specific cause is unconfirmed.");
      } });
    } catch { finish("Daddy's runtime status check could not be delivered."); }
  });
}

// Use a private scan so a diagnostic cannot invalidate Bookie's pagination cursor.
export async function captureStatus(pi, ctx, agentDir, openScan = openOperationArtifactScan) {
  if (ctx.isProjectTrusted?.() !== true) return "Capture check requires a trusted workspace.";
  const cwd = await realpath(ctx.cwd), sessionId = ctx.sessionManager.getSessionId();
  let scan, page, summary;
  try {
    scan = openScan(agentDir, { cwd, sessionId });
    page = scan.next(32);
    summary = `Capture check: first page has ${page.references.length} retained references, ${page.uncertain} unfinished, ${page.issues} unreadable.`;
  } catch {
    summary = "Capture check: Daddy could not scan the current session's stored results.";
  } finally { scan?.close(); }
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" &&
    e.customType === "pi-daddy:operation-artifact:v1" && e.data?.owner?.sessionId === sessionId && e.data.owner.cwd === cwd);
  const reference = entry?.data ?? page?.references[0];
  if (!reference) return summary + " No current-session reference was available for a read check.";
  const requestId = randomUUID(), start = performance.now();
  const status = await new Promise(resolve => {
    const timer = setTimeout(() => resolve("no reply within Bookie's 1.5-second deadline"), 1500);
    try {
      pi.events.emit("pi-daddy:operation-artifacts:v1", { version: 1, cwd, sessionId, requestId, action: "read", reference,
        reply(result) {
          clearTimeout(timer);
          if (result?.version !== 1 || result.requestId !== requestId || result.sessionId !== sessionId || result.cwd !== cwd)
            return resolve("reply identity mismatch");
          if (result.ok === true) return resolve("read succeeded");
          const reasons = ["owner-unavailable", "authority", "source-changed", "not-found", "unavailable"];
          resolve(reasons.includes(result.code) ? result.code : "unavailable");
        },
      });
    } catch { clearTimeout(timer); resolve("event delivery failed"); }
  });
  const result = summary + ` Daddy read of ${entry ? "latest branch" : "first page"} reference: ${status} (${Math.round(performance.now() - start)} ms).`;
  return status === "owner-unavailable" ? result + " " + await explainOwner(pi, cwd, sessionId) : result;
}
