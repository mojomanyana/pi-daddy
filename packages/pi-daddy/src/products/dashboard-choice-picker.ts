/** A Bookie question is inspected on Enter. The terminal never infers an option or writes during a redraw. */
import type { DashboardChoiceDetail, DashboardChoiceTarget } from "../kernel/dashboard-choice.ts";
import type { DashboardScreenState } from "./dashboard-screen.ts";
import type { createDashboardConnection } from "./dashboard-session-client.ts";

export interface ChoicePicker {
  target: DashboardChoiceTarget;
  phase: "loading" | "unavailable" | "options" | "custom" | "confirm" | "refused" | "saving" | "saved";
  index: number;
  draft: string;
  detail?: DashboardChoiceDetail;
  error?: string;
}

function current(screen: DashboardScreenState, picker: ChoicePicker) {
  const choice = screen.items.find((item) => item.key === screen.selectedKey)?.choice;
  return (
    choice?.choiceId === picker.target.choiceId &&
    choice.sourceGeneration === picker.target.sourceGeneration &&
    choice.expectedOwner.sessionId === picker.target.expectedOwner.sessionId &&
    choice.expectedOwner.cwd === picker.target.expectedOwner.cwd &&
    choice.expectedOwner.generation === picker.target.expectedOwner.generation
  );
}

export function openChoice(screen: DashboardScreenState): boolean {
  const target = screen.items.find((item) => item.key === screen.selectedKey)?.choice;
  if (!target) return false;
  screen.picker = { target, phase: "loading", index: 0, draft: "" };
  screen.view = "choice";
  screen.offset = 0;
  screen.manualScroll = false;
  return true;
}

function close(screen: DashboardScreenState) {
  screen.picker = undefined;
  screen.view = "main";
  screen.offset = 0;
  screen.manualScroll = false;
}

export function choiceKey(
  screen: DashboardScreenState,
  key: string,
  text?: string,
): "answer-choice" | "quit" | undefined {
  const picker = screen.picker;
  if (!picker || key === "ctrl-c" || (key === "q" && picker.phase !== "custom")) return "quit";
  if (key === "pageup" || key === "pagedown") {
    screen.manualScroll = true;
    screen.offset = Math.max(0, screen.offset + (key === "pageup" ? -8 : 8));
    return;
  }
  if (key === "escape") {
    if (picker.phase !== "saving") close(screen);
    return;
  }
  const detail = picker.detail;
  if (!detail || !current(screen, picker)) return;
  if (picker.phase === "custom") {
    if (key === "return") {
      if (!picker.draft.trim()) {
        picker.error = "Write an answer first.";
        return;
      }
      picker.phase = "confirm";
      screen.offset = 0;
    } else if (key === "backspace") {
      picker.draft = [...picker.draft].slice(0, -1).join("");
    } else if (text && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) {
      if ((picker.draft + text).length > 240) {
        picker.error = "Use up to 240 characters.";
        return;
      }
      picker.draft += text;
    }
    picker.error = undefined;
    screen.manualScroll = false;
    return;
  }
  if (picker.phase === "confirm" || picker.phase === "refused") {
    if (key === (picker.phase === "refused" ? "r" : "return")) {
      picker.phase = "saving";
      picker.error = undefined;
      screen.offset = 0;
      return "answer-choice";
    }
    if (key === "backspace" || key === "e") {
      picker.phase = picker.index === detail.options.length ? "custom" : "options";
      picker.error = undefined;
      screen.offset = 0;
    }
    return;
  }
  if (picker.phase !== "options") return;
  const last = detail.options.length + 1;
  if (["up", "down", "k", "j"].includes(key)) {
    picker.index = Math.max(0, Math.min(last, picker.index + (key === "up" || key === "k" ? -1 : 1)));
    screen.manualScroll = false;
  } else if (key === "return") {
    if (picker.index === last) close(screen);
    else picker.phase = picker.index === last - 1 ? "custom" : "confirm";
    screen.offset = 0;
    screen.manualScroll = false;
  }
}

export function choiceKeys(screen: DashboardScreenState): string[] {
  switch (screen.picker?.phase) {
    case "options":
      return ["↑↓ select · Enter choose", "Esc decide later"];
    case "custom":
      return ["Enter review · Esc cancel"];
    case "confirm":
      return ["Enter save to Bookie", "e edit · Esc cancel"];
    case "refused":
      return ["r retry save · e edit", "Esc cancel"];
    case "saving":
      return ["Waiting for Bookie…"];
    default:
      return ["Esc back"];
  }
}

/** Erase inspected note text and the draft when their source is no longer current. Keep an in-flight save's outcome visible. */
export function choiceBody(screen: DashboardScreenState): string[] {
  const picker = screen.picker;
  if (!picker) return [];
  if (!current(screen, picker)) {
    picker.detail = undefined;
    picker.draft = "";
    if (picker.phase !== "saving" && picker.phase !== "saved") picker.phase = "unavailable";
  }
  if (picker.phase === "saved") return ["Answer saved in Bookie."];
  if (picker.phase === "saving") return ["Saving your answer in Bookie…"];
  if (picker.phase === "loading") return ["Reading this choice from Bookie…"];
  if (picker.phase === "unavailable" || !picker.detail)
    return [
      ...(picker.error ? [picker.error] : []),
      "This choice is unavailable. Return to the list to check its current status.",
    ];
  const detail = picker.detail;
  const issues = picker.error ? [picker.error, ""] : [];
  if (picker.phase === "custom") return [...issues, detail.label, "", "Write your own answer", picker.draft + "▏"];
  if (picker.phase === "confirm" || picker.phase === "refused")
    return [
      ...issues,
      detail.label,
      "",
      "Save this answer in Bookie?",
      "",
      detail.options[picker.index] ?? picker.draft.trim(),
    ];
  return [
    detail.label,
    "From: " + detail.title,
    "",
    ...detail.options.map(
      (option, i) =>
        (i === picker.index ? "> " : "  ") +
        option +
        (detail.recommendation?.option === option ? " · Recommended" : ""),
    ),
    (picker.index === detail.options.length ? "> " : "  ") + "Write my own answer",
    (picker.index === detail.options.length + 1 ? "> " : "  ") + "Decide later",
    ...(detail.recommendation
      ? [
          "",
          "Recommended: " + detail.recommendation.option,
          "Why: " + detail.recommendation.reason,
          "Basis: " + detail.recommendation.evidence,
        ]
      : []),
  ];
}

type ChoiceConnection = Pick<ReturnType<typeof createDashboardConnection>, "inspectChoice" | "change" | "state">;

export async function inspectChoice(screen: DashboardScreenState, connection: ChoiceConnection) {
  const picker = screen.picker;
  if (!picker || picker.phase !== "loading") return;
  try {
    const detail = await connection.inspectChoice(picker.target);
    if (screen.picker !== picker || picker.phase !== "loading" || !current(screen, picker)) return;
    picker.detail = detail;
    picker.phase = "options";
  } catch (error) {
    if (screen.picker !== picker || picker.phase !== "loading") return;
    picker.phase = "unavailable";
    picker.error = error instanceof Error ? error.message : "Bookie could not open this choice.";
  }
}

export async function saveChoice(screen: DashboardScreenState, connection: ChoiceConnection) {
  const picker = screen.picker;
  if (!picker || picker.phase !== "saving" || !picker.detail || !current(screen, picker)) return;
  const option = picker.detail.options[picker.index];
  const saved = await connection.change({
    action: "answer-choice",
    ...picker.target,
    revision: picker.detail.revision,
    answer: option === undefined ? { custom: picker.draft.trim() } : { option },
  });
  if (saved) {
    picker.phase = "saved";
    picker.detail = undefined;
    picker.draft = "";
  } else {
    // A lost acknowledgment can follow a committed write. Reopen the live row before any further submission.
    if (!connection.state.snapshot) {
      picker.detail = undefined;
      picker.draft = "";
    }
    picker.phase = picker.detail ? "refused" : "unavailable";
    picker.error =
      connection.state.error ??
      (connection.state.acknowledgment?.state === "refused"
        ? connection.state.acknowledgment.effect
        : "Bookie could not save this answer.");
  }
}
