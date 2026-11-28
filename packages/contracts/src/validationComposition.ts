import { Schema } from "effect";
import { NonEmptyTrimmedString, NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CausationId, CorrelationId, GlobalSequence, UtcTimestamp } from "./events";
import { ToolActionAuthority, ToolActionId } from "./toolActions";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

export const ValidationPlanId = brandedUuid("ValidationPlanId");
export type ValidationPlanId = typeof ValidationPlanId.Type;

export const ValidationEvidenceId = brandedUuid("ValidationEvidenceId");
export type ValidationEvidenceId = typeof ValidationEvidenceId.Type;

export const ValidationSourceKind = Schema.Literals([
  "repository-test",
  "artifact-validation",
  "browser-observation",
  "computer-use-observation",
  "apple-build",
  "apple-test",
  "manual-check",
]);
export type ValidationSourceKind = typeof ValidationSourceKind.Type;

export const ValidationOutcome = Schema.Literals([
  "passed",
  "failed",
  "inconclusive",
  "unavailable",
  "interrupted",
  "skipped",
]);
export type ValidationOutcome = typeof ValidationOutcome.Type;

export const ValidationSourceRef = Schema.Struct({
  kind: ValidationSourceKind,
  reference: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  actionId: Schema.optional(ToolActionId),
  correlationId: Schema.optional(CorrelationId),
});
export type ValidationSourceRef = typeof ValidationSourceRef.Type;

export const ValidationStep = Schema.Struct({
  stepId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  description: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  sources: Schema.Array(ValidationSourceRef),
  expectedOutcome: Schema.optional(ValidationOutcome),
});
export type ValidationStep = typeof ValidationStep.Type;

export const ValidationPlan = Schema.Struct({
  planId: ValidationPlanId,
  authority: ToolActionAuthority,
  steps: Schema.NonEmptyArray(ValidationStep),
  createdAt: UtcTimestamp,
  budgetMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(600_000)),
  ),
});
export type ValidationPlan = typeof ValidationPlan.Type;

export const ValidationEvidenceRecord = Schema.Struct({
  evidenceId: ValidationEvidenceId,
  planId: ValidationPlanId,
  stepId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  source: ValidationSourceRef,
  outcome: ValidationOutcome,
  authority: ToolActionAuthority,
  observedAt: UtcTimestamp,
  detail: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(8192))),
  redacted: Schema.Boolean,
});
export type ValidationEvidenceRecord = typeof ValidationEvidenceRecord.Type;

export const ValidationReport = Schema.Struct({
  planId: ValidationPlanId,
  authority: ToolActionAuthority,
  evidence: Schema.Array(ValidationEvidenceRecord),
  overallOutcome: ValidationOutcome,
  completedAt: UtcTimestamp,
  stepResults: Schema.Array(
    Schema.Struct({
      stepId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
      outcome: ValidationOutcome,
      evidenceCount: NonNegativeInt,
    }),
  ),
});
export type ValidationReport = typeof ValidationReport.Type;

export const ValidationCompositionFailure = Schema.Union([
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("budget-exceeded"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("replay-denied"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("missing"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("stale"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("superseded"),
    message: NonEmptyTrimmedString,
  }),
]);
export type ValidationCompositionFailure = typeof ValidationCompositionFailure.Type;

/**
 * A single evidence timeline entry with replay-safe ordering.
 * Source references are safe opaque tokens — never raw filesystem paths.
 */
export const ValidationTimelineEntry = Schema.Struct({
  sequence: GlobalSequence,
  correlationId: CorrelationId,
  causationId: Schema.optional(CausationId),
  evidenceId: ValidationEvidenceId,
  planId: ValidationPlanId,
  stepId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  outcome: ValidationOutcome,
  sourceKind: ValidationSourceKind,
  sourceReference: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  redacted: Schema.Boolean,
  observedAt: UtcTimestamp,
  detail: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(8192))),
});
export type ValidationTimelineEntry = typeof ValidationTimelineEntry.Type;

/** A step-level summary projected from validation evidence. */
export const ValidationStepSummary = Schema.Struct({
  stepId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  description: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  outcome: ValidationOutcome,
  evidenceCount: NonNegativeInt,
  sourceKinds: Schema.Array(ValidationSourceKind),
});
export type ValidationStepSummary = typeof ValidationStepSummary.Type;

/** Projected validation evidence snapshot stored in SQLite for replay. */
export const ValidationEvidenceSnapshot = Schema.Struct({
  authority: ToolActionAuthority,
  sequence: GlobalSequence,
  snapshotAt: UtcTimestamp,
  plan: Schema.optional(ValidationPlan),
  timeline: Schema.Array(ValidationTimelineEntry),
  steps: Schema.Array(ValidationStepSummary),
  overallOutcome: ValidationOutcome,
  report: Schema.optional(ValidationReport),
});
export type ValidationEvidenceSnapshot = typeof ValidationEvidenceSnapshot.Type;

export const decodeValidationPlanId = Schema.decodeUnknownSync(
  ValidationPlanId,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidationEvidenceId = Schema.decodeUnknownSync(
  ValidationEvidenceId,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidationSourceKind = Schema.decodeUnknownSync(
  ValidationSourceKind,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidationOutcome = Schema.decodeUnknownSync(
  ValidationOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidationSourceRef = Schema.decodeUnknownSync(
  ValidationSourceRef,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidationStep = Schema.decodeUnknownSync(ValidationStep, STRICT_DECODE_OPTIONS);
export const decodeValidationPlan = Schema.decodeUnknownSync(ValidationPlan, STRICT_DECODE_OPTIONS);
export const decodeValidationEvidenceRecord = Schema.decodeUnknownSync(
  ValidationEvidenceRecord,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidationReport = Schema.decodeUnknownSync(
  ValidationReport,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidationCompositionFailure = Schema.decodeUnknownSync(
  ValidationCompositionFailure,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidationTimelineEntry = Schema.decodeUnknownSync(
  ValidationTimelineEntry,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidationStepSummary = Schema.decodeUnknownSync(
  ValidationStepSummary,
  STRICT_DECODE_OPTIONS,
);
export const decodeValidationEvidenceSnapshot = Schema.decodeUnknownSync(
  ValidationEvidenceSnapshot,
  STRICT_DECODE_OPTIONS,
);
