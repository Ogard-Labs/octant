import type {
  UsageAttributionEntry,
  UsageDashboardRequest,
  UsageDashboardResponse,
} from "@octant/contracts";
import { buildUsageDashboard, type UsageDashboardSourceRow } from "./usageDashboardModel";
import {
  USAGE_PROJECTION_SCHEMA_VERSION,
  type UsageRecordProjectionRow,
} from "./persistence/usagePersistenceSchema";
import {
  deriveModeFromSubjectType,
  usageModeCondition,
  usageProjectConditionParams,
  usageProjectConditionSql,
  usageUnfiledConditionSql,
} from "./persistence/usageProjection";
import type { UsageProjectScope } from "./usageProjectScope";
import type { SqliteConnection } from "./persistence/sqlitePort";

/** Upper bound on rows one dashboard query may scan, so a large ledger cannot stall a window. */
const MAX_SCANNED_ROWS = 5_000;
const DEFAULT_DETAIL_LIMIT = 50;
const DEFAULT_BREAKDOWN_LIMIT = 10;

export interface UsageDashboardServiceOptions {
  readonly queryAt: string;
  readonly projectScope: UsageProjectScope;
  readonly maxScannedRows?: number;
}

/**
 * Host-authoritative dashboard read model.
 *
 * The query runs against the durable usage projection and resolves the
 * dimensions the renderer must never derive: mode from the subject aggregate
 * type and, for a Project-less thread, the durable thread record; Project from
 * the durable thread projections. A subject the host cannot place stays
 * unattributed instead of being guessed, which is why both lookups return
 * `undefined` rather than a fallback value.
 */
export function readUsageDashboard(
  connection: SqliteConnection,
  request: UsageDashboardRequest,
  options: UsageDashboardServiceOptions,
): UsageDashboardResponse {
  const scanLimit = options.maxScannedRows ?? MAX_SCANNED_ROWS;
  const timeZone = request.timeZone ?? "UTC";
  assertTimeZone(timeZone);

  const { rows, truncated } = selectRows(connection, request, scanLimit, options.projectScope);
  const projectCache = new Map<string, string | undefined>();
  const sourceRows: Array<UsageDashboardSourceRow> = [];
  let unreadableRecordCount = 0;

  for (const row of rows) {
    const attribution = readAttribution(row);
    if (attribution === undefined) {
      unreadableRecordCount += 1;
      continue;
    }
    const mode = deriveModeFromSubjectType(row.subject_type);
    const projectId = resolveProjectId(connection, projectCache, row.subject_type, row.subject_id);
    sourceRows.push({
      reconciliationId: row.reconciliation_id,
      hostId: row.host_id,
      providerInstanceId: row.provider_instance_id,
      modelId: row.model_id,
      requestShape: row.request_shape,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      quality: row.quality,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      plannedInputTokens: row.planned_input_tokens,
      varianceTokens: row.variance_tokens,
      ...(row.reasoning_tokens === null ? {} : { reasoningTokens: row.reasoning_tokens }),
      ...(row.cache_read_input_tokens === null
        ? {}
        : { cacheReadInputTokens: row.cache_read_input_tokens }),
      ...(row.cache_write_input_tokens === null
        ? {}
        : { cacheWriteInputTokens: row.cache_write_input_tokens }),
      ...(row.provider_execution_duration_ms === null
        ? {}
        : { providerExecutionDurationMs: row.provider_execution_duration_ms }),
      attribution,
      observedAt: row.observed_at,
      ...(mode === undefined ? {} : { mode }),
      ...(projectId === undefined ? {} : { projectId }),
    });
  }

  return buildUsageDashboard(sourceRows, {
    queryAt: options.queryAt,
    timeZone,
    detailLimit: request.detailLimit ?? DEFAULT_DETAIL_LIMIT,
    breakdownLimit: request.breakdownLimit ?? DEFAULT_BREAKDOWN_LIMIT,
    unreadableRecordCount,
    scanTruncated: truncated,
  });
}

function selectRows(
  connection: SqliteConnection,
  request: UsageDashboardRequest,
  scanLimit: number,
  projectScope: UsageProjectScope,
): { readonly rows: ReadonlyArray<UsageRecordProjectionRow>; readonly truncated: boolean } {
  const filter = request.filter ?? {};
  const conditions: Array<string> = [];
  const params: Array<string | number> = [];

  if (filter.providerInstanceId !== undefined) {
    conditions.push("provider_instance_id = ?");
    params.push(String(filter.providerInstanceId));
  }
  if (filter.modelId !== undefined) {
    conditions.push("model_id = ?");
    params.push(String(filter.modelId));
  }
  if (filter.subjectAggregateType !== undefined) {
    conditions.push("subject_type = ?");
    params.push(filter.subjectAggregateType);
  }
  if (filter.subjectAggregateId !== undefined) {
    conditions.push("subject_id = ?");
    params.push(filter.subjectAggregateId);
  }
  if (filter.requestShape !== undefined) {
    conditions.push("request_shape = ?");
    params.push(filter.requestShape);
  }
  if (filter.quality !== undefined) {
    conditions.push("quality = ?");
    params.push(filter.quality);
  }
  if (filter.hostId !== undefined) {
    conditions.push("host_id = ?");
    params.push(String(filter.hostId));
  }
  if (filter.from !== undefined) {
    conditions.push("observed_at >= ?");
    params.push(String(filter.from));
  }
  if (filter.to !== undefined) {
    conditions.push("observed_at <= ?");
    params.push(String(filter.to));
  }
  if (filter.category !== undefined) {
    conditions.push("attribution_json LIKE ?");
    params.push(`%"category":"${filter.category}"%`);
  }
  if (filter.projectId !== undefined) {
    conditions.push(usageProjectConditionSql(1));
    params.push(...usageProjectConditionParams([String(filter.projectId)]));
  }
  // The authority scope narrows the same bounded query, so it can never be
  // widened by a filter and never truncates rows the caller may see in favour
  // of rows it may not.
  if (projectScope.kind === "unfiled") {
    conditions.push(usageUnfiledConditionSql());
  } else {
    if (projectScope.projectIds.length === 0) return { rows: [], truncated: false };
    conditions.push(usageProjectConditionSql(projectScope.projectIds.length));
    params.push(...usageProjectConditionParams(projectScope.projectIds));
  }
  if (filter.mode !== undefined) {
    const condition = usageModeCondition(filter.mode);
    if (condition === undefined) return { rows: [], truncated: false };
    conditions.push(condition.sql);
    params.push(...condition.params);
  }

  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const rows = connection
    .prepare(
      `SELECT * FROM usage_record_projection ${where} ORDER BY observed_at DESC LIMIT ?`.trim(),
    )
    .all(...params, scanLimit + 1) as ReadonlyArray<UsageRecordProjectionRow>;

  return { rows: rows.slice(0, scanLimit), truncated: rows.length > scanLimit };
}

/**
 * A row whose attribution cannot be read, or whose projection schema this build
 * does not understand, is unreadable rather than empty: counting it keeps the
 * reader aware that a durable record exists outside the totals.
 */
function readAttribution(
  row: UsageRecordProjectionRow,
): ReadonlyArray<UsageAttributionEntry> | undefined {
  if (row.schema_version !== USAGE_PROJECTION_SCHEMA_VERSION) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.attribution_json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.category !== "string") return undefined;
    if (typeof candidate.plannedTokens !== "number") return undefined;
    if (typeof candidate.quality !== "string") return undefined;
  }
  return parsed as ReadonlyArray<UsageAttributionEntry>;
}

/**
 * The Project a row is displayed under, read from the same authoritative
 * ownership records the scope predicates in `usageProjection` filter on. A row a
 * Project-scoped window can see must therefore name that Project here, and a row
 * an unfiled window can see names none.
 */
function resolveProjectId(
  connection: SqliteConnection,
  cache: Map<string, string | undefined>,
  subjectType: string,
  subjectId: string,
): string | undefined {
  const key = `${subjectType} ${subjectId}`;
  if (cache.has(key)) return cache.get(key);

  const ownership: Record<string, string | undefined> = {
    "chat-thread": "SELECT project_id FROM chat_thread_projection WHERE thread_id = ?",
    "code-thread": "SELECT project_id FROM code_thread_projection WHERE thread_id = ?",
    // A Work thread has no SQL projection; its required, immutable Project is
    // recorded on the create event the in-memory projection hydrates from.
    "work-thread": `
      SELECT json_extract(payload_json, '$.thread.projectId') AS project_id
      FROM event_journal
      WHERE aggregate_type = 'work-thread'
        AND aggregate_id = ?
        AND event_name = 'work.thread-created@1'`,
  };

  const sql = ownership[subjectType];
  const row =
    sql === undefined
      ? undefined
      : (connection.prepare(sql).get(subjectId) as
          | { readonly project_id: string | null }
          | undefined);
  const projectId = row?.project_id ?? undefined;
  cache.set(key, projectId);
  return projectId;
}

function assertTimeZone(timeZone: string): void {
  new Intl.DateTimeFormat("en-US", { timeZone }).format();
}

export const usageDashboardServiceLimits = {
  MAX_SCANNED_ROWS,
  DEFAULT_DETAIL_LIMIT,
  DEFAULT_BREAKDOWN_LIMIT,
};
