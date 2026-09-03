/**
 * Shared harness for the `delegate_chain` suites — a fake `pi` driving the real extension.
 *
 * **Shared because the chain's tests belong in two tiers, and that split is the point.** A test that refuses or
 * aborts before spawning is pure and belongs in `test/`. A test that lets a step actually run spawns a real `pi`
 * child, and a `pi` child always calls a **model** — so it costs tokens, needs network and credentials, and varies
 * in duration. Those belong in `test-integration/`, opt-in behind `PI_GRANTS_IT_MODEL=1`, exactly as
 * `delegation.it.ts` already is.
 *
 * A reviewer measured what ignoring that line costs: `npm test` became **2m19s wall on 14.8s of CPU** — two minutes
 * waiting on a provider — with runs of 66s, 127s and 346s, while `CLAUDE.md` still advertised it as "fast, pure, no
 * pi, no network".
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import grantsExtension from "../extensions/grants.ts";
import { ENV_HERDR } from "../src/executor.ts";
import { ENV_APPROVED, ENV_DEPTH, ENV_FANOUT, ENV_GATED, ENV_GRANT, ENV_LEDGER, ENV_MAX_DEPTH, ENV_PARENT_ID } from "../src/propagation.ts";
import { tempDir } from "./tmp.ts";

const KEYS = [ENV_GRANT, ENV_DEPTH, ENV_MAX_DEPTH, ENV_GATED, ENV_APPROVED, ENV_LEDGER, ENV_FANOUT, ENV_PARENT_ID, ENV_HERDR];
const saved = new Map<string, string | undefined>();

/** Restore every governance variable this harness clears. Call from each suite's `afterEach`. */
export function restoreEnv(): void {
  for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
  saved.clear();
}

export interface ToolSpec {
  name: string;
  parameters?: unknown;
  execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

/** A definition holding exactly `allowedTools`, so a step's ceiling is whatever the test needs. */
export async function definition(dir: string, name: string, allowedTools: string): Promise<void> {
  await mkdir(join(dir, ".pi", "skills", name), { recursive: true });
  await writeFile(
    join(dir, ".pi", "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Does ${name} work.\nallowed-tools: ${allowedTools}\n---\nDo the ${name} job.`,
    "utf8",
  );
}

/**
 * How the fake operator answers the gate.
 *
 * `"decline"` keeps a test fast because nothing spawns — but a test that declines can only prove *that* a dialog
 * appeared, never what happens afterwards. **That distinction cost me a test.** The first version of "asks ONCE"
 * declined, so no step ever ran, and dropping `preApproved` entirely left it green: the count was 1 because the
 * chain aborted at the gate, not because the steps were satisfied. Found by mutation, which is the only way it
 * could have been.
 */
export type GateAnswer =
  | "decline"
  /** Every dialog approved for the session. Note this ALSO writes `sessionApprovals`, so it cannot isolate
   *  `preApproved` — use `allow-once` for that. */
  | "allow-session"
  /** Every dialog approved `once`. A `once` answer never enters `sessionApprovals`, so a later step can only be
   *  satisfied by `preApproved` being threaded — which is what makes it the mode that pins the threading. */
  | "allow-once"
  /**
   * Approve the first dialog, then click **Deny**.
   *
   * Deny, not dismiss. `"decline"` returns `undefined`, which pi treats as *dismissed* — a timeout or an escape — and
   * the ledger records `gateOutcome: "dismissed"` with `humanDenied` false. Only an explicit Deny sets
   * `humanDenied`, and the distinction is deliberate: "a person said no" and "nobody answered" call for different
   * responses (`src/ledger.ts`). A test asserting `humanDenied` has to model the former.
   */
  | "allow-then-decline";

export async function harness(env: Record<string, string>, existingDir?: string, answer: GateAnswer = "decline") {
  const dir = existingDir ?? (await tempDir("grants-chain-"));
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { [ENV_HERDR]: "0", ...env });

  const tools = new Map<string, ToolSpec>();
  const hooks = new Map<string, (e: unknown, c: unknown) => unknown>();
  const selects: string[] = [];
  const offered: string[][] = [];
  const ctx = {
    cwd: dir,
    modelRegistry: { find: (provider: string, id: string) => provider === "known" && id === "model" ? { provider, id } : undefined },
    hasUI: true,
    ui: {
      notify: () => {},
      // Records every dialog and DECLINES. Counting dialogs is the point of most of this file; declining keeps it
      // fast, because nothing spawns.
      select: async (title: string, options: string[]) => {
        selects.push(title);
        offered.push(options);
        if (answer === "decline") return undefined;
        // The literal Deny option, so `humanDenied` is set — see the `GateAnswer` note.
        if (answer === "allow-then-decline" && selects.length > 1) return options.find((o) => /^deny$/i.test(o)) ?? options[0];
        if (answer === "allow-once") return options.find((o) => o.includes("once")) ?? options[1];
        // "Allow for this session" — no persisted store is touched, which a test must never do.
        return options.find((o) => o.includes("this session")) ?? options[1];
      },
    },
  };

  grantsExtension({
    on: (name: string, handler: (e: unknown, c: unknown) => unknown) => void hooks.set(name, handler),
    registerTool: (spec: ToolSpec) => void tools.set(spec.name, spec),
    registerCommand: () => {},
    getAllTools: () => ["read", "grep", "write", "bash", "delegate"].map((name) => ({ name })),
  } as never);

  await hooks.get("session_start")!({}, ctx);
  return { dir, tools, ctx, selects, offered };
}
