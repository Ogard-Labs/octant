import { Schema } from "effect";
import { CorrelationId, UtcTimestamp } from "./events";
import { ToolActionAuthority, ToolActionId } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const ValidationPlanId = brandedUuid("ValidationPlanId");
export type ValidationPlanId = typeof ValidationPlanId.Type;

export const ValidationEvidenceId = brandedUuid("ValidationEvidenceId");
export type ValidationEvidenceId = typeof ValidationEvidenceId.Type;

export const ValidationSourceKind = Schema.Literal(
  "repository-test",
  "artifact-validation",
  "browser-observation",
  "computer-use-observation",
  "apple-build",
  "apple-test",
  "manual-check",
);
export type ValidationSourceKind = typeof ValidationSourceKind.Type;

export const ValidationOutcome = Schema.Literal(
  "passed",
  "failed",
  "inconclusive",
  "unavailable",
  "interrupted",
  "skipped",
);
export type ValidationOutcome = typeof ValidationOutcome.Type;

export const ValidationSourceRef = Schema.Struct({
  kind: ValidationSourceKind,
  reference: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  actionId: Schema.optional(ToolActionId),
  correlationId: Schema.optional(CorrelationId),
}).annotations(strict);
export type ValidationSourceRef = typeof ValidationSourceRef.Type;

export const ValidationStep = Schema.Struct({
  stepId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  description: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  sources: Schema.Array(ValidationSourceRef),
  expectedOutcome: Schema.optional(ValidationOutcome),
}).annotations(strict);
export type ValidationStep = typeof ValidationStep.Type;

export const ValidationPlan = Schema.Struct({
  planId: ValidationPlanId,
  authority: ToolActionAuthority,
  steps: Schema.NonEmptyArray(ValidationStep),
  createdAt: UtcTimestamp,
  budgetMs: Schema.optional(Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(600_000))),
}).annotations(strict);
export type ValidationPlan = typeof ValidationPlan.Type;

export const ValidationEvidenceRecord = Schema.Struct({
  evidenceId: ValidationEvidenceId,
  planId: ValidationPlanId,
  stepId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  source: ValidationSourceRef,
  outcome: ValidationOutcome,
  authority: ToolActionAuthority,
  observedAt: UtcTimestamp,
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8192))),
  redacted: Schema.Boolean,
}).annotations(strict);
export type ValidationEvidenceRecord = typeof ValidationEvidenceRecord.Type;

export const ValidationReport = Schema.Struct({
  planId: ValidationPlanId,
  authority: ToolActionAuthority,
  evidence: Schema.Array(ValidationEvidenceRecord),
  overallOutcome: ValidationOutcome,
  completedAt: UtcTimestamp,
  stepResults: Schema.Array(
    Schema.Struct({
      stepId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
      outcome: ValidationOutcome,
      evidenceCount: Schema.Int.pipe(Schema.nonNegative()),
    }).annotations(strict),
  ),
}).annotations(strict);
export type ValidationReport = typeof ValidationReport.Type;

export const ValidationCompositionFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("budget-exceeded"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("replay-denied"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("missing"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("stale"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("superseded"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
).annotations(strict);
export type ValidationCompositionFailure = typeof ValidationCompositionFailure.Type;

export const decodeValidationPlanId = Schema.decodeUnknownSync(ValidationPlanId);
export const decodeValidationEvidenceId = Schema.decodeUnknownSync(ValidationEvidenceId);
export const decodeValidationSourceKind = Schema.decodeUnknownSync(ValidationSourceKind);
export const decodeValidationOutcome = Schema.decodeUnknownSync(ValidationOutcome);
export const decodeValidationSourceRef = Schema.decodeUnknownSync(ValidationSourceRef);
export const decodeValidationStep = Schema.decodeUnknownSync(ValidationStep);
export const decodeValidationPlan = Schema.decodeUnknownSync(ValidationPlan);
export const decodeValidationEvidenceRecord = Schema.decodeUnknownSync(ValidationEvidenceRecord);
export const decodeValidationReport = Schema.decodeUnknownSync(ValidationReport);
export const decodeValidationCompositionFailure = Schema.decodeUnknownSync(
  ValidationCompositionFailure,
);
