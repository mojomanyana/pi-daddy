// A successful `pi install` does not mean the installed Daddy can bind the installed Principal agents.
// Exercise the public slash command in the fresh beta profile. An approval gate is not a missing role.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, RpcClient, SessionManager } from "@earendil-works/pi-coding-agent";
import release from "../src/products/ecosystem-release.json" with { type: "json" };

const profile = process.env.PI_CODING_AGENT_DIR;
assert.ok(profile, "Point PI_CODING_AGENT_DIR at the fresh setup profile");
const configured = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8")).packages;
assert.deepEqual(configured.toSorted(), Object.entries(release.publicVersions).map(([n, v]) => `npm:${n}@${v}`).sort());

const phases = ["build", "review", "debug"];
const client = new RpcClient({ cliPath: process.argv[2], args: ["--offline", "--no-session", "--no-approve"] });
const notices = [];
client.onEvent((event) => {
  if (event.type === "extension_ui_request" && event.method === "notify") notices.push(event);
});
try {
  await client.start();
  assert.ok((await client.getCommands()).some(({ name }) => name === "grants"), "Daddy must register /grants");
  assert.equal(await client.prompt("/grants"), "handled");
  const failures = notices.filter((n) => n.notifyType === "error" || n.message.includes("a definition was not loaded"));
  assert.deepEqual(failures.map((n) => n.message), []);
  const report = notices.find((n) => n.message.startsWith("grants: ACTIVE"))?.message;
  assert.ok(report, "Expected the active /grants report");
  for (const role of phases) {
    const row = report.split("\n").find((line) => new RegExp(`^\\s*(?:allow|BLOCK|AUTO)\\s+${role}\\s+\\[`).test(line));
    assert.ok(row, `Missing ${role} verdict`);
    if (row.trimStart().startsWith("BLOCK")) assert.match(row, /requires explicit approval/, row);
  }
} finally {
  await client.stop();
}

// A verdict row alone cannot distinguish a delegated binding from a same-named inline skill.
const { session } = await createAgentSession({ agentDir: profile, sessionManager: SessionManager.inMemory() });
try {
  await session.bindExtensions({ mode: "rpc" });
  session.setActiveToolsByName([...session.getActiveToolNames(), "delegate_describe"]);
  const describe = session.agent.state.tools.find((t) => t.name === "delegate_describe");
  assert.ok(describe);
  for (const phase of phases) {
    const { details } = await describe.execute(`verify-${phase}`, { agent: phase });
    assert.deepEqual(details.binding, { package: "principal-pi-skills", phase });
    assert.equal(details.selectedResources.package.version, release.publicVersions["principal-pi-skills"]);
  }
} finally {
  session.dispose();
}
console.log("/grants lists all three roles and delegate_describe confirms their Principal bindings; no children launched.");
