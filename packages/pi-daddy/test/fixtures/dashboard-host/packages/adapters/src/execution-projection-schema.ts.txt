import { Compile } from "typebox/compile";
const text = { type: "string", minLength: 1, maxLength: 512 };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const list = (items: object) => ({ type: "array", items, maxItems: 4096, uniqueItems: true });
const closed = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
/** Read-model contract only. It cannot carry an acceptance or activation grant. */
export const EXECUTION_ARCHIVE_PROJECTION_SCHEMA = freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/mojomanyana/skill-harness/contracts/execution-archive/v1/projection.schema.json",
  ...closed({ version: { const: "execution-archive-projection-v1" },
    executions: { type: "array", maxItems: 4096, items: closed({
      executionId: text, parentExecutionIds: list(nullable(text)), retainedSessionIds: list(text), activeBranch: { const: null },
      toolCallIds: list(nullable(text)), archiveIds: list(text), runtime: { enum: ["running", "terminal", "conflict"] },
      outcome: nullable(closed({ code: nullable({ type: "integer", minimum: -2147483648, maximum: 2147483647 }),
        signal: nullable(text), timedOut: { type: "boolean" }, aborted: { type: "boolean" }, truncated: { type: "boolean" }, failed: { type: "boolean" } })),
      sourceReferences: list(hash), issues: list(text), coverage: { const: "partial" }, acceptance: { const: "not-assessed" },
    }) }, acceptance: { const: "not-assessed" },
  }),
});
const compiled = Compile(EXECUTION_ARCHIVE_PROJECTION_SCHEMA);
export function assertExecutionProjection(value: unknown): void {
  if (!compiled.Check(value) || Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error("invalid or oversized execution archive projection");
}
