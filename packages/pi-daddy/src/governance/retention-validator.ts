/** Dependency-free evaluator for the fixed retention schema; unsupported vocabulary fails at construction. */
type Check = (value: unknown) => boolean;
type Schema = Record<string, any>;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keywords = new Set([
  "$schema",
  "$id",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "items",
  "maxItems",
  "uniqueItems",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
]);

/** This is internal retention vocabulary, not a general JSON Schema implementation. */
export function compileRetentionShape(schema: Schema): Check {
  for (const key of Object.keys(schema))
    if (!keywords.has(key)) throw new TypeError(`unsupported retention schema keyword: ${key}`);
  const checks: Check[] = [];
  if (schema.type !== undefined) {
    const types: Record<string, Check> = {
      object,
      array: Array.isArray,
      string: (value) => typeof value === "string",
      boolean: (value) => typeof value === "boolean",
      integer: Number.isInteger,
      null: (value) => value === null,
    };
    if (!Object.hasOwn(types, schema.type)) throw new TypeError("unsupported retention schema type");
    checks.push(types[schema.type]);
  }
  if (Object.hasOwn(schema, "const")) checks.push((value) => value === schema.const);
  if (schema.enum) checks.push((value) => schema.enum.includes(value));
  if (schema.properties) {
    const properties = Object.entries(schema.properties).map(
      ([key, shape]) => [key, compileRetentionShape(shape as Schema)] as const,
    );
    checks.push(
      (value) => !object(value) || properties.every(([key, check]) => !Object.hasOwn(value, key) || check(value[key])),
    );
  }
  if (schema.required)
    checks.push((value) => !object(value) || schema.required.every((key: string) => Object.hasOwn(value, key)));
  if (schema.additionalProperties !== undefined) {
    if (schema.additionalProperties !== false) throw new TypeError("unsupported retention additionalProperties");
    checks.push(
      (value) => !object(value) || Object.keys(value).every((key) => Object.hasOwn(schema.properties ?? {}, key)),
    );
  }
  if (schema.pattern) {
    const pattern = new RegExp(schema.pattern);
    checks.push((value) => typeof value !== "string" || pattern.test(value));
  }
  if (schema.minLength !== undefined || schema.maxLength !== undefined)
    checks.push(
      (value) =>
        typeof value !== "string" ||
        ([...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? Infinity)),
    );
  if (schema.minimum !== undefined || schema.maximum !== undefined)
    checks.push(
      (value) =>
        typeof value !== "number" || (value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity)),
    );
  if (schema.items) {
    const check = compileRetentionShape(schema.items);
    checks.push((value) => !Array.isArray(value) || value.every(check));
  }
  if (schema.maxItems !== undefined) checks.push((value) => !Array.isArray(value) || value.length <= schema.maxItems);
  if (schema.uniqueItems) checks.push((value) => !Array.isArray(value) || new Set(value).size === value.length);
  for (const kind of ["anyOf", "oneOf", "allOf"] as const) {
    if (!schema[kind]) continue;
    const alternatives = schema[kind].map(compileRetentionShape) as Check[];
    checks.push((value) =>
      kind === "anyOf"
        ? alternatives.some((check) => check(value))
        : kind === "allOf"
          ? alternatives.every((check) => check(value))
          : alternatives.filter((check) => check(value)).length === 1,
    );
  }
  if (schema.not) {
    const check = compileRetentionShape(schema.not);
    checks.push((value) => !check(value));
  }
  if (schema.if) {
    const condition = compileRetentionShape(schema.if);
    const yes = schema.then ? compileRetentionShape(schema.then) : () => true;
    const no = schema.else ? compileRetentionShape(schema.else) : () => true;
    checks.push((value) => (condition(value) ? yes(value) : no(value)));
  }
  return (value) => checks.every((check) => check(value));
}
