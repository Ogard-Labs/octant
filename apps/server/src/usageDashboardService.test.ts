import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeUsageDashboardResponse, type UsageDashboardRequest } from "@octant/contracts";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { USAGE_PROJECTION_SCHEMA_VERSION } from "./persistence/usagePersistenceSchema";
import { readUsageDashboard } from "./usageDashboardService";
import type { UsageProjectScope } from "./usageProjectScope";

/**
 * The scope of a window bound to no Project. Every case below that is not about
 * scope seeds rows no Project places, so this is the scope that reads them.
 */
const unfiledScope: UsageProjectScope = { kind: "unfiled" };

const directories: Array<string> = [];
const now = "2026-07-24T12:00:00.000Z";
const ids = {
  provider: "67000000-0000-4000-8000-000000000001",
  project: "67000000-0000-4000-8000-000000000002",
  chatThread: "67000000-0000-4000-8000-000000000003",
  codeThread: "67000000-0000-4000-8000-000000000004",
  otherProject: "67000000-0000-4000-8000-000000000005",
  otherChatThread: "67000000-0000-4000-8000-000000000006",
  workThread: "67000000-0000-4000-8000-000000000007",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function connect(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-usage-dashboard-service-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

interface SeedOverrides {
  readonly reconciliationId?: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly quality?: string;
  readonly observedAt?: string;
  readonly hostId?: string;
  readonly attributionJson?: string;
  readonly schemaVersion?: number;
  readonly modelId?: string;
  readonly sequence?: number;
}

function seedUsageRow(connection: SqliteConnection, overrides: SeedOverrides = {}): void {
  connection
    .prepare(`
      INSERT INTO usage_record_projection (
        reconciliation_id, subject_type, subject_id, provider_instance_id,
        model_id, request_shape, quality, input_tokens, output_tokens,
        planned_input_tokens, variance_tokens, schema_version,
        attribution_json, observed_at, last_sequence, host_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      overrides.reconciliationId ?? "67000000-0000-4000-8000-00000000000a",
      overrides.subjectType ?? "chat-thread",
      overrides.subjectId ?? ids.chatThread,
      ids.provider,
      overrides.modelId ?? "gpt-4o",
      "chat-turn",
      overrides.quality ?? "exact",
      100,
      50,
      95,
      5,
      overrides.schemaVersion ?? USAGE_PROJECTION_SCHEMA_VERSION,
      overrides.attributionJson ??
        JSON.stringify([{ category: "conversation", plannedTokens: 95, quality: "exact" }]),
      overrides.observedAt ?? now,
      overrides.sequence ?? 1,
      overrides.hostId ?? "local",
    );
}

function seedChatThread(
  connection: SqliteConnection,
  projectId: string | null,
  threadId: string = ids.chatThread,
): void {
  connection
    .prepare(`
      INSERT INTO chat_thread_projection (
        thread_id, project_id, lifecycle, schema_version, thread_json,
        aggregate_version, updated_at, last_sequence
      ) VALUES (?, ?, 'active', 1, '{}', 1, ?, 1)
    `)
    .run(threadId, projectId, now);
}

function seedCodeThread(connection: SqliteConnection, projectId: string): void {
  connection
    .prepare(`
      INSERT INTO code_thread_projection (
        thread_id, project_id, checkout_id, lifecycle, schema_version,
        thread_json, aggregate_version, updated_at, last_sequence
      ) VALUES (?, ?, 'checkout-1', 'active', 1, '{}', 1, ?, 1)
    `)
    .run(ids.codeThread, projectId, now);
}

/** The authoritative `work.thread-created@1` record of a Work thread's Project. */
function seedWorkThread(connection: SqliteConnection, threadId: string, projectId: string): void {
  connection
    .prepare(`
      INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version, event_name,
        event_version, correlation_id, actor_kind, actor_id, occurred_at, payload_json
      ) VALUES (?, 'work-thread', ?, 1, 'work.thread-created@1', 1, ?, 'system', ?, ?, ?)
    `)
    .run(
      `event-${threadId}`,
      threadId,
      `correlation-${threadId}`,
      ids.provider,
      now,
      JSON.stringify({ kind: "thread-created", thread: { id: threadId, projectId } }),
    );
}

/**
 * Two rows for the requested Project, sitting behind three newer rows from
 * another Project: the shape that hides an older Project once the scan bound is
 * smaller than the volume of unrelated newer traffic.
 */
function seedProjectBehindNewerRows(connection: SqliteConnection): void {
  seedChatThread(connection, ids.project);
  seedChatThread(connection, ids.otherProject, ids.otherChatThread);
  const observedAt = [
    "2026-07-20T12:00:00.000Z",
    "2026-07-21T12:00:00.000Z",
    "2026-07-22T12:00:00.000Z",
    "2026-07-23T12:00:00.000Z",
    "2026-07-24T12:00:00.000Z",
  ];
  observedAt.forEach((timestamp, index) => {
    seedUsageRow(connection, {
      reconciliationId: `67000000-0000-4000-8000-00000000001${index}`,
      sequence: index + 1,
      observedAt: timestamp,
      ...(index < 2 ? {} : { subjectId: ids.otherChatThread }),
    });
  });
}

function read(
  connection: SqliteConnection,
  request: UsageDashboardRequest = {},
  projectScope: UsageProjectScope = unfiledScope,
) {
  return decodeUsageDashboardResponse(
    readUsageDashboard(connection, request, { queryAt: now, projectScope }),
  );
}

describe("readUsageDashboard", () => {
  it("returns an empty dashboard for an empty projection", () => {
    const dashboard = read(connect());
    expect(dashboard.summary.totals.totalRequests).toBe(0);
    expect(dashboard.summary.excludedRecordCount).toBe(0);
  });

  it("resolves Project attribution from the durable chat thread projection", () => {
    const connection = connect();
    seedChatThread(connection, ids.project);
    seedUsageRow(connection);

    const dashboard = read(connection, {}, { kind: "projects", projectIds: [ids.project] });
    expect(dashboard.detail[0]?.projectId).toBe(ids.project);
    const project = dashboard.breakdown.find((group) => group.dimension === "project");
    expect(project?.rows[0]?.availability).toBe("recorded");
  });

  it("leaves Project unattributed when the thread has no Project", () => {
    const connection = connect();
    seedChatThread(connection, null);
    seedUsageRow(connection);

    const dashboard = read(connection);
    expect(dashboard.detail[0]?.projectId).toBeUndefined();
    expect(
      dashboard.breakdown.find((group) => group.dimension === "project")?.rows[0]?.availability,
    ).toBe("unavailable");
  });

  it("declares Project attribution partial once a subject cannot be placed", () => {
    const connection = connect();
    seedUsageRow(connection, { subjectType: "work-thread", subjectId: "work-1" });

    const dashboard = read(connection);
    expect(
      dashboard.dimensionSources.find((source) => source.dimension === "project")?.status,
    ).toBe("partial");
  });

  it("resolves Work Project attribution from the authoritative create event", () => {
    const connection = connect();
    seedWorkThread(connection, ids.workThread, ids.project);
    seedUsageRow(connection, {
      subjectType: "work-thread",
      subjectId: ids.workThread,
    });

    const dashboard = read(connection, {}, { kind: "projects", projectIds: [ids.project] });
    expect(dashboard.detail[0]?.projectId).toBe(ids.project);
    expect(
      dashboard.breakdown.find((group) => group.dimension === "project")?.rows[0]?.availability,
    ).toBe("recorded");
    expect(
      dashboard.dimensionSources.find((source) => source.dimension === "project")?.status,
    ).toBe("recorded");
  });

  it("filters Chat and Code thread usage by the durable Project", () => {
    const connection = connect();
    seedChatThread(connection, ids.project);
    seedCodeThread(connection, ids.project);
    seedUsageRow(connection);
    seedUsageRow(connection, {
      reconciliationId: "67000000-0000-4000-8000-00000000000b",
      subjectType: "code-thread",
      subjectId: ids.codeThread,
      sequence: 2,
    });

    const scope: UsageProjectScope = { kind: "projects", projectIds: [ids.project] };
    expect(
      read(connection, { filter: { projectId: ids.project } as never }, scope).summary.totals
        .totalRequests,
    ).toBe(2);
    expect(
      read(
        connection,
        { filter: { projectId: "67000000-0000-4000-8000-0000000000ff" } as never },
        scope,
      ).summary.totals.totalRequests,
    ).toBe(0);
  });

  it("bounds the scan to the filtered Project instead of dropping it behind newer rows", () => {
    const connection = connect();
    seedProjectBehindNewerRows(connection);

    const dashboard = decodeUsageDashboardResponse(
      readUsageDashboard(
        connection,
        { filter: { projectId: ids.project } as never },
        {
          queryAt: now,
          projectScope: { kind: "projects", projectIds: [ids.project, ids.otherProject] },
          maxScannedRows: 3,
        },
      ),
    );
    expect(dashboard.summary.totals.totalRequests).toBe(2);
    expect(dashboard.detailTruncated).toBe(false);
  });

  it("declares truncation when a Project-filtered scan reaches the bound", () => {
    const connection = connect();
    seedProjectBehindNewerRows(connection);

    const dashboard = decodeUsageDashboardResponse(
      readUsageDashboard(
        connection,
        { filter: { projectId: ids.project } as never },
        {
          queryAt: now,
          projectScope: { kind: "projects", projectIds: [ids.project, ids.otherProject] },
          maxScannedRows: 1,
        },
      ),
    );
    expect(dashboard.summary.totals.totalRequests).toBe(1);
    expect(dashboard.detailTruncated).toBe(true);
  });

  it("bounds the scan to the caller's Project scope instead of filtering after truncation", () => {
    const connection = connect();
    seedProjectBehindNewerRows(connection);

    // Three newer rows from another Project sit ahead of the scoped Project's
    // two rows. Scoping inside the bounded query is what keeps them visible.
    const dashboard = decodeUsageDashboardResponse(
      readUsageDashboard(
        connection,
        {},
        {
          queryAt: now,
          projectScope: { kind: "projects", projectIds: [ids.project] },
          maxScannedRows: 3,
        },
      ),
    );
    expect(dashboard.summary.totals.totalRequests).toBe(2);
    expect(dashboard.detailTruncated).toBe(false);
    expect(dashboard.detail.every((row) => row.projectId === ids.project)).toBe(true);
  });

  it("reads nothing for a scope that names no Project", () => {
    const connection = connect();
    seedChatThread(connection, ids.project);
    seedUsageRow(connection);

    const dashboard = decodeUsageDashboardResponse(
      readUsageDashboard(
        connection,
        {},
        { queryAt: now, projectScope: { kind: "projects", projectIds: [] } },
      ),
    );
    expect(dashboard.summary.totals.totalRequests).toBe(0);
  });

  it("keeps a subject no Project places out of a Project-scoped read", () => {
    const connection = connect();
    seedChatThread(connection, null);
    seedUsageRow(connection);
    seedUsageRow(connection, {
      reconciliationId: "67000000-0000-4000-8000-00000000000d",
      subjectType: "work-thread",
      subjectId: "work-1",
      sequence: 2,
    });

    const dashboard = decodeUsageDashboardResponse(
      readUsageDashboard(
        connection,
        {},
        { queryAt: now, projectScope: { kind: "projects", projectIds: [ids.project] } },
      ),
    );
    expect(dashboard.summary.totals.totalRequests).toBe(0);
  });

  it("applies host, model, quality, and range filters", () => {
    const connection = connect();
    seedUsageRow(connection, {
      reconciliationId: "67000000-0000-4000-8000-00000000000b",
      sequence: 1,
    });
    seedUsageRow(connection, {
      reconciliationId: "67000000-0000-4000-8000-00000000000c",
      sequence: 2,
      hostId: "laptop",
      modelId: "claude-sonnet",
      quality: "estimated",
      observedAt: "2026-07-20T12:00:00.000Z",
    });

    expect(
      read(connection, { filter: { hostId: "laptop" } as never }).summary.totals.totalRequests,
    ).toBe(1);
    expect(
      read(connection, { filter: { modelId: "gpt-4o" } as never }).summary.totals.totalRequests,
    ).toBe(1);
    expect(
      read(connection, { filter: { quality: "estimated" } as never }).summary.totals.totalRequests,
    ).toBe(1);
    expect(
      read(connection, { filter: { from: "2026-07-22T00:00:00.000Z" } as never }).summary.totals
        .totalRequests,
    ).toBe(1);
  });

  it("counts a row with unreadable attribution instead of aggregating it", () => {
    const connection = connect();
    seedUsageRow(connection, {
      reconciliationId: "67000000-0000-4000-8000-00000000000b",
      sequence: 1,
    });
    seedUsageRow(connection, {
      reconciliationId: "67000000-0000-4000-8000-00000000000c",
      sequence: 2,
      attributionJson: '{"category":"conversation"}',
    });

    const dashboard = read(connection);
    expect(dashboard.summary.totals.totalRequests).toBe(1);
    expect(dashboard.summary.excludedRecordCount).toBe(1);
  });

  it("counts a row written by an unsupported projection schema as unreadable", () => {
    const connection = connect();
    seedUsageRow(connection, { schemaVersion: USAGE_PROJECTION_SCHEMA_VERSION + 1 });

    const dashboard = read(connection);
    expect(dashboard.summary.totals.totalRequests).toBe(0);
    expect(dashboard.summary.excludedRecordCount).toBe(1);
  });

  it("marks the response as truncated once the scan bound is reached", () => {
    const connection = connect();
    seedUsageRow(connection, {
      reconciliationId: "67000000-0000-4000-8000-00000000000b",
      sequence: 1,
    });
    seedUsageRow(connection, {
      reconciliationId: "67000000-0000-4000-8000-00000000000c",
      sequence: 2,
    });

    const truncated = decodeUsageDashboardResponse(
      readUsageDashboard(
        connection,
        {},
        { queryAt: now, projectScope: unfiledScope, maxScannedRows: 1 },
      ),
    );
    expect(truncated.detailTruncated).toBe(true);
    expect(truncated.summary.totals.totalRequests).toBe(1);
  });

  it("rejects an unusable time zone rather than silently bucketing in UTC", () => {
    const connection = connect();
    expect(() =>
      readUsageDashboard(
        connection,
        { timeZone: "Mars/Olympus" },
        { queryAt: now, projectScope: unfiledScope },
      ),
    ).toThrow();
  });
});
