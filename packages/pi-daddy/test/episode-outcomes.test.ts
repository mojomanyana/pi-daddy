import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { appendRecord, readRecords } from "../src/governance/record.ts";
import { gitIsAncestor, updateEpisodeOutcomes } from "../src/products/episode-outcomes.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

const exec = promisify(execFile);
after(cleanupTempDirs);

const SURVIVED = "episode:00000000-0000-4000-8000-0000000000a1";
const REVERTED = "episode:00000000-0000-4000-8000-0000000000b2";
const YOUNG = "episode:00000000-0000-4000-8000-0000000000c3";
const ROOT_REVERTED = "episode:00000000-0000-4000-8000-0000000000d4";
const BACKDATED_REVERTED = "episode:00000000-0000-4000-8000-0000000000e5";

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return (await exec("git", args, { cwd, env: { ...process.env, ...env } })).stdout;
}
async function gitResult(cwd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    return { stdout: await git(cwd, args), code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", code: failure.code ?? 127 };
  }
}
async function commit(cwd: string, file: string, value: string, message: string, date: string): Promise<string> {
  await writeFile(join(cwd, file), value);
  await git(cwd, ["add", file]);
  await git(cwd, ["commit", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

async function fixtureRepo(): Promise<{ cwd: string; ledger: string; activity: string; youngDate: Date }> {
  const cwd = await tempDir("episode-outcomes-");
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await commit(cwd, "survived.txt", "kept\n", `ship survivor\n\nPi-Episode: ${SURVIVED}`, "2020-01-01T00:00:00Z");
  await commit(cwd, "survived.txt", "kept and fixed\n", "fix survivor", "2020-01-01T12:00:00Z");
  const reverted = await commit(
    cwd,
    "reverted.txt",
    "remove me\n",
    `ship reverted\n\nPi-Episode: ${REVERTED}`,
    "2020-01-02T00:00:00Z",
  );
  await git(cwd, ["revert", "--no-edit", reverted], {
    GIT_AUTHOR_DATE: "2020-01-03T00:00:00Z",
    GIT_COMMITTER_DATE: "2020-01-03T00:00:00Z",
  });
  const youngDate = new Date();
  await commit(cwd, "young.txt", "new\n", `ship young\n\nPi-Episode: ${YOUNG}`, youngDate.toISOString());
  const state = join(cwd, ".pi", "pi-daddy"),
    activity = join(state, "activity.jsonl"),
    prompt = "No, undo the reverted change",
    digest = createHash("sha256").update(prompt).digest("hex");
  await mkdir(join(state, "content"), { recursive: true });
  await writeFile(join(state, "content", digest), prompt);
  for (const [taskId, at, withPrompt] of [
    ["first", "2020-01-02T00:00:00.000Z", false],
    ["next", "2020-01-03T01:00:00.000Z", true],
  ] as const)
    await appendRecord(activity, "activity", {
      version: 1,
      id: randomUUID(),
      kind: "task_started",
      at,
      rootId: "root",
      episodeId: REVERTED,
      taskId,
      ...(withPrompt ? { prompt: { digest, bytes: Buffer.byteLength(prompt), ref: `content/${digest}` } } : {}),
    });
  return { cwd, ledger: join(state, "grants.jsonl"), activity, youngDate };
}

test("outcomes label surviving, reverted, and younger-than-48-hours fixture commits", async () => {
  const fixture = await fixtureRepo();
  const result = await updateEpisodeOutcomes({
    cwd: fixture.cwd,
    ledgerPath: fixture.ledger,
    activityPath: fixture.activity,
    now: new Date(),
    runGh: async () => null,
  });
  assert.equal(result.appended, 3);
  const records = readRecords(await readFile(fixture.ledger, "utf8")).records;
  const byEpisode = new Map(
    records.map((record) => {
      const body = record.body as Record<string, unknown>;
      return [body.episodeId, body];
    }),
  );
  assert.deepEqual(
    [SURVIVED, REVERTED, YOUNG].map((episode) => ({
      episode,
      survived: byEpisode.get(episode)?.survived,
      ci: byEpisode.get(episode)?.ci,
      amended: byEpisode.get(episode)?.amended,
      corrected: byEpisode.get(episode)?.corrected,
      label: byEpisode.get(episode)?.label,
    })),
    [
      { episode: SURVIVED, survived: true, ci: "none", amended: true, corrected: false, label: "positive" },
      { episode: REVERTED, survived: false, ci: "none", amended: false, corrected: true, label: "negative" },
      { episode: YOUNG, survived: true, ci: "none", amended: false, corrected: false, label: "unknown" },
    ],
  );
});

test("a root episode commit removed by a later inverse diff is not reported as surviving", async () => {
  const cwd = await tempDir("episode-root-revert-");
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await commit(cwd, "root.txt", "root\n", `ship root\n\nPi-Episode: ${ROOT_REVERTED}`, "2020-01-02T00:00:00Z");
  await git(cwd, ["rm", "root.txt"]);
  await git(cwd, ["commit", "-m", "remove root contents"], {
    GIT_AUTHOR_DATE: "2020-01-03T00:00:00Z",
    GIT_COMMITTER_DATE: "2020-01-03T00:00:00Z",
  });
  const result = await updateEpisodeOutcomes({
    cwd,
    ledgerPath: join(cwd, "grants.jsonl"),
    activityPath: join(cwd, "activity.jsonl"),
    now: new Date("2020-01-05T00:00:00Z"),
    runGh: async () => null,
  });
  assert.equal(result.outcomes[0]?.survived, false);
  assert.equal(result.outcomes[0]?.label, "negative");
});

test("descendant order, not author time, identifies a backdated revert", async () => {
  const cwd = await tempDir("episode-backdated-revert-");
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await commit(cwd, "base.txt", "base\n", "base", "2020-01-01T00:00:00Z");
  const candidate = await commit(
    cwd,
    "candidate.txt",
    "candidate\n",
    `ship candidate\n\nPi-Episode: ${BACKDATED_REVERTED}`,
    "2020-01-03T00:00:00Z",
  );
  await git(cwd, ["revert", "--no-edit", candidate], {
    GIT_AUTHOR_DATE: "2020-01-02T00:00:00Z",
    GIT_COMMITTER_DATE: "2020-01-04T00:00:00Z",
  });
  const result = await updateEpisodeOutcomes({
    cwd,
    ledgerPath: join(cwd, "grants.jsonl"),
    activityPath: join(cwd, "activity.jsonl"),
    now: new Date("2020-01-06T00:00:00Z"),
    runGh: async () => null,
  });
  assert.equal(result.outcomes[0]?.survived, false);
});

test("unexpected git ancestry failures are loud rather than recorded as not surviving", async () => {
  const fixture = await fixtureRepo();
  await assert.rejects(gitIsAncestor(fixture.cwd, "0".repeat(40), "main"), /git merge-base failed/);
});

test("shared descendants are diffed once across episodes", async () => {
  const cwd = await tempDir("episode-shared-descendants-");
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await commit(cwd, "base.txt", "base\n", "base", "2020-01-01T00:00:00Z");
  await commit(
    cwd,
    "candidate.txt",
    "candidate\n",
    `ship shared\n\nPi-Episode: ${SURVIVED}\nPi-Episode: ${REVERTED}`,
    "2020-01-02T00:00:00Z",
  );
  await commit(cwd, "later.txt", "later\n", "later work", "2020-01-03T00:00:00Z");
  const expensive: string[] = [];
  await updateEpisodeOutcomes({
    cwd,
    ledgerPath: join(cwd, "grants.jsonl"),
    activityPath: join(cwd, "activity.jsonl"),
    now: new Date("2020-01-05T00:00:00Z"),
    runGh: async () => null,
    runGit: async (args) => {
      if (["diff", "show", "diff-tree"].includes(args[0] ?? "")) expensive.push(args.join(" "));
      return gitResult(cwd, args);
    },
  });
  assert.ok(expensive.length > 0, "the injected runner must observe Git reads");
  assert.equal(expensive.length, new Set(expensive).size, `duplicate Git reads: ${expensive.join(" | ")}`);
});

test("Git diff, root show, and default-branch failures append no outcomes", async () => {
  const fixture = await fixtureRepo();
  for (const [operation, fails, message] of [
    ["diff", (args: string[]) => args[0] === "diff", /git diff failed/],
    ["show", (args: string[]) => args[0] === "show", /git show failed/],
    [
      "branch",
      (args: string[]) => args[0] === "symbolic-ref" && args.at(-1) === "refs\/remotes\/origin\/HEAD",
      /git symbolic-ref failed/,
    ],
  ] as const) {
    const ledgerPath = join(fixture.cwd, `${operation}.jsonl`);
    await assert.rejects(
      updateEpisodeOutcomes({
        cwd: fixture.cwd,
        ledgerPath,
        activityPath: fixture.activity,
        now: new Date(),
        runGh: async () => null,
        runGit: async (args) => (fails(args) ? { stdout: "", code: 128 } : gitResult(fixture.cwd, args)),
      }),
      message,
    );
    await assert.rejects(readFile(ledgerPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  }
});

test("an available gh returning malformed run data is loud rather than recorded as no CI", async () => {
  const fixture = await fixtureRepo();
  await assert.rejects(
    updateEpisodeOutcomes({
      cwd: fixture.cwd,
      ledgerPath: fixture.ledger,
      activityPath: fixture.activity,
      now: new Date(),
      runGh: async () => "not json",
    }),
    /gh run list returned invalid JSON/,
  );
});

test("an unknown outcome advances after its 48-hour wait even when the four measured signals stay equal", async () => {
  const fixture = await fixtureRepo();
  const base = {
    cwd: fixture.cwd,
    ledgerPath: fixture.ledger,
    activityPath: fixture.activity,
    runGh: async () => null,
  };
  await updateEpisodeOutcomes({ ...base, now: fixture.youngDate });
  const advanced = await updateEpisodeOutcomes({
    ...base,
    now: new Date(fixture.youngDate.getTime() + 49 * 60 * 60 * 1_000),
  });
  assert.equal(advanced.appended, 1);
  assert.equal(advanced.outcomes.find((outcome) => outcome.episodeId === YOUNG)?.label, "positive");
});

test("outcomes append nothing when signals are unchanged", async () => {
  const fixture = await fixtureRepo();
  const options = {
    cwd: fixture.cwd,
    ledgerPath: fixture.ledger,
    activityPath: fixture.activity,
    now: new Date(),
    runGh: async () => null,
  };
  assert.equal((await updateEpisodeOutcomes(options)).appended, 3);
  assert.equal((await updateEpisodeOutcomes(options)).appended, 0);
  assert.equal(readRecords(await readFile(fixture.ledger, "utf8")).records.length, 3);
});
