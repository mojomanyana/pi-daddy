import assert from "node:assert/strict";
import { Compile } from "typebox/compile";
import { RETENTION_SCHEMA } from "../src/governance/retention-contract.ts";
import { compileRetentionShape } from "../src/governance/retention-validator.ts";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  beginExecutionRetention,
  ENV_NATIVE_SESSION_ROOT,
  type ExecutionRetentionManifest,
} from "../src/governance/execution-retention.ts";
import { filterDiagnostic } from "../src/products/diagnostic-filter.ts";
import { exportDiagnostics, parseDiagnosticSelection } from "../src/products/diagnostic-export.ts";
import { main, parseArgs } from "../src/cli.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sessionBytes = () =>
  Buffer.from(
    [
      {
        type: "session",
        version: 3,
        id: "12345678-1234-1234-1234-123456789abc",
        cwd: "/private/project",
        timestamp: "2026-10-09T00:00:00Z",
      },
      {
        type: "message",
        id: "a",
        parentId: null,
        timestamp: "2026-10-09T00:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PRIVATE_REASONING", signature: "PRIVATE_SIGNATURE" },
            { type: "text", text: "Visible progress" },
            {
              type: "toolCall",
              id: "call",
              name: "bash",
              arguments: { command: "npm test", env: { VALUE: "PRIVATE_ENV" } },
            },
          ],
          reasoning_details: [{ text: "ALSO_PRIVATE" }],
          provider: "fixture",
          model: "scripted",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );

test("visible native export removes private blocks but preserves calls, text and original embedded JSON strings", () => {
  const result = filterDiagnostic(sessionBytes(), "session");
  const text = result.bytes.toString();
  assert.match(text, /Visible progress/);
  assert.match(text, /npm test/);
  assert.doesNotMatch(text, /PRIVATE_|ALSO_PRIVATE/);
  assert.equal(result.omissions["private-reasoning"], 1);
  const input = '{ "question": "literal spacing", "array": [1, 2] }';
  const projected = JSON.parse(filterDiagnostic(Buffer.from(JSON.stringify({ input })), "json").bytes.toString());
  assert.equal(projected.input, input);
  const encodedSecret = JSON.stringify({ input: JSON.stringify({ env: { KEY: "hidden" }, question: "keep" }) });
  const filtered = JSON.parse(filterDiagnostic(Buffer.from(encodedSecret), "json").bytes.toString());
  assert.deepEqual(JSON.parse(filtered.input), { question: "keep" });
  assert.deepEqual(
    JSON.parse(
      filterDiagnostic(
        Buffer.from(
          JSON.stringify({ OPENROUTER_API_KEY: "hidden", nested: { type: "reasoning", content: "private" } }),
        ),
        "json",
      ).bytes.toString(),
    ),
    { nested: null },
  );
  assert.equal(
    filterDiagnostic(Buffer.from("OPENROUTER_API_KEY=secret\nBearer abc123"), "text").bytes.toString(),
    "OPENROUTER_API_KEY=[REDACTED]\nBearer [REDACTED]",
  );
  const credential = { token: "TOKEN_SECRET", DATABASE_URL: "postgresql://user:DB_SECRET@localhost/db" };
  const clean = JSON.parse(filterDiagnostic(Buffer.from(JSON.stringify(credential)), "json").bytes.toString());
  assert.deepEqual(clean, { DATABASE_URL: "postgresql://[REDACTED]@localhost/db" });
  assert.equal(filterDiagnostic(Buffer.from(credential.DATABASE_URL), "text").bytes.toString(), clean.DATABASE_URL);
  assert.equal(
    filterDiagnostic(Buffer.from("https://example.test/path"), "text").bytes.toString(),
    "https://example.test/path",
  );
});

test("export deduplicates identical payloads, records both hashes, preserves source and refuses overwrites", async () => {
  const root = await tempDir("diagnostic-export-");
  const original = sessionBytes();
  await writeFile(join(root, "session.jsonl"), original);
  await writeFile(join(root, "copy.jsonl"), original);
  await writeFile(
    join(root, "selection.json"),
    JSON.stringify({
      version: 1,
      sources: [
        { path: "session.jsonl", format: "session" },
        { path: "copy.jsonl", format: "session" },
        { path: "session.jsonl", format: "session" },
      ],
    }),
  );
  const destination = join(root, "export");
  const result = await exportDiagnostics(join(root, "selection.json"), destination);
  const inventory = JSON.parse(await readFile(result.inventory, "utf8"));
  assert.equal(result.entries, 2);
  assert.equal(result.objects, 1);
  assert.equal(result.missing, 0);
  for (const entry of inventory.entries) {
    assert.equal(entry.sourceSha256, hash(original));
    assert.notEqual(entry.sha256, entry.sourceSha256);
    const payload = await readFile(join(destination, entry.path));
    assert.equal(hash(payload), entry.sha256);
    assert.equal(payload.length, entry.bytes);
    assert.equal((await stat(join(destination, entry.path))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.deepEqual(await readFile(join(root, "session.jsonl")), original);
  assert.equal(inventory.trainingEligible, false);
  assert.equal(inventory.acceptance, "not-assessed");
  await assert.rejects(exportDiagnostics(join(root, "selection.json"), destination), { code: "EEXIST" });
});

test("missing, changed-digest, malformed and symlink sources are recorded without including their bytes", async () => {
  const root = await tempDir("diagnostic-export-missing-");
  await writeFile(join(root, "value.txt"), "hidden source");
  await writeFile(join(root, "bad.json"), '{"same":1,"same":2}');
  await symlink(join(root, "value.txt"), join(root, "link.txt"));
  await writeFile(
    join(root, "selection.json"),
    JSON.stringify({
      version: 1,
      sources: [
        { path: "absent.txt", format: "text" },
        { path: "value.txt", format: "text", sha256: "0".repeat(64) },
        { path: "link.txt", format: "text" },
        { path: "bad.json", format: "json" },
      ],
    }),
  );
  const result = await exportDiagnostics(join(root, "selection.json"), join(root, "export"));
  assert.equal(result.missing, 4);
  assert.equal(result.objects, 0);
  assert.deepEqual(await readdir(join(root, "export", "objects")), []);
  const inventory = JSON.parse(await readFile(result.inventory, "utf8"));
  assert.deepEqual(
    inventory.entries.map((entry: { reason: string }) => entry.reason).sort(),
    [
      "ENOENT",
      "invalid-or-unreadable-source",
      "source-digest-mismatch",
      "source-must-be-canonical-regular-file",
    ].sort(),
  );
});

async function retainedFixture() {
  const root = await tempDir("diagnostic-retention-"),
    archive = join(root, "archive"),
    native = join(root, "native.jsonl");
  const retention = beginExecutionRetention(
    {
      executionId: "exec:fixture",
      parentExecutionId: null,
      childId: "child",
      toolCallId: "call",
      executor: "process",
      taskDigest: null,
      definitionDigest: null,
      configurationDigest: "a".repeat(64),
      workspaceId: null,
    },
    archive,
  );
  const previousRoot = process.env[ENV_NATIVE_SESSION_ROOT];
  process.env[ENV_NATIVE_SESSION_ROOT] = root;
  try {
    retention.observeSession({ source: "pi-session-file", value: native });
    await retention.flush();
    await writeFile(native, sessionBytes(), { mode: 0o600 });
    retention.observeSession({ source: "pi-session-file", value: native });
    await retention.flush();
  } finally {
    if (previousRoot === undefined) delete process.env[ENV_NATIVE_SESSION_ROOT];
    else process.env[ENV_NATIVE_SESSION_ROOT] = previousRoot;
  }
  retention.capture("result", Buffer.from("Complete task result"));
  retention.capture("checkReceipt", Buffer.from('{"status":"checked"}'));
  retention.capture("stdout", Buffer.alloc(1024 * 1024 + 1, 65));
  retention.finish({ code: 0, signal: null, timedOut: false, aborted: false, truncated: false, failed: false });
  const manifestPath = (await retention.flush()).manifestPath!;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ExecutionRetentionManifest;
  return { root, archive, manifestPath, manifest };
}

test("retention export uses real manifests, traverses selected aliases, omits streams and reports losses", async () => {
  const { root, archive, manifestPath, manifest } = await retainedFixture();
  const selection = join(root, "selection.json"),
    resultPath = join(dirname(manifestPath), manifest.content.result.path!);
  await writeFile(
    selection,
    JSON.stringify({
      version: 1,
      sources: [
        { path: manifestPath, format: "json" },
        { path: resultPath, format: "text" },
      ],
      retentionRoots: [archive],
    }),
  );
  const exported = await exportDiagnostics(selection, join(root, "export"));
  const inventory = JSON.parse(await readFile(exported.inventory, "utf8"));
  assert.equal(exported.missing, 2, "only unretained stderr and pane snapshot are missing");
  assert.equal(inventory.captures.length, 1, "explicitly selected manifest must still expand its retained references");
  assert.ok(inventory.captures[0].currentLosses.includes("stdout-observation-dropped"));
  assert.deepEqual(inventory.captures[0].recoveredObservations, ["native-session-read-failed-earlier"]);
  assert.ok(inventory.entries.some((entry: { reason: string }) => entry.reason === "raw-stream-or-pane"));
  assert.equal(inventory.entries.filter((entry: { source: string }) => entry.source === resultPath).length, 1);
  assert.ok(
    inventory.entries.some((entry: { source: string }) => entry.source.endsWith(manifest.content.session.path!)),
  );
  assert.equal(
    inventory.entries.find((entry: { source: string }) => entry.source === resultPath).sourceSha256,
    manifest.content.result.sha256,
  );
});

test("invalid retention schemas and incorrect declared sizes remain explicit gaps, including already selected payloads", async () => {
  const { root, archive, manifestPath, manifest } = await retainedFixture();
  const selection = join(root, "selection.json"),
    resultPath = join(dirname(manifestPath), manifest.content.result.path!);
  await writeFile(
    selection,
    JSON.stringify({ version: 1, sources: [{ path: resultPath, format: "text" }], retentionRoots: [archive] }),
  );
  manifest.content.result.bytes!++;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const mismatch = await exportDiagnostics(selection, join(root, "mismatch"));
  let inventory = JSON.parse(await readFile(mismatch.inventory, "utf8"));
  assert.equal(mismatch.missing, 3);
  assert.ok(inventory.entries.some((entry: { reason: string }) => entry.reason === "source-size-mismatch"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: "unsupported" }));
  const invalid = await exportDiagnostics(selection, join(root, "invalid"));
  inventory = JSON.parse(await readFile(invalid.inventory, "utf8"));
  assert.equal(invalid.missing, 1);
  assert.ok(inventory.entries.some((entry: { reason: string }) => entry.reason === "invalid-retention-manifest"));
  await writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, content: { ...manifest.content, unboundedUnknownKind: { status: "missing" } } }),
  );
  const unknown = await exportDiagnostics(selection, join(root, "unknown-kind"));
  assert.equal(
    unknown.missing,
    1,
    "existing closed retention contract rejects unknown kinds instead of expanding arbitrary metadata",
  );
});

test("CLI exposes explicit export selection and refuses malformed or conflicting selections", async () => {
  assert.deepEqual(parseArgs(["node", "pi-daddy", "diagnostics", "export", "selection.json", "new-dir"]), {
    command: "diagnostics-export",
    force: false,
    errors: [],
    selectionPath: "selection.json",
    exportDirectory: "new-dir",
  });
  assert.ok(parseArgs(["node", "pi-daddy", "diagnostics", "export", "selection.json"]).errors.length);
  assert.throws(() => parseDiagnosticSelection('{"version":1,"sources":[{"path":"x","format":"raw"}]}', "/tmp"));
  const root = await tempDir("diagnostic-cli-");
  const selection = join(root, "selection.json");
  await writeFile(selection, JSON.stringify({ version: 1, sources: [{ path: "absent", format: "text" }] }));
  assert.equal(await main(["node", "pi-daddy", "diagnostics", "export", selection, join(root, "export")]), 1);
  await writeFile(
    selection,
    JSON.stringify({
      version: 1,
      sources: [
        { path: "same", format: "json" },
        { path: "same", format: "text" },
      ],
    }),
  );
  await assert.rejects(exportDiagnostics(selection, join(root, "conflict")), /conflicting diagnostic selection/);
  await assert.rejects(stat(join(root, "conflict")), { code: "ENOENT" });
});

test("offline retention validation preserves host schema decisions across real manifests and boundary mutations", async () => {
  const { manifest } = await retainedFixture();
  const host = Compile(RETENTION_SCHEMA),
    offline = compileRetentionShape(RETENTION_SCHEMA);
  const paths: string[][] = [];
  const visit = (value: unknown, path: string[]) => {
    paths.push(path);
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  visit(manifest, []);
  const values: unknown[] = [
    undefined,
    null,
    false,
    true,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    "x",
    "a".repeat(64),
    "a".repeat(513),
    "😀".repeat(512),
    "😀".repeat(513),
    "control\n",
    [],
    {},
    ["same", "same"],
    Array.from({ length: 65 }, (_, i) => `loss-${i}`),
  ];
  for (const path of paths) {
    for (const replacement of values) {
      let value: any = structuredClone(manifest);
      if (!path.length) value = replacement;
      else {
        let parent = value;
        for (const key of path.slice(0, -1)) parent = parent[key];
        if (replacement === undefined) delete parent[path.at(-1)!];
        else parent[path.at(-1)!] = replacement;
      }
      assert.equal(
        offline(value),
        host.Check(value),
        `schema mismatch at ${path.join(".")}: ${JSON.stringify(replacement)}`,
      );
    }
  }
  for (const version of ["2.0", "2.1"]) {
    for (const state of ["running", "terminal"]) {
      for (const source of ["pi-session-file", "pi-captured-final"]) {
        const value = structuredClone(manifest);
        Object.assign(value, { version, state });
        Object.assign(value.nativeSession, { source });
        assert.equal(offline(value), host.Check(value), `${version}/${state}/${source}`);
      }
    }
  }
  assert.throws(
    () => compileRetentionShape({ ...RETENTION_SCHEMA, unevaluatedProperties: false }),
    /unsupported retention schema keyword/,
  );
});
