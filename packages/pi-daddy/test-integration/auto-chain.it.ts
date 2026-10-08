/** Real Pi parent and child, scripted local provider: no credentials or network. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import grants from "../extensions/grants.ts";
import { createGrantsSession, type GrantsSession } from "../extensions/session.ts";
import { setAutoApproval, closeSessionAutoMode } from "../extensions/session-auto-mode.ts";
import { readRecords } from "../src/governance/record.ts";
import { createFixture } from "./pi-sdk/fixture-harness.ts";
import { textStep, toolStep } from "./pi-sdk/scripted-provider.ts";

const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";

test("a real chain completes its admitted first child but OFF refuses the next step without inherited Auto permission", async () => {
  const keys = [
    "PI_DADDY_GRANT",
    "PI_DADDY_GATED",
    "PI_DADDY_HERDR",
    "PI_CODING_AGENT_DIR",
    "PI_DADDY_LEDGER",
    "PI_DADDY_AUTO_MODE",
    "PI_DADDY_AUTO_MODE_REF",
    "PI_DADDY_APPROVED",
    "PATH",
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    PI_DADDY_GRANT: "tool:*",
    PI_DADDY_GATED: "tool:bash",
    PI_DADDY_HERDR: "0",
    PI_DADDY_AUTO_MODE: "1",
  });
  delete process.env.PI_DADDY_AUTO_MODE_REF;
  delete process.env.PI_DADDY_APPROVED;
  let owner!: GrantsSession;
  let admissions = 0;
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    fixture = await createFixture({
      prepare: async (root) => {
        await mkdir(join(root, "bin"));
        await mkdir(join(root, "child-agent"));
        process.env.PI_DADDY_LEDGER = join(root, "grants.jsonl");
        const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
        const extension = fileURLToPath(new URL("./pi-sdk/native-phase-extension.ts", import.meta.url));
        const path = join(root, "bin", "pi");
        await writeFile(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} -e ${quote(extension)} "$@"\n`);
        await chmod(path, 0o700);
        process.env.PATH = `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`;
        process.env.PI_CODING_AGENT_DIR = join(root, "child-agent");
        await writeFile(
          join(root, "child-agent", "settings.json"),
          JSON.stringify({
            defaultProjectTrust: "always",
            enableAnalytics: false,
            enableInstallTelemetry: false,
            compaction: { enabled: false },
            retry: { enabled: false },
            cacheWarming: "off",
          }),
        );
      },
      extension: () => (pi) => {
        owner = createGrantsSession(fileURLToPath(new URL("../extensions/grants.ts", import.meta.url)));
        grants(pi, owner);
        pi.on("session_start", () => {
          const auto = owner.autoMode!;
          const admit = auto.admit.bind(auto);
          auto.admit = async (signal) => {
            const admitted = await admit(signal);
            if (admitted && ++admissions === 1) await setAutoApproval(owner, false, "dashboard");
            return admitted;
          };
        });
      },
      next: (_request, index) =>
        index === 0
          ? toolStep("delegate_chain", {
              steps: [
                { task: "Return one short observation", tools: ["bash"] },
                { task: "Use the observation: {previous}", tools: ["bash"] },
              ],
            })
          : textStep("finished"),
    });
    await fixture.session.prompt("Run the two-step chain");
    const end = fixture.events.filter((event) => event.type === "tool_execution_end").at(-1);
    assert.ok(end, "the real parent must invoke the chain tool");
    const details = end.result.details;
    assert.equal(details.completed, 1, JSON.stringify(end));
    assert.equal(details.aborted, true);
    assert.equal(details.outcomes[0].ok, true);
    assert.equal(details.outcomes[0].cleanup.state, "settled");
    assert.equal(details.outcomes[1].ok, false);
    assert.equal(details.outcomes[1].refusal.code, "GATED_UNAPPROVED");
    assert.equal(admissions, 1);
    assert.equal(owner.sessionApprovals.size, 0);
    assert.equal((process.env.PI_DADDY_APPROVED ?? "").includes("tool:bash"), false);
    const records = readRecords<Record<string, unknown>>(await readFile(join(fixture.root, "grants.jsonl"), "utf8"));
    const decisions = records.records
      .map((record) => record.body)
      .filter((body) => body.event === "capability_decision");
    assert.equal(decisions.length, 2);
    assert.deepEqual(decisions[0].approvalSources, { "tool:bash": "auto" });
    assert.deepEqual(decisions[0].approvalScopes, { "tool:bash": "once" });
    assert.equal(decisions[1].gateOutcome, "no-ui");
    assert.notEqual(decisions[1].humanDenied, true);
    assert.deepEqual(fixture.errors, []);
  } finally {
    if (owner) await closeSessionAutoMode(owner);
    await fixture?.close();
    for (const [key, value] of Object.entries(before))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});
