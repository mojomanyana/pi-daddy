/**
 * The model-facing shape of a context handoff request (ADR-0078), shared by `delegate`, `delegate_all` and
 * `delegate_chain` so the three cannot describe the same parameter differently.
 *
 * Validation is NOT here. `parseContextRequest` in the kernel is the authority, because a schema the model sees and
 * a rule the planner enforces are two things, and this package's record is full of the second drifting from the
 * first. This shape exists to tell the model what the parameter is for.
 */
import { Type } from "typebox";
import {
  CONTEXT_MODES,
  DEFAULT_CONTEXT_TURNS,
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_TURNS,
} from "../src/kernel/context-handoff.ts";

export function contextShape() {
  return Type.Object({
    mode: Type.Union(
      CONTEXT_MODES.map((mode) => Type.Literal(mode)),
      {
        description:
          "What of YOUR session this sub-agent receives. none: nothing beyond its definition and the task. " +
          "files: the contents of paths you name. pruned: recent turns of your session plus turns naming those " +
          "files. summary: what you write in 'summary'. fork: your whole session (needs a human's approval). " +
          "A definition's allowed-tools caps this; asking for more than it permits is refused. If the child has " +
          "read tools in the same workspace, prefer none and ask it to inspect the checkout instead of embedding files.",
      },
    ),
    files: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: MAX_CONTEXT_FILES,
        description: `At most ${MAX_CONTEXT_FILES} repository-relative paths, for files and pruned.`,
      }),
    ),
    summary: Type.Optional(Type.String({ description: "What the sub-agent needs to know, in your own words." })),
    turns: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_CONTEXT_TURNS,
        description: `For pruned: how many recent turns to keep. Default ${DEFAULT_CONTEXT_TURNS}.`,
      }),
    ),
  });
}
