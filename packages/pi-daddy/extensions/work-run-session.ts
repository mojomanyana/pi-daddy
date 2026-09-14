import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { supportedModelEfforts as getSupportedThinkingLevels } from "../src/model-preflight.ts";
import { splitBudget } from "../src/fanout.ts";
import { runWorkSetup, type WorkRunResult } from "../src/work-run.ts";
import { loadWorkSetup, type RecordedWorkSetup } from "../src/work-setup.ts";
import { privateDirectory, writeProductJson } from "../src/product-files.ts";
import { loadDeclaredWork } from "../src/work-command.ts";
import { readDailySnapshot } from "../src/daily-view-input.ts";
import { ordinaryChildrenFor } from "../src/ordinary-children.ts";
import { runOneDelegation } from "./run-delegation.ts";
import { newDelegationOccurrence } from "./execution-occurrence.ts";
import { assertDelegationAuthority } from "./delegation-authority.ts";
import type { GrantsSession } from "./session.ts";
import { prepareNextWorkPolicy } from "./work-policy-session.ts";

export async function runSelectedWork(session: GrantsSession, ctx: ExtensionCommandContext, setup: RecordedWorkSetup, priorities?: string[], lifetime?: { signal: AbortSignal; started: (promise: Promise<WorkRunResult>) => void }): Promise<WorkRunResult | null> {
  assertDelegationAuthority(session);
  if (!ctx.isIdle() || !ordinaryChildrenFor(session).quiescent()) throw Error("Wait for original work to settle before starting a bounded run");
  const loaded = await loadWorkSetup(setup.state);
  if (!loaded || session.declaredWork?.selectedSnapshot.snapshot.digest !== setup.state.selectedSnapshot.snapshot.digest) throw Error("selected work changed");
  const available=splitBudget(session.fanoutBudget,setup.setup.tasks.length);if(!available.ok)throw Error(available.reason);
  const policy = await prepareNextWorkPolicy(ctx, setup.state, setup.setup), configured = policy.setup;
  // Resolve every profile before any ledger, result store or child. No provider/model/effort fallback.
  for (const task of configured.tasks) {
    const slash = task.model.indexOf("/"), model = ctx.modelRegistry.find(task.model.slice(0, slash), task.model.slice(slash + 1));
    if (!model || !getSupportedThinkingLevels(model).includes(task.thinking)) throw Error(`Unsupported profile for ${task.outcome}: ${task.model} / ${task.thinking}; choose a listed model and effort`);
  }
  if (!await ctx.ui.confirm("Run this work?", `${setup.setup.tasks.length} attempts; at most ${setup.setup.maxParallel} parallel. Each child's existing timeout/output/grant bounds apply. Dependencies receive complete bounded predecessor output. No automatic retries; no universal token/cost cap on ordinary children.\n\n${configured.tasks.map(t => `${t.outcome} — ${t.agent ?? "no tools"}, ${t.model}, ${t.thinking}`).join("\n")}`)) return null;
  const selectedNow=await loadDeclaredWork(setup.state.statePath);
  if(selectedNow?.selectedSnapshot.snapshot.digest!==setup.state.selectedSnapshot.snapshot.digest||session.declaredWork?.selectedSnapshot.snapshot.digest!==setup.state.selectedSnapshot.snapshot.digest)throw Error("work selection changed during confirmation; no order started");
  const root = join(homedir(), ".local", "state", "pi-daddy", "work-runs");
  await mkdir(root, { recursive: true, mode: 0o700 }); await privateDirectory(root);
  const abort = new AbortController(), signal = lifetime ? AbortSignal.any([abort.signal, lifetime.signal]) : abort.signal;
  signal.throwIfAborted(); const orderId = randomUUID(), policyPin = await policy.pin(orderId);
  const run = (update: (text: string) => void) => { const pending = runWorkSetup({ directory: join(root, orderId), orderId, policyPin, selectionDigest: setup.state.selectedSnapshot.snapshot.digest, setup: configured, budget: session.fanoutBudget, priorities, signal, admissionOpen:()=>(ordinaryChildrenFor(session).inspect() as {admission:string}).admission==="open",
    onUpdate: rows => update(rows.map(row => `${row.state}: ${setup.setup.tasks.find(t => t.id === row.id)!.outcome}`).join("\n")),
    execute: async (task, prompt, budget, started) => {
      assertDelegationAuthority(session);
      if(session.declaredWork?.selectedSnapshot.snapshot.digest!==setup.state.selectedSnapshot.snapshot.digest)throw Error("selected work changed; remaining order attempts were not launched");
      const ids = newDelegationOccurrence(session, setup.setup.tasks.findIndex(t => t.id === task.id));
      await started(ids.executionId);
      const state = { ...setup.state, obligation: setup.tasks.find(t => t.id === task.id)!.obligation };
      return runOneDelegation(session, { task: prompt, ...(task.agent ? { agent: task.agent } : { tools: [] }), model: task.model, thinking: task.thinking, correlation: { schema_version: "1.0", task_id: task.id, context_id: `work-${setup.setup.id}` } }, ids, budget, ctx, signal, { declaredWork: state, toolCallId: `work-run:${ids.executionId}` });
    },
  }); lifetime?.started(pending); return pending; };
  let result: WorkRunResult;
  if (ctx.mode === "tui") {
    result = await ctx.ui.custom<WorkRunResult>((tui, theme, _keys, done) => {
      const loader = new BorderedLoader(tui, theme, "Running declared work — Esc requests cancellation; awaiting all original children");
      loader.onAbort = () => abort.abort();
      void run(text => ctx.ui.setWidget("pi-daddy-work", text.split("\n"))).then(done).catch(error => done({ error } as unknown as WorkRunResult));
      return loader;
    });
    ctx.ui.setWidget("pi-daddy-work", undefined);
    if ("error" in result) throw (result as unknown as { error: unknown }).error;
  } else result = await run(text => ctx.ui.notify(text, "info"));
  // Navigation index only; the original occurrence ledger/control journal remains the result authority.
  await writeProductJson(join(session.cwd, ".pi", "work-last-run.json"), result.binding, true);
  return result;
}
export async function showWorkResults(ctx: ExtensionCommandContext, result: WorkRunResult): Promise<void> {
  const choices = result.tasks.map((row, i) => `${i + 1}. ${row.state} — ${result.binding.initial.setup.tasks.find(t => t.id === row.id)?.outcome ?? row.id}`);
  const choice = await ctx.ui.select("Results — execution is not acceptance", choices);
  const row = result.tasks[choices.indexOf(choice ?? "")]; if (!row) return;
  if (!row.resultPath || !row.resultDigest) { ctx.ui.notify(row.reason ?? "No retained output; original acknowledgement unavailable", "warning"); return; }
  if (row.resultPath !== join(result.binding.directory, `${row.id}.txt`)) throw Error("result path mismatch");
  const source = await readDailySnapshot(row.resultPath, 1024 * 1024);
  if (source.status !== "read" || source.sha256 !== row.resultDigest) throw Error("retained output missing or changed");
  const output = new TextDecoder("utf8", { fatal: true }).decode(source.bytes);
  await ctx.ui.editor("Retained full output (controls escaped; edits do not alter the artifact)", output.replace(/[\p{Cc}\p{Cf}]/gu, c => c === "\n" || c === "\t" ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4,"0")}`));
}
