/** Locations of the selected definition, not permission to load additional resources. */
export interface SelectedResources {
  readonly version: 1;
  readonly selectedSkill: Readonly<{ path: string; sha256: string }>;
  readonly definition: Readonly<{ path: string; sha256: string }>;
  readonly resourceDirectory: string;
  /** Present only after the selected Principal package's existing binding checks succeeded. */
  readonly package?: Readonly<{ name: "principal-pi-skills"; root: string; version?: string }>;
}

export function selectedResourcePrompt(resources: SelectedResources | undefined): string | undefined {
  if (!resources) return undefined;
  return (
    "Selected definition resource locations (pi-daddy, version 1):\n" +
    JSON.stringify(resources) +
    "\nThese locations identify the selected instruction source. Resolve its relative resource references here, " +
    "using only tools already granted. Other resource contents and availability have not been verified or loaded. " +
    "These locations grant no additional tools, runtime skills, permission, or task approval."
  );
}
