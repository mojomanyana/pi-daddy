import { sectionHeading } from "./dashboard-layout.ts";

/** Settings are owner observations; rendering never grants consent or changes execution. */
export const JEV_EDIT_ACTIONS = ["limit", "configure", "hints"] as const;
export type JevEditAction = (typeof JEV_EDIT_ACTIONS)[number];
export const isJevEditAction = (value: unknown): value is JevEditAction =>
  JEV_EDIT_ACTIONS.some((key) => value === key);
export type DashboardSettingKey =
  JevEditAction | "auto" | "jev" | "wall" | "idle" | "descendants" | "depth" | "perCall";
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
  limit?: number;
  used?: number;
  hintsEnabled?: boolean;
  controls?: JevEditAction[];
  availability?: string;
  providerReadiness?: string;
  selectedProvider?: string;
  selectedModel?: string;
  transport?: string;
  storageRoot?: string;
  error?: string;
}
export function visibleSettingKeys(jev?: DashboardJevState): DashboardSettingKey[] {
  const extra = JEV_EDIT_ACTIONS.filter((key) => jev?.available && jev.controls?.includes(key));
  return ["auto", "jev", ...extra, ...DASHBOARD_SETTING_KEYS.slice(2)];
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
export const JEV_EDITOR_NOTICE = "Finish editing in the main Pi session.";
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
  width: number,
): string[] {
  if (!settings) return ["Owner settings unavailable. Reconnect from /grants dashboard."];
  const row = (key: DashboardSettingKey, label: string, nested = false) =>
    `${key === selected ? ">" : " "}${nested ? "   " : " "}${label}`;
  const jev = settings.jev;
  const canConfigure = jev.controls?.includes("configure");
  const providerIndent = canConfigure ? "      " : "    ";
  const providerLines = [
    jev.controls?.includes("limit")
      ? `Provider status: ${jev.availability ?? "unknown"}`
      : `${jev.availability ?? "unknown"} · ${jev.remaining ?? 0} paid calls left`,
    `Key: ${jev.providerReadiness ?? "unknown"}; storage: ${jev.storage ?? "not granted"}`,
    ...(jev.selectedProvider || jev.selectedModel
      ? [`Model: ${jev.selectedProvider ?? "unknown"}/${jev.selectedModel ?? "not reported"}`]
      : []),
    ...(jev.transport ? [`Via: ${jev.transport}`] : []),
    ...(jev.storageRoot ? [`Data: ${jev.storageRoot}`] : []),
  ];
  return [
    sectionHeading("PERMISSIONS", width),
    row("auto", `Permission Auto: ${auto ? "ON" : "OFF"}`),
    "",
    sectionHeading("JEV · optional advice", width),
    row(
      "jev",
      `JEV: ${jev.pending ? "waiting for consent" : !jev.available ? "unavailable" : jev.enabled ? "ON" : "OFF"}`,
    ),
    ...(jev.available
      ? [
          "    Pi asks before paid calls or storage.",
          ...(jev.controls?.includes("limit")
            ? [
                row("limit", `Call limit: ${jev.limit ?? "unknown"} per session`, true),
                `      ${jev.used ?? "?"} used · ${jev.remaining ?? "?"} available now`,
              ]
            : []),
          ...(canConfigure ? [row("configure", "Choose JEV model and storage…", true)] : []),
          ...providerLines.map((line) => providerIndent + line),
          ...(jev.controls?.includes("hints")
            ? [
                row(
                  "hints",
                  `Tool hints: ${jev.hintsEnabled === true ? "ON" : jev.hintsEnabled === false ? "OFF" : "unknown"}`,
                  true,
                ),
                "      Suggestions only · above 90% confidence",
              ]
            : []),
        ]
      : ["    Load skill-harness to connect JEV controls."]),
    ...(jev.error ? [`    ${jev.error}`] : []),
    "",
    sectionHeading("CHILD TIMEOUTS", width),
    row("wall", `Child wall: ${settings.wallSeconds}s (${settings.wallSource})`),
    row("idle", `Child idle: ${settings.idleSeconds}s (${settings.idleSource})`),
    settings.editable
      ? "    Time limits apply to future children only."
      : "    Read-only: change settings in the owning parent.",
    "",
    sectionHeading("STARTUP LIMITS · restart to change", width),
    row("descendants", `Active descendants: ${settings.descendants} (${settings.reserved} reserved) · PI_DADDY_FANOUT`),
    row("depth", `Maximum depth: ${settings.maxDepth} · PI_DADDY_MAX_DEPTH`),
    row("perCall", `Children per call: ${settings.perCall} (fixed safety bound)`),
  ];
}
