/** UNTESTED (per request). Explicit SDK-owned native Bash product, disabled until operator opt-in.
 * No reconstruction of the CLI's captured options, global bearer, command wrapper or historical hydration.
 * Source/native factory owns prefix/hooks/env/options and finalizes every native result. Cache-only failures
 * never cancel already ordinary work. Explicit shutdown joins native finalization and independent owners.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { types } from "node:util";
import { Type, type TSchema } from "typebox";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import { CacheNativeRoot } from "./cache-native-root.ts";
import { CacheNativeBashFactory, cacheNativeEnvironment, type CacheNativeAdmission } from "./cache-native-bash.ts";
import type { InstalledCacheNative } from "./cache-installed-native.ts";
import type { GrantsSession } from "./session.ts";
import type { ReloadLifecycle } from "./reload-environment.ts";
import { CacheProductReaders, CacheProductReadUnavailable } from "../src/executors/cache-product-readers.ts";
import { CacheProductStorage } from "../src/executors/cache-product-storage.ts";
import { loadCacheNativeAssets } from "../src/executors/cache-native-loader.ts";
import { startSupervisedCache, type CacheSupervisorHandle } from "../src/executors/cache-supervisor.ts";
import { CacheSupervisorTerminationError } from "../src/executors/cache-supervisor-cleanup.ts";
import { readCacheOwner } from "../src/kernel/cache-owner.ts";
import { BoundedReadCleanupError } from "../src/kernel/bounded-read.ts";
import { projectSettingsPath } from "../src/kernel/project-paths.ts";
import { cacheProductLimits, cacheProductBufferBudget, type CacheProductLimits } from "../src/kernel/cache-product-limits.ts";
import { WatchmanTracker } from "../src/executors/cache-watchman.ts";
import { startPersonalBash } from "../src/executors/cache-personal-bash.ts";
import { CacheChecksumProfile } from "../src/products/cache-checksum-profile.ts";
import { PersonalCacheRuntime } from "../src/products/cache-personal-runtime.ts";
import { CacheShellBackend, type CacheShellBackendCompletion } from "../src/products/cache-shell-backend.ts";
import { appendRecord } from "../src/governance/record.ts";
import { validateCacheHistory, type CacheHistory } from "../src/governance/cache-history.ts";
export interface CacheSessionControls {
  status(): ReturnType<CacheSessionProduct["status"]>;
  clear(): void;
  forceNext(): void;
  enable(): Promise<void>;
  disable(): Promise<void>;
  shutdown(): Promise<void>;
  recover(): Promise<void>;
}
export interface CacheSessionConfiguration {
  /** Trusted SDK options actually passed to our owned native constructor, not metadata about another tool. */
  nativeOptions: BashToolOptions;
  manifests: readonly string[];
  watchman: { ownedExecutable: string } | { sharedSocket: string };
  /** Explicit trusted host/operator opt-in. Workspace settings can only narrow this choice. */
  enabled?: boolean;
  limits?: Partial<CacheProductLimits>;
  onDiagnostic(message: string): void;
  /** Trusted SDK host lifecycle port, not an ambient child endpoint or profile authority. */
  onControl?(controls: CacheSessionControls): void;
  /** Optional bounded history consumer. These facts never become reusable cache state. */
  onHistory?(event: Readonly<CacheHistory>): void;
}
class CacheStartupStopped extends Error {}
interface Call {
  id: string;
  requestedAt: string;
  started: number;
  fingerprint: string | null;
  completion?: CacheShellBackendCompletion;
  reason: string;
  rejected?: true;
  control?: "clear" | "disable";
}
export class CacheSessionProduct {
  readonly definition: ReturnType<InstalledCacheNative["native"]["createBashToolDefinition"]>;
  private readonly session: GrantsSession;
  private readonly factoryCwd: string;
  private readonly config: CacheSessionConfiguration;
  private readonly installed: InstalledCacheNative;
  private readonly limits: Readonly<CacheProductLimits>;
  private readonly readers: CacheProductReaders;
  private readonly storage: CacheProductStorage;
  private readonly secret = randomBytes(32);
  private readonly calls = new Map<string, Call>();
  private readonly nativeTasks = new Set<Promise<unknown>>();
  private readonly trackers: WatchmanTracker[] = [];
  private readonly failures: unknown[] = [];
  private readonly telemetry = new Set<Promise<void>>();
  private readonly cancellation = new AbortController();
  private profiles: CacheChecksumProfile[] = [];
  private runtime?: PersonalCacheRuntime;
  private root?: CacheNativeRoot;
  private readonly ordinaryFactory: CacheNativeBashFactory;
  private cacheStopped = false;
  private watcher?: CacheSupervisorHandle;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private disabling?: Promise<void>;
  private recovering?: Promise<void>;
  private enabled: boolean;
  private closed = false;
  private force = false;
  private lifecycle?: ReloadLifecycle;
  private rootSessionId = "unbound";
  private sessionIdProvider?: () => string;
  private requester = "unbound";
  private workspace = "unbound";
  private ledgerPath?: string;
  private readonly epoch = randomUUID();
  private launches = 0;
  private last?: CacheHistory;
  constructor(
    session: GrantsSession,
    configuration: CacheSessionConfiguration,
    installed: InstalledCacheNative,
    readers = new CacheProductReaders(cacheProductLimits(configuration.limits).readerBytes, cacheProductLimits(configuration.limits).calls),
  ) {
    this.readers = readers;
    this.limits = cacheProductLimits(configuration.limits);
    if (
      !configuration.nativeOptions || typeof configuration.nativeOptions !== "object" ||
      types.isProxy(configuration.nativeOptions) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(configuration.nativeOptions)) ||
      Object.values(Object.getOwnPropertyDescriptors(configuration.nativeOptions)).some((row) => !Object.hasOwn(row, "value")) ||
      (configuration.nativeOptions.commandPrefix !== undefined && typeof configuration.nativeOptions.commandPrefix !== "string") ||
      (configuration.nativeOptions.spawnHook !== undefined && typeof configuration.nativeOptions.spawnHook !== "function") ||
      (configuration.nativeOptions.exposeSessionEnvironment !== undefined && typeof configuration.nativeOptions.exposeSessionEnvironment !== "boolean") ||
      !configuration.manifests.length ||
      configuration.manifests.length > 8 ||
      configuration.nativeOptions.operations !== undefined ||
      configuration.nativeOptions.shellPath !== "/bin/bash"
    )
      throw Error("cache product requires explicit default native Bash options and 1..8 GNU manifests");
    this.storage = new CacheProductStorage(this.limits.imageBytes);
    this.session = session;
    this.installed = installed;
    this.factoryCwd = session.cwd;
    this.config = {
      ...configuration,
      nativeOptions: { ...configuration.nativeOptions },
      manifests: [...configuration.manifests],
    };
    this.enabled = configuration.enabled === true;
    this.ordinaryFactory = new CacheNativeBashFactory({
      cwd: session.cwd,
      options: this.config.nativeOptions,
      native: installed.native,
      maxCalls: this.limits.calls,
      authorize: () => this.authorized(),
      authorizeCall: (input, call) => this.authorizeCall(input, call.toolCallId),
      allocate: async () => undefined,
    });
    const ordinary = this.ordinaryFactory.definition;
    // 1.0.2 publicly exposes outputSchema/structuredContent. Preserve every native schema field and
    // required key; only add optional provenance. 0.84 has no such public contract and remains text/details.
    const schema = (ordinary as unknown as { outputSchema?: TSchema & { properties?: Record<string, TSchema> } }).outputSchema;
    const provenanceSchema = Type.Object({
      decision: Type.Union([Type.Literal("reuse"), Type.Literal("join")]),
      contract: Type.Literal("personal-best-effort-v1"),
      executionId: Type.Optional(Type.String()),
      originalStartedAt: Type.Optional(Type.String()),
      originalEndedAt: Type.Optional(Type.String()),
    });
    this.definition = {
      ...ordinary,
      ...(installed.version === "1.0.2" && schema?.properties ? {
        outputSchema: { ...schema, properties: { ...schema.properties, executionCache: Type.Optional(provenanceSchema) } },
      } : {}),
      execute: (...args) => {
        if (this.closed || !this.authorized()) {
          this.record(args[0], {
            id: randomUUID(),
            requestedAt: new Date().toISOString(),
            started: performance.now(),
            fingerprint: null,
            reason: "current native owning session authority unavailable",
            rejected: true,
          });
          throw Error("cache native owning session authority unavailable");
        }
        if (this.calls.has(args[0])) throw Error("cache native tool-call identity already active; not retrying");
        if (this.calls.size >= this.limits.calls) throw Error("cache native call owner bound exceeded");
        const call: Call = {
          id: randomUUID(),
          requestedAt: new Date().toISOString(),
          started: performance.now(),
          fingerprint: null,
          reason: this.enabled ? "not eligible or cache unavailable" : "operator disabled",
        };
        this.calls.set(args[0], call);
        const work = Promise.resolve().then(async () => {
          try {
            try {
              await this.starting;
            } catch (error) {
              if (!(error instanceof CacheStartupStopped) && !this.failures.includes(error)) throw error;
              call.reason = "cache startup unavailable; ordinary native execution";
            }
            if (!this.authorized()) {
              call.rejected = true;
              throw Error("cache native current authority changed before execution");
            }
            const result = await (this.enabled && this.root ? this.root.definition : ordinary).execute(...args);
            if (!this.authorized()) {
              call.rejected = true;
              throw Error("cache native result current authority/epoch unavailable; no automatic retry");
            }
            const resolution = call.completion?.resolution;
            if (resolution?.kind === "reuse" || resolution?.kind === "join") {
              const notice =
                `${resolution.kind === "reuse" ? "Reused" : "Joined"} execution ${resolution.executionId}; ` +
                `original execution ${resolution.outcome?.startedAt ?? "unknown"}; personal-best-effort-v1.`;
              const executionCache = {
                decision: resolution.kind,
                contract: "personal-best-effort-v1",
                executionId: resolution.executionId,
                originalStartedAt: resolution.outcome?.startedAt,
                originalEndedAt: resolution.outcome?.endedAt,
              };
              const structured = (result as unknown as { structuredContent?: Record<string, unknown> }).structuredContent;
              return {
                ...result,
                ...(installed.version === "1.0.2" && schema?.properties && structured ? {
                  structuredContent: { ...structured, executionCache },
                } : {}),
                content: [...result.content, { type: "text" as const, text: notice }],
                details: {
                  ...(result.details && typeof result.details === "object" ? result.details : {}),
                  executionCache,
                },
              };
            }
            return result;
          } catch (error) {
            if (!call.completion) call.reason = "native tool rejected; no inferred exit status or automatic retry";
            throw error;
          } finally {
            this.record(args[0], call);
            this.calls.delete(args[0]);
          }
        });
        this.nativeTasks.add(work);
        void work.then(
          () => this.nativeTasks.delete(work),
          () => this.nativeTasks.delete(work),
        );
        return work;
      },
    };
  }
  private authorized(): boolean { return !this.closed && this.currentOwner(); }
  private currentOwner(): boolean {
    const session = this.session;
    return (
      session.cwd === this.factoryCwd &&
      session.ownerBound &&
      session.reloadLifecycle === this.lifecycle &&
      this.sessionIdProvider?.() === this.rootSessionId &&
      session.executionCacheToolAvailable?.() === true &&
      (!session.governed || session.ownGrant.includes("tool:*") || session.ownGrant.includes("tool:bash"))
    );
  }
  /** Host and command mutations require the current owning root, even on a stopped recovery target. */
  assertOperator(): void {
    if (this.session.depth !== 0 || !this.currentOwner()) throw Error("cache control requires current owning root authority");
  }
  private startupGuard(): void {
    if (this.closed || this.cacheStopped || !this.enabled || this.cancellation.signal.aborted)
      throw new CacheStartupStopped("cache startup intentionally stopped; acquired owners retained for teardown");
    if (!this.authorized()) throw Error("cache startup authority/epoch changed; no further admission");
  }
  private authorizeCall(input: Readonly<CacheNativeAdmission>, id: string): boolean {
    const call = this.calls.get(id);
    if (!call || !this.authorized()) return false;
    const data = cacheNativeEnvironment(input.env);
    // Do not invoke an unsupported hook's environment accessors just to write optional telemetry.
    call.fingerprint = data && typeof input.command === "string" && typeof input.cwd === "string" &&
      (input.timeout === undefined || typeof input.timeout === "number") &&
      (input.shell === undefined || typeof input.shell === "string")
      ? createHmac("sha256", this.secret)
          .update(
            JSON.stringify([
              input.command,
              input.cwd,
              input.shell,
              Object.entries(data),
              input.timeout,
            ]),
          )
          .digest("hex")
      : null;
    return true;
  }
  needsReplacement(rootSessionId: string, lifecycle: ReloadLifecycle): boolean {
    return (
      this.factoryCwd !== this.session.cwd ||
      (this.lifecycle !== undefined && (this.lifecycle !== lifecycle || this.rootSessionId !== rootSessionId))
    );
  }
  replacement(): CacheSessionProduct {
    return new CacheSessionProduct(
      this.session,
      { ...this.config, enabled: this.enabled && !this.cacheStopped },
      this.installed,
    );
  }
  async bind(rootSessionId: string, lifecycle: ReloadLifecycle, currentSessionId: () => string): Promise<void> {
    if (this.lifecycle && (this.lifecycle !== lifecycle || this.rootSessionId !== rootSessionId)) {
      await this.shutdown();
      throw Error("cache native owner changed; create a new cold SDK binding");
    }
    this.lifecycle = lifecycle;
    this.rootSessionId = rootSessionId;
    this.sessionIdProvider = currentSessionId;
    this.requester = this.session.ownExecutionId ?? "root";
    this.ledgerPath = this.session.ledgerPath;
    this.workspace = await realpath(this.session.cwd);
    if (!this.authorized()) throw Error("cache binding owner changed during workspace resolution");
    const control = <T>(work: () => T): T => { this.assertOperator(); return work(); };
    try {
      this.config.onControl?.(
        Object.freeze({
          status: () => this.status(),
          clear: () => control(() => this.clear()),
          forceNext: () => control(() => this.forceNext()),
          enable: () => control(() => this.enable()),
          disable: () => control(() => this.disable()),
          shutdown: () => control(() => this.shutdown()),
          recover: () => control(() => this.recover()),
        }),
      );
    } catch (cause) {
      this.enabled = false;
      const error = new Error("cache host lifecycle binding failed; no helper started", { cause });
      this.fault(error);
      throw error;
    }
    if (this.enabled) await this.enable();
  }
  enable(): Promise<void> {
    if (this.session.depth !== 0 || !this.authorized()) throw Error("only the current owning root may enable caching");
    if (this.stopping || this.cacheStopped || this.failures.length)
      throw Error("cache product is terminal; recover resources then create a new owner");
    this.enabled = true;
    return (this.starting ??= Promise.resolve()
      .then(async () => {
        this.startupGuard();
        const cwd = await realpath(this.session.cwd);
        this.startupGuard();
        const settingsPath = projectSettingsPath(cwd);
        let configured = false;
        try {
          await lstat(settingsPath);
          this.startupGuard();
          configured = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (configured) {
          const bytes = await this.readers.read(settingsPath, 1024 * 1024);
          this.startupGuard();
          let settings: unknown;
          try {
            settings = JSON.parse(bytes.toString());
          } catch {
            throw Error("cache project settings JSON malformed; contents withheld");
          }
          if (!settings || typeof settings !== "object" || Array.isArray(settings))
            throw Error("cache project settings malformed");
          const policy = (settings as Record<string, unknown>).executionCache;
          if (
            policy !== undefined &&
            (!policy ||
              typeof policy !== "object" ||
              Array.isArray(policy) ||
              (policy as Record<string, unknown>).enabled !== true)
          )
            throw Error("project settings disable execution caching");
          // A workspace true never enables this product; only this explicit operator/host enable method does.
        }
        if (!this.authorized()) throw Error("cache authority changed during startup");
        await this.storage.prepare();
        this.startupGuard();
        const owner = await readCacheOwner(process.pid, "/proc", async (path, limits) => ({
          ok: true,
          text: (await this.readers.read(path, limits.maxBytes)).toString(),
        }));
        this.startupGuard();
        const assets = await loadCacheNativeAssets(this.readers);
        this.startupGuard();
        const brokerPath = await this.storage.publish("broker", assets.broker);
        this.startupGuard();
        for (const manifest of this.config.manifests) {
          this.profiles.push(await CacheChecksumProfile.create(cwd, manifest, this.readers));
          this.startupGuard();
        }
        if (!this.authorized()) throw Error("cache startup authority changed before watcher admission");
        const socket =
          "sharedSocket" in this.config.watchman
            ? this.config.watchman.sharedSocket
            : join(this.storage.path, "watch.sock");
        if ("ownedExecutable" in this.config.watchman) {
          const executable = this.config.watchman.ownedExecutable;
          if (!executable.startsWith("/") || !(await lstat(executable)).isFile())
            throw Error("owned Watchman executable unsupported");
          this.startupGuard();
          this.watcher = await startSupervisedCache({
            owner,
            signal: this.cancellation.signal,
            entry: new URL(
              import.meta.url.endsWith(".ts")
                ? "../src/executors/cache-watchman-worker.ts"
                : "../executors/cache-watchman-worker.js",
              import.meta.url,
            ),
            args: [executable, socket],
          });
          this.startupGuard();
        }
        for (const root of new Set(this.profiles.flatMap((profile) => profile.roots))) {
          this.startupGuard();
          this.trackers.push(
            await WatchmanTracker.connect({
              socketPath: socket,
              root,
              onChange: (names) => this.runtime?.changed(names.map((name) => join(root, name))),
              onUncertain: (reason) => {
                this.runtime?.uncertain(reason);
                this.diagnose(`cache observer uncertain: ${reason}`);
              },
            }),
          );
          this.startupGuard();
        }
        if (this.watcher) await this.storage.ownWatchmanFiles();
        this.startupGuard();
        const limits = this.limits;
        const output = {
          bytes: limits.outputBytes,
          itemBytes: limits.itemBytes,
          payloads: limits.entries,
          deliveries: limits.calls,
        };
        this.runtime = new PersonalCacheRuntime({
          workspace: cwd,
          profiles: this.profiles.map((row) => row.profile),
          graph: {
            workspaces: 1,
            observations: 256,
            entries: limits.entries,
            runs: limits.running,
            edges: limits.edges,
            keyBytes: 4096,
            output,
          },
          scheduler: {
            running: limits.running,
            pending: limits.pending,
            requests: limits.calls,
            requesters: limits.calls,
            work: limits.entries,
            validationMs: 10000,
            completionMs: 10000,
            calls: limits.calls,
            streamBytes: limits.itemBytes,
            streamChunks: 4096,
            replies: output,
          },
          captures: limits.captures,
          inputs: { paths: limits.inputPaths, bytes: limits.inputBytes, entries: 256, ms: 10000 },
          barrier: async () => {
            const barriers = [];
            for (const tracker of this.trackers) barriers.push(await tracker.barrier());
            return {
              clock: barriers.map((row) => row.clock).join(";"),
              epoch: barriers.reduce((n, row) => n + row.epoch, 0),
              changed: barriers.flatMap((row, index) =>
                row.changed.map((name) => join(this.trackers[index].root, name)),
              ),
              fresh: barriers.every((row) => row.fresh),
            };
          },
          closeInputs: async () => {
            for (const tracker of this.trackers) tracker.close();
          },
          start: async (invocation, options) => {
            this.launches++;
            return startPersonalBash(invocation, { ...options, owner });
          },
        });
        const backend = new CacheShellBackend(this.runtime);
        if (!this.authorized()) throw Error("cache startup authority changed before broker admission");
        this.root = new CacheNativeRoot({
          parent: owner,
          cwd,
          options: this.config.nativeOptions,
          native: this.installed.native,
          authorize: () => this.authorized(),
          authorizeCall: (input, call) => this.authorizeCall(input, call.toolCallId),
          images: {
            directory: this.storage.path,
            image: assets.shell,
            sha256: assets.shellSha256,
            socket: join(this.storage.path, "broker.sock"),
            admissionMs: 10000,
            maxLeases: limits.calls,
            maxImageBytes: 8 * 1024 * 1024,
            maxStorageBytes: Math.max(1, limits.imageBytes - this.storage.stats().reservedBytes),
          },
          context: { checks: limits.calls, maxReadBytes: 1200000, maxTotalBytes: 3000000, timeoutMs: 3000 },
          maxCalls: limits.calls,
          maxPending: limits.calls,
          handshakeMs: 10000,
          readinessMs: 10000,
          brokerPath,
          eligible: (invocation) => this.profiles.some((row) => row.matches(invocation)),
          admit: async (invocation, context) => {
            const profile = this.profiles.find((row) => row.matches(invocation));
            const call = this.calls.get(context.toolCallId);
            try {
              const admitted = profile ? await profile.admit(invocation, () =>
                this.authorized() && this.enabled && !this.cacheStopped && !context.signal.aborted && this.calls.get(context.toolCallId) === call,
              ) : false;
              if (call) call.reason = profile?.reason ?? "no exact eligible profile";
              return admitted;
            } catch (error) {
              if (
                !(error instanceof CacheProductReadUnavailable) &&
                !["ENOENT", "EACCES", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")
              )
                throw error;
              if (call) call.reason = "known input/runtime uncertainty; ordinary pre-issuance execution";
              this.diagnose(`cache input unavailable before issuance: ${String(error)}`);
              return false;
            }
          },
          run: async (invocation, options) => {
            const call = this.calls.get(options.call.toolCallId);
            if (!call) throw Error("cache native request owner absent after commitment; not retrying");
            const force = this.force;
            this.force = false;
            const result = await backend.run(invocation, { ...options, force });
            call.completion = result;
            return result;
          },
          closeBackend: () => this.runtime!.shutdown(),
          onError: (error) => this.fault(error),
        });
        await this.root.ready;
        this.startupGuard();
        await this.storage.ownSocket("broker.sock");
        this.startupGuard();
        if (!this.authorized()) throw Error("cache authority changed during startup");
        this.diagnose("cache enabled: explicit GNU fixture, personal best effort; no performance/QA acceptance claim");
      })
      .catch((error) => {
        if (!(error instanceof CacheStartupStopped)) this.fault(error);
        this.enabled = false;
        // Preserve original startup failure and all actual cleanup capabilities; do not launch replacements.
        throw error;
      }));
  }
  private diagnose(message: string) {
    try {
      this.config.onDiagnostic(message);
    } catch (error) {
      console.error("cache diagnostic failed", error);
    }
  }
  private fault(error: unknown) {
    this.failures.push(error);
    this.diagnose(`cache unavailable: ${String(error)}`);
  }
  private record(toolCallId: string, call: Call) {
    const completion = call.completion,
      resolution = completion?.resolution,
      outcome = resolution?.outcome;
    const event: CacheHistory = {
      cacheVersion: 1,
      event: "execution_cache",
      epoch: this.epoch,
      rootSessionId: this.rootSessionId,
      requester: this.requester,
      workspace: this.workspace,
      requestId: resolution?.requestId ?? call.id,
      toolCallId,
      decision:
        call.control ??
        (call.rejected ? "reject" : completion?.bypassReason ? "bypass" : (resolution?.kind ?? "bypass")),
      reason: completion?.bypassReason ?? call.reason,
      invocationFingerprint: call.fingerprint,
      inputFingerprint: resolution?.inputFingerprint ?? null,
      profileId: resolution?.profileId ?? null,
      executionId: resolution?.executionId ?? null,
      originalExecutionId: resolution?.kind === "reuse" ? (resolution.executionId ?? null) : null,
      requestedAt: call.requestedAt,
      deliveredAt: new Date().toISOString(),
      executionStartedAt: outcome?.startedAt ?? null,
      executionEndedAt: outcome?.endedAt ?? null,
      exitCode: outcome?.exitCode ?? null,
      signal: outcome?.signal ?? null,
      cancelled: outcome?.cancelled ?? null,
      timedOut: outcome?.timedOut ?? null,
      published: resolution?.published === true,
      outputDigest: outcome ? createHash("sha256").update(outcome.output).digest("hex") : null,
      coverage: outcome ? "personal-best-effort-v1" : "ordinary-native-unobserved",
      requestElapsedMs: performance.now() - call.started,
    };
    if (!validateCacheHistory(event)) {
      this.diagnose("optional cache history malformed; native outcome unchanged");
      return;
    }
    this.last = Object.freeze(event);
    try {
      this.config.onHistory?.(event);
    } catch (cause) {
      this.diagnose(String(new Error("optional cache history consumer failed; native outcome unchanged", { cause })));
    }
    if (!this.ledgerPath || (this.stopping && !this.calls.has(toolCallId))) return;
    if (this.telemetry.size >= this.limits.calls) {
      this.diagnose("optional cache telemetry lost: bounded writer queue full");
      return;
    }
    const task = Promise.resolve()
      .then(async () => {
        if (!validateCacheHistory(event)) throw Error("cache history contract malformed");
        await appendRecord(this.ledgerPath!, "control", event, { readTail: (path, maxBytes) => this.readers.readTail(path, maxBytes) });
      })
      .catch((error) => this.diagnose(`cache telemetry lost (native outcome unchanged): ${String(error)}`));
    this.telemetry.add(task);
    void task.then(() => this.telemetry.delete(task));
  }
  clear() {
    this.runtime?.clear();
    this.record("operator:clear", {
      id: randomUUID(),
      requestedAt: new Date().toISOString(),
      started: performance.now(),
      fingerprint: null,
      reason: "operator cleared reusable state; never hydrate history",
      control: "clear",
    });
    this.diagnose("cache cleared; historical records retained");
  }
  forceNext() {
    if (!this.enabled || !this.root || this.calls.size)
      throw Error("force requires an enabled cache with no active native calls");
    this.force = true;
  }
  status() {
    return {
      epoch: this.epoch,
      enabled: this.enabled,
      closed: this.closed,
      installedPi: this.installed.version,
      launches: this.launches,
      limits: this.limits,
      bufferedReservations: cacheProductBufferBudget(this.limits),
      budgetExclusions: "JS/SDK accumulator/helper heaps/kernel memory and growing Watchman files; not a total-RSS/disk guarantee",
      failures: this.failures.map(String),
      runtime: this.runtime?.stats(),
      native: this.root?.stats(),
      readers: this.readers.stats(),
      storage: this.storage.stats(),
      profiles: this.profiles.map((row) => ({ id: row.profile.id, reason: row.reason })),
      limitation: "SDK-owned Bash only; default CLI/custom/Herdr/captured-child attachments are not qualified",
    };
  }
  explain() {
    return { status: this.status(), last: this.last ?? null };
  }
  disable(): Promise<void> {
    if (this.disabling) return this.disabling;
    this.enabled = false;
    this.cacheStopped = true;
    this.cancellation.abort(new CacheStartupStopped("cache helper admission intentionally stopped")); // Never the ordinary factory.
    return (this.disabling = Promise.resolve().then(async () => {
    await this.starting?.catch((error) => {
      if (!(error instanceof CacheStartupStopped) && !this.failures.includes(error)) throw error;
    });
    const resources = await Promise.allSettled([
      this.root?.disableCaching(),
      this.runtime?.shutdown(),
      this.watcher?.stop(),
    ]);
    for (const tracker of this.trackers) tracker.close();
    await Promise.allSettled([...this.telemetry]);
    const readerStop = await Promise.allSettled([this.readers.join()]);
    const errors = [...resources, ...readerStop].flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
    if (!errors.length) {
      try {
        if (this.root && this.storage.stats().directoryOwned) await this.storage.ownSocket("broker.sock", true);
        if (this.watcher && this.storage.stats().directoryOwned) await this.storage.ownWatchmanFiles();
        await this.storage.close();
      } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      this.failures.push(...errors);
      throw new AggregateError(errors, "cache disable cleanup unresolved; retain");
    }
    this.record("operator:disable", {
      id: randomUUID(),
      requestedAt: new Date().toISOString(),
      started: performance.now(),
      fingerprint: null,
      reason: "operator disabled optimization for this epoch",
      control: "disable",
    });
    this.diagnose(
      "cache disabled for this epoch; ordinary native Bash remains available; restart cold to enable again",
    );
    }));
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.enabled = false;
    this.stopping = Promise.resolve().then(async () => {
      const startup = await Promise.allSettled([this.starting, this.disabling]);
      const resources = await Promise.allSettled([
        this.root?.shutdown(),
        this.ordinaryFactory.shutdown(),
        this.runtime?.shutdown(),
        this.watcher?.stop(),
      ]);
      // Command rejections are outcomes, not proof of failed physical cleanup; the two factories own cleanup.
      await Promise.allSettled([...this.nativeTasks]);
      for (const tracker of this.trackers) tracker.close();
      await Promise.allSettled([...this.telemetry]);
      const readerStop = await Promise.allSettled([this.readers.stop()]);
      const errors = [...startup, ...resources, ...readerStop].flatMap((row) => (row.status === "rejected" && !(row.reason instanceof CacheStartupStopped) ? [row.reason] : []));
      if (!errors.length) {
        try {
          if (this.root && this.storage.stats().directoryOwned) await this.storage.ownSocket("broker.sock", true);
          if (this.watcher && this.storage.stats().directoryOwned) await this.storage.ownWatchmanFiles();
          await this.storage.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        this.failures.push(...errors);
        throw new AggregateError(errors, "cache product cleanup unresolved; retain");
      }
    });
    this.cancellation.abort(new CacheStartupStopped("cache helper admission intentionally stopped"));
    return this.stopping;
  }
  recover(): Promise<void> {
    if (!this.closed && !this.cacheStopped) throw Error("disable/stop cache before recovery");
    return (this.recovering ??= Promise.resolve().then(async () => {
    await Promise.allSettled([this.stopping, this.disabling]);
    await this.readers.stop().catch((error) => this.diagnose(`original cache reader stop failed: ${String(error)}`));
    await this.readers.recover();
    await this.watcher?.retryCleanup();
    await this.root?.recoverResources();
    if (this.closed) await this.ordinaryFactory.recover();
    // Failed startup may have no returned handle; retain and invoke its exact typed supervisor capability.
    const recover = async (failure: unknown): Promise<void> => {
      if (failure instanceof CacheSupervisorTerminationError || failure instanceof BoundedReadCleanupError)
        await failure.cleanup();
      else if (failure instanceof AggregateError) for (const nested of failure.errors) await recover(nested);
    };
    for (const failure of this.failures) await recover(failure);
    if (
      this.root &&
      (this.root.stats().factory.owned ||
        this.root.stats().issuer.owned ||
        this.root.stats().images.rootOwned ||
        this.root.stats().context.owned)
    )
      throw Error("native owners remain; explicit original-capability recovery required");
    if (this.root && this.storage.stats().directoryOwned) await this.storage.ownSocket("broker.sock", true);
    if (this.watcher && this.storage.stats().directoryOwned) await this.storage.ownWatchmanFiles();
    await this.storage.close().catch((error) => {
      this.failures.push(error);
      this.diagnose(`original cache storage stop failed: ${String(error)}`);
    });
    await this.storage.recover();
    }).finally(() => { this.recovering = undefined; }));
  }
}
