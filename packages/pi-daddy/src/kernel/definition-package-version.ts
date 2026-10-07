/** Validate retained definition attribution without loading Pi resource discovery. */
export function isDefinitionPackageVersion(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(value);
}
