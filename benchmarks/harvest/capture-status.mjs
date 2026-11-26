import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { openOperationArtifactScan } from "../../packages/pi-daddy/src/governance/operation-artifact-scan.ts";

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
  return summary + ` Daddy read of ${entry ? "latest branch" : "first page"} reference: ${status} (${Math.round(performance.now() - start)} ms).`;
}
