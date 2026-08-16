import {
  ValidationEvidenceRecorded,
  ValidationPlanCreated,
  ValidationReportCompleted,
  type EventEnvelope,
  type ToolActionAuthority,
  type ValidationEvidenceRecord,
  type ValidationEvidenceSnapshot,
  type ValidationOutcome,
  type ValidationPlan,
  type ValidationReport,
  type ValidationSourceKind,
  type ValidationStepSummary,
  type ValidationTimelineEntry,
} from "@octant/contracts";
import { computeOverallOutcome } from "@octant/domain";
import { Schema } from "effect";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  VALIDATION_PROJECTION_SCHEMA_VERSION,
  decodePersistedPlan,
  decodePersistedReport,
  decodePersistedSteps,
  decodePersistedTimeline,
  snapshotFromState,
  type ValidationEvidenceProjectionRow,
  type ValidationEvidenceProjectionState,
} from "./validationEvidencePersistenceSchema";
import {
  VALIDATION_AGGREGATE_TYPE,
  VALIDATION_EVIDENCE_RECORDED,
  VALIDATION_PLAN_CREATED,
  VALIDATION_REPORT_COMPLETED,
} from "./validationEventStore";

const decodePlanCreated = Schema.decodeUnknownSync(ValidationPlanCreated);
const decodeEvidenceRecorded = Schema.decodeUnknownSync(ValidationEvidenceRecorded);
const decodeReportCompleted = Schema.decodeUnknownSync(ValidationReportCompleted);

/**
 * Rebuildable validation evidence projection. Applies
 * `validation.plan-created@1`, `validation.evidence-recorded@1`, and
 * `validation.report-completed@1` events from the authoritative journal into
 * a per-plan projection table indexed by authority fields.
 *
 * Replay-safe ordering is guaranteed by the global journal sequence applied
 * in order. Source references are opaque tokens — raw filesystem paths,
 * prompt bodies, file contents, credentials, and provider headers never
 * enter the projection. When an evidence record is `redacted`, its `detail`
 * is stripped so only the opaque reference and outcome remain.
 *
 * The projection is idempotent: replaying the same event sequence produces
 * identical state, so reconnect or restart rebuilds evidence snapshots from
 * the authoritative event journal without a separate store.
 */
export class ValidationEvidenceProjection implements Projection {
  readonly name = "validation-evidence";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`DELETE FROM validation_evidence_projection;`);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.aggregateType !== VALIDATION_AGGREGATE_TYPE) return;
    if (event.eventName === VALIDATION_PLAN_CREATED && event.eventVersion === 1) {
      this.#applyPlanCreated(connection, event);
      return;
    }
    if (event.eventName === VALIDATION_EVIDENCE_RECORDED && event.eventVersion === 1) {
      this.#applyEvidenceRecorded(connection, event);
      return;
    }
    if (event.eventName === VALIDATION_REPORT_COMPLETED && event.eventVersion === 1) {
      this.#applyReportCompleted(connection, event);
      return;
    }
  }

  #applyPlanCreated(connection: SqliteConnection, event: EventEnvelope): void {
    const payload = decodePlanCreated(event.payload);
    const plan = payload.plan;
    const existing = readRow(connection, plan.planId);
    if (existing !== undefined && existing.aggregateVersion >= event.aggregateVersion) return;

    const steps = buildStepSummaries(plan, []);
    const state: ValidationEvidenceProjectionState = {
      planId: plan.planId,
      authority: plan.authority,
      plan,
      timeline: [],
      steps,
      overallOutcome: "unavailable",
      report: undefined,
      aggregateVersion: event.aggregateVersion,
      planSequence: event.globalSequence,
      lastSequence: event.globalSequence,
    };
    upsertState(connection, state);
  }

  #applyEvidenceRecorded(connection: SqliteConnection, event: EventEnvelope): void {
    const payload = decodeEvidenceRecorded(event.payload);
    const evidence = payload.evidence;
    const existing = readRow(connection, evidence.planId);
    if (existing === undefined) {
      // Evidence without a plan is not projectable; fail closed by ignoring.
      return;
    }
    if (existing.aggregateVersion >= event.aggregateVersion) return;

    const plan = existing.plan;
    const timeline = [...existing.timeline, toTimelineEntry(event, evidence)];
    const steps = plan !== undefined ? buildStepSummaries(plan, timeline) : existing.steps;
    const evidenceOutcome: ValidationOutcome =
      timeline.length === 0 ? "unavailable" : computeOverallOutcome(timelineToRecords(timeline));
    const reconciled = reconcileReport(existing.report, evidenceOutcome);
    const state: ValidationEvidenceProjectionState = {
      planId: evidence.planId,
      authority: existing.authority,
      plan,
      timeline,
      steps,
      overallOutcome: reconciled.overallOutcome,
      report: reconciled.report,
      aggregateVersion: event.aggregateVersion,
      planSequence: existing.planSequence,
      lastSequence: event.globalSequence,
    };
    upsertState(connection, state);
  }

  #applyReportCompleted(connection: SqliteConnection, event: EventEnvelope): void {
    const payload = decodeReportCompleted(event.payload);
    const report = payload.report;
    const existing = readRow(connection, report.planId);
    if (existing === undefined) return;
    if (existing.aggregateVersion >= event.aggregateVersion) return;

    const evidenceOutcome =
      existing.timeline.length === 0
        ? "unavailable"
        : computeOverallOutcome(timelineToRecords(existing.timeline));
    const reconciled = reconcileReport(report, evidenceOutcome);
    const state: ValidationEvidenceProjectionState = {
      planId: report.planId,
      authority: existing.authority,
      plan: existing.plan,
      timeline: existing.timeline,
      steps: existing.steps,
      overallOutcome: reconciled.overallOutcome,
      report: reconciled.report,
      aggregateVersion: event.aggregateVersion,
      planSequence: existing.planSequence,
      lastSequence: event.globalSequence,
    };
    upsertState(connection, state);
  }
}

function reconcileReport(
  report: ValidationReport | undefined,
  evidenceOutcome: ValidationOutcome,
): {
  readonly overallOutcome: ValidationOutcome;
  readonly report?: ValidationReport;
} {
  if (report === undefined) return { overallOutcome: evidenceOutcome };
  const overallOutcome = computeOverallOutcome([
    { outcome: evidenceOutcome },
    { outcome: report.overallOutcome },
  ]);
  return overallOutcome === report.overallOutcome ? { overallOutcome, report } : { overallOutcome };
}

function toTimelineEntry(
  event: EventEnvelope,
  evidence: ValidationEvidenceRecord,
): ValidationTimelineEntry {
  return {
    sequence: event.globalSequence,
    correlationId: event.correlationId,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    evidenceId: evidence.evidenceId,
    planId: evidence.planId,
    stepId: evidence.stepId,
    outcome: evidence.outcome,
    sourceKind: evidence.source.kind,
    sourceReference: evidence.source.reference,
    redacted: evidence.redacted,
    observedAt: evidence.observedAt,
    ...(evidence.redacted || evidence.detail === undefined ? {} : { detail: evidence.detail }),
  };
}

function buildStepSummaries(
  plan: ValidationPlan,
  timeline: ReadonlyArray<ValidationTimelineEntry>,
): ReadonlyArray<ValidationStepSummary> {
  return plan.steps.map((step) => {
    const stepEvidence = timeline.filter((entry) => entry.stepId === step.stepId);
    const outcomes = stepEvidence.map((e) => e.outcome);
    const effective = outcomes.filter((o) => o !== "skipped");
    const outcome: ValidationOutcome =
      stepEvidence.length === 0
        ? "unavailable"
        : effective.length === 0
          ? "inconclusive"
          : computeOverallOutcome(stepEvidence as ReadonlyArray<{ outcome: ValidationOutcome }>);
    const sourceKinds = uniqueSourceKinds(stepEvidence.map((e) => e.sourceKind));
    return {
      stepId: step.stepId,
      description: step.description,
      outcome,
      evidenceCount: stepEvidence.length,
      sourceKinds,
    };
  });
}

function uniqueSourceKinds(kinds: ReadonlyArray<ValidationSourceKind>): ValidationSourceKind[] {
  const seen = new Set<ValidationSourceKind>();
  const result: ValidationSourceKind[] = [];
  for (const kind of kinds) {
    if (!seen.has(kind)) {
      seen.add(kind);
      result.push(kind);
    }
  }
  return result;
}

function timelineToRecords(
  timeline: ReadonlyArray<ValidationTimelineEntry>,
): ReadonlyArray<{ outcome: ValidationOutcome }> {
  return timeline.map((entry) => ({ outcome: entry.outcome }));
}

interface ReadState {
  plan: ValidationPlan | undefined;
  timeline: ReadonlyArray<ValidationTimelineEntry>;
  steps: ReadonlyArray<ValidationStepSummary>;
  report: ValidationReport | undefined;
  authority: ToolActionAuthority;
  aggregateVersion: number;
  planSequence: number;
}

function readRow(connection: SqliteConnection, planId: string): ReadState | undefined {
  const row = connection
    .prepare(`SELECT * FROM validation_evidence_projection WHERE plan_id = ?`)
    .get(planId) as ValidationEvidenceProjectionRow | undefined;
  if (row === undefined) return undefined;
  return {
    plan: decodePersistedPlan(row.plan_json === null ? undefined : JSON.parse(row.plan_json)),
    timeline: decodePersistedTimeline(row.timeline_json),
    steps: decodePersistedSteps(row.steps_json),
    report: decodePersistedReport(
      row.report_json === null ? undefined : JSON.parse(row.report_json),
    ),
    authority: decodeAuthority(row),
    aggregateVersion: row.aggregate_version,
    planSequence: row.plan_sequence,
  };
}

function decodeAuthority(row: ValidationEvidenceProjectionRow): ToolActionAuthority {
  const base = {
    hostId: row.host_id,
    mode: row.mode,
    projectId: row.project_id,
    ...(row.root_id !== null ? { rootId: row.root_id } : {}),
    ...(row.worktree_id !== null ? { worktreeId: row.worktree_id } : {}),
    providerInstanceId: row.provider_instance_id,
    extension:
      row.extension_kind === "core"
        ? { kind: "core" as const }
        : {
            kind: "trusted-extension" as const,
            extensionId: row.extension_id!,
          },
  };
  return base as ToolActionAuthority;
}

function upsertState(connection: SqliteConnection, state: ValidationEvidenceProjectionState): void {
  const planJson = state.plan === undefined ? null : JSON.stringify(state.plan);
  const timelineJson = JSON.stringify(state.timeline);
  const stepsJson = JSON.stringify(state.steps);
  const reportJson = state.report === undefined ? null : JSON.stringify(state.report);
  connection
    .prepare(
      `
      INSERT INTO validation_evidence_projection (
        plan_id, schema_version, host_id, mode, project_id, root_id, worktree_id,
        provider_instance_id, extension_kind, extension_id, plan_json, timeline_json,
        steps_json, overall_outcome, report_json, aggregate_version, plan_sequence, last_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        host_id = excluded.host_id,
        mode = excluded.mode,
        project_id = excluded.project_id,
        root_id = excluded.root_id,
        worktree_id = excluded.worktree_id,
        provider_instance_id = excluded.provider_instance_id,
        extension_kind = excluded.extension_kind,
        extension_id = excluded.extension_id,
        plan_json = excluded.plan_json,
        timeline_json = excluded.timeline_json,
        steps_json = excluded.steps_json,
        overall_outcome = excluded.overall_outcome,
        report_json = excluded.report_json,
        aggregate_version = excluded.aggregate_version,
        plan_sequence = excluded.plan_sequence,
        last_sequence = excluded.last_sequence
    `,
    )
    .run(
      state.planId,
      VALIDATION_PROJECTION_SCHEMA_VERSION,
      state.authority.hostId,
      state.authority.mode,
      state.authority.projectId,
      state.authority.rootId ?? null,
      state.authority.worktreeId ?? null,
      state.authority.providerInstanceId,
      state.authority.extension.kind,
      state.authority.extension.kind === "trusted-extension"
        ? state.authority.extension.extensionId
        : null,
      planJson,
      timelineJson,
      stepsJson,
      state.overallOutcome,
      reportJson,
      state.aggregateVersion,
      state.planSequence,
      state.lastSequence,
    );
}

/**
 * Read the latest validation evidence snapshot for an authority scope.
 * Returns the plan with the highest `last_sequence` matching the authority.
 * When no evidence exists for the authority, returns `undefined` so the
 * caller can fail closed with an honest unavailable state.
 */
export function readValidationEvidenceSnapshot(
  connection: SqliteConnection,
  authority: ToolActionAuthority,
  snapshotAt: string,
): ValidationEvidenceSnapshot | undefined {
  const row = connection
    .prepare(
      `
      SELECT * FROM validation_evidence_projection
      WHERE host_id = ? AND mode = ? AND project_id = ? AND root_id IS ? AND worktree_id IS ?
        AND provider_instance_id = ? AND extension_kind = ? AND extension_id IS ?
      ORDER BY plan_sequence DESC
      LIMIT 1
    `,
    )
    .get(
      authority.hostId,
      authority.mode,
      authority.projectId,
      authority.rootId ?? null,
      authority.worktreeId ?? null,
      authority.providerInstanceId,
      authority.extension.kind,
      authority.extension.kind === "trusted-extension" ? authority.extension.extensionId : null,
    ) as ValidationEvidenceProjectionRow | undefined;
  if (row === undefined) return undefined;

  const state: ValidationEvidenceProjectionState = {
    planId: row.plan_id,
    authority: decodeAuthority(row),
    plan: decodePersistedPlan(row.plan_json === null ? undefined : JSON.parse(row.plan_json)),
    timeline: decodePersistedTimeline(row.timeline_json),
    steps: decodePersistedSteps(row.steps_json),
    overallOutcome: row.overall_outcome,
    report: decodePersistedReport(
      row.report_json === null ? undefined : JSON.parse(row.report_json),
    ),
    aggregateVersion: row.aggregate_version,
    planSequence: row.plan_sequence,
    lastSequence: row.last_sequence,
  };
  return snapshotFromState(state, snapshotAt);
}

/**
 * Read the latest projection sequence for an authority scope. Used to detect
 * stale cursors during reconnect replay.
 */
export function readValidationEvidenceSequence(
  connection: SqliteConnection,
  authority: ToolActionAuthority,
): number {
  const row = connection
    .prepare(
      `
      SELECT last_sequence AS last_sequence
      FROM validation_evidence_projection
      WHERE host_id = ? AND mode = ? AND project_id = ? AND root_id IS ? AND worktree_id IS ?
        AND provider_instance_id = ? AND extension_kind = ? AND extension_id IS ?
      ORDER BY plan_sequence DESC
      LIMIT 1
    `,
    )
    .get(
      authority.hostId,
      authority.mode,
      authority.projectId,
      authority.rootId ?? null,
      authority.worktreeId ?? null,
      authority.providerInstanceId,
      authority.extension.kind,
      authority.extension.kind === "trusted-extension" ? authority.extension.extensionId : null,
    ) as { readonly last_sequence: number } | undefined;
  return row?.last_sequence ?? 0;
}
