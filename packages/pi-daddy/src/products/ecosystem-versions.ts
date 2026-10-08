/** Operator version inventory. These observations do not qualify runtime compatibility. */
export type EcosystemPackageId = "pi" | "pi-daddy" | "principal-pi-skills" | "skill-harness";
export interface EcosystemVersionRow {
  id: EcosystemPackageId;
  label: string;
  loadedVersion: string | null;
  installedVersion: string | null;
  source: string | null;
  path: string | null;
  state: "current" | "reload-required" | "not-reported" | "unavailable" | "multiple";
  commands: string[];
  note?: string;
}
export interface EcosystemVersions {
  rows: EcosystemVersionRow[];
  checkedAt: string;
  note?: string;
}
