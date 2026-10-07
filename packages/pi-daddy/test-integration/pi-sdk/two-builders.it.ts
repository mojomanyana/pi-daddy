/** Actual parent SDK -> native Build -> real Pi Bash -> candidate review and serialized integration. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pilot, git, check, principal } from "./two-builders-harness.ts";
import { acquireWorkspaceLease } from "../../src/governance/workspace-lease.ts";
import { validateRegisteredWorkspace } from "../../src/kernel/workspace.ts";
const options = { skip: principal ? false : "set PRINCIPAL_CANDIDATE to the actual Principal candidate" };
const body = (module: string, expression: string) =>
  `const assert=require('node:assert/strict');assert.equal(require('./${module}.cjs').value(),${expression});\n`;
const progressInput = (repo: string, command: string, args: string[], input: string) =>
  JSON.parse(
    execFileSync(process.execPath, [join(principal!, "scripts/progress-artifacts.mjs"), command, ...args], {
      cwd: repo,
      input,
      encoding: "utf8",
    }),
  );
async function evidence(name: string, value: unknown) {
  if (process.env.P14_EVIDENCE_DIR) {
    await mkdir(process.env.P14_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.P14_EVIDENCE_DIR, name + ".json"), JSON.stringify(value, null, 2) + "\n");
  }
}
async function declarePlan(p: Awaited<ReturnType<typeof pilot>>, name: string, jobs: Array<{ declaration: unknown }>) {
  const baseline = Object.fromEntries(
    ["a", "b"].map((id) => [
      id,
      {
        base: git(join(p.root, id), "rev-parse", "HEAD"),
        branch: git(join(p.root, id), "branch", "--show-current"),
        dirty: git(join(p.root, id), "status", "--porcelain"),
      },
    ]),
  );
  const run = p.progress("create", p.repo, "pilot-plan", p.base + ":" + name);
  const plan = progressInput(
    p.repo,
    "report",
    [run, "plan.md"],
    JSON.stringify(
      {
        version: 1,
        name,
        integrationBase: git(p.repo, "rev-parse", "HEAD"),
        baseline,
        jobs: jobs.map((x) => x.declaration),
        sharedResources: "Git object store only; distinct mutable worktrees",
        dependentWork: "Manual coordinator must inspect independent reviews and merged checks before proceeding.",
        launchesBeforeDeclaration: await p.count(),
      },
      null,
      2,
    ),
  );
  return { baseline, plan };
}
async function review(p: Awaited<ReturnType<typeof pilot>>, result: any, id: string) {
  const reviewPath = join(p.root, "review-" + id);
  git(p.repo, "worktree", "add", "-q", "--detach", reviewPath, result.candidate);
  assert.equal(git(reviewPath, "status", "--porcelain"), "");
  const checked = check(reviewPath, ...result.tests);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  return checked.stdout;
}

test(
  "two independent builders preserve full reports, resume reviewed candidates without relaunch, and match sequential merged behavior",
  options,
  async () => {
    const trees: string[] = [];
    for (const mode of ["parallel", "sequential"]) {
      const p = await pilot();
      let ok = false;
      try {
        const a = await p.job(
          "a",
          mode + "-a",
          { "alpha.cjs": "exports.value=()=>4;\n" },
          { "alpha.test.cjs": body("alpha", "4") },
        );
        const b = await p.job(
          "b",
          mode + "-b",
          { "beta.cjs": "exports.value=()=>9;\n" },
          { "beta.test.cjs": body("beta", "9") },
        );
        const { baseline, plan } = await declarePlan(p, mode, [a, b]);
        assert.equal(await p.count(), 0, "plan must be saved before any builder launch");
        if (mode === "parallel") {
          const result = await p.call("delegate_all", { children: [a.spec, b.spec] });
          assert.equal(result.isError, false, JSON.stringify(result));
          assert.equal(result.result.details.outcomes.length, 2);
          for (const outcome of result.result.details.outcomes) {
            assert.equal(outcome.final.state, "complete");
            assert.equal(outcome.cleanup.state, "settled");
          }
        } else
          for (const item of [a, b]) {
            const result = await p.call("delegate", item.spec);
            assert.equal(result.isError, false, JSON.stringify(result));
          }
        const candidates = [await a.result(), await b.result()];
        const identity = candidates.map((x) => x.candidate).join("+");
        const run = p.progress("create", p.repo, "two-builders", identity);
        const facts: Record<
          string,
          { state: string; evidence: Array<{ path: string; sha256: string }>; note: string }
        > = Object.fromEntries(
          ["planned", "implemented", "reviewed", "integrated", "verified"].map((name) => [
            name,
            { state: "unknown", evidence: [], note: "not established" },
          ]),
        );
        facts.planned = { state: "complete", evidence: [plan], note: "scope/base/dependencies declared" };
        facts.implemented = {
          state: "complete",
          evidence: candidates.map((x) => x.report),
          note: "two exact candidate commits and complete reports",
        };
        const record = {
          version: 1,
          plan,
          step: "independent",
          candidate: identity,
          facts,
          findings: [],
          nextAction: "review then serial integration",
        };
        progressInput(p.repo, "append", [run], JSON.stringify(record));
        const launches = await p.count();
        assert.equal(launches, 2);
        const resumed = p.progress("read", run, identity);
        assert.deepEqual(resumed.issues, []);
        assert.equal(resumed.records[0].facts.implemented.state, "complete");
        assert.equal(resumed.records[0].facts.integrated.state, "unknown");
        for (const [index, id] of ["a", "b"].entries())
          assert.equal(git(join(p.root, id), "rev-parse", "HEAD"), candidates[index].candidate);
        assert.equal(
          await p.count(),
          launches,
          "resume must consume checked candidates without launching builders again",
        );
        const reviews = [];
        const interruptions = [];
        const verifyUnchanged = async () => {
          assert.equal(await p.count(), launches, "manual resume must not duplicate a builder launch");
          for (const [index, id] of ["a", "b"].entries()) {
            assert.equal(git(join(p.root, id), "rev-parse", "HEAD"), candidates[index].candidate);
            assert.equal(git(join(p.root, id), "diff", "--exit-code", candidates[index].candidate), "");
            assert.equal(git(join(p.root, id), "status", "--porcelain"), baseline[id].dirty);
            assert.deepEqual(p.progress("reference", candidates[index].report.path), candidates[index].report);
          }
        };
        for (const [index, candidate] of candidates.entries()) {
          reviews.push(
            progressInput(p.repo, "report", [run, `review-${index}.md`], await review(p, candidate, String(index))),
          );
          if (index === 0) {
            facts.reviewed = {
              state: "incomplete",
              evidence: [...reviews],
              note: `reviewed ${candidate.candidate}; second candidate remains unreviewed`,
            };
            progressInput(
              p.repo,
              "append",
              [run],
              JSON.stringify({ ...record, nextAction: "resume remaining candidate review" }),
            );
            const resumedReview = p.progress("read", run, identity);
            assert.deepEqual(resumedReview.issues, []);
            assert.deepEqual(resumedReview.records.at(-1).issues, []);
            assert.equal(resumedReview.records.at(-1).facts.reviewed.state, "incomplete");
            assert.equal(resumedReview.records.at(-1).facts.integrated.state, "unknown");
            assert.equal(git(p.repo, "rev-parse", "HEAD"), p.base);
            await verifyUnchanged();
            interruptions.push({
              phase: "review",
              reviewed: [candidate.candidate],
              integrationHead: p.base,
              launches: await p.count(),
            });
          }
        }
        facts.reviewed = {
          state: "complete",
          evidence: reviews,
          note: "checks ran in fresh detached review worktrees",
        };
        progressInput(p.repo, "append", [run], JSON.stringify({ ...record, nextAction: "serial integration" }));
        for (const [index, candidate] of candidates.entries()) {
          git(p.repo, "cherry-pick", candidate.candidate);
          if (index === 0) {
            const integrationHead = git(p.repo, "rev-parse", "HEAD");
            const applied = progressInput(
              p.repo,
              "report",
              [run, "integration-first.md"],
              JSON.stringify(
                {
                  appliedCandidate: candidate.candidate,
                  integrationHead,
                  pendingCandidate: candidates[1].candidate,
                },
                null,
                2,
              ),
            );
            facts.integrated = {
              state: "incomplete",
              evidence: [applied],
              note: "first candidate applied; second remains pending",
            };
            progressInput(
              p.repo,
              "append",
              [run],
              JSON.stringify({ ...record, nextAction: "resume only second serial cherry-pick" }),
            );
            const resumedIntegration = p.progress("read", run, identity);
            assert.deepEqual(resumedIntegration.issues, []);
            assert.deepEqual(resumedIntegration.records.at(-1).issues, []);
            assert.equal(resumedIntegration.records.at(-1).facts.integrated.state, "incomplete");
            const receipt = JSON.parse(await readFile(applied.path, "utf8"));
            assert.equal(receipt.appliedCandidate, candidates[0].candidate);
            assert.equal(receipt.pendingCandidate, candidates[1].candidate);
            assert.equal(receipt.integrationHead, git(p.repo, "rev-parse", "HEAD"));
            assert.equal(git(p.repo, "rev-list", "--count", `${p.base}..HEAD`), "1");
            await verifyUnchanged();
            interruptions.push({ phase: "integration", ...receipt, launches: await p.count() });
          }
        }
        assert.equal(
          git(p.repo, "rev-list", "--count", `${p.base}..HEAD`),
          "2",
          "manual continuation must not integrate a candidate twice",
        );
        const merged = check(p.repo);
        assert.equal(merged.status, 0, merged.stdout + merged.stderr);
        const mergedReport = progressInput(
          p.repo,
          "report",
          [run, "merged.md"],
          `Merged candidate ${git(p.repo, "rev-parse", "HEAD")}\n${merged.stdout}`,
        );
        facts.integrated = { state: "complete", evidence: [mergedReport], note: "serialized cherry-picks" };
        facts.verified = { state: "complete", evidence: [mergedReport], note: "independent merged tests passed" };
        progressInput(
          p.repo,
          "append",
          [run],
          JSON.stringify({ ...record, nextAction: "dependent work may now use integrated candidate" }),
        );
        for (const id of ["a", "b"])
          assert.equal(
            await readFile(join(p.root, id, "operator-note.txt"), "utf8"),
            "untracked baseline; preserve verbatim\n",
          );
        trees.push(git(p.repo, "write-tree"));
        await evidence(mode, {
          fixtureRoot: p.root,
          base: p.base,
          baseline,
          plan,
          candidates: candidates.map((x) => ({ candidate: x.candidate, report: x.report })),
          nativeResults: p.nativeResults,
          interruptions,
          launches,
          mergedTree: trees.at(-1),
          progress: p.progress("read", run, identity).records.map((x: any) => x.facts),
          limitations: "scripted provider/process qualification only",
        });
        ok = true;
      } finally {
        await p.finish(ok);
      }
    }
    assert.equal(trees[0], trees[1], "matched independent changes produce the same verified merged tree");
  },
);

test(
  "a failed sibling and a shared-writer refusal preserve the successful candidate and never relaunch denied work",
  options,
  async () => {
    const p = await pilot();
    let ok = false;
    try {
      const failed = await p.job("a", "failed-a", {}, {}, true);
      const good = await p.job(
        "b",
        "successful-b",
        { "beta.cjs": "exports.value=()=>9;\n" },
        { "beta.test.cjs": body("beta", "9") },
      );
      const { plan } = await declarePlan(p, "failure-and-writer", [failed, good]);
      assert.equal(await p.count(), 0);
      const result = await p.call("delegate_all", { children: [failed.spec, good.spec] });
      assert.equal(result.isError, true);
      assert.equal(result.result.details.outcomes[0].ok, false);
      assert.equal(result.result.details.outcomes[1].final.state, "complete");
      const candidate = await good.result();
      assert.ok((await readFile(candidate.report.path, "utf8")).includes(candidate.candidate));
      await review(p, candidate, "good");
      git(p.repo, "cherry-pick", candidate.candidate);
      assert.equal(check(p.repo).status, 0);
      const workspace = await validateRegisteredWorkspace({ workspaceId: "a", registeredRoot: join(p.root, "a") });
      const lease = await acquireWorkspaceLease({
        workspace,
        access: "write",
        leaseDir: join(p.root, "leases"),
        ownerId: "pilot-review-holder",
      });
      const before = await p.count();
      try {
        const denied = await p.call("delegate", failed.spec);
        assert.equal(denied.isError, true);
        assert.match(JSON.stringify(denied), /WORKSPACE_WRITE_CONFLICT|writer/i);
        assert.equal(await p.count(), before);
      } finally {
        await lease.release();
      }
      assert.equal(
        git(join(p.root, "b"), "rev-parse", "HEAD"),
        candidate.candidate,
        "feedback still reaches the retained builder candidate",
      );
      await evidence("failure-and-writer", {
        fixtureRoot: p.root,
        successfulCandidate: candidate.candidate,
        plan,
        report: candidate.report,
        nativeResults: p.nativeResults,
        launches: await p.count(),
        failedSiblingPreserved: true,
        sharedWriterDenied: true,
      });
      ok = true;
    } finally {
      await p.finish(ok);
    }
  },
);

test(
  "merged checks catch a coupled interface mismatch and the repair starts on the integrated result",
  options,
  async () => {
    const p = await pilot();
    let ok = false;
    try {
      const a = await p.job(
        "a",
        "producer-change",
        { "producer.cjs": "exports.payload=()=>({amount:2});\n" },
        {
          "producer.test.cjs":
            "const a=require('node:assert/strict');a.deepEqual(require('./producer.cjs').payload(),{amount:2});\n",
        },
        false,
        "coupled producer/consumer interface; parallel experiment must not authorize dependent work",
      );
      const b = await p.job(
        "b",
        "consumer-mismatch",
        { "consumer.cjs": "exports.render=x=>x.quantity+1;\n" },
        {
          "consumer.test.cjs":
            "const a=require('node:assert/strict');a.equal(require('./consumer.cjs').render({quantity:2}),3);\n",
        },
        false,
        "coupled interface deliberately mismatched for merged-test oracle",
      );
      const { plan } = await declarePlan(p, "deliberate-coupled-negative-experiment", [a, b]);
      assert.equal(await p.count(), 0);
      const built = await p.call("delegate_all", { children: [a.spec, b.spec] });
      assert.equal(built.isError, false, JSON.stringify(built));
      const candidates = [await a.result(), await b.result()];
      for (const [index, candidate] of candidates.entries()) {
        await review(p, candidate, "coupled-" + index);
        git(p.repo, "cherry-pick", candidate.candidate);
      }
      const mismatch = check(p.repo);
      assert.notEqual(mismatch.status, 0, "separate green checks must not hide the interface mismatch");
      assert.equal(
        await p.count(),
        2,
        "dependent work stayed blocked through candidate review and failed merged verification",
      );
      const integration = git(p.repo, "rev-parse", "HEAD");
      git(join(p.root, "b"), "merge", "--no-edit", integration);
      assert.equal(
        git(join(p.root, "b"), "write-tree"),
        git(p.repo, "write-tree"),
        "repair starts from the actual integrated tree",
      );
      const repair = await p.job(
        "b",
        "sequential-interface-repair",
        { "consumer.cjs": "exports.render=x=>x.amount+1;\n" },
        {
          "consumer.test.cjs":
            "const a=require('node:assert/strict');a.equal(require('./consumer.cjs').render({amount:2}),3);\n",
        },
        false,
        "depends on integrated producer amount contract",
      );
      const repairPlan = await declarePlan(p, "sequential-interface-repair", [repair]);
      const repaired = await p.call("delegate", repair.spec);
      assert.equal(repaired.isError, false, JSON.stringify(repaired));
      const fix = await repair.result();
      await review(p, fix, "repair");
      git(p.repo, "cherry-pick", fix.candidate);
      const final = check(p.repo);
      assert.equal(final.status, 0, final.stdout + final.stderr);
      assert.equal(await p.count(), 3);
      await evidence("coupled-interface", {
        fixtureRoot: p.root,
        base: p.base,
        plan,
        candidates: candidates.map((x) => ({ candidate: x.candidate, report: x.report })),
        nativeResults: p.nativeResults,
        mismatchStatus: mismatch.status,
        integration,
        repairPlan: repairPlan.plan,
        repair: { candidate: fix.candidate, report: fix.report },
        finalStatus: final.status,
        launches: 3,
        policy:
          "deliberate parallel negative experiment; runtime does not classify or block semantic dependencies; coordinator uses merged failure then sequential repair; no parallel quality or speed claim",
      });
      ok = true;
    } finally {
      await p.finish(ok);
    }
  },
);
