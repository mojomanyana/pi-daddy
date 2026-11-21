/** Bounded Principal delivery metadata for display in the current task view. */
export const DASHBOARD_DELIVERY_PRODUCER = "principal-delivery";

export interface DashboardTaskDelivery {
  deliveryId: string;
  taskId?: string;
  revision: number;
  outcome: string;
  outstanding?: string;
  nextAction?: string;
  state: "open" | "verified" | "partial";
  handoff?: "assistant" | "fallback";
  evidence?: string[];
}

export function validDashboardTaskDelivery(value: unknown): value is DashboardTaskDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const fields = [
    "deliveryId",
    "taskId",
    "revision",
    "outcome",
    "outstanding",
    "nextAction",
    "state",
    "handoff",
    "evidence",
  ];
  const text = (s: unknown, limit = 240) => typeof s === "string" && Boolean(s.trim()) && s.length <= limit;
  const optional = (s: unknown, limit?: number) => s === undefined || text(s, limit);
  return (
    Object.keys(v).every((key) => fields.includes(key)) &&
    text(v.deliveryId, 160) &&
    optional(v.taskId, 160) &&
    Number.isSafeInteger(v.revision) &&
    Number(v.revision) >= 0 &&
    text(v.outcome) &&
    optional(v.outstanding) &&
    optional(v.nextAction) &&
    (v.state === "open" || v.state === "verified" || v.state === "partial") &&
    (v.handoff === undefined || v.handoff === "assistant" || v.handoff === "fallback") &&
    (v.evidence === undefined ||
      (Array.isArray(v.evidence) && v.evidence.length <= 6 && v.evidence.every((line) => text(line))))
  );
}
