/** UNTESTED (per request). Explicit owned-factory SDK composition and operator controls.
 * Default CLI extension loading never infers another Bash implementation/options or replaces it.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import grants from "./grants.ts";
import { createGrantsSession, type GrantsSession } from "./session.ts";
import { CacheSessionProduct, type CacheSessionConfiguration } from "./cache-session-product.ts";
import { CacheProductReaders } from "../src/executors/cache-product-readers.ts";
import { cacheProductLimits } from "../src/kernel/cache-product-limits.ts";
import { loadInstalledCacheNative } from "./cache-installed-native.ts";
export type { CacheSessionConfiguration, CacheSessionControls } from "./cache-session-product.ts";
export function createExecutionCacheExtension(
  configuration: CacheSessionConfiguration & { cwd: string; installedEntry?: URL },
) {
  return async (pi: ExtensionAPI): Promise<void> => {
    const suffix = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const session = createGrantsSession(
      fileURLToPath(new URL(`./grants.${suffix}`, import.meta.url)),
      undefined,
      fileURLToPath(new URL(`./activity-timeline.${suffix}`, import.meta.url)),
    );
    session.cwd = configuration.cwd;
    const limits = cacheProductLimits(configuration.limits);
    const readers = new CacheProductReaders(limits.readerBytes, limits.calls);
    try {
      const installed = await loadInstalledCacheNative(readers, configuration.installedEntry);
      session.executionCache = new CacheSessionProduct(session, configuration, installed, readers);
      // This is the actual factory owned by this explicit SDK host, NOT qualification of a preexisting tool.
      const native = session.executionCache.definition;
      pi.registerTool({ ...native, execute: (...args) => session.executionCache!.definition.execute(...args) });
      session.executionCacheToolAvailable = () => pi.getActiveTools().includes("bash");
    } catch (error) {
      session.executionCache = undefined;
      session.executionCacheReader = readers;
      pi.on("session_shutdown", async () => readers.stop());
      try {
        configuration.onDiagnostic(`cache native binding unavailable; ordinary tool unchanged: ${String(error)}`);
      } catch (diagnostic) {
        console.error("cache native binding diagnostic failed", error, diagnostic);
      }
    }
    grants(pi, session);
  };
}
export async function bindExecutionCache(session: GrantsSession, ctx: ExtensionContext): Promise<void> {
  let product = session.executionCache;
  if (!product) {
    if (session.executionCacheReader) {
      const owners = (session.reloadLifecycle.executionCacheReaders ??= []);
      if (!owners.includes(session.executionCacheReader)) owners.push(session.executionCacheReader);
    }
    return;
  }
  const lifecycle = session.reloadLifecycle,
    id = ctx.sessionManager.getSessionId();
  const prior = lifecycle.executionCache;
  if (product.needsReplacement(id, lifecycle)) {
    const replacement = product.replacement();
    try {
      await product.shutdown();
    } catch (error) {
      (lifecycle.executionCacheRetained ??= []).push(product);
      await replacement.disable();
      ctx.ui.notify(`prior cache owner cleanup unresolved; resources retained: ${String(error)}`, "error");
    }
    session.executionCache = product = replacement;
  }
  if (prior && prior !== product && !lifecycle.executionCacheRetained?.includes(prior)) {
    try {
      await prior.shutdown();
    } catch (error) {
      (lifecycle.executionCacheRetained ??= []).push(prior);
      await product.disable();
      ctx.ui.notify(`prior cache epoch cleanup unresolved; ordinary native work remains: ${String(error)}`, "error");
    }
  }
  lifecycle.executionCache = product;
  await product.bind(id, lifecycle, () => ctx.sessionManager.getSessionId());
}
export async function shutdownExecutionCache(session: GrantsSession): Promise<void> {
  const owners = new Set([session.executionCache, ...(session.reloadLifecycle.executionCacheRetained ?? [])]);
  const results = await Promise.allSettled([
    ...[...owners].map((owner) => owner?.shutdown()),
    ...(session.reloadLifecycle.executionCacheReaders ?? []).map((owner) => owner.stop()),
  ]);
  const errors = results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
  if (errors.length)
    throw new AggregateError(errors, "execution cache epoch cleanup unresolved; retain original owners");
}
export async function executionCacheCommand(session: GrantsSession, args: string): Promise<string> {
  const [verb = "status", extra] = args.trim().split(/\s+/).filter(Boolean);
  if (extra || !["status", "explain", "enable", "clear", "force", "disable", "shutdown", "recover"].includes(verb))
    throw Error("usage: /grants cache status|explain|enable|clear|force|disable|shutdown|recover");
  const product = session.executionCache;
  if (!product) {
    if (!["status", "explain"].includes(verb) && (session.depth !== 0 || !session.ownerBound))
      throw Error("cache mutation requires the current owning root");
    if (verb === "recover" && session.reloadLifecycle.executionCacheReaders?.length) {
      for (const reader of session.reloadLifecycle.executionCacheReaders) {
        await reader.stop().catch((error) => console.error("original cache binding reader stop failed", error));
        await reader.recover();
      }
      return "cache binding reader resources recovered; the original failed binding remains unavailable";
    }
    if (verb !== "status" && verb !== "explain")
      throw Error(
        "cache control requires an explicit SDK-owned native factory binding; default CLI/custom/Herdr unchanged",
      );
    return (
      "cache: disabled — default CLI does not export its captured Bash options/definition. " +
      "Use createExecutionCacheExtension with explicitly owned native options; captured children/Herdr remain ordinary."
    );
  }
  if (verb === "status") return JSON.stringify(product.status(), null, 2);
  if (verb === "explain") return JSON.stringify(product.explain(), null, 2);
  if (session.depth !== 0 || !session.ownerBound)
    throw Error("cache mutations are operator controls of the owning root only");
  product.assertOperator();
  if (verb === "enable") await product.enable();
  if (verb === "clear") product.clear();
  if (verb === "force") product.forceNext();
  if (verb === "disable") await product.disable();
  if (verb === "shutdown") await product.shutdown();
  if (verb === "recover") {
    const retained = session.reloadLifecycle.executionCacheRetained ?? [];
    for (const old of [...retained]) {
      await old.recover();
      retained.splice(retained.indexOf(old), 1); // Physical recovery only; old rejected outcomes stay rejected.
    }
    for (const reader of session.reloadLifecycle.executionCacheReaders ?? []) {
      await reader.stop().catch((error) => console.error("original cache binding reader stop failed", error));
      await reader.recover();
    }
    await product.recover();
  }
  return `cache: ${verb} applied; ${verb === "force" ? "next admitted eligible request runs independently" : "history retained"}`;
}
