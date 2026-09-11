import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Compile } from "typebox/compile";
import { cleanupTempDirs, tempDir } from "./tmp.ts";
import { verifyLedger } from "../src/ledger.ts";
import { parseDashboardLedger } from "../src/dashboard-projection.ts";
import { inspectWorkLedger } from "../src/work-ledger.ts";
import { layoutFixture, layoutAuthority, fixtureText } from "./work-ledger-fixtures.ts";
after(cleanupTempDirs);
import {
  buildWorkRevisionEvent, buildWorkSnapshotEvent, buildWorkOccurrenceEvent,
  buildWorkAcceptanceEvent, parseWorkLedgerText, WorkInputError,
} from "../src/work-ledger.ts";
import { canonicalWorkJson, parseWorkJson } from "../src/work-ledger-json.ts";
import type { RevisionRef, WorkRevision, WorkInputCode } from "../src/work-ledger-types.ts";

// Foundation tests below are pure. Published-contract checks at the end use explicit fresh targets
// and bounded Node-only children; no package manager, model, source generation default or worktree.
const now = new Date("2026-09-06T12:00:00.000Z");
const digest = "a".repeat(64);
const ref = (kind: RevisionRef["kind"], id: string = kind): RevisionRef => ({ kind, id, revision: 1, digest });
const revision = (): Omit<WorkRevision, "digest"> => ({
  kind: "scope", id: "scope", revision: 1, scopeId: "scope", predecessor: null,
  contentDigest: digest, parent: null, dependencies: [], ownerId: "owner",
  permittedEffects: ["write", "read"], policy: null,
});
const rev = () => buildWorkRevisionEvent({ eventId: "revision", now, revision: revision() });
const snapshot = () => ({ snapshotId: "snapshot", scope: ref("scope"), revisions: [ref("policy"), ref("goal")], bindings: [] });
const occurrence = () => ({
  scope: ref("scope"), obligation: ref("obligation"),
  executionId: "exec:00000000-0000-4000-8000-000000000001", parentExecutionId: null,
  childId: null, variantId: null, artifact: null, provenance: "observed" as const, state: "completed" as const,
  labels: { sessionId: null, branchLeafId: null, toolCallId: null, taskId: null, workspaceId: null,
    definitionDigest: null, configurationDigest: null, modelId: null, effortId: null },
});
const acceptance = () => ({ authorityId: "authority", binding: {
  snapshot: { id: "snapshot", digest }, scope: ref("scope"), intent: ref("goal"),
  obligation: ref("obligation"), artifact: ref("artifact"), artifactDigest: digest, policy: ref("policy"),
  evidence: [{ id: "evidence", digest, event: null }],
} });
const inputError = (code: WorkInputCode) => (error: unknown) => {
  assert.ok(error instanceof WorkInputError);
  assert.ok(error instanceof TypeError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  return true;
};
const parseError = (text: string, code: WorkInputCode) => {
  const result = parseWorkLedgerText(text);
  assert.deepEqual(result, { events: [], errors: [{ line: 1, code }], complete: false });
};

// Expected canonical strings are literal independent declarations, NOT emitter output.
test("work-v4 canonical identity matches independently fixed vectors", () => {
  const vectors: Array<[unknown, string]> = [
    [{ b: 2, a: 1 }, '{"a":1,"b":2}'],
    [{ "2": 2, "10": 10, nested: { z: [null, true, false, 9007199254740991, -9007199254740991], a: -0 } },
      '{"10":10,"2":2,"nested":{"a":0,"z":[null,true,false,9007199254740991,-9007199254740991]}}'],
    [{ "\ue000": "last", "😀": "middle", "a": "\b\n\t\r\f\\\"" },
      '{"a":"\\b\\n\\t\\r\\f\\\\\\\"","😀":"middle","\ue000":"last"}'],
  ];
  for (const [value, expected] of vectors) assert.equal(canonicalWorkJson(value), expected);
  assert.equal(createHash("sha256").update(canonicalWorkJson({ b: 2, a: 1 })).digest("hex"),
    "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  assert.equal(createHash("sha256").update(canonicalWorkJson(vectors[1][0])).digest("hex"),
    "7387728ea907b36d7f9f0eb1125ad32afa3fa8f5e9b9e8edda4f8905d2a85202");
  assert.notEqual(canonicalWorkJson([1, 2]), canonicalWorkJson([2, 1]));
  for (const token of ["1", "1.0", "10e-1", "0.01e2", "90071992547409910e-1"]) {
    assert.equal(parseWorkJson(token), token.startsWith("9007") ? Number.MAX_SAFE_INTEGER : 1);
  }
  for (const token of ["1.00000000000000001", "9007199254740992", "9007199254740991.1", "1e-999999", "1e999999", "0.5"]) {
    assert.throws(() => parseWorkJson(token), inputError("WORK_SCHEMA_INVALID"));
  }
  assert.equal(canonicalWorkJson(parseWorkJson("-0e999999")), "0");
});

test("work-v4 syntax then decoded duplicates then numeric profile determine diagnostics", () => {
  parseError('{"n":1.1,"later":}', "WORK_JSON_INVALID");
  parseError('{"x":1,"x":2,}', "WORK_JSON_INVALID");
  parseError('{"n":1.1,"x":1,"x":2}', "WORK_DUPLICATE_MEMBER");
  parseError('{"n":1.1,"ledgerVersion":3}', "WORK_SCHEMA_INVALID");
});

test("work-v4 strict text detects decoded duplicates before materialization and version checks", () => {
  for (const text of [
    '{"eventId":1,"\\u0065ventId":2}', '{"x":{"a":1,"\\u0061":2}}',
    '{"x":[{"a":1,"a":2}]}', '{"__proto__":null,"__proto__":{}}',
    '{"ledgerVersion":3,"payload":{"x":1,"x":2}}',
  ]) parseError(text, "WORK_DUPLICATE_MEMBER");
  for (const text of ['{"a":1,}', '[1,]', '{"a":"\\x20"}', '"unterminated', '01', '{} true', '{"a":NaN}']) {
    parseError(text, "WORK_JSON_INVALID");
  }
  for (const text of ['"\\ud800"', '"\\udfff"', '"\ud800"', '{"ledgerVersion":3,"n":1.0000000000000001}']) {
    parseError(text, "WORK_SCHEMA_INVALID");
  }
  assert.equal(parseWorkJson('"\\ud83d\\ude00"'), "😀");
  const proto = parseWorkJson('{"__proto__":{"polluted":true}}') as object;
  assert.equal(Object.hasOwn(proto, "__proto__"), true);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  parseError(JSON.stringify({ ...rev(), __proto__: null, extra: true }), "WORK_SCHEMA_INVALID");
  parseError('{"ledgerVersion":3}', "WORK_VERSION_UNSUPPORTED");
});

test("real work-v4 builders hash every own field and preserve nested digest identity", () => {
  const events = [rev(), buildWorkSnapshotEvent({ eventId: "snapshot", now, snapshot: snapshot() }),
    buildWorkOccurrenceEvent({ eventId: "occurrence", now, payload: occurrence() }),
    buildWorkAcceptanceEvent({ eventId: "acceptance", now, payload: acceptance() })];
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["digest", "event", "eventId", "ledgerVersion", "payload", "ts"]);
    const compact = JSON.stringify(event);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(event).reverse()), null, 0);
    const rawPretty = JSON.stringify(event, null, 2);
    assert.notEqual(createHash("sha256").update(rawPretty).digest("hex"), createHash("sha256").update(compact).digest("hex"));
    assert.deepEqual(parseWorkLedgerText(` \t${reordered}\t `), { events: [event], errors: [], complete: true });
    parseError(JSON.stringify({ ...event, ts: "2026-09-06T12:00:00.001Z" }), "WORK_DIGEST_MISMATCH");
    parseError(JSON.stringify({ ...event, eventId: "other" }), "WORK_DIGEST_MISMATCH");
    parseError(JSON.stringify({ ...event, digest: "b".repeat(64) }), "WORK_DIGEST_MISMATCH");
    const { digest: own, ...body } = event;
    assert.equal(own, createHash("sha256").update(canonicalWorkJson(body)).digest("hex"));
    assert.equal(Object.isFrozen(event.payload), true);
  }
  const first = rev();
  // SHA-256 over separately declared canonical bodies, not generated by these builders/emitter.
  assert.equal(first.payload.revision.digest, "191d991431d5dcbd940304f916579e57540e0d555e263f6d22a0e8aa4e416233");
  assert.equal(first.digest, "166a77a5c489dd37a350c6f0faa1058ea8ca4e764f35d8d21a19a083c6291c0a");
  const escaped = JSON.stringify(first).replace('"eventId":"revision"', String.raw`"eventId":"\u0072evision"`)
    .replace('"revision":1', '"revision":10e-1');
  assert.deepEqual(parseWorkLedgerText(escaped), { events: [first], errors: [], complete: true });
  assert.notEqual(first.digest, buildWorkRevisionEvent({ eventId: "revision", now: new Date(now.getTime() + 1), revision: revision() }).digest);
  assert.deepEqual(first.payload.revision.permittedEffects, ["read", "write"]);
  for (const [field, value] of Object.entries({ id: "other", scopeId: "other", contentDigest: "b".repeat(64), ownerId: "other", permittedEffects: [] })) {
    const changed = { ...first.payload.revision, [field]: value };
    // Rehash outer event independently: a stale INNER digest must still be refused.
    const body = { ...first, payload: { revision: changed } };
    const { digest: _, ...outer } = body;
    parseError(JSON.stringify({ ...outer, digest: createHash("sha256").update(canonicalWorkJson(outer)).digest("hex") }),
      field === "id" || field === "scopeId" ? "WORK_SCHEMA_INVALID" : "WORK_DIGEST_MISMATCH");
  }
  const snap = events[1];
  const altered = structuredClone(snap) as any;
  altered.payload.snapshot.snapshotId = "other";
  const { digest: _, ...body } = altered;
  altered.digest = createHash("sha256").update(canonicalWorkJson(body)).digest("hex");
  parseError(JSON.stringify(altered), "WORK_DIGEST_MISMATCH");
});

test("work-v4 builders reject unsupported objects without invoking getters or coercions", () => {
  let invoked = 0;
  const cycle: any = {}; cycle.self = cycle;
  const unsupported = [undefined, NaN, Infinity, 1n, () => 1, Symbol("x"), new Date(), new Map(), cycle,
    Object.defineProperty({}, "x", { enumerable: true, get() { invoked++; return 1; } }),
    Object.assign({}, { [Symbol("x")]: 1 }), new Array(1), Object.assign([], { extra: 1 })];
  for (const value of unsupported) {
    assert.throws(() => buildWorkRevisionEvent({ eventId: "revision", now, revision: { ...revision(), extra: value } } as any),
      inputError("WORK_SCHEMA_INVALID"));
  }
  const args = Object.defineProperty({ eventId: "revision", revision: revision() }, "now", { get() { invoked++; return now; } });
  assert.throws(() => buildWorkRevisionEvent(args as any), inputError("WORK_SCHEMA_INVALID"));
  assert.equal(invoked, 0);
  for (const invalidDate of [new Date(NaN), Object.create(Date.prototype)]) {
    assert.throws(() => buildWorkRevisionEvent({ eventId: "revision", now: invalidDate, revision: revision() }), inputError("WORK_SCHEMA_INVALID"));
  }
  assert.throws(() => buildWorkRevisionEvent({ eventId: "revision", now, revision: { ...revision(), digest } } as any), inputError("WORK_SCHEMA_INVALID"));
  assert.throws(() => buildWorkSnapshotEvent({ eventId: "snapshot", now, snapshot: { ...snapshot(), digest } } as any), inputError("WORK_SCHEMA_INVALID"));
  const input = revision(); const event = buildWorkRevisionEvent({ eventId: "revision", now, revision: input });
  input.permittedEffects.push("other");
  assert.deepEqual(event.payload.revision.permittedEffects, ["read", "write"]);
  assert.throws(() => (event.payload.revision.permittedEffects as string[]).push("other"), TypeError);
});

test("work-v4 closed shapes, ID domains, timestamp calendar and canonical sets fail closed", () => {
  const good = rev();
  for (const field of Object.keys(good)) {
    const bad = structuredClone(good) as any; delete bad[field];
    parseError(JSON.stringify(bad), field === "ledgerVersion" ? "WORK_VERSION_UNSUPPORTED" : "WORK_SCHEMA_INVALID");
  }
  for (const id of ["", " space", "a b", "é", "a".repeat(129)]) {
    assert.throws(() => buildWorkRevisionEvent({ eventId: id, now, revision: revision() }), inputError("WORK_SCHEMA_INVALID"));
  }
  for (const ts of ["0000-01-01T00:00:00.000Z", "2026-02-29T00:00:00.000Z", "1900-02-29T00:00:00.000Z",
    "2026-09-06T12:00:60.000Z", "2026-09-06T12:00:00Z", "2026-09-06t12:00:00.000z", "2026-09-06T24:00:00.000Z"]) {
    parseError(JSON.stringify({ ...good, ts }), "WORK_SCHEMA_INVALID");
  }
  for (const ts of ["0001-01-01T00:00:00.000Z", "2000-02-29T00:00:00.000Z", "9999-12-31T23:59:59.999Z"]) {
    assert.equal(buildWorkRevisionEvent({ eventId: "revision", now: new Date(ts), revision: revision() }).ts, ts);
  }
  assert.throws(() => buildWorkRevisionEvent({ eventId: "revision", now, revision: { ...revision(), permittedEffects: ["x", "x"] } }), inputError("WORK_SCHEMA_INVALID"));
  const unsorted = structuredClone(good) as any;
  unsorted.payload.revision.permittedEffects.reverse();
  parseError(JSON.stringify(unsorted), "WORK_SCHEMA_INVALID");
  assert.throws(() => buildWorkSnapshotEvent({ eventId: "snapshot", now, snapshot: { ...snapshot(), revisions: [ref("goal"), ref("goal")] } }), inputError("WORK_SCHEMA_INVALID"));
  assert.throws(() => buildWorkAcceptanceEvent({ eventId: "acceptance", now, payload: { ...acceptance(), binding: { ...acceptance().binding, evidence: [] } } }), inputError("WORK_SCHEMA_INVALID"));
  assert.throws(() => buildWorkOccurrenceEvent({ eventId: "occurrence", now, payload: { ...occurrence(), parentExecutionId: occurrence().executionId } }), inputError("WORK_SCHEMA_INVALID"));
});

test("work-v4 validates every required field and closes every nested object", () => {
  const events = [rev(), buildWorkSnapshotEvent({ eventId: "snapshot", now, snapshot: snapshot() }),
    buildWorkOccurrenceEvent({ eventId: "occurrence", now, payload: occurrence() }),
    buildWorkAcceptanceEvent({ eventId: "acceptance", now, payload: acceptance() })];
  for (const event of events) {
    const paths: string[][] = [];
    function visit(value: unknown, path: string[]) {
      if (value === null || typeof value !== "object") return;
      if (!Array.isArray(value)) paths.push(path);
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
    visit(event, []);
    for (const path of paths) {
      const original: any = path.reduce((value: any, key) => value[key], event);
      for (const key of Object.keys(original)) {
        const changed: any = structuredClone(event);
        const object = path.reduce((value: any, key) => value[key], changed);
        delete object[key];
        parseError(JSON.stringify(changed), path.length === 0 && key === "ledgerVersion" ? "WORK_VERSION_UNSUPPORTED" : "WORK_SCHEMA_INVALID");
      }
      for (const key of ["extra", "__proto__", "approved_by", "receipt"]) {
        const changed: any = structuredClone(event);
        const object = path.reduce((value: any, key) => value[key], changed);
        Object.defineProperty(object, key, { value: "forbidden", enumerable: true });
        parseError(JSON.stringify(changed), "WORK_SCHEMA_INVALID");
      }
    }
  }
});

test("work-v4 non-scope revisions, populated references and builder limits use the same strict foundation", () => {
  for (const kind of ["goal", "node", "obligation", "artifact", "policy"] as const) {
    const record: Omit<WorkRevision, "digest"> = { ...revision(), kind, id: kind, permittedEffects: [],
      parent: kind === "goal" ? ref("scope") : kind === "node" || kind === "obligation" ? ref("goal") : null,
      policy: kind === "obligation" ? ref("policy") : null,
      dependencies: kind === "obligation" ? [ref("obligation", "z"), ref("obligation", "a")] : [],
    };
    const first = buildWorkRevisionEvent({ eventId: kind, now, revision: record });
    const successor = buildWorkRevisionEvent({ eventId: `${kind}:2`, now, revision: {
      ...record, revision: 2, predecessor: { kind, id: kind, revision: 1, digest: first.payload.revision.digest },
    } });
    assert.equal(parseWorkLedgerText(JSON.stringify(successor)).complete, true);
    assert.notEqual(first.payload.revision.digest, successor.payload.revision.digest);
    assert.throws(() => buildWorkRevisionEvent({ eventId: kind, now, revision: {
      ...record, revision: 2, predecessor: { ...ref(kind), revision: 2 },
    } }), inputError("WORK_SCHEMA_INVALID"));
  }
  const binding = { intent: ref("goal"), obligation: ref("obligation"), artifact: ref("artifact"), policy: ref("policy") };
  const event = buildWorkSnapshotEvent({ eventId: "snapshot", now, snapshot: {
    ...snapshot(), bindings: [binding], revisions: [ref("policy"), ref("goal"), ref("obligation"), ref("artifact")],
  } });
  assert.equal(parseWorkLedgerText(JSON.stringify(event)).complete, true);
  const claimed = acceptance();
  const evidence = { id: "z", digest, event: { eventId: "observation", digest } };
  claimed.binding.evidence = [evidence, ...claimed.binding.evidence] as any;
  const claim = buildWorkAcceptanceEvent({ eventId: "acceptance", now, payload: claimed });
  assert.deepEqual(claim.payload.binding.evidence.map(e => e.id), ["evidence", "z"]);
  assert.equal(parseWorkLedgerText(JSON.stringify(claim)).complete, true);
  const unsorted = structuredClone(claim) as any;
  unsorted.payload.binding.evidence.reverse();
  parseError(JSON.stringify(unsorted), "WORK_SCHEMA_INVALID");
  assert.throws(() => buildWorkRevisionEvent({ eventId: "revision", now, revision: {
    ...revision(), permittedEffects: Array.from({ length: 257 }, (_, i) => `effect:${i}`),
  } }), inputError("WORK_LIMIT_EXCEEDED"));
  const large = acceptance();
  large.binding.evidence = Array.from({ length: 256 }, (_, i) => ({
    id: `e${i}`.padEnd(128, "x"), digest,
    event: { eventId: `event${i}`.padEnd(128, "x"), digest },
  })) as any;
  assert.throws(() => buildWorkAcceptanceEvent({ eventId: "acceptance", now, payload: large }), inputError("WORK_LIMIT_EXCEEDED"));
});

test("work-v4 ingestion bounds and diagnostics preserve valid physical deliveries without repair", () => {
  const line = JSON.stringify(rev());
  assert.deepEqual(parseWorkLedgerText(" \t\r\n"), { events: [], errors: [], complete: true });
  const result = parseWorkLedgerText(`\n${line}\n{broken\n${line}\n{"ledgerVersion":3}\n`);
  assert.deepEqual(result, { events: [rev(), rev()], errors: [
    { line: 3, code: "WORK_JSON_INVALID" }, { line: 5, code: "WORK_VERSION_UNSUPPORTED" },
  ], complete: false });
  assert.ok(Object.isFrozen(result.events[0].payload));
  assert.ok(Object.isFrozen(result.errors[0]));
  for (const value of [null, undefined, 1, {}]) assert.deepEqual(parseWorkLedgerText(value as any), {
    events: [], errors: [{ line: null, code: "WORK_SCHEMA_INVALID" }], complete: false,
  });
  assert.equal(parseWorkLedgerText((line + "\n").repeat(10_000)).events.length, 10_000);
  assert.deepEqual(parseWorkLedgerText((line + "\n").repeat(10_001)), {
    events: [], errors: [{ line: null, code: "WORK_LIMIT_EXCEEDED" }], complete: false,
  });
  assert.equal(parseWorkLedgerText(" ".repeat(16 * 1024 * 1024)).complete, true);
  assert.deepEqual(parseWorkLedgerText(" ".repeat(16 * 1024 * 1024 + 1)), {
    events: [], errors: [{ line: null, code: "WORK_LIMIT_EXCEEDED" }], complete: false,
  });
  assert.equal(parseWorkLedgerText(line + " ".repeat(65536 - Buffer.byteLength(line))).complete, true);
  parseError(line + " ".repeat(65537 - Buffer.byteLength(line)), "WORK_LIMIT_EXCEEDED");
  assert.equal((parseWorkJson("[" + "0,".repeat(255) + "0]") as unknown[]).length, 256);
  assert.throws(() => parseWorkJson("[" + "0,".repeat(256) + "0]"), inputError("WORK_LIMIT_EXCEEDED"));
  assert.doesNotThrow(() => parseWorkJson("[".repeat(16) + "0" + "]".repeat(16)));
  assert.throws(() => parseWorkJson("[".repeat(17) + "0" + "]".repeat(17)), inputError("WORK_LIMIT_EXCEEDED"));
});

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../..");
const contractRoot = join(packageRoot, "contracts/ledger/v4");
const generatorUrl = new URL("../scripts/generate-ledger-v4-contract.ts", import.meta.url);
const loadGenerator = async () => await import(generatorUrl.href) as typeof import("../scripts/generate-ledger-v4-contract.ts");
const fixtureNames = ["work-acceptance.json", "work-occurrence.json", "work-revision.json", "work-snapshot.json"];
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
async function collateral(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const version of ["v2", "v3", "v4"]) {
    const root = join(packageRoot, "contracts/ledger", version);
    if (!existsSync(root)) continue;
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      files[path] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  const path = join(packageRoot, "scripts/generate-ledger-v3-contract.ts");
  files[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  return files;
}
function expectedPublishedFixtures() {
  const scope = rev(), scopeRef = { ...ref("scope"), digest: scope.payload.revision.digest };
  const binding = { intent: ref("goal"), obligation: ref("obligation"), artifact: ref("artifact"), policy: ref("policy") };
  const selected = buildWorkSnapshotEvent({ eventId: "snapshot", now, snapshot: { ...snapshot(), scope: scopeRef,
    revisions: [ref("goal"), ref("obligation"), ref("artifact"), ref("policy")], bindings: [binding] } });
  const observed = buildWorkOccurrenceEvent({ eventId: "occurrence", now,
    payload: { ...occurrence(), scope: scopeRef, artifact: ref("artifact") } });
  const claim = buildWorkAcceptanceEvent({ eventId: "acceptance", now, payload: { authorityId: "authority", binding: {
    ...acceptance().binding, scope: scopeRef, snapshot: { id: "snapshot", digest: selected.payload.snapshot.digest },
    evidence: [{ id: "evidence", digest, event: { eventId: observed.eventId, digest: observed.digest } }],
  } } });
  return { "work-revision.json": scope, "work-snapshot.json": selected, "work-occurrence.json": observed, "work-acceptance.json": claim };
}

// The complete scalar, including any final line break, must satisfy the runtime domain.
test("work-v4 scalar domains reject terminal line breaks before hashing", () => {
  for (const ending of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    assert.throws(() => buildWorkRevisionEvent({ eventId: "valid" + ending, now, revision: revision() }), inputError("WORK_SCHEMA_INVALID"));
    assert.throws(() => buildWorkRevisionEvent({ eventId: "revision", now,
      revision: { ...revision(), contentDigest: digest + ending } }), inputError("WORK_SCHEMA_INVALID"));
    assert.throws(() => buildWorkOccurrenceEvent({ eventId: "occurrence", now,
      payload: { ...occurrence(), executionId: occurrence().executionId + ending } }), inputError("WORK_SCHEMA_INVALID"));
  }
});

test("published work-v4 fixtures come from real builders and the closed schema", async () => {
  const generator = await loadGenerator();
  const fixtures = generator.buildLedgerV4ContractFixtures();
  assert.deepEqual(fixtures, expectedPublishedFixtures());
  assert.deepEqual(Object.keys(fixtures).sort(), fixtureNames);
  const schema = await json(join(contractRoot, "ledger-event.schema.json")), validator = Compile(schema);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.oneOf.map((s: any) => s.$ref).sort(),
    ["workRevisionEvent", "workSnapshotEvent", "workOccurrenceEvent", "workAcceptanceEvent"].map(s => "#/$defs/" + s).sort());
  assert.deepEqual(schema.$defs.revisionKind.enum, ["scope", "goal", "node", "obligation", "artifact", "policy"]);
  assert.deepEqual(schema.$defs.occurrenceProvenance.enum, ["declared", "observed"]);
  assert.deepEqual(schema.$defs.occurrenceState.enum, ["unknown", "starting", "running", "completed", "failed"]);
  const dir = await tempDir("work-contract-generation-"), before = await collateral();
  await generator.generateLedgerV4Contract(dir);
  assert.deepEqual(await collateral(), before);
  assert.deepEqual(await readFile(join(dir, "ledger-event.schema.json")), await readFile(join(contractRoot, "ledger-event.schema.json")));
  for (const [name, event] of Object.entries(fixtures)) {
    const bytes = JSON.stringify(event, null, 2) + "\n";
    assert.equal(await readFile(join(contractRoot, "fixtures", name), "utf8"), bytes);
    assert.equal(await readFile(join(dir, "fixtures", name), "utf8"), bytes);
    assert.equal(validator.Check(event), true, name);
    assert.equal(parseWorkLedgerText(JSON.stringify(event)).complete, true);
    assert.ok(Object.isFrozen(event));
    const visit = (value: any, path: string[]) => {
      if (!value || typeof value !== "object") return;
      if (!Array.isArray(value)) {
        for (const key of [...Object.keys(value), "extra", "__proto__", "approved_by", "receipt"]) {
          const altered: any = structuredClone(event), target = path.reduce((o, k) => o[k], altered);
          if (Object.hasOwn(value, key)) delete target[key];
          else Object.defineProperty(target, key, { value: "forbidden", enumerable: true });
          assert.equal(validator.Check(altered), false, `${name} ${path.join(".")} ${key}`);
          assert.equal(parseWorkLedgerText(JSON.stringify(altered)).errors[0]?.code,
            !path.length && key === "ledgerVersion" ? "WORK_VERSION_UNSUPPORTED" : "WORK_SCHEMA_INVALID");
        }
      }
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    };
    visit(event, []);
    for (const discriminator of ["capability_decision", "unknown", null, 4]) assert.equal(validator.Check({ ...(event as object), event: discriminator }), false);
  }
  const manifest = await json(join(packageRoot, "package.json"));
  for (const target of ["ledger-event.schema.json", "fixtures/*.json"]) {
    assert.equal(manifest.exports[`./contracts/ledger/v4/${target}`], `./contracts/ledger/v4/${target}`);
  }
  assert.equal(manifest.scripts["contracts:generate:v4"], "node scripts/generate-ledger-v4-contract.ts contracts/ledger/v4");
  assert.equal(manifest.scripts["contracts:generate"], "node scripts/generate-ledger-v3-contract.ts");
  assert.equal(manifest.version, "0.24.0"); // Manifest target checks are NOT compiled-export validation.
  const adrPath = join(repositoryRoot, "docs/06-decisions/ADR-0044-opt-in-work-v4-evidence.md");
  const adr = await readFile(adrPath, "utf8"), spec = await readFile(join(repositoryRoot, "docs/SPEC.md"), "utf8");
  assert.match(adr, /^\*\*Date:\*\* 2026-09-06$/m); assert.match(adr, /^\*\*Status:\*\* Accepted$/m);
  for (const heading of ["Context", "Options considered", "Decision", "Consequences", "Revisit trigger"]) assert.ok(adr.includes(`## ${heading}\n`));
  assert.ok((adr.match(/^### Option /gm) ?? []).length >= 2);
  assert.ok(adr.includes("2026-09-05")); assert.ok(adr.includes("368025d938c667b30e62b6ca58a7e09e22646cae2fc3024103faf180c4c02787"));
  for (const phrase of ["fixture trust-boundary simulation", "trusted computing base", "non-expiring"]) assert.ok(adr.includes(phrase));
  assert.ok(spec.includes("## Opt-in work-v4 evidence (candidate)"));
  assert.ok(spec.includes("ADR-0044-opt-in-work-v4-evidence.md"));
  for (const [path, text] of [[adrPath, adr], [join(contractRoot, "README.md"), await readFile(join(contractRoot, "README.md"), "utf8")]]) {
    const links = [...text.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(m => m[1]);
    assert.ok(links.length >= 2);
    for (const link of links.filter(link => !/^https?:/.test(link))) assert.ok(existsSync(resolve(dirname(path), link)), `${path}: ${link}`);
  }
  // Structure/reference assertions above do not substitute for independent semantic ADR review.
});

test("work-v4 schema domains agree with runtime without pretending to validate semantic evidence", async () => {
  const schema = await json(join(contractRoot, "ledger-event.schema.json")), validator = Compile(schema);
  const fixtures = expectedPublishedFixtures();
  const checkSchema = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (node.additionalProperties === false) assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    if (node.type === "array") {
      assert.ok(Number.isInteger(node.maxItems) && node.maxItems <= 256);
      if (node.items) assert.equal(node.uniqueItems, true);
    }
    for (const child of Object.values(node)) checkSchema(child);
  };
  checkSchema(schema);
  const bothInvalid = (event: any, path: string[], value: unknown) => {
    const bad: any = structuredClone(event), parent = path.slice(0, -1).reduce((o, k) => o[k], bad);
    parent[path.at(-1)!] = value;
    assert.equal(validator.Check(bad), false, path.join("."));
    assert.equal(parseWorkLedgerText(JSON.stringify(bad)).errors[0]?.code, "WORK_SCHEMA_INVALID", path.join("."));
  };
  for (const id of ["", " space", "space ", "bad id", "é", "a".repeat(129), "valid\n", "valid\r", "valid\u2028"]) {
    bothInvalid(fixtures["work-revision.json"], ["eventId"], id);
  }
  for (const bad of ["a".repeat(63), "a".repeat(65), "A".repeat(64), digest + "\n"]) {
    bothInvalid(fixtures["work-revision.json"], ["payload", "revision", "contentDigest"], bad);
  }
  for (const bad of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) bothInvalid(fixtures["work-revision.json"], ["payload", "revision", "revision"], bad);
  for (const ts of ["0000-01-01T00:00:00.000Z", "2026-13-01T00:00:00.000Z", "2026-01-32T00:00:00.000Z",
    "2026-01-01T24:00:00.000Z", "2026-01-01T00:00:60.000Z", "2026-01-01T00:00:00Z"]) bothInvalid(fixtures["work-revision.json"], ["ts"], ts);
  for (const field of ["executionId", "parentExecutionId"]) for (const bad of ["exec:bad", occurrence().executionId + "\n"]) {
    bothInvalid(fixtures["work-occurrence.json"], ["payload", field], bad);
  }
  for (const provenance of ["declared", "observed"] as const) for (const state of ["unknown", "starting", "running", "completed", "failed"] as const) {
    const e = buildWorkOccurrenceEvent({ eventId: "states", now, payload: { ...occurrence(), provenance, state } });
    assert.equal(validator.Check(e), true); assert.equal(parseWorkLedgerText(JSON.stringify(e)).complete, true);
  }
  for (const field of ["provenance", "state"]) bothInvalid(fixtures["work-occurrence.json"], ["payload", field], "approved");
  for (const field of Object.keys(occurrence().labels)) {
    bothInvalid(fixtures["work-occurrence.json"], ["payload", "labels", field], field.endsWith("Digest") ? "not-a-digest" : "bad label");
  }
  for (const kind of ["scope", "goal", "node", "obligation", "artifact", "policy"] as const) {
    const body: Omit<WorkRevision, "digest"> = { ...revision(), kind, id: kind, permittedEffects: [],
      parent: kind === "goal" ? ref("scope") : kind === "node" || kind === "obligation" ? ref("goal") : null,
      policy: kind === "obligation" ? ref("policy") : null, dependencies: kind === "obligation" ? [ref("obligation", "other")] : [] };
    for (const n of [1, 2]) {
      const e = buildWorkRevisionEvent({ eventId: kind, now, revision: { ...body, revision: n,
        predecessor: n === 1 ? null : { kind, id: kind, revision: 1, digest } } });
      assert.equal(validator.Check(e), true, kind); assert.equal(parseWorkLedgerText(JSON.stringify(e)).complete, true);
    }
    for (const parentKind of (kind === "goal" ? ["scope", "goal"] : kind === "node" || kind === "obligation" ? ["goal", "node"] : []) as RevisionRef["kind"][]) {
      const alternative = buildWorkRevisionEvent({ eventId: kind, now, revision: { ...body, parent: ref(parentKind) } });
      assert.equal(validator.Check(alternative), true); assert.equal(parseWorkLedgerText(JSON.stringify(alternative)).complete, true);
    }
    const e = buildWorkRevisionEvent({ eventId: kind, now, revision: body });
    bothInvalid(e, ["payload", "revision", "parent"], kind === "goal" || kind === "node" || kind === "obligation" ? null : ref("goal"));
    if (kind !== "obligation") bothInvalid(e, ["payload", "revision", "dependencies"], [ref("obligation")]);
    bothInvalid(e, ["payload", "revision", "policy"], kind === "obligation" ? null : ref("policy"));
    if (kind === "artifact" || kind === "policy") bothInvalid(e, ["payload", "revision", "permittedEffects"], ["write"]);
  }
  bothInvalid(fixtures["work-revision.json"], ["payload", "revision", "predecessor"], ref("scope"));
  bothInvalid(fixtures["work-revision.json"], ["payload", "revision", "revision"], 2);
  for (const [file, path, kind] of [
    ["work-snapshot.json", ["scope"], "goal"], ["work-snapshot.json", ["revisions", "0"], "scope"],
    ...["intent", "obligation", "artifact", "policy"].map(k => ["work-snapshot.json", ["bindings", "0", k], "scope"]),
    ...["scope", "obligation", "artifact"].map(k => ["work-occurrence.json", [k], "policy"]),
    ...["scope", "intent", "obligation", "artifact", "policy"].map(k => ["work-acceptance.json", ["binding", k], k === "intent" ? "artifact" : "node"]),
  ] as [keyof typeof fixtures, string[], string][]) {
    bothInvalid(fixtures[file], ["payload", ...(file === "work-snapshot.json" ? ["snapshot"] : []), ...path, "kind"], kind);
  }
  const maximal = buildWorkRevisionEvent({ eventId: "maximal", now, revision: { ...revision(), revision: Number.MAX_SAFE_INTEGER,
    predecessor: { ...ref("scope"), revision: Number.MAX_SAFE_INTEGER - 1 }, permittedEffects: Array.from({ length: 256 }, (_, i) => `effect:${i}`) } });
  assert.equal(validator.Check(maximal), true); assert.equal(parseWorkLedgerText(JSON.stringify(maximal)).complete, true);
  const upper = buildWorkOccurrenceEvent({ eventId: "upper", now, payload: { ...occurrence(), executionId: occurrence().executionId.toUpperCase() } });
  assert.equal(validator.Check(upper), true);
  const unselectedArtifact = buildWorkSnapshotEvent({ eventId: "null-artifact", now, snapshot: { ...snapshot(),
    bindings: [{ intent: ref("node"), obligation: ref("obligation"), artifact: null, policy: ref("policy") }] } });
  assert.equal(validator.Check(unselectedArtifact), true);
  const many = Array.from({ length: 257 }, (_, i) => "effect:" + String(i).padStart(3, "0"));
  const oversized = structuredClone(fixtures["work-revision.json"]) as any; oversized.payload.revision.permittedEffects = many;
  assert.equal(validator.Check(oversized), false); assert.equal(parseWorkLedgerText(JSON.stringify(oversized)).errors[0]?.code, "WORK_LIMIT_EXCEEDED");
  bothInvalid(fixtures["work-acceptance.json"], ["payload", "binding", "evidence"], []);
  bothInvalid(fixtures["work-revision.json"], ["payload", "revision", "permittedEffects"], ["read", "read"]);
  // Object schemas cannot recover duplicate source members, supplied digest consistency or trust.
  const forged = { ...fixtures["work-revision.json"], digest: "b".repeat(64) };
  assert.equal(validator.Check(forged), true); assert.equal(parseWorkLedgerText(JSON.stringify(forged)).errors[0]?.code, "WORK_DIGEST_MISMATCH");
  const duplicate = JSON.stringify(fixtures["work-revision.json"]).replace('"ledgerVersion":4', '"ledgerVersion":4,"ledgerVersion":4');
  assert.equal(validator.Check(JSON.parse(duplicate)), true); assert.equal(parseWorkLedgerText(duplicate).errors[0]?.code, "WORK_DUPLICATE_MEMBER");
});

test("work-v4 contract generator import is read-only and every write target is explicit", async () => {
  const dir = await tempDir("work-generator-import-"), before = await collateral();
  const code = `import fs from 'node:fs/promises'; import sync from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const refuse = () => { throw new Error('generator import attempted mutation'); };
    for (const name of ['mkdir','writeFile','appendFile','rm','rename']) fs[name]=refuse;
    for (const name of ['mkdirSync','writeFileSync','appendFileSync','rmSync','renameSync']) sync[name]=refuse;
    syncBuiltinESMExports(); const g=await import(${JSON.stringify(generatorUrl.href)});
    console.log(JSON.stringify(Object.keys(g.buildLedgerV4ContractFixtures()).sort()));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { cwd: dir, encoding: "utf8", timeout: 10000, maxBuffer: 100000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); assert.equal(child.error, undefined);
  assert.deepEqual(JSON.parse(child.stdout), fixtureNames); assert.deepEqual(await readdir(dir), []);
  const generator = await loadGenerator();
  for (const bad of [undefined, null, "", "relative", dir + "\0"]) {
    await assert.rejects(generator.writeLedgerV4ContractFixtures(bad as never), TypeError);
    await assert.rejects(generator.generateLedgerV4Contract(bad as never), TypeError);
  }
  const missing = spawnSync(process.execPath, [fileURLToPath(generatorUrl)], { cwd: dir, encoding: "utf8", timeout: 10000, maxBuffer: 100000 });
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /explicit target/);
  assert.deepEqual(await readdir(dir), []); assert.deepEqual(await collateral(), before);
  const output = join(dir, "explicit");
  const generated = spawnSync(process.execPath, [fileURLToPath(generatorUrl), output], { cwd: dir, encoding: "utf8", timeout: 10000, maxBuffer: 100000 });
  assert.equal(generated.status, 0, generated.stderr); assert.equal(generated.signal, null);
  assert.deepEqual((await readdir(join(output, "fixtures"))).sort(), ["layout-options.json", ...fixtureNames]);
  assert.deepEqual(await collateral(), before);
});

test("layout options fixtures are reproducible without Principal vocabulary", async () => {
  const generator = await loadGenerator();
  assert.equal(typeof generator.buildLayoutOptionsFixture, "function", "pure complete layout wire fixture export is required");
  const layout = generator.buildLayoutOptionsFixture(), expected = layoutFixture().events;
  assert.deepEqual(layout, expected, "separate fixed declarations through the real production builders");
  assert.ok(Array.isArray(layout)); assert.ok(Object.isFrozen(layout)); assert.equal(layout.length, 11);
  const validator = Compile(await json(join(contractRoot, "ledger-event.schema.json")));
  assert.equal(validator.Check(layout), false, "an array is NOT an event");
  for (const event of layout) {
    assert.equal(validator.Check(event), true); assert.ok(Object.isFrozen(event));
    assert.deepEqual(Object.keys(event).sort(), ["digest", "event", "eventId", "ledgerVersion", "payload", "ts"]);
  }
  const bytes = JSON.stringify(layout, null, 2) + "\n", before = await collateral();
  assert.doesNotMatch(bytes, /principal|approved_by|receiptId|authoritySnapshot|assurance|review-specification/i);
  assert.equal(parseWorkLedgerText(JSON.stringify(layout)).complete, false, "convert the array explicitly to JSONL");
  assert.equal(parseWorkLedgerText(fixtureText(layout)).complete, true);
  const published = await readFile(join(contractRoot, "fixtures/layout-options.json"), "utf8"); assert.equal(published, bytes);
  const exported = import.meta.resolve("pi-daddy/contracts/ledger/v4/fixtures/layout-options.json");
  assert.equal(fileURLToPath(exported), join(contractRoot, "fixtures/layout-options.json"));
  assert.deepEqual((await import(exported, { with: { type: "json" } })).default, layout); // Real JSON export, not installed smoke.
  for (let i = 0; i < 2; i++) {
    const dir = await tempDir("layout-contract-reproduction-"); await generator.generateLedgerV4Contract(dir);
    assert.equal(await readFile(join(dir, "fixtures/layout-options.json"), "utf8"), bytes);
    for (const name of fixtureNames) {
      assert.equal(Array.isArray(await json(join(dir, "fixtures", name))), false);
      assert.deepEqual(await readFile(join(dir, "fixtures", name)), await readFile(join(contractRoot, "fixtures", name)));
    }
    assert.deepEqual((await readdir(join(dir, "fixtures"))).sort(), ["layout-options.json", ...fixtureNames]);
    assert.deepEqual(await readFile(join(dir, "ledger-event.schema.json")), await readFile(join(contractRoot, "ledger-event.schema.json")));
  }
  assert.deepEqual(await collateral(), before);
  const ctx = layoutAuthority(), { projectWorkLedger } = await import("../src/work-ledger.ts");
  const positive = projectWorkLedger(fixtureText(layout), ctx);
  assert.deepEqual(positive.progress, { accepted: 1, total: 1 });
  assert.deepEqual(positive.runtime!.counts, { attempts: 2, variants: 3, observedCompletedAttempts: 2 });
  assert.deepEqual(projectWorkLedger(fixtureText(layout), { selectedSnapshot: ctx.selectedSnapshot, authority: null }).progress, { accepted: 0, total: 1 });
});

test("explicit work-v4 inspection does not widen old readers", async () => {
  const events = Object.values(expectedPublishedFixtures()), text = events.map(e => JSON.stringify(e)).join("\n") + "\n";
  const dir = await tempDir("work-reader-compat-"), path = join(dir, "work"); await writeFile(path, text);
  const inspection = await inspectWorkLedger({ version: 4, path });
  assert.equal(inspection.ingestion!.complete, true); assert.equal(inspection.projection!.progress, null);
  const legacy = await verifyLedger(path), dashboard = parseDashboardLedger(text);
  assert.equal(legacy.events, 0); assert.equal(legacy.records, 0); assert.equal(legacy.corrupt.length, 4);
  assert.deepEqual(legacy.lifecycle, { starting: 0, running: 0, completed: 0, failed: 0 });
  assert.deepEqual(dashboard.nodes, []); assert.deepEqual(dashboard.workflowFacts, []);
  assert.equal(dashboard.active, 0); assert.equal(dashboard.corrupt.length, 4);
  assert.equal(await readFile(path, "utf8"), text);
});
