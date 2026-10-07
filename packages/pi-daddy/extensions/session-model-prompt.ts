import { readFile } from "node:fs/promises";
import { appendLedgerEvent, buildSessionConfigEvent } from "../src/governance/ledger.ts";
import { readRecords } from "../src/governance/record.ts";
import {
  parseConfiguredModel,
  parseThinkingLevel,
  resolveDefinitionRuntime,
  THINKING_LEVELS,
  type DefinitionRuntimeChoice,
  type DefinitionRuntimeSettings,
} from "./definition-runtime.ts";

export interface SessionModelPromptState {
  episodeId: string;
  ledgerPath?: string;
  definitions: Map<string, { name: string }>;
  definitionRuntimeSettings: DefinitionRuntimeSettings;
  definitionRuntimeOverrides: Map<string, DefinitionRuntimeChoice>;
}
export interface SessionModelPromptUI {
  hasUI: boolean;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

async function historicalDefinitions(path: string | undefined): Promise<string[]> {
  if (!path) return [];
  try {
    const parsed = readRecords(await readFile(path, "utf8"));
    return parsed.records
      .map((record) => record.body as { event?: unknown; agentType?: unknown })
      .filter((body) => body.event === "capability_decision" && typeof body.agentType === "string")
      .map((body) => body.agentType as string)
      .filter((name) => name !== "delegate");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function sessionModelRows(state: SessionModelPromptState, names: readonly string[]) {
  return names.map((name) => {
    const selected = resolveDefinitionRuntime({
      definition: name,
      explicit: {},
      session: state.definitionRuntimeOverrides,
      settings: state.definitionRuntimeSettings,
    });
    return {
      definition: name,
      model: selected.model ?? "pi default",
      thinking: selected.thinking ?? "pi default",
      source: `${selected.modelSource}/${selected.thinkingSource}`,
    };
  });
}

function table(state: SessionModelPromptState, names: readonly string[]): string {
  const rows = sessionModelRows(state, names).map(
    (row) => `${row.definition}\t${row.model}\t${row.thinking}\t${row.source}`,
  );
  return ["definition\tmodel\tthinking\tsource", ...rows].join("\n");
}

export function applySessionModelEdits(
  raw: string,
  names: readonly string[],
  target: Map<string, DefinitionRuntimeChoice>,
): string | null {
  const next = new Map(target);
  for (const line of raw
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const parts = line.split(/\s+/);
    if (parts.length !== 3) return "Each edit must be: <definition> <provider:model> <thinking>.";
    const [subject, rawModel, rawThinking] = parts;
    const model = parseConfiguredModel(rawModel);
    const thinking = parseThinkingLevel(rawThinking);
    if (!model || !thinking)
      return `Invalid model or thinking. Model must be provider:model; thinking must be one of: ${THINKING_LEVELS.join(", ")}.`;
    const selected = subject === "all" ? [...names] : [subject];
    if (selected.some((name) => !names.includes(name)))
      return `Unknown definition ${subject}. Known definitions: ${names.join(", ") || "(none)"}.`;
    for (const name of selected) next.set(name, { model, thinking });
  }
  target.clear();
  for (const [name, value] of next) target.set(name, value);
  return null;
}

async function record(
  state: SessionModelPromptState,
  outcome: "kept" | "changed",
  trigger: "first-delegation" | "grants-models",
): Promise<void> {
  if (!state.ledgerPath) return;
  await appendLedgerEvent(
    { path: state.ledgerPath, strict: true },
    buildSessionConfigEvent({
      episodeId: state.episodeId,
      outcome,
      trigger,
      overrides: state.definitionRuntimeOverrides,
      now: new Date(),
    }),
  );
}

async function choose(
  state: SessionModelPromptState,
  current: readonly string[],
  ui: SessionModelPromptUI,
  trigger: "first-delegation" | "grants-models",
): Promise<void> {
  const names = [...new Set([...(await historicalDefinitions(state.ledgerPath)), ...current])].sort();
  if (!ui.hasUI) {
    await record(state, "kept", trigger);
    return;
  }
  while (true) {
    const answer = await ui.input(
      `Child model defaults\n\n${table(state, names)}\n\nPress Enter to keep, or enter edits one per line.`,
      "<definition> <provider:model> <thinking> | all <provider:model> <thinking>",
    );
    if (answer === undefined) throw new Error("session model selection was dismissed; no child was spawned");
    if (!answer.trim()) {
      await record(state, "kept", trigger);
      return;
    }
    const invalid = await saveSessionModelEdits(state, answer, names, trigger);
    if (invalid) {
      ui.notify(invalid, "error");
      continue;
    }
    return;
  }
}

export async function saveSessionModelEdits(
  state: SessionModelPromptState,
  raw: string,
  names: readonly string[],
  trigger: "first-delegation" | "grants-models",
): Promise<string | null> {
  const invalid = applySessionModelEdits(raw, names, state.definitionRuntimeOverrides);
  if (invalid) return invalid;
  await record(state, "changed", trigger);
  return null;
}

export async function changeSessionModels(state: SessionModelPromptState, ui: SessionModelPromptUI): Promise<void> {
  await choose(state, [...state.definitions.keys()], ui, "grants-models");
}

export function renderSessionModels(state: SessionModelPromptState): string {
  return table(state, [...state.definitions.keys()].sort());
}
