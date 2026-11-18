/**
 * Describe binds the definitionId in a real Pi 1.0.4 session (owner decision of 2026-11-17), model-free.
 *
 * The unit wiring tests drive `grants.ts` with the lifecycle events Pi is read to send. This drives them with Pi:
 * `session.reload()` builds a new extension runtime for the same session manager, and `navigateTree` fires
 * `session_tree`. A delegation names an unresolvable model, so it is refused after the identity check and starts
 * no child; its error says whether the call was bound to a described definition.
 *
 * The production changes that break it: dropping the binding on a real reload, not refusing it after the selected
 * Principal body changed and was reloaded, or keeping it after real tree navigation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import grants from "../../extensions/grants.ts";
import { createFixture } from "./fixture-harness.ts";
import { textStep, toolStep } from "./scripted-provider.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const PHASES = ["plan", "build", "review", "debug", "investigate"];

/** The Principal package layout `test/selected-definitions.test.ts` builds, with an editable build body. */
async function writePrincipal(root: string, buildEdit = "") {
  const bindings: Record<string, unknown> = {};
  await mkdir(join(root, "agents"), { recursive: true });
  for (const phase of PHASES) {
    await mkdir(join(root, phase), { recursive: true });
    const skill = `---\nname: ${phase}\ndescription: inline\nallowed-tools: read\n---\nINLINE`;
    const agent =
      `---\nname: principal-${phase}\ndescription: delegated\nallowed-tools: read, write\n---\n` +
      `EXACT DELEGATED ${phase}${phase === "build" ? buildEdit : ""}\n`;
    await writeFile(join(root, phase, "SKILL.md"), skill);
    await writeFile(join(root, "agents", `principal-${phase}.md`), agent);
    bindings[phase] = {
      skill: `${phase}/SKILL.md`,
      agent: `agents/principal-${phase}.md`,
      skillSha256: hash(skill),
      agentSha256: hash(agent),
    };
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "principal-pi-skills", version: "4.7.3" }));
  await writeFile(
    join(root, "principal-agents.json"),
    JSON.stringify({ version: 1, package: "principal-pi-skills", bindings }),
  );
}

test("a real reload keeps the described definitionId, a changed body refuses it, and tree navigation drops it", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "described-binding-agent-"));
  const env = {
    PI_DADDY_GRANT: "tool:delegate,agent:build,tool:read",
    PI_DADDY_HERDR: "0",
    PI_CODING_AGENT_DIR: agentDir,
  };
  const old = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let tool = "delegate_describe";
  let args: Record<string, unknown> = { agent: "build" };
  const f = await createFixture({
    prepare: (root) => writePrincipal(root),
    extension: (root) => (pi) => {
      grants(pi);
      pi.on("resources_discover", () => ({ skillPaths: [join(root, "build")] }));
    },
    next: (_request, index) => (index % 2 === 0 ? toolStep(tool, args, `call-${index}`) : textStep()),
  });
  const run = async (name: string, values: Record<string, unknown>) => {
    tool = name;
    args = values;
    await f.session.prompt(`${name} ${JSON.stringify(values)}`);
    const end = f.events.filter((event) => event.type === "tool_execution_end").at(-1);
    return { isError: end.isError as boolean, text: JSON.stringify(end.result), details: end.result.details };
  };
  const probe = () => run("delegate", { agent: "build", task: "must not launch", model: "nope/nope" });
  const bound = async () => {
    const result = await probe();
    assert.equal(result.isError, true, result.text);
    if (/has no described definition\. Describe it first with delegate_describe\./.test(result.text)) return "none";
    if (/it changed since this session described it\. Describe it again with delegate_describe\./.test(result.text))
      return "stale";
    assert.match(result.text, /nope\/nope/);
    return "bound";
  };
  try {
    assert.equal(await bound(), "none", "never described");
    const described = await run("delegate_describe", { agent: "build" });
    assert.equal(described.isError, false, described.text);
    const first = described.details.definitionId;
    assert.deepEqual(described.details.delegationArguments, { agent: "build", definitionId: first });
    assert.equal(await bound(), "bound");

    await f.session.reload();
    assert.equal(await bound(), "bound", "a real reload keeps it");

    await writePrincipal(f.root, " changed");
    await f.session.reload();
    assert.equal(await bound(), "stale", "the selected body changed since the describe");
    const again = await run("delegate_describe", { agent: "build" });
    assert.notEqual(again.details.definitionId, first);
    assert.equal(await bound(), "bound", "describing again binds the current one");

    const firstUser = f.manager
      .getEntries()
      .find((entry: any) => entry.type === "message" && entry.message.role === "user");
    await f.session.navigateTree(firstUser!.id);
    assert.equal(await bound(), "none", "tree navigation drops it");
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
    await rm(agentDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(old))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});
