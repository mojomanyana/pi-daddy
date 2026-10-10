/** Settings are owner observations; rendering never grants consent or changes execution. */
export type DashboardSettingKey = "auto" | "jev" | "wall" | "idle" | "descendants" | "depth" | "perCall";
export const DASHBOARD_SETTING_KEYS: DashboardSettingKey[] = [
  "auto",
  "jev",
  "wall",
  "idle",
  "descendants",
  "depth",
  "perCall",
];
export interface DashboardJevState {
  available: boolean;
  enabled: boolean;
  pending: boolean;
  mode?: string;
  storage?: string | null;
  remaining?: number;
  availability?: string;
  providerReadiness?: string;
  selectedProvider?: string;
  selectedModel?: string;
  transport?: string;
  storageRoot?: string;
  error?: string;
}
export interface DashboardSettingsSnapshot {
  editable: boolean;
  wallSeconds: number;
  idleSeconds: number;
  wallSource: "session" | "startup";
  idleSource: "session" | "startup";
  descendants: number;
  reserved: number;
  maxDepth: number;
  perCall: number;
  jev: DashboardJevState;
}
export const JEV_CONSENT_NOTICE = "Complete JEV paid-call and LoRA-storage choices in the parent Pi session";
export function dashboardJevNotice(jev: DashboardJevState): string {
  if (jev.pending) return JEV_CONSENT_NOTICE;
  if (!jev.available) return "JEV controls unavailable; inspect the parent Pi session";
  return jev.error || `JEV ${jev.enabled ? "enabled" : "disabled"}; ${jev.availability ?? "status unknown"}`;
}
export function dashboardSettingsLines(
  settings: DashboardSettingsSnapshot | undefined,
  auto: boolean | undefined,
  selected: DashboardSettingKey,
): string[] {
  if (!settings) return ["SETTINGS", "Owner settings unavailable. Reconnect from /grants dashboard."];
  const row = (key: DashboardSettingKey, label: string) => `${key === selected ? ">" : " "} ${label}`;
  const jev = settings.jev;
  return [
    "SETTINGS · current session",
    row("auto", `Permission Auto: ${auto ? "ON" : "OFF"}`),
    row(
      "jev",
      `JEV: ${jev.pending ? "waiting for consent" : !jev.available ? "unavailable" : jev.enabled ? "ON" : "OFF"}`,
    ),
    ...(jev.available
      ? [
          `  ${jev.availability ?? "unknown"} · ${jev.remaining ?? 0} paid calls left`,
          `  Key: ${jev.providerReadiness ?? "unknown"}; storage: ${jev.storage ?? "not granted"}`,
          ...(jev.selectedProvider || jev.selectedModel
            ? [`  Model: ${jev.selectedProvider ?? "unknown"}/${jev.selectedModel ?? "not reported"}`]
            : []),
          ...(jev.transport ? [`  Via: ${jev.transport}`] : []),
          ...(jev.storageRoot ? [`  Data: ${jev.storageRoot}`] : []),
        ]
      : ["  Load skill-harness to connect JEV controls."]),
    ...(jev.error ? [`  ${jev.error}`] : []),
    row("wall", `Child wall: ${settings.wallSeconds}s (${settings.wallSource})`),
    row("idle", `Child idle: ${settings.idleSeconds}s (${settings.idleSource})`),
    settings.editable
      ? "Edits apply to future children from this parent."
      : "Read-only: change settings in the owning parent.",
    "Running children keep their captured limits.",
    "JEV ON asks paid-call and LoRA-storage consent in Pi.",
    "Auto never supplies that consent. No model token budget.",
    "",
    "STARTUP LIMITS · restart to change",
    row("descendants", `Active descendants: ${settings.descendants} (${settings.reserved} reserved) · PI_DADDY_FANOUT`),
    row("depth", `Maximum depth: ${settings.maxDepth} · PI_DADDY_MAX_DEPTH`),
    row("perCall", `Children per call: ${settings.perCall} (fixed safety bound)`),
    "s settings · m models · v versions",
  ];
}
