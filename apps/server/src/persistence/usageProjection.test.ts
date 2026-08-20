import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  readUsageRecord,
  queryUsageRecords,
  readAllUsageRecords,
  countUsageRecords,
  purgeUsageOlderThan,
  resetUsageProjection,
  recordUsageAuditEvent,
  readUsageAuditEvents,
} from "./usageProjection";
import { aggregateUsage } from "./usageAggregation";
import { recordsToCsv, recordsToJson, SENSITIVE_EXPORT_FIELDS } from "./usageExport";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { catchUpProjection, rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { USAGE_PROJECTION_SCHEMA_VERSION } from "./usagePersistenceSchema";
import { openSqlite, type SqliteConnection } from "./sqlitePort";
import type { UsageProjectScope } from "../usageProjectScope";

const unfiledScope: UsageProjectScope = { kind: "unfiled" };
const directories: Array<string> = [];
const now = "2026-07-24T12:00:00.000Z";
const ids = {
  actor: "63000000-0000-4000-8000-000000000001",
  correlation: "63000000-0000-4000-8000-000000000002",
  aggregate: "63000000-0000-4000-8000-000000000003",
  provider: "63000000-0000-4000-8000-000000000004",
  entry: "63000000-0000-4000-8000-000000000005",
  manifest: "63000000-0000-4000-8000-000000000006",
  plan: "63000000-0000-4000-8000-000000000007",
  usage: "63000000-0000-4000-8000-000000000008",
  usage2: "63000000-0000-4000-8000-000000000009",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openDatabase(): { connection: SqliteConnection; journal: Journal } {
  const directory = mkdtempSync(join(tmpdir(), "octant-usage-proj-"));
  directories.push(directory);
  const path = join(directory, "octant.sqlite3");
  const connection = openSqlite(path);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  return { connection, journal };
}

function contextManifestFixture() {
  return {
    id: ids.manifest,
    subject: { aggregateType: "chat-thread", aggregateId: ids.aggregate },
    providerInstanceId: ids.provider,
    modelId: "gpt-4o",
    entries: [
      {
        id: ids.entry,
        source: { kind: "message", referenceId: "message-1" },
        category: "conversation",
        label: "Conversation history",
        eligibility: {
          providerInstanceId: ids.provider,
          status: "eligible",
          reason: "selected-provider",
        },
        posture: "required",
        retention: "active",
        priority: 100,
        originalSize: 200,
        includedSize: 200,
        tokens: { kind: "known", tokens: 50, accuracy: "exact-tokenizer" },
        state: "included",
        introducedAtTurn: 1,
        lastUsedAtTurn: 1,
        reuseCount: 0,
        preview: { redacted: true, label: "Conversation history" },
      },
    ],
    overrides: { pinnedEntryIds: [], excludedEntryIds: [] },
    createdAt: now,
  };
}

function contextPlanFixture() {
  return {
    id: ids.plan,
    manifestId: ids.manifest,
    safeInputBudget: 100_000,
    plannedInputTokens: 50,
    reserves: {
      response: 4_096,
      reasoning: 0,
      framing: 1_000,
      variance: 500,
      safety: 0,
    },
    entries: [
      {
        entryId: ids.entry,
        state: "included",
        tokens: { kind: "known", tokens: 50, accuracy: "exact-tokenizer" },
        reason: "required",
      },
    ],
    health: "healthy",
    blocked: false,
    remedies: [],
    createdAt: now,
  };
}

function usageReconciliationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.usage,
    planId: ids.plan,
    providerInstanceId: ids.provider,
    modelId: "gpt-4o",
    requestShape: "chat-turn",
    plannedInputTokens: 50,
    actualInputTokens: 50,
    actualOutputTokens: 25,
    varianceTokens: 0,
    observedAt: now,
    ...overrides,
  };
}

function pending(eventName: string, payload: unknown) {
  return {
    eventId: crypto.randomUUID(),
    eventName,
    eventVersion: 1,
    correlationId: ids.correlation,
    actor: { kind: "system", actorId: ids.actor },
    occurredAt: now,
    payload,
  };
}

function appendFullUsageCycle(
  journal: Journal,
  reconciliationOverrides: Record<string, unknown> = {},
) {
  journal.append({
    aggregate: { aggregateType: "context-ledger", aggregateId: ids.aggregate },
    expectedVersion: 0,
    events: [
      pending("context.manifest-created@1", { manifest: contextManifestFixture() }),
      pending("context.plan-created@1", { plan: contextPlanFixture() }),
      pending("context.usage-reconciled@1", {
        reconciliation: usageReconciliationFixture(reconciliationOverrides),
      }),
    ],
  });
}

describe("UsageProjection", () => {
  it("builds a usage record from a full context event cycle", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const record = readUsageRecord(connection, ids.usage);
    expect(record).toBeDefined();
    expect(record!.reconciliationId).toBe(ids.usage);
    expect(record!.providerInstanceId).toBe(ids.provider);
    expect(record!.modelId).toBe("gpt-4o");
    expect(record!.requestShape).toBe("chat-turn");
    expect(record!.inputTokens).toBe(50);
    expect(record!.outputTokens).toBe(25);
    expect(record!.plannedInputTokens).toBe(50);
    expect(record!.varianceTokens).toBe(0);
    expect(record!.quality).toBe("exact");
    expect(record!.subject.aggregateType).toBe("chat-thread");
    expect(record!.subject.aggregateId).toBe(ids.aggregate);
  });

  it("projects authoritative advanced dimensions and keeps missing dimensions unknown", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal, {
      reasoningTokens: 11,
      cacheReadInputTokens: 7,
      cacheWriteInputTokens: 2,
      providerExecutionDurationMs: 840,
    });

    const record = readUsageRecord(connection, ids.usage);
    expect(record).toMatchObject({
      reasoningTokens: 11,
      cacheReadInputTokens: 7,
      cacheWriteInputTokens: 2,
      providerExecutionDurationMs: 840,
    });

    const { connection: unknownConnection, journal: unknownJournal } = openDatabase();
    appendFullUsageCycle(unknownJournal);
    const unknown = readUsageRecord(unknownConnection, ids.usage);
    expect(unknown?.reasoningTokens).toBeUndefined();
    expect(unknown?.cacheReadInputTokens).toBeUndefined();
    expect(unknown?.cacheWriteInputTokens).toBeUndefined();
    expect(unknown?.providerExecutionDurationMs).toBeUndefined();
  });

  it("classifies reconciled quality when variance is non-zero", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal, {
      actualInputTokens: 55,
      varianceTokens: 5,
    });

    const record = readUsageRecord(connection, ids.usage);
    expect(record).toBeDefined();
    expect(record!.quality).toBe("reconciled");
    expect(record!.varianceTokens).toBe(5);
  });

  it("builds attribution from manifest entries", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const record = readUsageRecord(connection, ids.usage);
    expect(record).toBeDefined();
    expect(record!.attribution).toHaveLength(1);
    expect(record!.attribution[0]).toEqual({
      category: "conversation",
      plannedTokens: 50,
      quality: "exact",
    });
  });

  it("does not include prompt bodies, file contents, or credentials in records", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const record = readUsageRecord(connection, ids.usage);
    expect(record).toBeDefined();
    const json = JSON.stringify(record);
    expect(json).not.toContain("promptBody");
    expect(json).not.toContain("fileContents");
    expect(json).not.toContain("credentials");
    expect(json).not.toContain("providerHeaders");
    expect(json).not.toContain("accountId");
    expect(json).not.toContain("message-1");
  });

  it("returns undefined for unknown reconciliation id", () => {
    const { connection } = openDatabase();
    expect(readUsageRecord(connection, "00000000-0000-4000-8000-000000000099")).toBeUndefined();
  });
});

describe("queryUsageRecords", () => {
  it("returns all records with no filter", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records, hasMore } = queryUsageRecords(connection, {}, 100, 0, unfiledScope);
    expect(records).toHaveLength(1);
    expect(hasMore).toBe(false);
  });

  it("filters by provider instance id", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records } = queryUsageRecords(
      connection,
      { providerInstanceId: ids.provider },
      100,
      0,
      unfiledScope,
    );
    expect(records).toHaveLength(1);

    const { records: noRecords } = queryUsageRecords(
      connection,
      { providerInstanceId: "00000000-0000-4000-8000-000000000099" },
      100,
      0,
      unfiledScope,
    );
    expect(noRecords).toHaveLength(0);
  });

  it("filters by quality", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records: exactRecords } = queryUsageRecords(
      connection,
      { quality: "exact" },
      100,
      0,
      unfiledScope,
    );
    expect(exactRecords).toHaveLength(1);

    const { records: staleRecords } = queryUsageRecords(
      connection,
      { quality: "stale" },
      100,
      0,
      unfiledScope,
    );
    expect(staleRecords).toHaveLength(0);
  });

  it("filters by subject", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records } = queryUsageRecords(
      connection,
      { subjectAggregateType: "chat-thread", subjectAggregateId: ids.aggregate },
      100,
      0,
      unfiledScope,
    );
    expect(records).toHaveLength(1);
  });

  it("respects limit and reports hasMore", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records, hasMore } = queryUsageRecords(connection, {}, 0, 0, unfiledScope);
    expect(records).toHaveLength(0);
    expect(hasMore).toBe(true);
  });

  it("paginates with afterSequence", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records: all } = queryUsageRecords(connection, {}, 100, 0, unfiledScope);
    expect(all).toHaveLength(1);

    const { records: afterAll } = queryUsageRecords(connection, {}, 100, 999, unfiledScope);
    expect(afterAll).toHaveLength(0);
  });
});

describe("readAllUsageRecords", () => {
  it("returns all records ordered by sequence", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const records = readAllUsageRecords(connection);
    expect(records).toHaveLength(1);
    expect(records[0]!.reconciliationId).toBe(ids.usage);
  });
});

describe("usage projection rebuild", () => {
  it("rebuilds usage records from journal replay", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const runtime = createPhase1RuntimeRegistries();
    const usageProjection = runtime.projections.get("usage");
    expect(usageProjection).toBeDefined();

    rebuildProjection({
      connection,
      journal,
      projection: usageProjection!,
      clock: () => now,
    });

    const record = readUsageRecord(connection, ids.usage);
    expect(record).toBeDefined();
    expect(record!.quality).toBe("exact");
    expect(record!.inputTokens).toBe(50);
  });
});

describe("usage project scope", () => {
  const scopeIds = {
    project: "63000000-0000-4000-8000-000000000010",
    otherProject: "63000000-0000-4000-8000-000000000011",
    workThread: "63000000-0000-4000-8000-000000000012",
    workUsage: "63000000-0000-4000-8000-000000000014",
  } as const;

  function seedUsageRow(
    connection: SqliteConnection,
    input: {
      readonly reconciliationId: string;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly sequence: number;
    },
  ): void {
    connection
      .prepare(`
        INSERT INTO usage_record_projection (
          reconciliation_id, subject_type, subject_id, provider_instance_id,
          model_id, request_shape, quality, input_tokens, output_tokens,
          planned_input_tokens, variance_tokens, schema_version,
          attribution_json, observed_at, last_sequence, host_id
        ) VALUES (?, ?, ?, ?, 'gpt-4o', 'chat-turn', 'exact', 100, 50, 95, 5, ?, '[]', ?, ?, 'local')
      `)
      .run(
        input.reconciliationId,
        input.subjectType,
        input.subjectId,
        ids.provider,
        USAGE_PROJECTION_SCHEMA_VERSION,
        now,
        input.sequence,
      );
  }

  /** Appends the authoritative `work.thread-created@1` the host records. */
  function seedWorkThread(journal: Journal, threadId: string, projectId: string): void {
    journal.append({
      aggregate: { aggregateType: "work-thread", aggregateId: threadId },
      expectedVersion: 0,
      events: [
        pending("work.thread-created@1", {
          kind: "thread-created",
          thread: {
            id: threadId,
            projectId,
            title: "Work thread",
            lifecycle: "active",
            providerInstanceId: ids.provider,
            modelId: "gpt-4o",
            version: 1,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ],
    });
  }

  function subjectIds(connection: SqliteConnection, scope: UsageProjectScope): Array<string> {
    return queryUsageRecords(connection, {}, 100, 0, scope).records.map((record) =>
      String(record.subject.aggregateId),
    );
  }

  it("keeps a Project's Work usage out of an unfiled window", () => {
    const { connection, journal } = openDatabase();
    seedWorkThread(journal, scopeIds.workThread, scopeIds.project);
    seedUsageRow(connection, {
      reconciliationId: scopeIds.workUsage,
      subjectType: "work-thread",
      subjectId: scopeIds.workThread,
      sequence: 10,
    });

    expect(subjectIds(connection, unfiledScope)).toEqual([]);
  });

  it("reads a Project's own Work usage in that Project's window", () => {
    const { connection, journal } = openDatabase();
    seedWorkThread(journal, scopeIds.workThread, scopeIds.project);
    seedUsageRow(connection, {
      reconciliationId: scopeIds.workUsage,
      subjectType: "work-thread",
      subjectId: scopeIds.workThread,
      sequence: 10,
    });

    expect(subjectIds(connection, { kind: "projects", projectIds: [scopeIds.project] })).toEqual([
      scopeIds.workThread,
    ]);
    expect(
      subjectIds(connection, { kind: "projects", projectIds: [scopeIds.otherProject] }),
    ).toEqual([]);
  });

  it("partitions the ledger so no row is visible to both scopes or to neither", () => {
    const { connection, journal } = openDatabase();
    seedWorkThread(journal, scopeIds.workThread, scopeIds.project);
    seedUsageRow(connection, {
      reconciliationId: scopeIds.workUsage,
      subjectType: "work-thread",
      subjectId: scopeIds.workThread,
      sequence: 10,
    });
    seedUsageRow(connection, {
      reconciliationId: ids.usage,
      subjectType: "context-ledger",
      subjectId: ids.aggregate,
      sequence: 12,
    });

    const unfiled = subjectIds(connection, unfiledScope);
    const filed = subjectIds(connection, { kind: "projects", projectIds: [scopeIds.project] });

    expect(unfiled.filter((subject) => filed.includes(subject))).toEqual([]);
    expect([...unfiled, ...filed].sort()).toEqual([scopeIds.workThread, ids.aggregate].sort());
  });
});

describe("queryUsageRecords filter gaps", () => {
  it("filters by request shape", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records } = queryUsageRecords(
      connection,
      { requestShape: "chat-turn" },
      100,
      0,
      unfiledScope,
    );
    expect(records).toHaveLength(1);

    const { records: none } = queryUsageRecords(
      connection,
      { requestShape: "other-shape" },
      100,
      0,
      unfiledScope,
    );
    expect(none).toHaveLength(0);
  });

  it("filters by mode derived from subject type", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records: chatRecords } = queryUsageRecords(
      connection,
      { mode: "chat" },
      100,
      0,
      unfiledScope,
    );
    expect(chatRecords).toHaveLength(1);

    const { records: codeRecords } = queryUsageRecords(
      connection,
      { mode: "code" },
      100,
      0,
      unfiledScope,
    );
    expect(codeRecords).toHaveLength(0);
  });

  it("filters by host id (local host boundary)", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records: localRecords } = queryUsageRecords(
      connection,
      { hostId: "local" },
      100,
      0,
      unfiledScope,
    );
    expect(localRecords).toHaveLength(1);

    const { records: remoteRecords } = queryUsageRecords(
      connection,
      { hostId: "remote-host" },
      100,
      0,
      unfiledScope,
    );
    expect(remoteRecords).toHaveLength(0);
  });

  it("filters by attribution category", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records } = queryUsageRecords(
      connection,
      { category: "conversation" },
      100,
      0,
      unfiledScope,
    );
    expect(records).toHaveLength(1);

    const { records: none } = queryUsageRecords(
      connection,
      { category: "tool-results" },
      100,
      0,
      unfiledScope,
    );
    expect(none).toHaveLength(0);
  });
});

describe("usage aggregation", () => {
  it("builds daily, weekly, cumulative, and top consumers from records", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);

    const { records } = queryUsageRecords(connection, {}, 100, 0, unfiledScope);
    const aggregation = aggregateUsage(records);
    expect(aggregation.byDay).toHaveLength(1);
    expect(aggregation.byDay[0]!.inputTokens).toBe(50);
    expect(aggregation.byDay[0]!.exactCount).toBe(1);
    expect(aggregation.byWeek).toHaveLength(1);
    expect(aggregation.cumulative).toHaveLength(1);
    expect(aggregation.cumulative[0]!.cumulativeInputTokens).toBe(50);
    expect(aggregation.topConsumers).toHaveLength(1);
    expect(aggregation.topConsumers[0]!.subjectType).toBe("chat-thread");
  });

  it("aggregates measured advanced dimensions without treating unknown as zero", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal, {
      reasoningTokens: 11,
      cacheReadInputTokens: 7,
      providerExecutionDurationMs: 840,
    });
    const { records } = queryUsageRecords(connection, {}, 100, 0, unfiledScope);
    const aggregation = aggregateUsage(records);
    expect(aggregation.totals.totalReasoningTokens).toBe(11);
    expect(aggregation.totals.totalCacheReadInputTokens).toBe(7);
    expect(aggregation.totals.totalCacheWriteInputTokens).toBeUndefined();
    expect(aggregation.totals.totalProviderExecutionDurationMs).toBe(840);
  });
});

describe("usage retention and reset", () => {
  it("purges records older than a threshold", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);
    expect(countUsageRecords(connection)).toBe(1);

    const purged = purgeUsageOlderThan(connection, "2026-07-25T00:00:00.000Z");
    expect(purged).toBe(1);
    expect(countUsageRecords(connection)).toBe(0);
  });

  it("resets all usage records and returns the purged count", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);
    const count = resetUsageProjection(connection);
    expect(count).toBe(1);
    expect(countUsageRecords(connection)).toBe(0);
  });
});

describe("usage audit log", () => {
  it("records reset, purge, and export audit events without sensitive content", () => {
    const { connection } = openDatabase();
    recordUsageAuditEvent(connection, {
      action: "reset",
      purgedCount: 2,
      details: { reason: "user-requested" },
      occurredAt: now,
    });
    recordUsageAuditEvent(connection, {
      action: "purge",
      purgedCount: 1,
      details: { olderThan: now },
      occurredAt: now,
    });
    recordUsageAuditEvent(connection, {
      action: "export",
      purgedCount: 0,
      details: { format: "csv" },
      occurredAt: now,
    });

    const events = readUsageAuditEvents(connection);
    expect(events).toHaveLength(3);
    expect(events[0]!.action).toBe("reset");
    expect(events[1]!.action).toBe("purge");
    expect(events[2]!.action).toBe("export");
    for (const event of events) {
      const json = event.details_json;
      for (const field of SENSITIVE_EXPORT_FIELDS) {
        expect(json).not.toContain(field);
      }
    }
  });
});

describe("usage export privacy", () => {
  it("CSV export contains only safe fields and no sensitive content", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);
    const { records } = queryUsageRecords(connection, {}, 100, 0, unfiledScope);
    const csv = recordsToCsv(records);
    expect(csv).toContain("reconciliationId");
    expect(csv).toContain(ids.usage);
    for (const field of SENSITIVE_EXPORT_FIELDS) {
      expect(csv).not.toContain(field);
    }
    expect(csv).not.toContain("message-1");
  });

  it("JSON export contains only safe fields and no sensitive content", () => {
    const { connection, journal } = openDatabase();
    appendFullUsageCycle(journal);
    const { records } = queryUsageRecords(connection, {}, 100, 0, unfiledScope);
    const json = recordsToJson(records);
    const parsed = JSON.parse(json) as ReadonlyArray<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    const keys = Object.keys(parsed[0]!);
    for (const field of SENSITIVE_EXPORT_FIELDS) {
      expect(keys).not.toContain(field);
    }
  });
});
