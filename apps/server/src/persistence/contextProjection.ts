import {
  AGENT_RUN_USAGE_AGGREGATE_TYPE,
  CONTEXT_COMPACTION_EVENT_NAMES,
  CONTEXT_COMPACTION_REQUEST_SHAPE,
  decodeContextCompactionCompleted,
  decodeContextCompactionFailed,
  decodeContextCompactionRecord,
  decodeContextCompactionRequested,
  type ContextCompactionId,
  type ContextCompactionRecord,
  decodeCapacityReservation,
  decodeContextCapacityReservationUpdated,
  decodeContextManifest,
  decodeContextManifestCreated,
  decodeContextManifestId,
  decodeContextOverridesUpdated,
  decodeContextPlan,
  decodeContextPlanCreated,
  decodeContextPlanId,
  decodeContextSummary,
  decodeContextSummaryCreated,
  decodeContextSummaryId,
  decodeContextTurnOverrides,
  decodeContextUsageReconciled,
  decodeProviderInstanceId,
  decodeUsageReconciliation,
  decodeUsageReconciliationId,
  type CapacityReservation,
  type ContextManifest,
  type ContextManifestId,
  type ContextPlan,
  type ContextPlanId,
  type ContextSummary,
  type ContextSummaryId,
  type ContextSubjectRef,
  type ContextTurnOverrides,
  type EventEnvelope,
  type ProviderInstanceId,
  type UsageReconciliation,
  type UsageReconciliationId,
} from "@octant/contracts";
import type { Projection } from "./projection";
import {
  assertContextProjectionSchema,
  CONTEXT_PROJECTION_SCHEMA_VERSION,
  type ContextCapacityProjectionRow,
  type ContextManifestProjectionRow,
  type ContextOverrideProjectionRow,
  type ContextPlanProjectionRow,
  type ContextSummaryContentStoreRow,
  type ContextSummaryProjectionRow,
  type ContextUsageProjectionRow,
} from "./contextPersistenceSchema";
import type { SqliteConnection } from "./sqlitePort";

const contextEventNames = new Set([
  "context.manifest-created@1",
  "context.overrides-updated@1",
  "context.plan-created@1",
  "context.summary-created@1",
  "context.usage-reconciled@1",
  "context.capacity-reservation-updated@1",
]);

export class ContextProjection implements Projection {
  readonly name = "contexts";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM context_capacity_projection;
      DELETE FROM context_usage_projection;
      DELETE FROM context_summary_projection;
      DELETE FROM context_plan_projection;
      DELETE FROM context_override_projection;
      DELETE FROM context_manifest_projection;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (!contextEventNames.has(event.eventName)) return;
    // Image jobs and child runs reconcile usage without a context plan; only
    // the usage ledger reads them.
    if (
      event.eventName === "context.usage-reconciled@1" &&
      (event.aggregateType === "image-job" ||
        event.aggregateType === AGENT_RUN_USAGE_AGGREGATE_TYPE)
    ) {
      return;
    }
    assertProjection(event.eventVersion === 1 && event.aggregateType === "context-ledger");
    switch (event.eventName) {
      case "context.manifest-created@1":
        this.#applyManifest(connection, event);
        return;
      case "context.overrides-updated@1":
        this.#applyOverrides(connection, event);
        return;
      case "context.plan-created@1":
        this.#applyPlan(connection, event);
        return;
      case "context.summary-created@1":
        this.#applySummary(connection, event);
        return;
      case "context.usage-reconciled@1":
        this.#applyUsage(connection, event);
        return;
      case "context.capacity-reservation-updated@1":
        this.#applyCapacity(connection, event);
        return;
    }
  }

  #applyManifest(connection: SqliteConnection, event: EventEnvelope): void {
    const manifest = decodeProjection(() => decodeContextManifestCreated(event.payload).manifest);
    assertProjection(manifest.subject.aggregateId === event.aggregateId);
    const existing = rawManifest(connection, manifest.id);
    if (existing !== undefined) {
      assertProjection(existing.manifest_json === JSON.stringify(manifest));
      if (existing.last_sequence >= event.globalSequence) return;
      connection
        .prepare("UPDATE context_manifest_projection SET last_sequence = ? WHERE manifest_id = ?")
        .run(event.globalSequence, manifest.id);
      return;
    }
    connection
      .prepare(`
        INSERT INTO context_manifest_projection (
          manifest_id, subject_type, subject_id, provider_instance_id, model_id,
          schema_version, manifest_json, created_at, last_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        manifest.id,
        manifest.subject.aggregateType,
        manifest.subject.aggregateId,
        manifest.providerInstanceId,
        manifest.modelId,
        CONTEXT_PROJECTION_SCHEMA_VERSION,
        JSON.stringify(manifest),
        manifest.createdAt,
        event.globalSequence,
      );
  }

  #applyOverrides(connection: SqliteConnection, event: EventEnvelope): void {
    const update = decodeProjection(() => decodeContextOverridesUpdated(event.payload));
    const manifest = readContextManifest(connection, update.manifestId);
    assertProjection(manifest !== undefined && manifest.subject.aggregateId === event.aggregateId);
    decodeProjection(() => decodeContextManifest({ ...manifest, overrides: update.overrides }));
    const existing = rawOverrides(connection, update.manifestId);
    if (existing !== undefined && existing.last_sequence >= event.globalSequence) return;
    connection
      .prepare(`
        INSERT INTO context_override_projection (
          manifest_id, schema_version, overrides_json, occurred_at, last_sequence
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (manifest_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          overrides_json = excluded.overrides_json,
          occurred_at = excluded.occurred_at,
          last_sequence = excluded.last_sequence
        WHERE excluded.last_sequence > context_override_projection.last_sequence
      `)
      .run(
        update.manifestId,
        CONTEXT_PROJECTION_SCHEMA_VERSION,
        JSON.stringify(update.overrides),
        event.occurredAt,
        event.globalSequence,
      );
  }

  #applyPlan(connection: SqliteConnection, event: EventEnvelope): void {
    const plan = decodeProjection(() => decodeContextPlanCreated(event.payload).plan);
    const manifest = readContextManifest(connection, plan.manifestId);
    assertProjection(manifest !== undefined && manifest.subject.aggregateId === event.aggregateId);
    const existing = rawPlan(connection, plan.id);
    if (existing !== undefined) {
      assertProjection(existing.plan_json === JSON.stringify(plan));
      if (existing.last_sequence >= event.globalSequence) return;
      connection
        .prepare("UPDATE context_plan_projection SET last_sequence = ? WHERE plan_id = ?")
        .run(event.globalSequence, plan.id);
      return;
    }
    connection
      .prepare(`
        INSERT INTO context_plan_projection (
          plan_id, manifest_id, health, blocked, schema_version,
          plan_json, created_at, last_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        plan.id,
        plan.manifestId,
        plan.health,
        plan.blocked ? 1 : 0,
        CONTEXT_PROJECTION_SCHEMA_VERSION,
        JSON.stringify(plan),
        plan.createdAt,
        event.globalSequence,
      );
  }

  #applySummary(connection: SqliteConnection, event: EventEnvelope): void {
    const created = decodeProjection(() => decodeContextSummaryCreated(event.payload));
    const summary = created.summary;
    const existing = rawSummary(connection, summary.id);
    if (existing !== undefined) {
      assertProjection(existing.summary_json === JSON.stringify(summary));
      if (existing.last_sequence >= event.globalSequence) return;
      connection
        .prepare("UPDATE context_summary_projection SET last_sequence = ? WHERE summary_id = ?")
        .run(event.globalSequence, summary.id);
      return;
    }
    connection
      .prepare(`
        INSERT INTO context_summary_projection (
          summary_id, provider_instance_id, model_id, schema_version,
          summary_json, created_at, last_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        summary.id,
        summary.providerInstanceId,
        summary.modelId,
        CONTEXT_PROJECTION_SCHEMA_VERSION,
        JSON.stringify(summary),
        summary.createdAt,
        event.globalSequence,
      );
  }

  #applyUsage(connection: SqliteConnection, event: EventEnvelope): void {
    const reconciliation = decodeProjection(
      () => decodeContextUsageReconciled(event.payload).reconciliation,
    );
    const planId = reconciliation.planId;
    assertProjection(planId !== undefined);
    const plan = readContextPlan(connection, planId);
    assertProjection(plan !== undefined);
    const manifest = readContextManifest(connection, plan.manifestId);
    assertProjection(
      manifest !== undefined &&
        manifest.subject.aggregateId === event.aggregateId &&
        manifest.providerInstanceId === reconciliation.providerInstanceId &&
        manifest.modelId === reconciliation.modelId,
    );
    const existing = rawUsage(connection, reconciliation.id);
    if (existing !== undefined) {
      assertProjection(existing.reconciliation_json === JSON.stringify(reconciliation));
      if (existing.last_sequence >= event.globalSequence) return;
      connection
        .prepare(
          "UPDATE context_usage_projection SET last_sequence = ? WHERE reconciliation_id = ?",
        )
        .run(event.globalSequence, reconciliation.id);
      return;
    }
    connection
      .prepare(`
        INSERT INTO context_usage_projection (
          reconciliation_id, plan_id, provider_instance_id, model_id, request_shape,
          schema_version, reconciliation_json, observed_at, last_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        reconciliation.id,
        reconciliation.planId,
        reconciliation.providerInstanceId,
        reconciliation.modelId,
        reconciliation.requestShape,
        CONTEXT_PROJECTION_SCHEMA_VERSION,
        JSON.stringify(reconciliation),
        reconciliation.observedAt,
        event.globalSequence,
      );
  }

  #applyCapacity(connection: SqliteConnection, event: EventEnvelope): void {
    const reservation = decodeProjection(
      () => decodeContextCapacityReservationUpdated(event.payload).reservation,
    );
    assertProjection(reservation.subject.aggregateId === event.aggregateId);
    const existing = rawCapacity(connection, reservation.id);
    if (existing !== undefined) {
      const previous = decodeCapacityRow(existing);
      assertProjection(
        previous.subject.aggregateType === reservation.subject.aggregateType &&
          previous.subject.aggregateId === reservation.subject.aggregateId &&
          previous.providerInstanceId === reservation.providerInstanceId &&
          previous.modelId === reservation.modelId &&
          previous.createdAt === reservation.createdAt,
      );
      if (existing.last_sequence >= event.globalSequence) return;
      assertProjection(reservation.updatedAt >= previous.updatedAt);
    }
    connection
      .prepare(`
        INSERT INTO context_capacity_projection (
          reservation_id, subject_type, subject_id, provider_instance_id, model_id,
          state, schema_version, reservation_json, updated_at, last_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (reservation_id) DO UPDATE SET
          state = excluded.state,
          schema_version = excluded.schema_version,
          reservation_json = excluded.reservation_json,
          updated_at = excluded.updated_at,
          last_sequence = excluded.last_sequence
        WHERE excluded.last_sequence > context_capacity_projection.last_sequence
      `)
      .run(
        reservation.id,
        reservation.subject.aggregateType,
        reservation.subject.aggregateId,
        reservation.providerInstanceId,
        reservation.modelId,
        reservation.state,
        CONTEXT_PROJECTION_SCHEMA_VERSION,
        JSON.stringify(reservation),
        reservation.updatedAt,
        event.globalSequence,
      );
  }
}

function assertProjection(condition: boolean): asserts condition {
  if (!condition) throw new Error("Context projection event is inconsistent");
}

function decodeProjection<A>(decode: () => A): A {
  try {
    return decode();
  } catch {
    throw new Error("Context projection event is inconsistent");
  }
}

function rawManifest(
  connection: SqliteConnection,
  manifestId: ContextManifestId | string,
): ContextManifestProjectionRow | undefined {
  return connection
    .prepare("SELECT * FROM context_manifest_projection WHERE manifest_id = ?")
    .get(manifestId) as ContextManifestProjectionRow | undefined;
}

function rawOverrides(
  connection: SqliteConnection,
  manifestId: ContextManifestId | string,
): ContextOverrideProjectionRow | undefined {
  return connection
    .prepare("SELECT * FROM context_override_projection WHERE manifest_id = ?")
    .get(manifestId) as ContextOverrideProjectionRow | undefined;
}

function rawPlan(
  connection: SqliteConnection,
  planId: ContextPlanId | string,
): ContextPlanProjectionRow | undefined {
  return connection
    .prepare("SELECT * FROM context_plan_projection WHERE plan_id = ?")
    .get(planId) as ContextPlanProjectionRow | undefined;
}

function rawSummary(
  connection: SqliteConnection,
  summaryId: ContextSummaryId | string,
): ContextSummaryProjectionRow | undefined {
  return connection
    .prepare("SELECT * FROM context_summary_projection WHERE summary_id = ?")
    .get(summaryId) as ContextSummaryProjectionRow | undefined;
}

function rawUsage(
  connection: SqliteConnection,
  reconciliationId: UsageReconciliationId | string,
): ContextUsageProjectionRow | undefined {
  return connection
    .prepare("SELECT * FROM context_usage_projection WHERE reconciliation_id = ?")
    .get(reconciliationId) as ContextUsageProjectionRow | undefined;
}

function rawCapacity(
  connection: SqliteConnection,
  reservationId: CapacityReservation["id"] | string,
): ContextCapacityProjectionRow | undefined {
  return connection
    .prepare("SELECT * FROM context_capacity_projection WHERE reservation_id = ?")
    .get(reservationId) as ContextCapacityProjectionRow | undefined;
}

export function readContextManifest(
  connection: SqliteConnection,
  manifestId: ContextManifestId,
): ContextManifest | undefined {
  const row = rawManifest(connection, decodeContextManifestId(manifestId));
  if (row === undefined) return undefined;
  assertContextProjectionSchema(row.schema_version);
  const manifest = decodeProjection(() => decodeContextManifest(JSON.parse(row.manifest_json)));
  assertProjection(
    manifest.id === row.manifest_id &&
      manifest.subject.aggregateType === row.subject_type &&
      manifest.subject.aggregateId === row.subject_id &&
      manifest.providerInstanceId === row.provider_instance_id &&
      manifest.modelId === row.model_id &&
      manifest.createdAt === row.created_at,
  );
  return manifest;
}

export function readCurrentContextOverrides(
  connection: SqliteConnection,
  manifestId: ContextManifestId,
): ContextTurnOverrides | undefined {
  const row = rawOverrides(connection, decodeContextManifestId(manifestId));
  if (row === undefined) return readContextManifest(connection, manifestId)?.overrides;
  assertContextProjectionSchema(row.schema_version);
  const overrides = decodeProjection(() =>
    decodeContextTurnOverrides(JSON.parse(row.overrides_json)),
  );
  const manifest = readContextManifest(connection, manifestId);
  assertProjection(manifest !== undefined);
  decodeProjection(() => decodeContextManifest({ ...manifest, overrides }));
  return overrides;
}

export function readContextPlan(
  connection: SqliteConnection,
  planId: ContextPlanId,
): ContextPlan | undefined {
  const row = rawPlan(connection, decodeContextPlanId(planId));
  if (row === undefined) return undefined;
  assertContextProjectionSchema(row.schema_version);
  const plan = decodeProjection(() => decodeContextPlan(JSON.parse(row.plan_json)));
  assertProjection(
    plan.id === row.plan_id &&
      plan.manifestId === row.manifest_id &&
      plan.health === row.health &&
      plan.blocked === (row.blocked === 1) &&
      plan.createdAt === row.created_at,
  );
  return plan;
}

export function readContextSummary(
  connection: SqliteConnection,
  summaryId: ContextSummaryId,
): ContextSummary | undefined {
  const row = rawSummary(connection, decodeContextSummaryId(summaryId));
  if (row === undefined) return undefined;
  assertContextProjectionSchema(row.schema_version);
  const summary = decodeProjection(() => decodeContextSummary(JSON.parse(row.summary_json)));
  assertProjection(
    summary.id === row.summary_id &&
      summary.providerInstanceId === row.provider_instance_id &&
      summary.modelId === row.model_id &&
      summary.createdAt === row.created_at,
  );
  return summary;
}

/**
 * Records the generated text a summary stands for against the subject that
 * produced it. Callers write it in the same transaction as the
 * `context.summary-created@1` event so the text and its identity commit
 * together.
 */
export function writeContextSummaryContent(
  connection: SqliteConnection,
  input: {
    readonly summaryId: ContextSummaryId;
    readonly subject: ContextSubjectRef;
    readonly content: string;
    readonly createdAt: string;
  },
): void {
  connection
    .prepare(`
      INSERT INTO context_summary_content_store (
        summary_id, subject_type, subject_id, body_text, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      String(input.summaryId),
      input.subject.aggregateType,
      input.subject.aggregateId,
      input.content,
      input.createdAt,
    );
}

/**
 * Returns the generated text a summary stands for, or `undefined` once the
 * subject's content has been purged. A later turn sends the summary instead of
 * the material it replaced, so the text has to survive restart — but it
 * survives as subject-owned stored content, not as replayable journal payload,
 * because deleting the subject has to be able to destroy it.
 */
export function readContextSummaryContent(
  connection: SqliteConnection,
  summaryId: ContextSummaryId,
): string | undefined {
  const row = connection
    .prepare("SELECT * FROM context_summary_content_store WHERE summary_id = ?")
    .get(decodeContextSummaryId(summaryId)) as ContextSummaryContentStoreRow | undefined;
  return row?.body_text;
}

/** Removes every summary text a subject's own conversation produced. */
export function purgeContextSubjectContent(
  connection: SqliteConnection,
  subject: ContextSubjectRef,
): void {
  connection
    .prepare("DELETE FROM context_summary_content_store WHERE subject_type = ? AND subject_id = ?")
    .run(subject.aggregateType, subject.aggregateId);
}

/**
 * A purged thread's compactions leave with it. The rest of its context ledger
 * stays as host accounting, but a compaction is an action on the thread, and a
 * request left behind would read as one still running.
 */
export function purgeContextCompactions(
  connection: SqliteConnection,
  subject: ContextSubjectRef,
): void {
  const names = [
    CONTEXT_COMPACTION_EVENT_NAMES.requested,
    CONTEXT_COMPACTION_EVENT_NAMES.completed,
    CONTEXT_COMPACTION_EVENT_NAMES.failed,
  ];
  const owned = `SELECT global_sequence FROM event_journal
    WHERE aggregate_type = 'context-ledger' AND aggregate_id = ? AND event_name IN (?, ?, ?)`;
  connection
    .prepare(`DELETE FROM event_quarantine WHERE global_sequence IN (${owned})`)
    .run(subject.aggregateId, ...names);
  connection
    .prepare(`DELETE FROM event_journal WHERE global_sequence IN (${owned})`)
    .run(subject.aggregateId, ...names);
  // The plans and summaries a compaction committed sit between its events and
  // survive them. The store verifier treats a per-aggregate version gap as
  // corruption, so survivors are renumbered contiguously as journal compaction
  // does: ascending, each new version at most the old one, so the unique
  // version constraint never sees a transient collision. The caller reconciles
  // the aggregate head afterwards.
  const survivors = connection
    .prepare(
      `SELECT global_sequence, aggregate_version FROM event_journal
       WHERE aggregate_type = 'context-ledger' AND aggregate_id = ?
       ORDER BY global_sequence ASC`,
    )
    .all(subject.aggregateId) as ReadonlyArray<{
    readonly global_sequence: number;
    readonly aggregate_version: number;
  }>;
  const renumber = connection.prepare(
    "UPDATE event_journal SET aggregate_version = ? WHERE global_sequence = ?",
  );
  survivors.forEach((event, index) => {
    if (event.aggregate_version !== index + 1) renumber.run(index + 1, event.global_sequence);
  });
}

export function readContextUsage(
  connection: SqliteConnection,
  reconciliationId: UsageReconciliationId,
): UsageReconciliation | undefined {
  const row = rawUsage(connection, decodeUsageReconciliationId(reconciliationId));
  if (row === undefined) return undefined;
  assertContextProjectionSchema(row.schema_version);
  const reconciliation = decodeProjection(() =>
    decodeUsageReconciliation(JSON.parse(row.reconciliation_json)),
  );
  assertProjection(
    reconciliation.id === row.reconciliation_id &&
      reconciliation.planId === row.plan_id &&
      reconciliation.providerInstanceId === row.provider_instance_id &&
      reconciliation.modelId === row.model_id &&
      reconciliation.requestShape === row.request_shape &&
      reconciliation.observedAt === row.observed_at,
  );
  return reconciliation;
}

function decodeCapacityRow(row: ContextCapacityProjectionRow): CapacityReservation {
  assertContextProjectionSchema(row.schema_version);
  const reservation = decodeProjection(() =>
    decodeCapacityReservation(JSON.parse(row.reservation_json)),
  );
  assertProjection(
    reservation.id === row.reservation_id &&
      reservation.subject.aggregateType === row.subject_type &&
      reservation.subject.aggregateId === row.subject_id &&
      reservation.providerInstanceId === row.provider_instance_id &&
      reservation.modelId === row.model_id &&
      reservation.state === row.state &&
      reservation.updatedAt === row.updated_at,
  );
  return reservation;
}

export function readProviderCapacityReservations(
  connection: SqliteConnection,
  providerInstanceId: ProviderInstanceId,
): ReadonlyArray<CapacityReservation> {
  const decodedId = decodeProviderInstanceId(providerInstanceId);
  const rows = connection
    .prepare(
      "SELECT * FROM context_capacity_projection WHERE provider_instance_id = ? ORDER BY reservation_id",
    )
    .all(decodedId) as ReadonlyArray<ContextCapacityProjectionRow>;
  return rows.map(decodeCapacityRow);
}

export function readConservativeRestartReservations(
  connection: SqliteConnection,
  providerInstanceId: ProviderInstanceId,
): ReadonlyArray<CapacityReservation> {
  return readProviderCapacityReservations(connection, providerInstanceId).flatMap((reservation) =>
    reservation.state === "requested" ||
    reservation.state === "reserved" ||
    reservation.state === "running" ||
    reservation.state === "ambiguous"
      ? [decodeCapacityReservation({ ...reservation, state: "ambiguous" })]
      : [],
  );
}

export interface ContextSubjectProjectionState {
  readonly sequence: number;
  readonly next: { readonly manifest: ContextManifest; readonly plan: ContextPlan };
  readonly latestSent?: { readonly manifest: ContextManifest; readonly plan: ContextPlan };
  readonly summaries: ReadonlyArray<ContextSummary>;
  readonly latestUsage?: UsageReconciliation;
  readonly capacity?: CapacityReservation;
}

export function readContextSubjectProjection(
  connection: SqliteConnection,
  subject: ContextSubjectRef,
): ContextSubjectProjectionState | undefined {
  const manifestRow = connection
    .prepare(
      `SELECT * FROM context_manifest_projection
       WHERE subject_type = ? AND subject_id = ?
       ORDER BY last_sequence DESC, manifest_id DESC LIMIT 1`,
    )
    .get(subject.aggregateType, subject.aggregateId) as ContextManifestProjectionRow | undefined;
  if (manifestRow === undefined) return undefined;
  const persistedManifest = readContextManifest(connection, manifestRow.manifest_id as never);
  assertProjection(persistedManifest !== undefined);
  const currentOverrides = readCurrentContextOverrides(connection, persistedManifest.id);
  const manifest = decodeProjection(() =>
    decodeContextManifest({
      ...persistedManifest,
      overrides: currentOverrides ?? persistedManifest.overrides,
    }),
  );
  const planRow = connection
    .prepare(
      `SELECT * FROM context_plan_projection
       WHERE manifest_id = ? ORDER BY last_sequence DESC, plan_id DESC LIMIT 1`,
    )
    .get(manifest.id) as ContextPlanProjectionRow | undefined;
  assertProjection(planRow !== undefined);
  const plan = readContextPlan(connection, planRow.plan_id as never);
  assertProjection(plan !== undefined);

  // A compaction's own request is priced against the plan it compacted, but it
  // measures the summary request, not what the thread's window holds.
  const usageRow = connection
    .prepare(
      `SELECT u.* FROM context_usage_projection u
       JOIN context_plan_projection p ON p.plan_id = u.plan_id
       JOIN context_manifest_projection m ON m.manifest_id = p.manifest_id
       WHERE m.subject_type = ? AND m.subject_id = ? AND u.request_shape != ?
       ORDER BY u.last_sequence DESC, u.reconciliation_id DESC LIMIT 1`,
    )
    .get(subject.aggregateType, subject.aggregateId, CONTEXT_COMPACTION_REQUEST_SHAPE) as
    | ContextUsageProjectionRow
    | undefined;
  const latestUsage =
    usageRow === undefined
      ? undefined
      : readContextUsage(connection, usageRow.reconciliation_id as never);
  let latestSent: { readonly manifest: ContextManifest; readonly plan: ContextPlan } | undefined;
  if (latestUsage !== undefined) {
    const usagePlanId = latestUsage.planId;
    assertProjection(usagePlanId !== undefined);
    const sentPlan = readContextPlan(connection, usagePlanId);
    assertProjection(sentPlan !== undefined);
    const sentManifestPersisted = readContextManifest(connection, sentPlan.manifestId);
    assertProjection(sentManifestPersisted !== undefined);
    latestSent = { manifest: sentManifestPersisted, plan: sentPlan };
  }

  const capacityRow = connection
    .prepare(
      `SELECT * FROM context_capacity_projection
       WHERE subject_type = ? AND subject_id = ?
       ORDER BY last_sequence DESC, reservation_id DESC LIMIT 1`,
    )
    .get(subject.aggregateType, subject.aggregateId) as ContextCapacityProjectionRow | undefined;
  const capacity = capacityRow === undefined ? undefined : decodeCapacityRow(capacityRow);
  const entryIds = new Set([
    ...manifest.entries.map((entry) => entry.id),
    ...(latestSent?.manifest.entries.map((entry) => entry.id) ?? []),
  ]);
  const summaryRows = connection
    .prepare(
      `SELECT * FROM context_summary_projection
       WHERE provider_instance_id = ? AND model_id = ?
       ORDER BY last_sequence DESC, summary_id DESC`,
    )
    .all(
      manifest.providerInstanceId,
      manifest.modelId,
    ) as ReadonlyArray<ContextSummaryProjectionRow>;
  const relevantSummaryRows = summaryRows.flatMap((row) => {
    const summary = readContextSummary(connection, row.summary_id as never);
    return summary !== undefined && summary.sourceEntryIds.some((entryId) => entryIds.has(entryId))
      ? [{ row, summary }]
      : [];
  });
  const summaries = relevantSummaryRows.map(({ summary }) => summary);
  // The compaction's own usage is excluded above, and its completed event has
  // no projection row. A window that already accepted the live snapshot's
  // sequence — the journal head — would treat a lower restored sequence as a
  // broken response, so the head is part of the sequence.
  const journalHead = connection
    .prepare(
      `SELECT coalesce(max(global_sequence), 0) AS last_sequence FROM event_journal
       WHERE aggregate_type = 'context-ledger' AND aggregate_id = ?`,
    )
    .get(subject.aggregateId) as { readonly last_sequence: number } | undefined;
  const sequence = Math.max(
    manifestRow.last_sequence,
    planRow.last_sequence,
    usageRow?.last_sequence ?? 0,
    capacityRow?.last_sequence ?? 0,
    journalHead?.last_sequence ?? 0,
    ...relevantSummaryRows.map(({ row }) => row.last_sequence),
  );
  return {
    sequence,
    next: { manifest, plan },
    ...(latestSent === undefined ? {} : { latestSent }),
    summaries,
    ...(latestUsage === undefined ? {} : { latestUsage }),
    ...(capacity === undefined ? {} : { capacity }),
  };
}

/**
 * A subject's compactions, oldest first, folded straight from its journaled
 * events. Compactions are few and carry no content, so the journal is read
 * rather than projected; a thread purge that erases these events leaves
 * nothing behind to resurrect them.
 */
export function readContextCompactions(
  connection: SqliteConnection,
  subject: ContextSubjectRef,
): ReadonlyArray<ContextCompactionRecord> {
  const rows = connection
    .prepare(
      `SELECT event_name, payload_json FROM event_journal
       WHERE aggregate_type = 'context-ledger' AND aggregate_id = ?
         AND event_name IN (?, ?, ?)
       ORDER BY global_sequence`,
    )
    .all(
      subject.aggregateId,
      CONTEXT_COMPACTION_EVENT_NAMES.requested,
      CONTEXT_COMPACTION_EVENT_NAMES.completed,
      CONTEXT_COMPACTION_EVENT_NAMES.failed,
    ) as ReadonlyArray<{ readonly event_name: string; readonly payload_json: string }>;
  const records = new Map<string, ContextCompactionRecord>();
  for (const row of rows) {
    const payload: unknown = JSON.parse(row.payload_json);
    if (row.event_name === CONTEXT_COMPACTION_EVENT_NAMES.requested) {
      const requested = decodeProjection(() => decodeContextCompactionRequested(payload));
      if (!sameSubject(requested.subject, subject)) continue;
      records.set(
        String(requested.compactionId),
        decodeContextCompactionRecord({
          status: "running",
          compactionId: requested.compactionId,
          executor: requested.executor,
          requestedAt: requested.requestedAt,
        }),
      );
    } else if (row.event_name === CONTEXT_COMPACTION_EVENT_NAMES.completed) {
      const { receipt } = decodeProjection(() => decodeContextCompactionCompleted(payload));
      if (!sameSubject(receipt.subject, subject)) continue;
      records.delete(String(receipt.compactionId));
      records.set(String(receipt.compactionId), { status: "completed", receipt });
    } else {
      const failed = decodeProjection(() => decodeContextCompactionFailed(payload));
      const requested = records.get(String(failed.compactionId));
      if (!sameSubject(failed.subject, subject) || requested?.status !== "running") continue;
      records.delete(String(failed.compactionId));
      records.set(
        String(failed.compactionId),
        decodeContextCompactionRecord({
          status: "failed",
          compactionId: failed.compactionId,
          executor: requested.executor,
          reason: failed.reason,
          sessionMayHaveChanged: failed.sessionMayHaveChanged,
          failedAt: failed.failedAt,
        }),
      );
    }
  }
  return [...records.values()];
}

export function readContextCompaction(
  connection: SqliteConnection,
  subject: ContextSubjectRef,
  compactionId: ContextCompactionId,
): ContextCompactionRecord | undefined {
  return readContextCompactions(connection, subject).find(
    (record) => String(compactionIdOf(record)) === String(compactionId),
  );
}

/** Requested compactions that never reached a terminal event, on every subject. */
export function listRunningContextCompactions(connection: SqliteConnection): ReadonlyArray<{
  readonly subject: ContextSubjectRef;
  readonly compactionId: ContextCompactionId;
}> {
  const rows = connection
    .prepare(
      `SELECT DISTINCT aggregate_id FROM event_journal
       WHERE aggregate_type = 'context-ledger' AND event_name = ?`,
    )
    .all(CONTEXT_COMPACTION_EVENT_NAMES.requested) as ReadonlyArray<{
    readonly aggregate_id: string;
  }>;
  return rows.flatMap((row) => {
    const requested = connection
      .prepare(
        `SELECT payload_json FROM event_journal
         WHERE aggregate_type = 'context-ledger' AND aggregate_id = ? AND event_name = ?
         ORDER BY global_sequence LIMIT 1`,
      )
      .get(row.aggregate_id, CONTEXT_COMPACTION_EVENT_NAMES.requested) as
      | { readonly payload_json: string }
      | undefined;
    if (requested === undefined) return [];
    const { subject } = decodeProjection(() =>
      decodeContextCompactionRequested(JSON.parse(requested.payload_json)),
    );
    return readContextCompactions(connection, subject).flatMap((record) =>
      record.status === "running" ? [{ subject, compactionId: record.compactionId }] : [],
    );
  });
}

export function compactionIdOf(record: ContextCompactionRecord): ContextCompactionId {
  return record.status === "completed" ? record.receipt.compactionId : record.compactionId;
}

function sameSubject(left: ContextSubjectRef, right: ContextSubjectRef): boolean {
  return left.aggregateType === right.aggregateType && left.aggregateId === right.aggregateId;
}
