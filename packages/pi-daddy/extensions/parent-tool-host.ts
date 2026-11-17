/**
 * Parent-run tools, parent side: what this ROOT session can run for a child, and running it (2026-11-17).
 *
 * The rules are the kernel's (`src/kernel/parent-tools.ts`) and the transport is the owner socket
 * (`src/governance/parent-tool-calls.ts`). What is genuinely about Pi lives here: reading the host's tool
 * inventory, and calling `ctx.executeTool` from inside the `delegate`, `delegate_all` or `delegate_chain` call
 * that is waiting on the child. That call goes through Pi's ordinary tool pipeline, so the parent's own hooks and
 * permission prompts decide it exactly as they decide a call the parent's model made, and it is recorded as a
 * nested call of that delegation.
 *
 * Only a ROOT session offers anything. It owns the socket and holds the real tool; a deeper session's copy of
 * the tool is itself run by its parent, and a second level is refused rather than chained. And only for a child
 * whose `--model` is the root's own current provider and model (owner, 2026-11-17): the tool's answer reaches the
 * child's model, and a tool that binds its output to the session's model checks the root's, not the child's.
 * That is checked when planning, again at launch, and again at every call, against the model Pi reports now.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childToolUnavailable } from "../src/kernel/child-tools.ts";
import type { Delegation } from "../src/kernel/delegate.ts";
import { ENV_EXECUTION_ID, ENV_PARENT_TOOLS, ENV_PROXIED_TOOLS_KEY } from "../src/kernel/env-names.ts";
import {
  PARENT_PROXIED_TOOLS,
  PARENT_TOOL_REFUSALS,
  modelRefOf,
  parentProxiedTools,
  parentToolDescriptor,
  parentToolModelNote,
  parentToolResultText,
  parentToolsSwitch,
  sameModel,
  type ModelRef,
  type ParentToolDescriptor,
  type ParentToolReply,
} from "../src/kernel/parent-tools.ts";
import { GovernanceRefusal } from "../src/kernel/refusals.ts";
import { resolve, type Capability } from "../src/kernel/resolve.ts";
import type { GrantsSession } from "./session.ts";

/** The child-side entrypoint a plan loads with `-e` when it delivers a parent-run tool. */
export const PARENT_TOOL_EXTENSION_PATH = fileURLToPath(new URL("./parent-tool-proxy.ts", import.meta.url));

/**
 * The slice of Pi's tool-execution context this needs: the tools one tool may call, and the call itself.
 * A host that does not wire nested calls lacks one or the other, which is how such a host is recognised.
 */
export interface ParentToolHost {
  readonly tools?: readonly { name: string }[];
  /** The session's current model. Pi resolves it when read, so a later read sees a later `/model` choice. */
  readonly model?: { provider: string; id: string };
  executeTool?: (
    name: string,
    args: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<{ result?: unknown; isError?: boolean }>;
}

/**
 * The planner facts this layer supplies. `parentTools` and `rootModel` are always spelled, so an absence
 * overrides a preview's answer.
 */
export interface ParentToolContext {
  parentToolExtensionPath: string;
  parentTools: readonly ParentToolDescriptor[] | undefined;
  rootModel: ModelRef | "preview" | undefined;
}

/** The root's model now, as provider and id; undefined when there is none or the context has gone stale. */
function currentModel(host: ParentToolHost): ModelRef | undefined {
  try {
    return modelRefOf(host.model);
  } catch {
    return undefined; // A stale context throws from its getter, like `tools` below.
  }
}

/** `provider/id` of the host's current model, the value a delegation that inherits it passes as `--model`. */
export function hostModel(host: ParentToolHost | undefined): string | undefined {
  const model = host ? currentModel(host) : undefined;
  return model ? `${model.provider}/${model.id}` : undefined;
}

/** Names the live context can call, or undefined when it cannot run one tool from another at all. */
function callableNames(host: ParentToolHost): string[] | undefined {
  try {
    if (typeof host.executeTool !== "function" || !Array.isArray(host.tools)) return undefined;
    return host.tools.map((tool) => tool.name);
  } catch {
    return undefined; // A stale context (the session was replaced or reloaded) throws from its getter.
  }
}

/**
 * Which allowlisted tools this session can run for a child right now.
 *
 * Without `host` this is a preview from Pi's inventory under Pi's own callability rule, for the listings that
 * have no tool call to ask (startup summary, `/grants`). With it, the live tool context decides: it must offer
 * `executeTool` and list the tool as callable. Dispatch always passes the live context.
 */
function offer(pi: ExtensionAPI, session: GrantsSession, host?: ParentToolHost) {
  if (!parentToolsSwitch(process.env[ENV_PARENT_TOOLS]).enabled) return undefined;
  const authority = session.reloadLifecycle.autoMode?.authority;
  if (session.depth !== 0 || session.ownExecutionId || !authority || session.autoMode !== authority) return undefined;
  const callable = host ? callableNames(host) : undefined;
  if (host && !callable) return undefined;
  try {
    const active = new Set(pi.getActiveTools?.() ?? []);
    const offered = pi.getAllTools().flatMap((tool): ParentToolDescriptor[] => {
      if (!PARENT_PROXIED_TOOLS.includes(tool.name) || tool.sourceInfo?.path === PARENT_TOOL_EXTENSION_PATH) return [];
      const reachable = callable
        ? callable.includes(tool.name)
        : tool.exposure === "codemode" ||
          tool.exposure === "deferred" ||
          (tool.exposure === "direct" && active.has(tool.name));
      const descriptor = reachable ? parentToolDescriptor(tool) : undefined;
      return descriptor ? [descriptor] : [];
    });
    return offered.length > 0 ? offered : undefined;
  } catch {
    return undefined;
  }
}

export function bindParentTools(pi: ExtensionAPI, session: GrantsSession): void {
  session.parentToolContext = (host) => ({
    parentToolExtensionPath: PARENT_TOOL_EXTENSION_PATH,
    parentTools: offer(pi, session, host),
    // Without a delegation's context there is no child model to compare yet; dispatch decides with the live one.
    rootModel: host ? currentModel(host) : "preview",
  });
}

/**
 * The parent-run tools among `capabilities` that this session still holds and can run, decided by the kernel,
 * for a child given `childModel` as `--model`. Without `host` the answer is the inventory preview; dispatch and
 * every call pass the live context, whose current model must then be `childModel`.
 */
export function liveParentTools(
  session: GrantsSession,
  capabilities: readonly Capability[],
  host: ParentToolHost | undefined,
  childModel: string | undefined,
): string[] {
  return parentProxiedTools(capabilities, {
    depth: session.depth,
    autoModeRef: session.autoMode?.reference,
    ...session.parentToolContext?.(host),
    childModel,
  })
    .map((tool) => tool.name)
    .filter((name) => resolve({ requested: [`tool:${name}`], parentGrant: session.ownGrant }).denied.length === 0);
}

export interface ParentToolSession {
  /** Added to the child's launch environment: the key for this one execution. */
  env: Record<string, string>;
  activity(): string;
  close(): void;
}

/**
 * Register a planned child's parent-run tools for the life of its execution.
 *
 * Returns undefined for a plan with none. For a plan that has them it either registers or REFUSES before any
 * process starts, in the planner's own words: a child must never be launched believing it has a tool nobody
 * will answer for.
 */
export function openParentTools(
  session: GrantsSession,
  plan: Pick<Delegation, "parentTools" | "parentToolModel" | "effective" | "env">,
  executionId: string,
  host: ParentToolHost | undefined,
): ParentToolSession | undefined {
  const tools = plan.parentTools ?? [];
  if (tools.length === 0) return undefined;
  const calls = session.reloadLifecycle.autoMode?.authority?.parentTools;
  const childModel = plan.parentToolModel;
  // A gate prompt can sit between planning and here, and the root's model or switch can change while it does.
  const live = host ? liveParentTools(session, plan.effective, host, childModel) : [];
  if (!host || !calls || plan.env[ENV_EXECUTION_ID] !== executionId || tools.some((tool) => !live.includes(tool)))
    throw new GovernanceRefusal(
      childToolUnavailable(tools, host && !sameModel(childModel, currentModel(host)) ? parentToolModelNote(tools) : ""),
    );
  const granted = [...plan.effective];
  let registration: ReturnType<typeof calls.register>;
  try {
    registration = calls.register({
      executionId,
      tools,
      run: (tool, args, signal) => runParentTool(session, granted, childModel, host, tool, args, signal),
    });
  } catch {
    throw new GovernanceRefusal(childToolUnavailable(tools));
  }
  return {
    env: { [ENV_PROXIED_TOOLS_KEY]: registration.key },
    activity: registration.activity,
    close: registration.close,
  };
}

/**
 * Run one parent-run call. The conditions the planner applied are applied again, now, against this session's
 * current model, grant, switch, inventory and host, and only then is the real tool asked for through Pi's own
 * pipeline. A refusal there (a permission hook, a human's no) comes back as an error result, never as success.
 * Anything thrown outside that pipeline becomes a fixed refusal: its message may describe the parent.
 */
async function runParentTool(
  session: GrantsSession,
  granted: readonly Capability[],
  childModel: string | undefined,
  host: ParentToolHost,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ParentToolReply> {
  try {
    // Said separately because it is the one condition the operator changes in passing (`/model`).
    if (!sameModel(childModel, currentModel(host)))
      return { status: "refused", reason: PARENT_TOOL_REFUSALS.otherModel };
    if (!liveParentTools(session, granted, host, childModel).includes(tool))
      return { status: "refused", reason: PARENT_TOOL_REFUSALS.unavailable };
    const outcome = await host.executeTool!(tool, args, { signal });
    return { status: "result", isError: outcome?.isError === true, ...parentToolResultText(outcome?.result) };
  } catch {
    return { status: "refused", reason: PARENT_TOOL_REFUSALS.unavailable };
  }
}
