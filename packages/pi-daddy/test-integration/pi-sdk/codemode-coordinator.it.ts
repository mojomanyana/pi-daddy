/** Native tool-only Codemode qualification; no model transport, no child Codemode enablement. */
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { createFixture } from "./fixture-harness.ts";
import { textStep, toolStep } from "./scripted-provider.ts";
import { observeToolNames } from "../../src/kernel/propagation.ts";
import { ChildFinalCapture } from "../../src/executors/child-final.ts";

const native110 =
  JSON.parse(
    readFileSync(
      join(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), "../../package.json"),
      "utf8",
    ),
  ).version === "1.1.0";

async function capturedFinal(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const capture = new ChildFinalCapture();
  const header = fixture.manager.getHeader()!;
  capture.observe(Buffer.from(JSON.stringify(header) + "\n"));
  for (const event of fixture.events) capture.observe(Buffer.from(JSON.stringify(event) + "\n"));
  const path = join(fixture.root, "native-observed-session.jsonl");
  await writeFile(path, [header, ...fixture.manager.getEntries()].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return capture.finish(path);
}

test(
  "native tool-only Codemode preserves callable authority, concurrent IDs, errors and current final",
  { skip: !native110, timeout: 10000 },
  async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: string[] = [],
      seen: string[][] = [];
    let blockedRan = false;
    const fixture = await createFixture({
      sdkVersion: "1.1.0",
      next: (_request, index) =>
        index === 0
          ? toolStep("codemode", {
              code: "const r = await Promise.allSettled([tools.alpha({}), tools.beta({}), tools.blocked({})]); text(r.map(x => x.status)); text(typeof models);",
            })
          : textStep("qualified coordinator final"),
      extension: () => (pi) => {
        createCodemodeExtension({ mode: "only", models: false })(pi);
        pi.registerTool({
          name: "alpha",
          label: "alpha",
          description: "fixture",
          parameters: Type.Object({}),
          async execute() {
            starts.push("alpha");
            await barrier;
            return { content: [{ type: "text", text: "alpha result" }], details: {} };
          },
        });
        pi.registerTool({
          name: "beta",
          label: "beta",
          description: "fixture",
          exposure: "codemode",
          parameters: Type.Object({}),
          async execute() {
            starts.push("beta");
            release();
            throw Error("native nested fixture error");
          },
        });
        pi.registerTool({
          name: "blocked",
          label: "blocked",
          description: "fixture",
          exposure: "deferred",
          parameters: Type.Object({}),
          async execute() {
            blockedRan = true;
            return { content: [], details: {} };
          },
        });
        pi.on("session_start", () => pi.setActiveTools(["codemode", "alpha"]));
        pi.on("tool_call", (event) => {
          if (event.toolName === "codemode") seen.push(observeToolNames({}, pi.getAllTools(), pi.getActiveTools())!);
          return event.toolName === "blocked" ? { block: true, reason: "fixture permission denied" } : undefined;
        });
      },
    });
    try {
      await fixture.session.prompt("compose native tools");
      assert.deepEqual(starts.sort(), ["alpha", "beta"]);
      assert.equal(blockedRan, false);
      assert.ok(seen[0].includes("alpha") && seen[0].includes("beta") && seen[0].includes("blocked"));
      const nested = fixture.events.filter((e) => e.type === "tool_execution_end" && e.parentToolCallId === "call-1");
      assert.equal(nested.length, 3);
      assert.equal(new Set(nested.map((e) => e.toolCallId)).size, 3);
      assert.equal(nested.find((e) => e.toolName === "beta").isError, true);
      assert.equal(nested.find((e) => e.toolName === "blocked").isError, true);
      assert.equal(nested.find((e) => e.toolName === "alpha").isError, false);
      assert.ok(Number.isFinite(nested.find((e) => e.toolName === "alpha").durationMs));
      const outer = fixture.events.find((e) => e.type === "tool_execution_end" && e.toolName === "codemode");
      assert.match(JSON.stringify(outer.result), /undefined/, "the native factory does not expose models");
      const final = await capturedFinal(fixture);
      assert.equal(final.state, "complete", JSON.stringify(final));
      assert.deepEqual(fixture.errors, []);
    } finally {
      release();
      await fixture.close();
    }
  },
);

test(
  "native nested cancellation keeps aborted settlement distinct from an eligible final",
  { skip: !native110, timeout: 10000 },
  async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let aborted = false;
    const fixture = await createFixture({
      sdkVersion: "1.1.0",
      next: () => toolStep("codemode", { code: "await tools.pending({});" }),
      extension: () => (pi) => {
        createCodemodeExtension({ mode: "on", models: false })(pi);
        pi.registerTool({
          name: "pending",
          label: "pending",
          description: "fixture",
          exposure: "codemode",
          parameters: Type.Object({}),
          async execute(_id, _args, signal) {
            began();
            await new Promise<void>((_resolve, reject) => {
              const cancel = () => {
                aborted = true;
                reject(Error("fixture cancelled"));
              };
              signal?.addEventListener("abort", cancel, { once: true });
              if (signal?.aborted) cancel();
            });
            return { content: [], details: {} };
          },
        });
        pi.on("session_start", () => pi.setActiveTools(["codemode"]));
      },
    });
    try {
      const running = fixture.session.prompt("cancel nested tool");
      await started;
      await fixture.session.abort();
      await running;
      assert.equal(aborted, true);
      const settled = fixture.events.findLast((e) => e.type === "agent_settled");
      assert.equal(settled.aborted, true);
      assert.equal((await capturedFinal(fixture)).state, "unavailable");
    } finally {
      await fixture.close();
    }
  },
);
