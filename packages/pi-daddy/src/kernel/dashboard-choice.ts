/** Private owner controls, available only on the authenticated dashboard connection. */
export const DASHBOARD_CHOICE_EVENT = "pi-daddy:bookie-choice-controls:v1";
export interface DashboardChoiceDetail {
  id: string;
  label: string;
  title: string;
  revision: string;
  options: string[];
  recommendation?: { option: string; reason: string; evidence: string };
}
export type DashboardChoiceAnswer = { option: string } | { custom: string };
export interface DashboardChoiceTarget {
  choiceId: string;
  sourceGeneration: string;
  expectedOwner: { sessionId: string; cwd: string; generation: string };
}
export type DashboardChoiceAction = DashboardChoiceTarget &
  ({ action: "inspect-choice" } | { action: "answer-choice"; revision: string; answer: DashboardChoiceAnswer });
export type DashboardChoiceOutcome = "saved" | "refused" | "unconfirmed";
export interface DashboardChoiceRegistration {
  version: 1;
  sessionId: string;
  cwd: string;
  sourceGeneration: string;
  renew?(): Promise<void>;
  inspect(id: string, assertCurrent: () => void): Promise<DashboardChoiceDetail | undefined>;
  answer(
    id: string,
    revision: string,
    answer: DashboardChoiceAnswer,
    assertCurrent: () => void,
  ): Promise<DashboardChoiceOutcome>;
  reply(value: { version: 1; ok: false } | { version: 1; ok: true; close(): void }): void;
}
const record = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const text = (v: unknown, length: number): v is string =>
  typeof v === "string" &&
  v.trim() === v &&
  v.length > 0 &&
  v.length <= length &&
  !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(v);
const keys = (v: object, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));
export const validChoiceId = (v: unknown): v is string =>
  typeof v === "string" && /^open-choice-[a-zA-Z0-9_-]{1,128}$/.test(v);
export const validChoiceRevision = (v: unknown): v is string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
export const validChoiceAnswer = (v: unknown): v is DashboardChoiceAnswer =>
  record(v) && ((keys(v, ["option"]) && text(v.option, 120)) || (keys(v, ["custom"]) && text(v.custom, 240)));
export function validChoiceDetail(v: unknown): v is DashboardChoiceDetail {
  if (
    !record(v) ||
    !keys(v, ["id", "label", "title", "revision", "options", "recommendation"]) ||
    !validChoiceId(v.id) ||
    !text(v.label, 240) ||
    !text(v.title, 120) ||
    !validChoiceRevision(v.revision) ||
    !Array.isArray(v.options) ||
    v.options.length > 8 ||
    !v.options.every((option) => text(option, 120)) ||
    new Set(v.options).size !== v.options.length
  )
    return false;
  const rec = v.recommendation;
  return (
    rec === undefined ||
    (record(rec) &&
      keys(rec, ["option", "reason", "evidence"]) &&
      text(rec.option, 120) &&
      v.options.includes(rec.option) &&
      text(rec.reason, 240) &&
      text(rec.evidence, 240))
  );
}
