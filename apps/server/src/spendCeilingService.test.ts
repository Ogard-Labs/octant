import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAggregateVersion, decodeAgentRunId, decodeProjectId } from "@octant/contracts";
import { recordAgentRunTurnUsage } from "./agentRun/agentRunUsageLedger";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite } from "./persistence/sqlitePort";
import { decodeSpendCeilingReservationId, SpendCeilingService } from "./spendCeilingService";

const directories: Array<string> = [];
const now = "2026-09-09T12:00:00.000Z";
const ids = {
  thread: "73000000-0000-4000-8000-000000000001",
  project: "73000000-0000-4000-8000-000000000002",
  child: "73000000-0000-4000-8000-000000000003",
  provider: "73000000-0000-4000-8000-000000000004",
  reservationA: decodeSpendCeilingReservationId("73000000-0000-4000-8000-0000000000aa"),
  reservationB: decodeSpendCeilingReservationId("73000000-0000-4000-8000-0000000000bb"),
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openService(options?: { readonly clock?: () => string }) {
  const directory = mkdtempSync(join(tmpdir(), "octant-spend-ceiling-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const service = new SpendCeilingService({
    connection,
    journal,
    clock: options?.clock ?? (() => now),
    uuid: () => crypto.randomUUID(),
    threadExists: () => true,
    projectExists: () => true,
  });
  return { connection, journal, service, path: join(directory, "octant.sqlite3") };
}

function remainingOf(
  snapshot: ReturnType<SpendCeilingService["snapshot"]>,
  scope: "project" | "thread",
) {
  if ("kind" in snapshot) throw new Error("snapshot was unauthorized");
  return scope === "project" ? snapshot.projectRemaining : snapshot.threadRemaining;
}

function insertUsage(
  connection: ReturnType<typeof openSqlite>,
  input: {
    readonly id: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly tokens: { readonly input: number; readonly output: number };
    readonly quality?: string;
    readonly sequence: number;
    readonly observedAt?: string;
    readonly costUsdMicros?: number;
    readonly costKind?: "provider-recorded" | "api-estimate";
  },
): void {
  connection
    .prepare(
      `INSERT INTO usage_record_projection (
        reconciliation_id, subject_type, subject_id, provider_instance_id, model_id,
        request_shape, quality, input_tokens, output_tokens, reasoning_tokens,
        cache_read_input_tokens, cache_write_input_tokens, provider_execution_duration_ms,
        cost_usd_micros, cost_kind,
        planned_input_tokens, variance_tokens, schema_version, attribution_json,
        observed_at, last_sequence, host_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.subjectType,
      input.subjectId,
      ids.provider,
      "gpt-4o",
      "chat-turn",
      input.quality ?? "exact",
      input.tokens.input,
      input.tokens.output,
      null,
      null,
      null,
      null,
      input.costUsdMicros ?? null,
      input.costUsdMicros === undefined ? null : (input.costKind ?? "provider-recorded"),
      input.tokens.input,
      0,
      2,
      "[]",
      input.observedAt ?? now,
      input.sequence,
      "local",
    );
}

function seedChatThread(
  connection: ReturnType<typeof openSqlite>,
  threadId: string,
  projectId: string | null,
): void {
  connection
    .prepare(
      `INSERT INTO chat_thread_projection (
        thread_id, project_id, lifecycle, schema_version, thread_json,
        aggregate_version, updated_at, last_sequence
      ) VALUES (?, ?, 'active', 1, '{}', 1, ?, 1)`,
    )
    .run(threadId, projectId, now);
}

/** The journaled request that names a child run's parent thread and mode. */
function seedChildRun(
  connection: ReturnType<typeof openSqlite>,
  runId: string,
  parentThreadId: string,
): void {
  connection
    .prepare(
      `INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version, event_name,
        event_version, correlation_id, actor_kind, actor_id, occurred_at, payload_json
      ) VALUES (?, 'agent-run', ?, 1, 'agent.run-requested@1', 1, ?, 'system', ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      runId,
      crypto.randomUUID(),
      ids.provider,
      now,
      JSON.stringify({ run: { id: runId, parentThreadId, routingReceipt: { mode: "chat" } } }),
    );
}

describe("SpendCeilingService", () => {
  it("reserves remaining tokens so concurrent turns cannot both admit past the ceiling", () => {
    const { service } = openService();
    const set = service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 1_000 },
      window: { kind: "lifetime" },
    });
    expect(set.kind).toBe("set");

    const first = service.admit({
      reservationId: ids.reservationA,
      threadId: ids.thread,
      threadType: "chat-thread",
      turnUpperBoundTokens: 600,
    });
    expect(first).toMatchObject({ status: "admitted", reservedTokens: 600 });

    const second = service.admit({
      reservationId: ids.reservationB,
      threadId: ids.thread,
      threadType: "chat-thread",
      turnUpperBoundTokens: 600,
    });
    expect(second.status).toBe("refused");
    if (second.status !== "refused") return;
    expect(second.refusal.kind).toBe("exhausted");
    expect(second.refusal.message).toContain("thread");
  });

  it("counts child agent-run usage against the parent thread ceiling", () => {
    const { connection, service } = openService();
    service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 1_000 },
      window: { kind: "lifetime" },
    });
    insertUsage(connection, {
      id: "73000000-0000-4000-8000-000000000101",
      subjectType: "agent-run",
      subjectId: ids.child,
      tokens: { input: 700, output: 200 },
      sequence: 1,
    });
    const admission = service.admit({
      reservationId: ids.reservationA,
      threadId: ids.thread,
      threadType: "chat-thread",
      turnUpperBoundTokens: 200,
      childSubjectIds: [ids.child],
    });
    expect(admission.status).toBe("refused");
    if (admission.status !== "refused") return;
    expect(admission.refusal.kind).toBe("exhausted");
  });

  it("counts a child run under another thread of the same Project against the Project ceiling", () => {
    const { connection, journal, service } = openService();
    const sibling = "73000000-0000-4000-8000-000000000011";
    const otherProject = "73000000-0000-4000-8000-000000000012";
    const otherThread = "73000000-0000-4000-8000-000000000013";
    const elsewhereChild = "73000000-0000-4000-8000-000000000014";
    seedChatThread(connection, ids.thread, ids.project);
    seedChatThread(connection, sibling, ids.project);
    seedChatThread(connection, otherThread, otherProject);
    seedChildRun(connection, ids.child, sibling);
    seedChildRun(connection, elsewhereChild, otherThread);
    const ledger = { connection, journal, clock: () => now, uuid: () => crypto.randomUUID() };
    // The sibling thread's child spent 900 tokens and $0.50, through the same
    // path a managed child's settle takes; a child in another Project spent more.
    recordAgentRunTurnUsage(ledger, {
      runId: decodeAgentRunId(ids.child),
      providerInstanceId: ids.provider as never,
      modelId: "gpt-4o" as never,
      usage: { inputTokens: 800, outputTokens: 100, costUsd: 0.5 },
    });
    recordAgentRunTurnUsage(ledger, {
      runId: decodeAgentRunId(elsewhereChild),
      providerInstanceId: ids.provider as never,
      modelId: "gpt-4o" as never,
      usage: { inputTokens: 5_000, outputTokens: 0, costUsd: 9 },
    });
    service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "project", projectId: decodeProjectId(ids.project) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 1_000, costBudgetUsdCents: 100 },
      window: { kind: "calendar", period: "day", timeZone: "UTC" },
    });

    // The Project overview reads the child's spend without naming any thread.
    expect(
      remainingOf(
        service.snapshot({ principalKind: "local-window", projectId: ids.project }),
        "project",
      ),
    ).toMatchObject({ committedTokens: 900, usedUsdCents: 50, remainingUsdCents: 50 });
    const admission = service.admit({
      reservationId: ids.reservationA,
      threadId: ids.thread,
      threadType: "chat-thread",
      projectId: ids.project,
      turnUpperBoundTokens: 200,
    });
    expect(admission.status).toBe("refused");
    if (admission.status !== "refused") return;
    expect(admission.refusal).toMatchObject({ kind: "exhausted", scopeKind: "project" });
  });

  it("refuses unavailable usage instead of treating missing tokens as zero", () => {
    const { connection, service } = openService();
    service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 1_000 },
      window: { kind: "lifetime" },
    });
    insertUsage(connection, {
      id: "73000000-0000-4000-8000-000000000102",
      subjectType: "chat-thread",
      subjectId: ids.thread,
      tokens: { input: 0, output: 0 },
      quality: "unavailable",
      sequence: 1,
    });
    const admission = service.admit({
      reservationId: ids.reservationA,
      threadId: ids.thread,
      threadType: "chat-thread",
      turnUpperBoundTokens: 10,
    });
    expect(admission.status).toBe("refused");
    if (admission.status !== "refused") return;
    expect(admission.refusal.kind).toBe("unknown-spend");
  });

  it("refuses a hard-ceiling turn with no per-turn upper bound", () => {
    const { service } = openService();
    service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 1_000 },
      window: { kind: "lifetime" },
    });
    const admission = service.admit({
      reservationId: ids.reservationA,
      threadId: ids.thread,
      threadType: "chat-thread",
    });
    expect(admission.status).toBe("refused");
    if (admission.status !== "refused") return;
    expect(admission.refusal.kind).toBe("missing-turn-bound");
  });

  it("records an overrun and blocks further admission without widening", () => {
    const { service } = openService();
    service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 1_000 },
      window: { kind: "lifetime" },
    });
    expect(
      service.admit({
        reservationId: ids.reservationA,
        threadId: ids.thread,
        threadType: "chat-thread",
        turnUpperBoundTokens: 100,
      }).status,
    ).toBe("admitted");
    service.settle({ reservationId: ids.reservationA, observedTokens: 250 });
    const next = service.admit({
      reservationId: ids.reservationB,
      threadId: ids.thread,
      threadType: "chat-thread",
      turnUpperBoundTokens: 10,
    });
    expect(next.status).toBe("refused");
    if (next.status !== "refused") return;
    expect(next.refusal.kind).toBe("overrun");
  });

  it("does not sum imported provider history into the ceiling", () => {
    const { connection, service } = openService();
    service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 1_000 },
      window: { kind: "lifetime" },
    });
    connection.exec(`
      CREATE TABLE IF NOT EXISTS local_usage_history_projection (
        source_event_id TEXT PRIMARY KEY,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL
      );
      INSERT INTO local_usage_history_projection VALUES ('imported', 999999, 999999);
    `);
    const admission = service.admit({
      reservationId: ids.reservationA,
      threadId: ids.thread,
      threadType: "chat-thread",
      turnUpperBoundTokens: 100,
    });
    expect(admission.status).toBe("admitted");
  });

  it("releases in-flight reservations on restart so a crash cannot leak capacity", () => {
    const first = openService();
    first.service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 1_000 },
      window: { kind: "lifetime" },
    });
    expect(
      first.service.admit({
        reservationId: ids.reservationA,
        threadId: ids.thread,
        threadType: "chat-thread",
        turnUpperBoundTokens: 900,
      }).status,
    ).toBe("admitted");
    first.connection.close();

    const runtime = createPhase1RuntimeRegistries();
    const connection = openSqlite(first.path);
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const restarted = new SpendCeilingService({
      connection,
      journal,
      clock: () => now,
      uuid: () => crypto.randomUUID(),
      threadExists: () => true,
      projectExists: () => true,
    });
    const admission = restarted.admit({
      reservationId: ids.reservationB,
      threadId: ids.thread,
      threadType: "chat-thread",
      turnUpperBoundTokens: 900,
    });
    expect(admission.status).toBe("admitted");
    connection.close();
  });

  it("advances the projected ceiling version when an overrun is recorded", () => {
    const { service } = openService();
    expect(
      service.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
        expectedVersion: decodeAggregateVersion(0),
        policy: { tokenBudget: 1_000 },
        window: { kind: "lifetime" },
      }).kind,
    ).toBe("set");
    expect(
      service.admit({
        reservationId: ids.reservationA,
        threadId: ids.thread,
        threadType: "chat-thread",
        turnUpperBoundTokens: 100,
      }).status,
    ).toBe("admitted");
    service.settle({ reservationId: ids.reservationA, observedTokens: 250 });
    const snapshot = service.snapshot({
      principalKind: "local-window",
      threadId: ids.thread,
      threadType: "chat-thread",
    });
    expect("thread" in snapshot && snapshot.thread?.version).toBe(2);
    const raise = service.execute("local-window", {
      kind: "raise-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(2),
      tokenBudget: 5_000,
    });
    expect(raise.kind).toBe("raised");
  });

  it("refuses a turn once the monetary ceiling is used up", () => {
    const { connection, service } = openService();
    expect(
      service.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
        expectedVersion: decodeAggregateVersion(0),
        policy: { costBudgetUsdCents: 25_00 },
        window: { kind: "lifetime" },
      }).kind,
    ).toBe("set");
    insertUsage(connection, {
      id: "73000000-0000-4000-8000-000000000301",
      subjectType: "chat-thread",
      subjectId: ids.thread,
      tokens: { input: 100, output: 0 },
      sequence: 1,
      costUsdMicros: 25_000_000,
    });
    const admission = service.admit({
      reservationId: ids.reservationA,
      threadId: ids.thread,
      threadType: "chat-thread",
      turnUpperBoundTokens: 100,
    });
    expect(admission).toMatchObject({
      status: "refused",
      refusal: { kind: "exhausted", dimension: "monetary" },
    });
  });

  it("refuses a monetary ceiling when in-window usage has no price", () => {
    const { connection, service } = openService();
    expect(
      service.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
        expectedVersion: decodeAggregateVersion(0),
        policy: { costBudgetUsdCents: 25_00 },
        window: { kind: "lifetime" },
      }).kind,
    ).toBe("set");
    insertUsage(connection, {
      id: "73000000-0000-4000-8000-000000000302",
      subjectType: "chat-thread",
      subjectId: ids.thread,
      tokens: { input: 100, output: 0 },
      sequence: 1,
    });
    const admission = service.admit({
      reservationId: ids.reservationA,
      threadId: ids.thread,
      threadType: "chat-thread",
      turnUpperBoundTokens: 100,
    });
    expect(admission).toMatchObject({
      status: "refused",
      refusal: { kind: "unknown-spend", dimension: "monetary" },
    });
    // The reading names the money budget it cannot measure instead of
    // leaving it out, so a surface can say so beside the other budgets.
    const snapshot = service.snapshot({
      principalKind: "local-window",
      threadId: ids.thread,
      threadType: "chat-thread",
    });
    expect(remainingOf(snapshot, "thread")).toMatchObject({ ceilingUsdCents: 25_00 });
    expect(remainingOf(snapshot, "thread")).not.toHaveProperty("remainingUsdCents");
  });

  it("reads remaining money in cents and raises a money ceiling that survives restart", () => {
    const { connection, journal, service } = openService();
    const scope = {
      kind: "thread" as const,
      threadType: "chat-thread" as const,
      threadId: ids.thread,
    };
    service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope,
      expectedVersion: decodeAggregateVersion(0),
      policy: { costBudgetUsdCents: 25_00 },
      window: { kind: "lifetime" },
    });
    insertUsage(connection, {
      id: "73000000-0000-4000-8000-000000000303",
      subjectType: "chat-thread",
      subjectId: ids.thread,
      tokens: { input: 100, output: 0 },
      sequence: 1,
      costUsdMicros: 10_404_999,
      costKind: "api-estimate",
    });
    const before = service.snapshot({
      principalKind: "local-window",
      threadId: ids.thread,
      threadType: "chat-thread",
    });
    expect(before).toMatchObject({
      threadRemaining: { ceilingUsdCents: 25_00, usedUsdCents: 10_40, remainingUsdCents: 14_60 },
    });

    expect(
      service.execute("local-window", {
        kind: "raise-spend-ceiling",
        scope,
        expectedVersion: decodeAggregateVersion(1),
        costBudgetUsdCents: 10_00,
      }),
    ).toMatchObject({ kind: "refused", refusal: { kind: "not-a-raise" } });
    expect(
      service.execute("local-window", {
        kind: "raise-spend-ceiling",
        scope,
        expectedVersion: decodeAggregateVersion(1),
        costBudgetUsdCents: 40_00,
      }),
    ).toMatchObject({
      kind: "raised",
      ceiling: { policy: { costBudgetUsdCents: 40_00 } },
      previousCostBudgetUsdCents: 25_00,
    });

    const restarted = new SpendCeilingService({
      connection,
      journal,
      clock: () => now,
      uuid: () => crypto.randomUUID(),
    });
    expect(
      restarted.snapshot({
        principalKind: "local-window",
        threadId: ids.thread,
        threadType: "chat-thread",
      }),
    ).toMatchObject({
      thread: { policy: { costBudgetUsdCents: 40_00 } },
      threadRemaining: { ceilingUsdCents: 40_00, usedUsdCents: 10_40, remainingUsdCents: 29_60 },
    });
  });

  it("counts only scoped usage inside the calendar window", () => {
    const { connection, service } = openService();
    expect(
      service.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
        expectedVersion: decodeAggregateVersion(0),
        policy: { tokenBudget: 1_000 },
        window: { kind: "calendar", period: "day", timeZone: "UTC" },
      }).kind,
    ).toBe("set");
    insertUsage(connection, {
      id: "73000000-0000-4000-8000-000000000201",
      subjectType: "chat-thread",
      subjectId: ids.thread,
      tokens: { input: 800, output: 0 },
      sequence: 1,
      observedAt: "2026-09-08T12:00:00.000Z",
    });
    insertUsage(connection, {
      id: "73000000-0000-4000-8000-000000000202",
      subjectType: "chat-thread",
      subjectId: "73000000-0000-4000-8000-000000000099",
      tokens: { input: 900, output: 0 },
      sequence: 2,
      observedAt: now,
    });
    const admission = service.admit({
      reservationId: ids.reservationA,
      threadId: ids.thread,
      threadType: "chat-thread",
      turnUpperBoundTokens: 200,
    });
    expect(admission).toMatchObject({ status: "admitted", reservedTokens: 200 });
  });

  it("journals raise and clear so a person can recover", () => {
    const { service, journal } = openService();
    const set = service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(0),
      policy: { tokenBudget: 100 },
      window: { kind: "lifetime" },
    });
    expect(set.kind).toBe("set");
    const raise = service.execute("local-window", {
      kind: "raise-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(1),
      tokenBudget: 5_000,
    });
    expect(raise.kind).toBe("raised");
    const clear = service.execute("local-window", {
      kind: "clear-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(2),
    });
    expect(clear.kind).toBe("cleared");
    expect(
      service.execute("remote-device", {
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
        expectedVersion: decodeAggregateVersion(3),
        policy: { tokenBudget: 100 },
        window: { kind: "lifetime" },
      }).kind,
    ).toBe("refused");
    void journal;
  });

  it("sets a new ceiling after a clear, on thread and Project scopes", () => {
    const { service } = openService();
    const scopes = [
      { kind: "thread", threadType: "work-thread", threadId: ids.thread },
      { kind: "project", projectId: decodeProjectId(ids.project) },
    ] as const;
    for (const scope of scopes) {
      const window =
        scope.kind === "thread"
          ? ({ kind: "lifetime" } as const)
          : ({ kind: "calendar", period: "day", timeZone: "UTC" } as const);
      expect(
        service.execute("local-window", {
          kind: "set-spend-ceiling",
          scope,
          expectedVersion: decodeAggregateVersion(0),
          policy: { turnBudget: 2 },
          window,
        }).kind,
      ).toBe("set");
      expect(
        service.execute("local-window", {
          kind: "clear-spend-ceiling",
          scope,
          expectedVersion: decodeAggregateVersion(1),
        }).kind,
      ).toBe("cleared");
      const reset = service.execute("local-window", {
        kind: "set-spend-ceiling",
        scope,
        expectedVersion: decodeAggregateVersion(0),
        policy: { turnBudget: 3 },
        window,
      });
      expect(reset).toMatchObject({ kind: "set", ceiling: { version: 3 } });
      expect(
        service.execute("local-window", {
          kind: "raise-spend-ceiling",
          scope,
          expectedVersion: decodeAggregateVersion(3),
          turnBudget: 4,
        }).kind,
      ).toBe("raised");
    }
  });

  it("refuses a Project turn once its daily agent run time is used up, across restart", () => {
    let clock = "2026-09-09T09:00:00.000Z";
    const first = openService({ clock: () => clock });
    first.service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "project", projectId: decodeProjectId(ids.project) },
      expectedVersion: decodeAggregateVersion(0),
      policy: { runTimeBudgetSeconds: 7_200 },
      window: { kind: "calendar", period: "day", timeZone: "UTC" },
    });
    const turn = {
      threadId: ids.thread,
      threadType: "work-thread" as const,
      projectId: ids.project,
    };
    expect(first.service.admit({ ...turn, reservationId: ids.reservationA }).status).toBe(
      "admitted",
    );
    clock = "2026-09-09T10:30:00.000Z";
    first.service.settle({ reservationId: ids.reservationA });
    expect(
      remainingOf(
        first.service.snapshot({ principalKind: "local-window", projectId: ids.project }),
        "project",
      ),
    ).toMatchObject({
      usedRunTimeSeconds: 5_400,
      remainingRunTimeSeconds: 1_800,
    });

    // An in-flight turn's elapsed time counts before it settles.
    expect(first.service.admit({ ...turn, reservationId: ids.reservationB }).status).toBe(
      "admitted",
    );
    clock = "2026-09-09T11:00:00.000Z";
    const third = decodeSpendCeilingReservationId("73000000-0000-4000-8000-0000000000cc");
    const refused = first.service.admit({ ...turn, reservationId: third });
    expect(refused.status).toBe("refused");
    if (refused.status !== "refused") return;
    expect(refused.refusal).toMatchObject({ dimension: "run-time", scopeKind: "project" });
    first.service.settle({ reservationId: ids.reservationB });
    first.connection.close();

    const runtime = createPhase1RuntimeRegistries();
    const connection = openSqlite(first.path);
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => clock,
    });
    const restarted = new SpendCeilingService({
      connection,
      journal,
      clock: () => clock,
      uuid: () => crypto.randomUUID(),
      threadExists: () => true,
      projectExists: () => true,
    });
    expect(restarted.admit({ ...turn, reservationId: third }).status).toBe("refused");
    clock = "2026-09-10T00:00:01.000Z";
    expect(restarted.admit({ ...turn, reservationId: third }).status).toBe("admitted");
    connection.close();
  });

  it("counts turns settled before a turn ceiling was set, charged their elapsed time", () => {
    let clock = now;
    const { service } = openService({ clock: () => clock });
    const turn = { threadId: ids.thread, threadType: "chat-thread" as const };
    service.admit({ ...turn, reservationId: ids.reservationA });
    clock = "2026-09-09T12:00:30.000Z";
    service.settle({ reservationId: ids.reservationA });
    service.execute("local-window", {
      kind: "set-spend-ceiling",
      scope: { kind: "thread", threadType: "chat-thread", threadId: ids.thread },
      expectedVersion: decodeAggregateVersion(0),
      policy: { turnBudget: 2, runTimeBudgetSeconds: 3_600 },
      window: { kind: "lifetime" },
    });
    expect(
      remainingOf(
        service.snapshot({
          principalKind: "local-window",
          threadId: ids.thread,
          threadType: "chat-thread",
        }),
        "thread",
      ),
    ).toMatchObject({ usedTurns: 1, remainingTurns: 1, usedRunTimeSeconds: 30 });
    expect(service.admit({ ...turn, reservationId: ids.reservationB }).status).toBe("admitted");
    const third = decodeSpendCeilingReservationId("73000000-0000-4000-8000-0000000000cc");
    const refused = service.admit({ ...turn, reservationId: third });
    expect(refused.status).toBe("refused");
    if (refused.status !== "refused") return;
    expect(refused.refusal).toMatchObject({ dimension: "turns", ceilingTurns: 2 });
  });
});
