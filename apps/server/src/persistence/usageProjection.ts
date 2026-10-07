import {
  AGENT_RUN_TURN_REQUEST_SHAPE,
  AGENT_RUN_USAGE_AGGREGATE_TYPE,
  decodeCodeOperationEventFrame,
  decodeContextUsageReconciled,
  decodeUsageRecord,
  type EventEnvelope,
  type UsageAttributionEntry,
  type UsageQuality,
  type UsageRecord,
} from "@octant/contracts";
import { buildAttribution, classifyUsageQuality } from "@octant/domain";
import type { Projection } from "./projection";
import type { UsageProjectScope } from "../usageProjectScope";
import { readContextManifest, readContextPlan } from "./contextProjection";
import {
  assertUsageProjectionSchema,
  USAGE_PROJECTION_SCHEMA_VERSION,
  type UsageRecordProjectionRow,
} from "./usagePersistenceSchema";
import type { SqliteConnection } from "./sqlitePort";

const usageEventNames = new Set(["context.usage-reconciled@1"]);

/** Maps a usage subject aggregate type to a domain mode when derivable. */
export function deriveModeFromSubjectType(subjectType: string): string | undefined {
  switch (subjectType) {
    case "chat-thread":
      return "chat";
    case "work-thread":
      return "work";
    case "code-thread":
      return "code";
    default:
      return undefined;
  }
}

export class UsageProjection implements Projection {
  readonly name = "usage";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads", "contexts"];

  reset(connection: SqliteConnection): void {
    connection.exec(
      "DELETE FROM usage_record_projection WHERE request_shape != 'code-provider-turn';",
    );
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (!usageEventNames.has(event.eventName)) return;
    assertProjection(event.eventVersion === 1);
    if (
      event.aggregateType !== "context-ledger" &&
      event.aggregateType !== "image-job" &&
      event.aggregateType !== AGENT_RUN_USAGE_AGGREGATE_TYPE
    )
      return;
    this.#applyUsageReconciled(connection, event);
  }

  #applyUsageReconciled(connection: SqliteConnection, event: EventEnvelope): void {
    const reconciliation = decodeProjection(
      () => decodeContextUsageReconciled(event.payload).reconciliation,
    );

    const existing = rawUsageRecord(connection, reconciliation.id);
    if (existing !== undefined && existing.last_sequence >= event.globalSequence) return;

    const plan =
      reconciliation.planId === undefined
        ? undefined
        : readContextPlan(connection, reconciliation.planId);
    const manifest =
      plan !== undefined ? readContextManifest(connection, plan.manifestId) : undefined;

    // A child run's usage is journaled beside the run, not on it, but it is
    // the run's spend: its subject is the run itself.
    const subject = manifest?.subject ?? {
      aggregateType:
        event.aggregateType === AGENT_RUN_USAGE_AGGREGATE_TYPE ? "agent-run" : event.aggregateType,
      aggregateId: event.aggregateId,
    };
    // A reconciled request whose subject thread (or child run) was purged keeps
    // its row and aggregates for accounting, but the projector must not re-link
    // the purged identity when the journal is replayed after a purge.
    const deLinkedSubjectId = subjectPurged(connection, subject)
      ? null
      : String(subject.aggregateId);

    const attribution: ReadonlyArray<UsageAttributionEntry> =
      reconciliation.imageUnits !== undefined
        ? [
            {
              category: "current-request",
              plannedTokens: 0,
              quality: reconciliation.imageUnits.quality,
              imageCount: reconciliation.imageUnits.count,
              ...(reconciliation.imageUnits.size === undefined
                ? {}
                : { imageSize: reconciliation.imageUnits.size }),
              ...(reconciliation.imageUnits.outputQuality === undefined
                ? {}
                : { imageQuality: reconciliation.imageUnits.outputQuality }),
            },
          ]
        : manifest !== undefined
          ? buildAttribution(manifest.entries, true)
          : [];

    const quality = classifyUsageQuality({
      hasReconciliation: true,
      hasManifest: manifest !== undefined,
      hasPlan: plan !== undefined,
      varianceTokens: reconciliation.varianceTokens,
      observedAt: reconciliation.observedAt,
      now: event.occurredAt,
      ...(reconciliation.providerReported === false ? { providerReported: false } : {}),
    });

    const record = decodeUsageRecord({
      reconciliationId: reconciliation.id,
      subject,
      providerInstanceId: reconciliation.providerInstanceId,
      modelId: reconciliation.modelId,
      requestShape: reconciliation.requestShape,
      quality,
      inputTokens: reconciliation.actualInputTokens,
      outputTokens: reconciliation.actualOutputTokens,
      ...(reconciliation.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: reconciliation.reasoningTokens }),
      ...(reconciliation.cacheReadInputTokens === undefined
        ? {}
        : { cacheReadInputTokens: reconciliation.cacheReadInputTokens }),
      ...(reconciliation.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteInputTokens: reconciliation.cacheWriteInputTokens }),
      ...(reconciliation.providerExecutionDurationMs === undefined
        ? {}
        : { providerExecutionDurationMs: reconciliation.providerExecutionDurationMs }),
      ...(reconciliation.cost === undefined ? {} : { cost: reconciliation.cost }),
      plannedInputTokens: reconciliation.plannedInputTokens,
      varianceTokens: reconciliation.varianceTokens,
      attribution,
      observedAt: reconciliation.observedAt,
    });

    connection
      .prepare(`
        INSERT INTO usage_record_projection (
          reconciliation_id, subject_type, subject_id, provider_instance_id,
          model_id, request_shape, quality, input_tokens, output_tokens,
          reasoning_tokens, cache_read_input_tokens, cache_write_input_tokens,
          provider_execution_duration_ms, cost_usd_micros, cost_kind,
          planned_input_tokens, variance_tokens, schema_version,
          attribution_json, observed_at, last_sequence, host_id, planning_available
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (reconciliation_id) DO UPDATE SET
          quality = excluded.quality,
          reasoning_tokens = excluded.reasoning_tokens,
          cache_read_input_tokens = excluded.cache_read_input_tokens,
          cache_write_input_tokens = excluded.cache_write_input_tokens,
          provider_execution_duration_ms = excluded.provider_execution_duration_ms,
          cost_usd_micros = excluded.cost_usd_micros,
          cost_kind = excluded.cost_kind,
          attribution_json = excluded.attribution_json,
          last_sequence = excluded.last_sequence
        WHERE excluded.last_sequence > usage_record_projection.last_sequence
      `)
      .run(
        record.reconciliationId,
        record.subject.aggregateType,
        deLinkedSubjectId,
        record.providerInstanceId,
        record.modelId,
        record.requestShape,
        record.quality,
        record.inputTokens,
        record.outputTokens,
        record.reasoningTokens ?? null,
        record.cacheReadInputTokens ?? null,
        record.cacheWriteInputTokens ?? null,
        record.providerExecutionDurationMs ?? null,
        record.cost?.usdMicros ?? null,
        record.cost?.kind ?? null,
        record.plannedInputTokens ?? 0,
        record.varianceTokens ?? 0,
        USAGE_PROJECTION_SCHEMA_VERSION,
        JSON.stringify(record.attribution),
        record.observedAt,
        event.globalSequence,
        String(event.hostId),
        // A child run has no Octant planning estimate, so it has no variance
        // either; the request-detail table says so instead of showing zero.
        reconciliation.requestShape === AGENT_RUN_TURN_REQUEST_SHAPE ? 0 : 1,
      );
  }
}

/** A separate checkpoint imports saved Code reports on upgrade without
 * replaying unrelated usage that the user may have purged. */
export class CodeUsageProjection implements Projection {
  readonly name = "code-usage";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(
      "DELETE FROM usage_record_projection WHERE request_shape = 'code-provider-turn';",
    );
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventName !== "code.operation-event-recorded@1") return;
    assertProjection(event.eventVersion === 1 && event.aggregateType === "code-operation");
    const frame = decodeProjection(() => decodeCodeOperationEventFrame(event.payload));
    const turnEnded =
      frame.event.kind === "operation-state" &&
      (frame.event.state === "completed" ||
        frame.event.state === "interrupted" ||
        frame.event.state === "failed");
    if (frame.event.kind !== "usage" && !turnEnded) return;
    assertProjection(String(frame.operationId) === String(event.aggregateId));
    const start = connection
      .prepare(`
      SELECT payload_json FROM event_journal
      WHERE aggregate_type = 'code-operation' AND aggregate_id = ?
        AND event_name = 'code.operation-event-recorded@1' AND global_sequence < ?
        AND json_extract(payload_json, '$.event.kind') = 'conversation-turn-started'
      ORDER BY global_sequence DESC LIMIT 1
    `)
      .get(String(frame.operationId), event.globalSequence) as
      | { readonly payload_json: string }
      | undefined;
    if (start === undefined) return;
    const started = decodeProjection(() =>
      decodeCodeOperationEventFrame(JSON.parse(start.payload_json)),
    );
    assertProjection(started.event.kind === "conversation-turn-started");
    assertProjection(String(started.threadId) === String(frame.threadId));
    if (frame.event.kind !== "usage") {
      // A turn that ended without reporting usage — an ACP agent reports none
      // — still ran on the provider. Recording it as unreported and unpriced
      // keeps it out of "free": a spend ceiling refuses instead of counting
      // it as nothing. A turn that did report keeps its row untouched.
      connection
        .prepare(`
        INSERT INTO usage_record_projection (
          reconciliation_id, subject_type, subject_id, provider_instance_id,
          model_id, request_shape, quality, input_tokens, output_tokens,
          planned_input_tokens, variance_tokens, schema_version,
          attribution_json, observed_at, last_sequence, host_id, planning_available
        ) VALUES (?, 'code-thread', ?, ?, ?, 'code-provider-turn', 'unavailable', 0, 0, 0, 0, ?, '[]', ?, ?, ?, 0)
        ON CONFLICT (reconciliation_id) DO NOTHING
      `)
        .run(
          String(frame.operationId),
          String(frame.threadId),
          String(started.event.providerInstanceId),
          String(started.event.modelId),
          USAGE_PROJECTION_SCHEMA_VERSION,
          frame.occurredAt,
          event.globalSequence,
          String(event.hostId),
        );
      return;
    }
    const usage = frame.event;
    // The report's cost covers the same turn its tokens do, so it replaces the
    // previous cost too; a report without one leaves the turn unpriced. The
    // cost is the one journaled with the report, never priced here: a replay
    // must reproduce the ledger, not re-price it against today's rate table.
    // Code reports replace the turn's previous totals, just as its transcript
    // does. The operation id keeps live updates and replay on the same row.
    connection
      .prepare(`
      INSERT INTO usage_record_projection (
        reconciliation_id, subject_type, subject_id, provider_instance_id,
        model_id, request_shape, quality, input_tokens, output_tokens,
        cost_usd_micros, cost_kind,
        planned_input_tokens, variance_tokens, schema_version,
        attribution_json, observed_at, last_sequence, host_id, planning_available
      ) VALUES (?, 'code-thread', ?, ?, ?, 'code-provider-turn', 'exact', ?, ?, ?, ?, 0, 0, ?, '[]', ?, ?, ?, 0)
      ON CONFLICT (reconciliation_id) DO UPDATE SET
        quality = excluded.quality,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cost_usd_micros = excluded.cost_usd_micros,
        cost_kind = excluded.cost_kind,
        observed_at = excluded.observed_at,
        last_sequence = excluded.last_sequence
      WHERE excluded.last_sequence > usage_record_projection.last_sequence
    `)
      .run(
        String(frame.operationId),
        String(frame.threadId),
        String(started.event.providerInstanceId),
        String(started.event.modelId),
        usage.inputTokens,
        usage.outputTokens,
        usage.cost?.usdMicros ?? null,
        usage.cost?.kind ?? null,
        USAGE_PROJECTION_SCHEMA_VERSION,
        frame.occurredAt,
        event.globalSequence,
        String(event.hostId),
      );
  }
}

function rawUsageRecord(
  connection: SqliteConnection,
  reconciliationId: string,
): UsageRecordProjectionRow | undefined {
  return connection
    .prepare("SELECT * FROM usage_record_projection WHERE reconciliation_id = ?")
    .get(reconciliationId) as UsageRecordProjectionRow | undefined;
}

export function readUsageRecord(
  connection: SqliteConnection,
  reconciliationId: string,
): UsageRecord | undefined {
  const row = rawUsageRecord(connection, reconciliationId);
  if (row === undefined) return undefined;
  return decodeUsageRow(row);
}

export interface UsageQueryFilter {
  readonly providerInstanceId?: string;
  readonly modelId?: string;
  readonly subjectAggregateType?: string;
  readonly subjectAggregateId?: string;
  readonly mode?: string;
  readonly projectId?: string;
  readonly requestShape?: string;
  readonly category?: string;
  readonly hostId?: string;
  readonly quality?: UsageQuality;
  readonly from?: string;
  readonly to?: string;
}

/**
 * The threads of each mode whose Project passes `match`, as a subquery of
 * thread IDs.
 *
 * Chat and Code threads each carry their Project in a durable, indexed
 * `project_id` column. A Work thread has no SQL projection — its
 * ownership lives in the event journal that `WorkThreadProjection` hydrates
 * from — but a Work thread binds exactly one OS-confined Project root, so
 * `WorkThread.projectId` is required and immutable across updates, and the
 * create event is the host's authoritative record of it. `aggregate_id` is the
 * thread ID and is the leading column of the journal's unique key.
 */
const PROJECT_THREADS = [
  {
    mode: "chat",
    subjectType: "chat-thread",
    threads: (match: (projectColumn: string) => string) =>
      `SELECT thread_id FROM chat_thread_projection WHERE ${match("project_id")}`,
  },
  {
    mode: "code",
    subjectType: "code-thread",
    threads: (match: (projectColumn: string) => string) =>
      `SELECT thread_id FROM code_thread_projection WHERE ${match("project_id")}`,
  },
  {
    mode: "work",
    subjectType: "work-thread",
    threads: (match: (projectColumn: string) => string) => `
      SELECT aggregate_id FROM event_journal
      WHERE aggregate_type = 'work-thread'
        AND event_name = 'work.thread-created@1'
        AND ${match("json_extract(payload_json, '$.thread.projectId')")}`,
  },
] as const;

/**
 * The owning Project of every Project-bearing usage subject type, as one SQL
 * term per type (and per parent mode for a child run) mapping `subject_id` to a
 * Project.
 *
 * `match` is spliced into the owning query as the `project_id` test, so the two
 * predicates below differ only in that test and cannot drift apart.
 *
 * A child run belongs to its parent thread's Project, resolved through that
 * thread's current record exactly as the thread's own rows are, so a Project
 * counts the spend of every child its threads delegated and a thread moved to
 * another Project takes its children's spend with it. The run's parent and
 * mode are on its `agent.run-requested@1` event, which a purge erases with the
 * thread; the run's rows then belong to no Project.
 */
function projectBearingSubjectTerms(match: (projectColumn: string) => string): Array<string> {
  return [
    ...PROJECT_THREADS.map(
      ({ subjectType, threads }) => `(subject_type = '${subjectType}'
    AND subject_id IN (${threads(match)}))`,
    ),
    ...PROJECT_THREADS.map(
      ({ mode, threads }) => `(subject_type = 'agent-run'
    AND subject_id IN (
      SELECT aggregate_id FROM event_journal
      WHERE aggregate_type = 'agent-run'
        AND event_name = 'agent.run-requested@1'
        AND json_extract(payload_json, '$.run.routingReceipt.mode') = '${mode}'
        AND json_extract(payload_json, '$.run.parentThreadId') IN (${threads(match)})
    ))`,
    ),
  ];
}

/** How many times `usageProjectConditionSql` repeats the Project list. */
const PROJECT_BEARING_SUBJECT_COUNT = projectBearingSubjectTerms(() => "").length;

/**
 * SQL predicate placing a usage row in one of `projectCount` Projects.
 *
 * Every usage read resolves Project the same way — from the host's own durable
 * ownership records — so a scoped read cannot report a Project the host would
 * not attribute to it. A subject the host cannot place (an unfiled Chat thread,
 * or a subject type that carries no Project at all, such as the
 * `context-ledger` fallback used when no manifest names a subject) is nobody's
 * Project row and stays out.
 *
 * Pass the parameters with `usageProjectConditionParams` so the repeated
 * Project list stays aligned with the placeholders emitted here.
 *
 * The predicate belongs inside the bounded query: applied after the row cap it
 * would discard rows the cap already spent, so a Project would report fewer
 * rows — or none — while its durable rows still exist.
 */
export function usageProjectConditionSql(projectCount: number): string {
  const placeholders = Array.from({ length: projectCount }, () => "?").join(", ");
  const terms = projectBearingSubjectTerms((column) => `${column} IN (${placeholders})`);
  return `(\n  ${terms.join("\n  OR ")}\n)`;
}

/** The Project list repeated once per term `usageProjectConditionSql` emits. */
export function usageProjectConditionParams(
  projectIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return Array.from({ length: PROJECT_BEARING_SUBJECT_COUNT }).flatMap(() => projectIds);
}

/**
 * SQL predicate for a usage row the host cannot place in any Project: the exact
 * complement of `usageProjectConditionSql`, so the two scopes partition the
 * ledger and neither can reach the other's rows. It covers an unfiled thread, a
 * thread with no ownership record at all, a subject type that carries no
 * Project, and a de-linked row.
 *
 * A de-linked row (its thread was purged, so `subject_id` is NULL) is named
 * explicitly: SQL would otherwise propagate NULL through `NOT (...)` and drop
 * the row from both scopes, erasing retained spend from every read.
 */
export function usageUnfiledConditionSql(): string {
  const terms = projectBearingSubjectTerms((column) => `${column} IS NOT NULL`);
  return `(subject_id IS NULL OR NOT (\n  ${terms.join("\n  OR ")}\n))`;
}

export function queryUsageRecords(
  connection: SqliteConnection,
  filter: UsageQueryFilter,
  limit: number,
  afterSequence: number,
  projectScope: UsageProjectScope,
): {
  readonly records: ReadonlyArray<UsageRecord>;
  readonly hasMore: boolean;
  readonly nextAfterSequence: number | undefined;
} {
  const conditions: Array<string> = ["last_sequence > ?"];
  const params: Array<string | number> = [afterSequence];

  if (filter.providerInstanceId !== undefined) {
    conditions.push("provider_instance_id = ?");
    params.push(filter.providerInstanceId);
  }
  if (filter.modelId !== undefined) {
    conditions.push("model_id = ?");
    params.push(filter.modelId);
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
    params.push(filter.hostId);
  }
  if (filter.from !== undefined) {
    conditions.push("observed_at >= ?");
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    conditions.push("observed_at <= ?");
    params.push(filter.to);
  }
  if (filter.mode !== undefined) {
    const condition = usageModeCondition(filter.mode);
    if (condition === undefined)
      return { records: [], hasMore: false, nextAfterSequence: undefined };
    conditions.push(condition.sql);
    params.push(...condition.params);
  }
  if (filter.category !== undefined) {
    conditions.push("attribution_json LIKE ?");
    params.push(`%"category":"${filter.category}"%`);
  }
  if (filter.projectId !== undefined) {
    conditions.push(usageProjectConditionSql(1));
    params.push(...usageProjectConditionParams([filter.projectId]));
  }
  // The caller's authority scope narrows the same bounded query, so it can
  // never be widened by a filter and never spends the row cap on rows the
  // caller may not see.
  if (projectScope.kind === "unfiled") {
    conditions.push(usageUnfiledConditionSql());
  } else {
    if (projectScope.projectIds.length === 0) {
      return { records: [], hasMore: false, nextAfterSequence: undefined };
    }
    conditions.push(usageProjectConditionSql(projectScope.projectIds.length));
    params.push(...usageProjectConditionParams(projectScope.projectIds));
  }

  const where = conditions.join(" AND ");
  const rows = connection
    .prepare(
      `SELECT * FROM usage_record_projection WHERE ${where} ORDER BY last_sequence ASC LIMIT ?`,
    )
    .all(...params, limit + 1) as ReadonlyArray<UsageRecordProjectionRow>;

  const included = rows.slice(0, limit);
  const last = included.at(-1);
  const hasMore = rows.length > limit;
  return {
    records: included.map(decodeUsageRow),
    hasMore,
    nextAfterSequence: last === undefined ? undefined : last.last_sequence,
  };
}

/**
 * SQL predicate for the rows belonging to one mode, or `undefined` for a mode
 * no subject can be in.
 *
 * Shared by both query paths, because two copies of this rule is exactly how
 * one endpoint kept the defect after the other was fixed.
 *
 * Like the Project scope, this belongs inside the bounded query. Applied
 * after the row cap it would discard rows the cap already spent, so a mode
 * would report fewer rows — or none — while its durable rows still exist.
 */
export function usageModeCondition(
  mode: string,
): { readonly sql: string; readonly params: ReadonlyArray<string> } | undefined {
  if (mode !== "chat" && mode !== "work" && mode !== "code") return undefined;
  // A child run is in its parent thread's mode, the one its request records,
  // so a mode's total still adds up to the unfiltered one.
  return {
    sql: `(subject_type = ?
    OR (subject_type = 'agent-run' AND subject_id IN (
      SELECT aggregate_id FROM event_journal
      WHERE aggregate_type = 'agent-run'
        AND event_name = 'agent.run-requested@1'
        AND json_extract(payload_json, '$.run.routingReceipt.mode') = ?
    )))`,
    params: [`${mode}-thread`, mode],
  };
}

export function readAllUsageRecords(connection: SqliteConnection): ReadonlyArray<UsageRecord> {
  const rows = connection
    .prepare("SELECT * FROM usage_record_projection ORDER BY last_sequence ASC")
    .all() as ReadonlyArray<UsageRecordProjectionRow>;
  return rows.map(decodeUsageRow);
}

export function countUsageRecords(connection: SqliteConnection): number {
  const row = connection.prepare("SELECT COUNT(*) AS count FROM usage_record_projection").get() as {
    readonly count: number;
  };
  return row.count;
}

export function purgeUsageOlderThan(connection: SqliteConnection, olderThan: string): number {
  const result = connection
    .prepare("DELETE FROM usage_record_projection WHERE observed_at < ?")
    .run(olderThan);
  return result.changes;
}

export function resetUsageProjection(connection: SqliteConnection): number {
  const count = countUsageRecords(connection);
  connection.exec("DELETE FROM usage_record_projection;");
  return count;
}

export function recordUsageAuditEvent(
  connection: SqliteConnection,
  input: {
    readonly action: "reset" | "purge" | "export";
    readonly purgedCount: number;
    readonly details: unknown;
    readonly occurredAt: string;
  },
): void {
  connection
    .prepare(`
      INSERT INTO usage_audit_log (action, purged_count, details_json, occurred_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(input.action, input.purgedCount, JSON.stringify(input.details), input.occurredAt);
}

export function readUsageAuditEvents(connection: SqliteConnection): ReadonlyArray<{
  readonly action: string;
  readonly purged_count: number;
  readonly details_json: string;
  readonly occurred_at: string;
}> {
  return connection
    .prepare(
      "SELECT action, purged_count, details_json, occurred_at FROM usage_audit_log ORDER BY audit_id ASC",
    )
    .all() as ReadonlyArray<{
    readonly action: string;
    readonly purged_count: number;
    readonly details_json: string;
    readonly occurred_at: string;
  }>;
}

function decodeUsageRow(row: UsageRecordProjectionRow): UsageRecord {
  assertUsageProjectionSchema(row.schema_version);
  const attribution = JSON.parse(row.attribution_json) as ReadonlyArray<UsageAttributionEntry>;
  return decodeUsageRecord({
    reconciliationId: row.reconciliation_id,
    subject:
      row.subject_id === null
        ? { aggregateType: row.subject_type, deLinked: true }
        : { aggregateType: row.subject_type, aggregateId: row.subject_id },
    providerInstanceId: row.provider_instance_id,
    modelId: row.model_id,
    requestShape: row.request_shape,
    quality: row.quality,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
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
    ...(row.cost_usd_micros === null
      ? {}
      : {
          cost: {
            kind: row.cost_kind,
            usdMicros: row.cost_usd_micros,
          },
        }),
    ...(row.planning_available === 0
      ? {}
      : {
          plannedInputTokens: row.planned_input_tokens,
          varianceTokens: row.variance_tokens,
        }),
    attribution,
    observedAt: row.observed_at,
  });
}

/**
 * Whether the thread or child run a usage subject names was purged. The usage
 * row itself survives the purge — its aggregates are host accounting — but
 * replay must not re-link the erased identity.
 */
function subjectPurged(
  connection: SqliteConnection,
  subject: { readonly aggregateType: string; readonly aggregateId: string },
): boolean {
  if (subject.aggregateType === "agent-run") {
    // A purge erases a child run's history with its parent thread, leaving no
    // record of which thread it was; a run whose request is gone was purged.
    return (
      connection
        .prepare(
          `SELECT 1 AS present FROM event_journal
           WHERE aggregate_type = 'agent-run' AND aggregate_id = ?
             AND event_name = 'agent.run-requested@1'`,
        )
        .get(String(subject.aggregateId)) === undefined
    );
  }
  const mode = usageSubjectMode(subject.aggregateType);
  if (mode === undefined) return false;
  return (
    connection
      .prepare(`SELECT 1 AS present FROM thread_purge_tombstone WHERE mode = ? AND thread_id = ?`)
      .get(mode, String(subject.aggregateId)) !== undefined
  );
}

function usageSubjectMode(aggregateType: string): "chat" | "work" | "code" | undefined {
  switch (aggregateType) {
    case "chat-thread":
      return "chat";
    case "work-thread":
      return "work";
    case "code-thread":
      return "code";
    default:
      return undefined;
  }
}

function assertProjection(condition: boolean): asserts condition {
  if (!condition) throw new Error("usage projection invariant violated");
}

function decodeProjection<T>(decode: () => T): T {
  try {
    return decode();
  } catch {
    throw new Error("usage projection decode failed");
  }
}
