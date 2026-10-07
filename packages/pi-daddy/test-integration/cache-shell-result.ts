/** Qualification-fixture values only, never production eligibility or client authority.
 * Preserve the native result. Parity compares separate runs, so validated wall-time values
 * and the fixture-owned output filename have an explicit comparison-only projection.
 * Presence and every other result/status/metadata field still participate in comparison.
 */
export interface ShellToolResult {
  content: { text: string; [field: string]: unknown }[];
  details?: unknown;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [field: string]: unknown;
}
export interface ShellOutcome {
  ok: boolean;
  error?: string;
  result?: ShellToolResult;
  updates: string[];
  fullOutput?: string;
}
export function shellReturnedOutcome(result: ShellToolResult, updates: string[], fullOutput?: string): ShellOutcome {
  if (result.isError !== undefined && typeof result.isError !== "boolean")
    throw new Error("shell fixture native isError must be boolean when present");
  const failed = result.isError === true;
  return {
    ok: !failed,
    ...(failed ? { error: result.content.map((item) => item.text).join("") } : {}),
    result,
    fullOutput,
    updates,
  };
}
export function shellComparable(outcome: ShellOutcome) {
  const { updates: _, result, ...rest } = outcome;
  if (!result) return rest;
  const projected: ShellToolResult = { ...result };
  const details = result.details as { fullOutputPath?: unknown } | undefined;
  const path = details?.fullOutputPath;
  if (path !== undefined) {
    if (typeof path !== "string" || !path.length) throw new Error("shell fixture full-output reference is invalid");
    projected.content = result.content.map((item) => ({ ...item, text: item.text.replaceAll(path, "<full-output>") }));
    projected.details = { ...details, fullOutputPath: "<full-output>" };
    if (rest.error !== undefined) rest.error = rest.error.replaceAll(path, "<full-output>");
  }
  if (result.structuredContent !== undefined) {
    const original = result.structuredContent;
    if (!original || typeof original !== "object" || Array.isArray(original))
      throw new Error("shell fixture structuredContent must be an object");
    const structured = { ...original };
    if (Object.hasOwn(structured, "wall_time_seconds")) {
      const seconds = structured.wall_time_seconds;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
        throw new Error("shell fixture wall-time measurement is invalid");
      // Retain the key: missing timing on one side must still fail parity.
      structured.wall_time_seconds = "<per-execution-wall-time>";
    }
    if (path !== undefined && Object.hasOwn(structured, "full_output_path")) {
      if (structured.full_output_path !== path) throw new Error("shell fixture conflicting full-output reference");
      structured.full_output_path = "<full-output>";
    }
    projected.structuredContent = structured;
  }
  return { ...rest, result: projected };
}
