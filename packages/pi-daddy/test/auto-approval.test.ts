import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { makeCatalog, classifyToolNames } from "../src/kernel/catalog.ts";
import { createGrantsSession } from "../extensions/session.ts";
import { obtainApprovals, republishable } from "../extensions/approvals.ts";
import { recordDelegationDecision } from "../extensions/delegation-ledger.ts";
import { planWithApprovals } from "../extensions/run-delegation.ts";
import { createApprovalGate, createApprovalGateProvider, SCOPE_LABELS } from "../src/governance/approval-prompt.ts";
import type { AutoModeReader, PendingApproval } from "../src/kernel/auto-mode.ts";
import { appendLedgerEvent, buildAutoModeConfigEvent } from "../src/governance/ledger.ts";
import { validateLedgerV3Event } from "../src/governance/ledger-v3-validation.ts";
import { verifyLedger } from "../src/governance/ledger-report.ts";
import { readRecords } from "../src/governance/record.ts";
import { cleanupTempDirs, tempDir } from "./tmp.ts";

after(cleanupTempDirs);

function policy(initial = false) {
  let enabled = initial;
  const waiters = new Set<() => void>();
  const pending = new Map<string, PendingApproval>();
  let admissions = 0;
  const reader: AutoModeReader = {
    reference: { socketPath: "/unused-auto-test.sock", token: "a".repeat(48), ownerId: "b".repeat(32) },
    async read() {
      return {
        enabled,
        source: "session",
        ownerId: "b".repeat(32),
        revision: 0,
        pendingApprovals: [...pending.values()],
      };
    },
    async admit(signal) {
      admissions++;
      return !signal?.aborted && enabled;
    },
    waitEnabled(signal) {
      return new Promise<void>((resolve, reject) => {
        const abort = () => {
          waiters.delete(wake);
          reject(new Error("aborted"));
        };
        const wake = () => {
          signal.removeEventListener("abort", abort);
          waiters.delete(wake);
          resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else if (enabled) wake();
        else waiters.add(wake);
      });
    },
    trackPending(value) {
      pending.set(value.id, value);
      return () => {
        pending.delete(value.id);
      };
    },
    async close() {},
  };
  return {
    reader,
    pending,
    get admissions() {
      return admissions;
    },
    set(value: boolean) {
      enabled = value;
      if (value) for (const wake of [...waiters]) wake();
    },
  };
}

async function fixture(enabled = true) {
  const auto = policy(enabled);
  const session = createGrantsSession(undefined);
  session.cwd = await tempDir("auto-approval-");
  session.ownGrant = ["tool:read", "tool:bash", "tool:write"];
  session.gated = ["tool:bash", "tool:write"];
  session.catalog = makeCatalog(classifyToolNames(["read", "bash", "write", "fetch"]));
  session.catalogReady = Promise.resolve(session.catalog);
  session.maxDepth = 3;
  session.depth = 0;
  session.autoMode = auto.reader;
  let published = 0;
  session.publishChildEnv = () => {
    published++;
  };
  const ctx = {
    hasUI: true,
    mode: "interactive",
    ui: {
      notify() {},
      async select(_title?: string): Promise<string | undefined> {
        throw new Error("unexpected human dialog");
      },
    },
  };
  return {
    session,
    auto,
    ctx,
    get published() {
      return published;
    },
  };
}

test("Auto permits only this admission with honest once provenance and no reusable authority", async () => {
  const f = await fixture();
  const preview = await obtainApprovals(f.session, ["tool:bash"], "<delegate>", "delegate", null);
  assert.deepEqual(preview.approved, [], "a preview does not acquire Auto permission");
  const result = await planWithApprovals(f.session, { task: "inspect", tools: ["bash"] }, {}, f.ctx);
  assert.equal(result.plan.ok, true, result.plan.reason);
  assert.equal(f.auto.admissions, 1);
  assert.deepEqual(result.approval?.sources, { "tool:bash": "auto" });
  assert.deepEqual(result.approval?.recordedScopes, { "tool:bash": "once" });
  assert.deepEqual(result.approval?.uses, { "tool:bash": { max: 1, remaining: 0 } });
  assert.deepEqual(result.approval?.banked, []);
  assert.equal(f.session.sessionApprovals.size, 0);
  assert.equal(f.session.sessionApprovalBindings.size, 0);
  assert.deepEqual(republishable(f.session), []);
  assert.equal(f.published, 0);

  f.auto.set(false);
  const next = await planWithApprovals(f.session, { task: "next", tools: ["bash"] }, {}, { ...f.ctx, hasUI: false });
  assert.equal(next.plan.ok, false, "a later step cannot coast on the earlier Auto approval");
  assert.equal(next.approval?.gateOutcome, "no-ui");
  assert.equal(f.auto.admissions, 1);
});

test("OFF at final admission reopens only Auto gates and preserves independent manual permissions", async () => {
  const f = await fixture();
  f.session.sessionApprovals.add("tool:write@<delegate>");
  f.auto.reader.admit = async () => {
    f.auto.set(false);
    return false;
  };
  const prompts: string[] = [];
  f.ctx.ui.select = async (title?: string) => {
    prompts.push(title!);
    return SCOPE_LABELS.once;
  };
  const result = await planWithApprovals(f.session, { task: "change", tools: ["bash", "write"] }, {}, f.ctx);
  assert.equal(result.plan.ok, true, result.plan.reason);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /tool:bash/);
  assert.deepEqual(result.approval?.sources, { "tool:write": "session", "tool:bash": "prompt" });
  assert.equal(f.session.sessionApprovals.has("tool:write@<delegate>"), true);
  assert.equal(f.session.sessionApprovals.has("tool:bash@<delegate>"), false);
});

test("Auto cannot lift a missing capability or a canceled admission", async () => {
  const f = await fixture();
  const denied = await planWithApprovals(f.session, { task: "escape", tools: ["fetch"] }, {}, f.ctx);
  assert.equal(denied.plan.ok, false);
  assert.equal(denied.approval, undefined);
  assert.equal(f.auto.admissions, 0);
  const controller = new AbortController();
  controller.abort();
  const aborted = await planWithApprovals(
    f.session,
    { task: "canceled", tools: ["bash"] },
    {},
    f.ctx,
    controller.signal,
  );
  assert.equal(aborted.plan.ok, false);
  assert.equal(aborted.approval?.gateOutcome, "aborted");
});

test("ON releases the actual pending prompt and every concurrent caller gets its own Auto once", async () => {
  const auto = policy();
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let selects = 0,
    uiCanceled = 0;
  const gate = createApprovalGateProvider()({
    autoMode: auto.reader,
    hasUI: true,
    mode: "interactive",
    ui: {
      notify() {},
      select(_title, _labels, options) {
        selects++;
        entered();
        return new Promise((resolve) =>
          options?.signal?.addEventListener(
            "abort",
            () => {
              uiCanceled++;
              resolve(undefined);
            },
            { once: true },
          ),
        );
      },
    },
  });
  const request = { capability: "tool:bash", subject: "<delegate>", path: "delegate" as const };
  const first = gate.request(request);
  await opened;
  const second = gate.request(request);
  assert.equal(auto.pending.size, 1);
  auto.set(true);
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes, [
    { kind: "granted", scope: "once", source: "auto" },
    { kind: "granted", scope: "once", source: "auto" },
  ]);
  assert.equal(selects, 1);
  assert.equal(uiCanceled, 1);
  assert.equal(auto.pending.size, 0);
  assert.equal(auto.admissions, 0, "a prompt wake-up is provisional, not a final admission");
});

test("deadline or cancellation settles pending Auto observers without granting permission", async () => {
  for (const expected of ["expired", "aborted"] as const) {
    const auto = policy();
    const controller = new AbortController();
    let entered!: () => void;
    const opened = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = createApprovalGate({
      autoMode: auto.reader,
      hasUI: true,
      mode: "interactive",
      ...(expected === "expired" ? { timeoutMs: 1 } : {}),
      ui: {
        notify() {},
        select(_title, _labels, options) {
          entered();
          return new Promise((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
          );
        },
      },
    });
    const outcome = gate.request({
      capability: "tool:bash",
      subject: "<delegate>",
      path: "delegate",
      signal: controller.signal,
    });
    await opened;
    if (expected === "aborted") controller.abort();
    assert.equal((await outcome).kind, expected);
    assert.equal(auto.pending.size, 0);
    auto.set(true);
    assert.equal(auto.admissions, 0);
  }
});

test("Auto policy failure is a refusal, not a prompt or admission bypass", async () => {
  for (const stage of ["read", "admit"] as const) {
    const f = await fixture();
    f.auto.reader[stage] = async () => {
      throw new Error("owner unavailable");
    };
    const result = await planWithApprovals(f.session, { task: "inspect", tools: ["bash"] }, {}, f.ctx);
    assert.equal(result.plan.ok, false);
    assert.equal(result.approval?.gateOutcome, "error");
    assert.match(result.approval?.reason ?? "", /owner unavailable/);
    assert.deepEqual(result.approval?.approved, []);
    assert.deepEqual(result.approval?.sources, {});
    assert.equal(f.auto.admissions, 0);
  }
});

test("Auto decisions and configuration survive real ledger write/read with closed schema validation", async () => {
  const f = await fixture();
  const manual = { capability: "tool:write", subject: "<delegate>", scope: "once" as const };
  const result = await planWithApprovals(
    f.session,
    { task: "inspect", tools: ["bash", "write"] },
    {},
    f.ctx,
    undefined,
    [manual],
  );
  assert.equal(result.plan.ok, true, result.plan.reason);
  const path = join(f.session.cwd, "grants.jsonl");
  f.session.ledgerPath = path;
  await recordDelegationDecision({
    session: f.session,
    plan: result.plan,
    approval: result.approval,
    ids: {
      executionId: "exec:00000000-0000-4000-8000-000000000001",
      parentExecutionId: null,
      parentId: "d0",
      childId: "d0.1",
    },
    approvalFacts: {
      approved: ["tool:write"],
      sources: { "tool:write": "prompt" },
      scopes: { "tool:write": "once" },
      expiresAt: {},
      uses: { "tool:write": { max: 1, remaining: 0 } },
      humanDenied: false,
    },
  });
  const report = await verifyLedger(path);
  assert.equal(report.approvals.bySource.auto, 1);
  assert.equal(
    report.approvals.bySource.prompt,
    1,
    "the upfront manual once remains attributed beside fresh Auto permission",
  );
  const event = buildAutoModeConfigEvent({
    episodeId: f.session.episodeId,
    enabled: true,
    source: "session",
    revision: 1,
    now: new Date(),
  });
  await appendLedgerEvent({ path, strict: true }, event);
  const records = readRecords<Record<string, unknown>>(await readFile(path, "utf8"));
  assert.equal(records.records.at(-1)?.body.event, "session_config");
  assert.deepEqual(records.records.at(-1)?.body.autoMode, { enabled: true, source: "session", revision: 1 });
  const schema = JSON.parse(
    await readFile(new URL("../contracts/ledger-record/v1/governance-event.schema.json", import.meta.url), "utf8"),
  );
  const validator = Compile(schema);
  assert.equal(validator.Check(event), true);
  for (const invalid of [
    { ...event, autoMode: { ...event.autoMode, revision: -1 } },
    { ...event, autoMode: { ...event.autoMode, secret: "extra" } },
    { ...event, autoMode: undefined },
    { ...event, trigger: "grants-models" },
  ]) {
    assert.notEqual(validateLedgerV3Event(invalid), null);
    assert.equal(validator.Check(JSON.parse(JSON.stringify(invalid))), false, JSON.stringify(invalid));
  }
});

test("native child viewer cannot answer approvals; live Auto and existing approval remain usable", async () => {
  const f = await fixture(false);
  f.session.depth = 1;
  const ctx = { ...f.ctx, mode: "tui" };
  const blocked = await obtainApprovals(f.session, ["tool:write"], "<delegate>", "delegate", ctx);
  assert.equal(blocked.gateOutcome, "no-ui");
  assert.match(blocked.reason!, /view-only child/);
  assert.deepEqual(blocked.approved, []);
  f.auto.set(true);
  const auto = await obtainApprovals(f.session, ["tool:write"], "<delegate>", "delegate", ctx);
  assert.deepEqual(auto.approved, ["tool:write"]);
  assert.equal(auto.sources["tool:write"], "auto");
  f.auto.set(false);
  f.session.sessionApprovals.add("tool:write@<delegate>");
  const existing = await obtainApprovals(f.session, ["tool:write"], "<delegate>", "delegate", ctx);
  assert.deepEqual(existing.approved, ["tool:write"]);
  assert.equal(existing.sources["tool:write"], "session");
});
