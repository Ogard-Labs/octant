import { Schema } from "effect";
import { CausationId, CorrelationId, GlobalSequence, UtcTimestamp } from "./events";
import {
  ValidationCompositionFailure,
  ValidationEvidenceId,
  ValidationOutcome,
  ValidationPlan,
  ValidationPlanId,
  ValidationReport,
  ValidationSourceKind,
} from "./validationComposition";
export {
  ValidationCompositionFailure,
  decodeValidationCompositionFailure,
} from "./validationComposition";
export type { ValidationOutcome } from "./validationComposition";
import { ToolActionAuthority } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Request a validation evidence snapshot for a given authority scope.
 * The server returns the latest plan, evidence records, and report
 * visible to the requesting window capability.
 */
export const ValidationEvidenceRequest = Schema.Struct({
  authority: ToolActionAuthority,
  planId: Schema.optional(ValidationPlanId),
  afterSequence: Schema.optional(GlobalSequence),
}).annotations(strict);
export type ValidationEvidenceRequest = typeof ValidationEvidenceRequest.Type;

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
  stepId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  outcome: ValidationOutcome,
  sourceKind: ValidationSourceKind,
  sourceReference: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  redacted: Schema.Boolean,
  observedAt: UtcTimestamp,
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8192))),
}).annotations(strict);
export type ValidationTimelineEntry = typeof ValidationTimelineEntry.Type;

/**
 * A step-level summary for the result pane.
 */
export const ValidationStepSummary = Schema.Struct({
  stepId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  description: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  outcome: ValidationOutcome,
  evidenceCount: Schema.Int.pipe(Schema.nonNegative()),
  sourceKinds: Schema.Array(ValidationSourceKind),
}).annotations(strict);
export type ValidationStepSummary = typeof ValidationStepSummary.Type;

/**
 * The validation evidence snapshot returned by the server.
 * Carries honest loading/waiting/unavailable/interrupted/failed/inconclusive/completed states.
 */
export const ValidationEvidenceSnapshot = Schema.Struct({
  authority: ToolActionAuthority,
  sequence: GlobalSequence,
  snapshotAt: UtcTimestamp,
  plan: Schema.optional(ValidationPlan),
  timeline: Schema.Array(ValidationTimelineEntry),
  steps: Schema.Array(ValidationStepSummary),
  overallOutcome: ValidationOutcome,
  report: Schema.optional(ValidationReport),
}).annotations(strict);
export type ValidationEvidenceSnapshot = typeof ValidationEvidenceSnapshot.Type;

/**
 * Subscribe to validation evidence updates for a given authority scope.
 */
export const ValidationEvidenceSubscribe = Schema.Struct({
  kind: Schema.Literal("validation-evidence-subscribe"),
  authority: ToolActionAuthority,
  afterSequence: GlobalSequence,
}).annotations(strict);
export type ValidationEvidenceSubscribe = typeof ValidationEvidenceSubscribe.Type;

export const ValidationEvidenceRpcEnvelope = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("validation-evidence-request"),
    request: ValidationEvidenceRequest,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("validation-evidence-snapshot"),
    snapshot: ValidationEvidenceSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("validation-evidence-failure"),
    failure: ValidationCompositionFailure,
  }).annotations(strict),
  ValidationEvidenceSubscribe,
);
export type ValidationEvidenceRpcEnvelope = typeof ValidationEvidenceRpcEnvelope.Type;

export const decodeValidationEvidenceRequest = Schema.decodeUnknownSync(ValidationEvidenceRequest);
export const decodeValidationTimelineEntry = Schema.decodeUnknownSync(ValidationTimelineEntry);
export const decodeValidationStepSummary = Schema.decodeUnknownSync(ValidationStepSummary);
export const decodeValidationEvidenceSnapshot = Schema.decodeUnknownSync(
  ValidationEvidenceSnapshot,
);
export const decodeValidationEvidenceSubscribe = Schema.decodeUnknownSync(
  ValidationEvidenceSubscribe,
);
export const decodeValidationEvidenceRpcEnvelope = Schema.decodeUnknownSync(
  ValidationEvidenceRpcEnvelope,
);
