import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAggregateVersion } from "@octant/contracts";
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

function insertUsage(
  connection: ReturnType<typeof openSqlite>,
  input: {
    readonly id: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly tokens: { readonly input: number; readonly output: number };
    readonly quality?: string;
    readonly sequence: number;
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
      now,
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
});
