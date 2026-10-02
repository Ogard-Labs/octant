import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAggregateVersion, decodeProjectId } from "@octant/contracts";
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
  },
): void {
  connection
    .prepare(
      `INSERT INTO usage_record_projection (
        reconciliation_id, subject_type, subject_id, provider_instance_id, model_id,
        request_shape, quality, input_tokens, output_tokens, reasoning_tokens,
        cache_read_input_tokens, cache_write_input_tokens, provider_execution_duration_ms,
        planned_input_tokens, variance_tokens, schema_version, attribution_json,
        observed_at, last_sequence, host_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.tokens.input,
      0,
      2,
      "[]",
      input.observedAt ?? now,
      input.sequence,
      "local",
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
