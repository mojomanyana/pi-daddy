import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { supportedModelEfforts as getSupportedThinkingLevels } from "../src/kernel/model-preflight.ts";
import {
  workSetup,
  recordWorkSetup,
  selectRecordedWork,
  loadWorkSetup,
  listWorkSetups,
  type WorkSetup,
  type WorkTaskSetup,
} from "../src/products/work-setup.ts";
import { loadDeclaredWork } from "../src/products/work-command.ts";
import { intentKey } from "../src/products/intent-control.ts";
import { ordinaryChildrenFor } from "../src/products/ordinary-children.ts";
import { inspectWorkRun, type WorkRunInitial, type WorkRunResult } from "../src/products/work-run.ts";
import type { ControlBinding } from "../src/products/control-journal.ts";
import { readProductJson } from "../src/products/product-files.ts";
import { dashboardActionFeedback } from "../src/products/dashboard-cli.ts";
import { runSelectedWork, showWorkResults } from "./work-run-session.ts";
import type { GrantsSession } from "./session.ts";
import type { createDailyDashboardSession } from "./daily-dashboard-session.ts";

const cancelled = () => Error("Work setup cancelled; nothing selected or launched");
async function ask(ctx: ExtensionCommandContext, title: string, initial = ""): Promise<string> {
  const value = await ctx.ui.editor(title, initial);
  if (!value?.trim()) throw cancelled();
  return value.trim();
}
async function profile(ctx: ExtensionCommandContext, session: GrantsSession, previous?: WorkTaskSetup) {
  const agents = ["No tools (text-only)", ...session.definitions.keys()];
  const agent = await ctx.ui.select("Agent definition — existing grants still apply", agents);
  if (!agent) throw cancelled();
  const available = ctx.scopedModels?.length
    ? ctx.scopedModels.map((entry) => entry.model)
    : ctx.modelRegistry.getAvailable();
  if (!available.length)
    throw Error("No available Pi models. Configure a model in Pi, then reopen work setup; no fallback is chosen.");
  const labels = available.map((model) => `${model.provider}/${model.id}`);
  const selected = await ctx.ui.select("Model — no silent fallback", labels);
  const model = available[labels.indexOf(selected ?? "")];
  if (!model) throw cancelled();
  const thinking = await ctx.ui.select(
    "Requested effort (not proof of provider-internal reasoning)",
    getSupportedThinkingLevels(model),
  );
  if (!thinking) throw cancelled();
  return {
    agent: agent === agents[0] ? null : agent,
    model: `${model.provider}/${model.id}`,
    thinking: thinking as WorkTaskSetup["thinking"],
  };
}
async function author(ctx: ExtensionCommandContext, session: GrantsSession): Promise<WorkSetup> {
  const outcome = await ask(ctx, "What outcome should this work produce?");
  const tasks: WorkTaskSetup[] = [];
  do {
    const outcome = await ask(ctx, `Task ${tasks.length + 1}: outcome / instructions`);
    const selected = await profile(ctx, session);
    const dependencies: string[] = [];
    while (tasks.length) {
      const candidates = tasks.filter((t) => !dependencies.includes(t.id));
      const labels = ["Dependencies complete", ...candidates.map((t, i) => `${i + 1}. ${t.outcome}`)];
      const choice = await ctx.ui.select(
        "Wait for which prior tasks? Failed dependencies block only their branch",
        labels,
      );
      if (!choice) throw cancelled();
      if (choice === labels[0]) break;
      dependencies.push(candidates[labels.indexOf(choice) - 1].id);
    }
    tasks.push({ id: `task${tasks.length + 1}`, outcome, ...selected, dependencies });
  } while (
    tasks.length < 8 &&
    (await ctx.ui.confirm(
      "Add another task?",
      "Independent tasks can run in parallel; dependent tasks receive predecessor results.",
    ))
  );
  const width = await ctx.ui.select(
    "Maximum parallel agents",
    Array.from({ length: tasks.length }, (_, i) => String(i + 1)),
  );
  if (!width) throw cancelled();
  return workSetup({
    version: "work-setup-v1",
    id: `work-${randomUUID().slice(0, 8)}`,
    outcome,
    tasks,
    maxParallel: Number(width),
  });
}
async function revise(ctx: ExtensionCommandContext, session: GrantsSession, previous: WorkSetup): Promise<WorkSetup> {
  const setup = structuredClone(previous);
  while (true) {
    const labels = [
      "Save revision",
      "Overall outcome",
      "Parallel limit",
      ...setup.tasks.map((t, i) => `${i + 1}. ${t.outcome}`),
    ];
    const choice = await ctx.ui.select("Revise scope/configuration (topology and permissions stay fixed)", labels);
    if (!choice) throw cancelled();
    const index = labels.indexOf(choice);
    if (index === 0) return workSetup(setup);
    if (index === 1) setup.outcome = await ask(ctx, "Revised outcome", setup.outcome);
    else if (index === 2) {
      const width = await ctx.ui.select(
        "Parallel limit",
        Array.from({ length: setup.tasks.length }, (_, i) => String(i + 1)),
      );
      if (!width) throw cancelled();
      setup.maxParallel = Number(width);
    } else {
      const task = setup.tasks[index - 3];
      task.outcome = await ask(ctx, "Task outcome", task.outcome);
      Object.assign(task, await profile(ctx, session, task));
    }
  }
}

export function createWorkSession(
  session: GrantsSession,
  host: ReturnType<typeof createDailyDashboardSession>,
  rebind: () => void,
) {
  let pending: Promise<void> | null = null,
    owned: Promise<WorkRunResult> | null = null;
  const shutdown = new AbortController();
  const run = async (verb: string, ctx: ExtensionCommandContext) => {
    if (!ctx.hasUI) throw Error("Use /grants work in interactive Pi for setup and explicit run confirmation");
    const current = await loadDeclaredWork(join(ctx.cwd, ".pi", "work-current.json"));
    if (current) {
      session.declaredWork = current;
      rebind();
    }
    const selected = current ? await loadWorkSetup(current) : null;
    const menu = [
      "Run selected work",
      "Declare new work",
      "Revise scope / configuration",
      "Record alternative",
      "Select saved work",
      "Select task for ordinary delegation",
      "Change priority",
      "Inspect results",
    ];
    const choice = verb
      ? ({ run: menu[0], new: menu[1], results: menu[7] } as Record<string, string>)[verb]
      : await ctx.ui.select(
          current ? (selected?.setup.outcome ?? `Declared work: ${current.id}`) : "No work selected",
          menu,
        );
    if (!choice) {
      if (verb) throw Error("Use /grants work, work new, work run or work results");
      return;
    }
    const guard = () => {
      if (!ctx.isIdle() || !ordinaryChildrenFor(session).quiescent())
        throw Error("Wait for the original active work to settle before changing setup");
    };
    if (choice === menu[0]) {
      if (!selected) throw Error("Declare multi-task work first; existing ordinary delegation remains available");
      let priorities: string[] | undefined;
      if (host.running) {
        const frame = await host.frame(),
          controls = frame.controls as { intent?: { priorities: { obligation: { digest: string } }[] } };
        priorities = controls.intent?.priorities.map(
          (p) => selected.tasks.find((t) => t.obligation.digest === p.obligation.digest)?.id ?? "",
        );
      }
      const result = await runSelectedWork(session, ctx, selected, priorities, {
        signal: shutdown.signal,
        started: (promise) => {
          owned = promise;
        },
      });
      if (shutdown.signal.aborted) return;
      if (result) {
        ctx.ui.notify(
          `${result.tasks.filter((t) => t.state === "finished").length} finished; ${result.tasks.filter((t) => t.state !== "finished").length} failed/blocked. No acceptance inferred.`,
          "info",
        );
        await showWorkResults(ctx, result);
      }
      return;
    }
    if (choice === menu[7]) {
      const binding = (await readProductJson(
        join(ctx.cwd, ".pi", "work-last-run.json"),
      )) as ControlBinding<WorkRunInitial> | null;
      if (!binding) throw Error("No bounded run result is retained for this project yet");
      await showWorkResults(ctx, await inspectWorkRun(binding));
      return;
    }
    if (choice === menu[6]) {
      if (!host.running) throw Error("Start /grants host to change priority through the current dispatch owner");
      const frame = await host.frame(),
        actions = frame.actions.filter((a) => a.key.startsWith("priority-"));
      const labels = actions.map((a, i) => `${i + 1}. ${a.label}`),
        picked = await ctx.ui.select("Next-work priority (does not rearrange active children)", labels);
      const action = actions[labels.indexOf(picked ?? "")];
      if (action)
        ctx.ui.notify(
          dashboardActionFeedback(
            action.label,
            await host.choose(action.key, { tip: frame.tip, requestDigest: action.requestDigest }),
          ),
          "info",
        );
      return;
    }
    guard();
    if (choice === menu[5]) {
      if (!selected || !current) throw Error("No multi-task setup selected");
      const labels = selected.setup.tasks.map((t, i) => `${i + 1}. ${t.outcome}`),
        picked = await ctx.ui.select("Ordinary delegate binds which task?", labels),
        task = selected.tasks[labels.indexOf(picked ?? "")];
      if (!task) return;
      guard();
      session.declaredWork = await selectRecordedWork(
        { ...selected, state: { ...selected.state, obligation: task.obligation } },
        current.selectedSnapshot,
      );
      rebind();
      ctx.ui.notify("Task selected for subsequent ordinary delegation. Existing attempts were not rebound.", "info");
      return;
    }
    if (choice === menu[4]) {
      const setups = await listWorkSetups(ctx.cwd),
        labels = setups.map((s, i) => `${i + 1}. ${s.setup.outcome}`),
        picked = await ctx.ui.select("Select saved setup (existing work stays pinned)", labels),
        target = setups[labels.indexOf(picked ?? "")];
      if (!target) return;
      guard();
      if (host.running) {
        if (
          !(await ctx.ui.confirm(
            "Stop the current host and select saved work?",
            "The old host's evidence remains intact. Start /grants host again for the selected setup.",
          ))
        )
          return;
        await host.run("stop");
      }
      session.declaredWork = await selectRecordedWork(target, current?.selectedSnapshot ?? null);
      rebind();
      return;
    }
    const mode = choice === menu[1] ? "new" : choice === menu[2] ? "revise" : "alternative";
    if (mode !== "new" && !selected)
      throw Error("Existing single-task work remains supported; declare a new multi-task setup to use revisions");
    const draft = mode === "new" ? await author(ctx, session) : await revise(ctx, session, selected!.setup);
    if (
      !(await ctx.ui.confirm(
        "Save this work setup?",
        `${draft.outcome}\n${draft.tasks.length} obligations; up to ${draft.maxParallel} parallel. ` +
          `Outcome/instruction text is retained in private project files, not governance ledgers. Nothing runs now.`,
      ))
    )
      return;
    guard();
    if (mode === "new" && host.running) {
      if (
        !(await ctx.ui.confirm(
          "Stop current host?",
          "A new topology needs a new host binding. Old evidence is preserved; no running work changes.",
        ))
      )
        return;
      await host.run("stop");
    }
    const recorded = await recordWorkSetup(ctx.cwd, draft, mode, current);
    if (host.running) {
      const prefix = mode === "revise" ? "scope" : "alternative",
        digest = createHash("sha256").update(intentKey(recorded.state.selectedSnapshot)).digest("hex").slice(0, 12);
      ctx.ui.notify(dashboardActionFeedback("Select recorded work", await host.choose(`${prefix}-${digest}`)), "info");
    } else {
      session.declaredWork = await selectRecordedWork(recorded, current?.selectedSnapshot ?? null);
      rebind();
    }
    ctx.ui.notify("Work saved. /grants work run starts it explicitly; /grants host connects the panel.", "info");
  };
  return {
    async close() {
      shutdown.abort();
      if (owned) await owned.catch(() => undefined);
    },
    async run(verb: string, ctx: ExtensionCommandContext) {
      shutdown.signal.throwIfAborted();
      if (pending) throw Error("A work setup/run command is already active");
      pending = run(verb, ctx);
      try {
        await pending;
      } finally {
        pending = null;
        owned = null;
      }
    },
  };
}
