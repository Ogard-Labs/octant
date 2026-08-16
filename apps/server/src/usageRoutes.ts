import {
  decodeUsageExportRequest,
  decodeUsageQueryRequest,
  decodeUsageResetRequest,
  decodeUsageRetentionRequest,
  type UsageByCategory,
  type UsageByProvider,
  type UsagePurgeResult,
  type UsageQueryResponse,
  type UsageRecord,
  type WindowId,
} from "@octant/contracts";
import { isLoopbackHostname } from "./shellRoutes";
import { authenticateRouteWindowId } from "./principalRouteContext";
import type { UsageProjectScope } from "./usageProjectScope";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import {
  queryUsageRecords,
  purgeUsageOlderThan,
  resetUsageProjection,
  recordUsageAuditEvent,
  type UsageQueryFilter,
} from "./persistence/usageProjection";
import { aggregateUsage } from "./persistence/usageAggregation";
import { recordsToCsv, recordsToJson, SENSITIVE_EXPORT_FIELDS } from "./persistence/usageExport";
import type { SqliteConnection } from "./persistence/sqlitePort";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const DEFAULT_BODY_LIMIT = 1_048_576;
const DEFAULT_QUERY_LIMIT = 100;
const EXPORT_BODY_LIMIT = 8_388_608;

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type, content-disposition",
  };
}

function failureResponse(message: string, status: number, origin: string | null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

export interface UsageRouteDependencies {
  readonly connection: SqliteConnection;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * Resolve which Projects the authenticated window may read usage for.
   *
   * A window capability proves the caller is a live renderer of this host; it
   * says nothing about which Project that renderer is in. The query and the
   * export both name providers, models, threads, and token counts, and the
   * export serializes that detail in bulk, so without this an empty request
   * from any valid capability — including one forwarded by a remote client —
   * would read the host-wide ledger. Required rather than optional: a host that
   * cannot resolve the window's scope must not serve usage at all.
   */
  readonly readWindowProjectScope: (windowId: WindowId) => UsageProjectScope;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
  readonly clock?: () => string;
}

export function createUsageRouteHandler(dependencies: UsageRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/usage/")) return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse("Usage API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse("Renderer origin is not allowed.", 400, null);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    let windowId: WindowId;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse("Usage query is unauthorized.", 401, origin);
      }
      return failureResponse("Usage query request is invalid.", 400, origin);
    }

    if (request.method !== "POST") {
      return failureResponse("Usage API requires POST.", 405, origin);
    }

    if (url.pathname === "/api/usage/query" || url.pathname === "/api/usage/export") {
      let projectScope: UsageProjectScope;
      try {
        projectScope = dependencies.readWindowProjectScope(windowId);
      } catch {
        return failureResponse("Usage is unavailable.", 503, origin);
      }
      return url.pathname === "/api/usage/query"
        ? handleQuery(request, dependencies, bodyLimit, clock, origin, projectScope)
        : handleExport(request, dependencies, EXPORT_BODY_LIMIT, clock, origin, projectScope);
    }
    if (url.pathname === "/api/usage/reset") {
      return handleReset(request, dependencies, bodyLimit, clock, origin);
    }
    if (url.pathname === "/api/usage/retain") {
      return handleRetain(request, dependencies, bodyLimit, clock, origin);
    }
    return undefined;
  };
}

/**
 * A Project the window is not in is refused rather than quietly filtered away,
 * so a caller learns its request was denied instead of reading an empty result
 * as if that Project had no usage. An unnamed Project is scoped instead, which
 * is what makes an empty request honest.
 */
function isOutsideScope(scope: UsageProjectScope, projectId: string | undefined): boolean {
  if (projectId === undefined) return false;
  return scope.kind === "unfiled" || !scope.projectIds.includes(projectId);
}

async function handleQuery(
  request: Request,
  dependencies: UsageRouteDependencies,
  bodyLimit: number,
  clock: () => string,
  origin: string | null,
  projectScope: UsageProjectScope,
): Promise<Response> {
  const decoded = await readJson(request, bodyLimit);
  if (decoded.kind === "too-large") {
    return failureResponse("Request body is too large.", 413, origin);
  }
  if (decoded.kind === "invalid") {
    return failureResponse("Request body must be valid JSON.", 400, origin);
  }

  try {
    const query = decodeUsageQueryRequest(decoded.value);
    const filter = mapFilter(query.filter);
    if (isOutsideScope(projectScope, filter.projectId)) {
      return failureResponse("Usage query is not authorized for this Project.", 403, origin);
    }
    const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
    const afterSequence = query.afterSequence ?? 0;
    const timeZone = query.timeZone ?? "UTC";
    assertTimeZone(timeZone);

    const { records, hasMore } = queryUsageRecords(
      dependencies.connection,
      filter,
      limit,
      afterSequence,
      projectScope,
    );

    const response = buildUsageQueryResponse(records, hasMore, clock(), timeZone);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json", ...corsHeaders(origin) },
    });
  } catch {
    return failureResponse("Usage query is invalid.", 400, origin);
  }
}

async function handleExport(
  request: Request,
  dependencies: UsageRouteDependencies,
  bodyLimit: number,
  clock: () => string,
  origin: string | null,
  projectScope: UsageProjectScope,
): Promise<Response> {
  const decoded = await readJson(request, bodyLimit);
  if (decoded.kind === "too-large") {
    return failureResponse("Request body is too large.", 413, origin);
  }
  if (decoded.kind === "invalid") {
    return failureResponse("Request body must be valid JSON.", 400, origin);
  }

  try {
    const exportRequest = decodeUsageExportRequest(decoded.value);
    const filter = mapFilter(exportRequest.filter);
    if (isOutsideScope(projectScope, filter.projectId)) {
      return failureResponse("Usage export is not authorized for this Project.", 403, origin);
    }
    // Scoping the query that feeds the serializer is what scopes the export:
    // every emitted field — subject id, provider, model, tokens, attribution —
    // comes from these rows, and the file name carries no Project at all.
    const { records } = queryUsageRecords(dependencies.connection, filter, 500, 0, projectScope);

    const occurredAt = clock();
    dependencies.connection.transaction(() => {
      recordUsageAuditEvent(dependencies.connection, {
        action: "export",
        purgedCount: 0,
        details: { format: exportRequest.format, recordCount: records.length },
        occurredAt,
      });
    })();

    if (exportRequest.format === "csv") {
      const csv = recordsToCsv(records);
      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv",
          "content-disposition": 'attachment; filename="octant-usage.csv"',
          ...corsHeaders(origin),
        },
      });
    }
    const json = recordsToJson(records);
    return new Response(json, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="octant-usage.json"',
        ...corsHeaders(origin),
      },
    });
  } catch {
    return failureResponse("Usage export is invalid.", 400, origin);
  }
}

async function handleReset(
  request: Request,
  dependencies: UsageRouteDependencies,
  bodyLimit: number,
  clock: () => string,
  origin: string | null,
): Promise<Response> {
  const decoded = await readJson(request, bodyLimit);
  if (decoded.kind === "too-large") {
    return failureResponse("Request body is too large.", 413, origin);
  }
  if (decoded.kind === "invalid") {
    return failureResponse("Request body must be valid JSON.", 400, origin);
  }

  try {
    decodeUsageResetRequest(decoded.value);
    const occurredAt = clock();
    let result: UsagePurgeResult;
    dependencies.connection.transaction(() => {
      const purgedCount = resetUsageProjection(dependencies.connection);
      recordUsageAuditEvent(dependencies.connection, {
        action: "reset",
        purgedCount,
        details: { reason: "user-requested-reset" },
        occurredAt,
      });
      result = { purgedCount, occurredAt: occurredAt as UsagePurgeResult["occurredAt"] };
    })();
    return new Response(JSON.stringify(result!), {
      status: 200,
      headers: { "content-type": "application/json", ...corsHeaders(origin) },
    });
  } catch {
    return failureResponse("Usage reset is invalid.", 400, origin);
  }
}

async function handleRetain(
  request: Request,
  dependencies: UsageRouteDependencies,
  bodyLimit: number,
  clock: () => string,
  origin: string | null,
): Promise<Response> {
  const decoded = await readJson(request, bodyLimit);
  if (decoded.kind === "too-large") {
    return failureResponse("Request body is too large.", 413, origin);
  }
  if (decoded.kind === "invalid") {
    return failureResponse("Request body must be valid JSON.", 400, origin);
  }

  try {
    const retention = decodeUsageRetentionRequest(decoded.value);
    const occurredAt = clock();
    let result: UsagePurgeResult;
    dependencies.connection.transaction(() => {
      const purgedCount = purgeUsageOlderThan(dependencies.connection, retention.olderThan);
      recordUsageAuditEvent(dependencies.connection, {
        action: "purge",
        purgedCount,
        details: { olderThan: retention.olderThan },
        occurredAt,
      });
      result = { purgedCount, occurredAt: occurredAt as UsagePurgeResult["occurredAt"] };
    })();
    return new Response(JSON.stringify(result!), {
      status: 200,
      headers: { "content-type": "application/json", ...corsHeaders(origin) },
    });
  } catch {
    return failureResponse("Usage retention is invalid.", 400, origin);
  }
}

function mapFilter(filter: unknown): UsageQueryFilter {
  if (filter === undefined) return {};
  const f = filter as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (typeof f.providerInstanceId === "string") result.providerInstanceId = f.providerInstanceId;
  if (typeof f.modelId === "string") result.modelId = f.modelId;
  if (typeof f.subjectAggregateType === "string")
    result.subjectAggregateType = f.subjectAggregateType;
  if (typeof f.subjectAggregateId === "string") result.subjectAggregateId = f.subjectAggregateId;
  if (typeof f.mode === "string") result.mode = f.mode;
  if (typeof f.projectId === "string") result.projectId = f.projectId;
  if (typeof f.requestShape === "string") result.requestShape = f.requestShape;
  if (typeof f.category === "string") result.category = f.category;
  if (typeof f.hostId === "string") result.hostId = f.hostId;
  if (typeof f.quality === "string") result.quality = f.quality as UsageQueryFilter["quality"];
  if (typeof f.from === "string") result.from = f.from;
  if (typeof f.to === "string") result.to = f.to;
  return result as UsageQueryFilter;
}

function buildUsageQueryResponse(
  records: ReadonlyArray<UsageRecord>,
  hasMore: boolean,
  queryAt: string,
  timeZone: string,
): UsageQueryResponse {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let exactCount = 0;
  let estimatedCount = 0;
  let reconciledCount = 0;
  let staleCount = 0;
  let unavailableCount = 0;

  const providerMap = new Map<string, UsageByProvider>();
  const categoryMap = new Map<string, UsageByCategory>();

  for (const record of records) {
    totalInputTokens += record.inputTokens;
    totalOutputTokens += record.outputTokens;

    switch (record.quality) {
      case "exact":
        exactCount += 1;
        break;
      case "estimated":
        estimatedCount += 1;
        break;
      case "reconciled":
        reconciledCount += 1;
        break;
      case "stale":
        staleCount += 1;
        break;
      case "unavailable":
        unavailableCount += 1;
        break;
    }

    const providerKey = `${record.providerInstanceId}\u0000${record.modelId}`;
    const existingProvider = providerMap.get(providerKey);
    if (existingProvider === undefined) {
      providerMap.set(providerKey, {
        providerInstanceId: record.providerInstanceId,
        modelId: record.modelId,
        totalInputTokens: record.inputTokens,
        totalOutputTokens: record.outputTokens,
        ...(record.reasoningTokens === undefined
          ? {}
          : { totalReasoningTokens: record.reasoningTokens }),
        ...(record.cacheReadInputTokens === undefined
          ? {}
          : { totalCacheReadInputTokens: record.cacheReadInputTokens }),
        ...(record.cacheWriteInputTokens === undefined
          ? {}
          : { totalCacheWriteInputTokens: record.cacheWriteInputTokens }),
        ...(record.providerExecutionDurationMs === undefined
          ? {}
          : { totalProviderExecutionDurationMs: record.providerExecutionDurationMs }),
        requestCount: 1,
      });
    } else {
      providerMap.set(providerKey, {
        ...existingProvider,
        totalInputTokens: existingProvider.totalInputTokens + record.inputTokens,
        totalOutputTokens: existingProvider.totalOutputTokens + record.outputTokens,
        ...sumMeasuredProviderDimension(
          "totalReasoningTokens",
          existingProvider.totalReasoningTokens,
          record.reasoningTokens,
        ),
        ...sumMeasuredProviderDimension(
          "totalCacheReadInputTokens",
          existingProvider.totalCacheReadInputTokens,
          record.cacheReadInputTokens,
        ),
        ...sumMeasuredProviderDimension(
          "totalCacheWriteInputTokens",
          existingProvider.totalCacheWriteInputTokens,
          record.cacheWriteInputTokens,
        ),
        ...sumMeasuredProviderDimension(
          "totalProviderExecutionDurationMs",
          existingProvider.totalProviderExecutionDurationMs,
          record.providerExecutionDurationMs,
        ),
        requestCount: existingProvider.requestCount + 1,
      });
    }

    for (const entry of record.attribution) {
      const existingCategory = categoryMap.get(entry.category);
      if (existingCategory === undefined) {
        categoryMap.set(entry.category, {
          category: entry.category,
          plannedTokens: entry.plannedTokens,
          entryCount: 1,
        });
      } else {
        categoryMap.set(entry.category, {
          ...existingCategory,
          plannedTokens: existingCategory.plannedTokens + entry.plannedTokens,
          entryCount: existingCategory.entryCount + 1,
        });
      }
    }
  }

  const aggregation = aggregateUsage(records, 10, timeZone);

  return {
    records,
    totals: {
      totalInputTokens,
      totalOutputTokens,
      ...aggregation.totals,
      totalRequests: records.length,
      exactCount,
      estimatedCount,
      reconciledCount,
      staleCount,
      unavailableCount,
    },
    byProvider: Array.from(providerMap.values()),
    byCategory: Array.from(categoryMap.values()).sort((a, b) =>
      a.category.localeCompare(b.category),
    ),
    byDay: aggregation.byDay,
    byWeek: aggregation.byWeek,
    cumulative: aggregation.cumulative,
    topConsumers: aggregation.topConsumers,
    hasMore,
    queryAt: queryAt as UsageQueryResponse["queryAt"],
  };
}

function sumMeasuredProviderDimension<
  K extends
    | "totalReasoningTokens"
    | "totalCacheReadInputTokens"
    | "totalCacheWriteInputTokens"
    | "totalProviderExecutionDurationMs",
>(key: K, current: number | undefined, next: number | undefined): { readonly [P in K]?: number } {
  if (current === undefined && next === undefined) return {};
  return { [key]: (current ?? 0) + (next ?? 0) } as { readonly [P in K]: number };
}

type ReadJsonResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" };

async function readJson(request: Request, limit: number): Promise<ReadJsonResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > limit) {
    return { kind: "too-large" };
  }
  try {
    const text = await request.text();
    if (text.length > limit) return { kind: "too-large" };
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) ||
      parsed.protocol === "app:"
    );
  } catch {
    return false;
  }
}

function assertTimeZone(timeZone: string): void {
  new Intl.DateTimeFormat("en-US", { timeZone }).format();
}

export const usageRouteSensitiveFields = SENSITIVE_EXPORT_FIELDS;
