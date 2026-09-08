import { closed, experimentCancellation, type ExperimentCancellation, type ExperimentCharter, type ExperimentVariant } from "./experiment-contract.ts";
import { factoryDecision, type FactoryDecision } from "./order-schedule.ts";
export type VariantState = "unstarted" | "queued" | "dispatching" | "running" | "completed" | "failed" | "cancelled" | "timed-out" | "unknown";
export interface VariantRecord extends Pick<ExperimentVariant, "variantId" | "kind" | "operation"> { executionId: string; state: VariantState; artifactDigest: string | null; spawned: boolean }
export function replayExperiment(c: ExperimentCharter, events: Record<string, unknown>[]) {
  let claim: { owner: string; deadlineAt: number } | null = null, admitted = false;
  const variants: VariantRecord[] = c.variants.map(v => ({ variantId: v.variantId, kind: v.kind, operation: v.operation, executionId: v.executionId, state: "unstarted", artifactDigest: null, spawned: false }));
  const cancellations: ExperimentCancellation[] = [], decisions: FactoryDecision[] = [];
  let superseded = false;
  for (const e of events) {
    if (e.type === "order-decision") {
      closed(e,["type","request"]);const d=factoryDecision(e.request as FactoryDecision);
      if(!c.order || !c.order.nodes.some(n=>n.nodeId===d.nodeId&&n.decision?.authorityId===d.authorityId)||decisions.some(r=>r.nodeId===d.nodeId||r.requestId===d.requestId))throw new Error("invalid order decision sequence");decisions.push(d);
    } else if(e.type === "order-migrated") {
      closed(e,["type","requestId","successorDigest"]);if(!c.order||claim||superseded||typeof e.requestId!=="string"||typeof e.successorDigest!=="string"||!/^[a-f0-9]{64}$/.test(e.successorDigest))throw new Error("migration requires unstarted order");superseded=true;
    } else if (e.type === "claim") {
      closed(e, ["type", "owner", "deadlineAt"]);
      if (superseded || claim || typeof e.owner !== "string" || !/^[a-f0-9-]{36}$/.test(e.owner) || !Number.isSafeInteger(e.deadlineAt)) throw new Error("invalid experiment claim");
      claim = { owner: e.owner, deadlineAt: e.deadlineAt as number }; variants.forEach(v => v.state = "queued");
    } else if (e.type === "admitted") {
      closed(e, ["type"]); if (!claim || admitted) throw new Error("invalid experiment admission"); admitted = true;
    } else if (e.type === "cancel") {
      closed(e, ["type", "request"]); const request = experimentCancellation(e.request as ExperimentCancellation);
      if (!variants.some(v => v.executionId === request.executionId) || cancellations.some(r => r.requestId === request.requestId) || cancellations.length >= 64) throw new Error("invalid cancellation sequence");
      cancellations.push(request);
    } else if (e.type === "controller-unknown") {
      closed(e, ["type"]); if (!claim) throw new Error("missing claim");
      variants.filter(v => v.artifactDigest === null).forEach(v => v.state = "unknown");
    } else {
      const v = variants.find(v => v.executionId === e.executionId);
      if (!claim || !admitted || !v || v.artifactDigest !== null) throw new Error("invalid variant sequence");
      if (e.type === "dispatch") {
        closed(e, ["type", "executionId"]); if (v.state !== "queued") throw new Error("duplicate dispatch"); v.state = "dispatching";
      } else if (e.type === "spawn") {
        closed(e, ["type", "executionId"]); if (v.state !== "dispatching") throw new Error("invalid spawn observation"); v.state = "running"; v.spawned = true;
      } else if (e.type === "result") {
        closed(e, ["type", "executionId", "state", "artifactDigest"]);
        if (!["dispatching", "running"].includes(v.state) || !["completed", "failed", "cancelled", "timed-out"].includes(String(e.state)) || typeof e.artifactDigest !== "string" || !/^[a-f0-9]{64}$/.test(e.artifactDigest)) throw new Error("invalid result observation");
        v.state = e.state as VariantState; v.artifactDigest = e.artifactDigest;
      } else throw new Error("unknown experiment event");
    }
  }
  return { claim, admitted, variants, cancellations, decisions, superseded };
}
