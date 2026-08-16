import { Schema } from "effect";
import {
  ValidationEvidenceRecord,
  ValidationPlan,
  ValidationReport,
} from "./validationComposition";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Event payload recorded when a validation plan is created for an authority
 * scope. The aggregate is the validation plan (`planId`).
 *
 * Raw prompt bodies, file contents, credentials, and provider headers never
 * enter this payload. Source references are opaque tokens.
 */
export const ValidationPlanCreated = Schema.Struct({
  plan: ValidationPlan,
}).annotations(strict);
export type ValidationPlanCreated = typeof ValidationPlanCreated.Type;

/**
 * Event payload recorded when a single validation evidence record is observed.
 * The aggregate is the validation plan (`planId`). Replay-safe ordering is
 * guaranteed by the global journal sequence; correlation and causation are
 * carried by the event envelope.
 *
 * Source references are opaque tokens — never raw filesystem paths. Set
 * `redacted: true` when the originating observation carried raw content that
 * must not be projected or returned.
 */
export const ValidationEvidenceRecorded = Schema.Struct({
  evidence: ValidationEvidenceRecord,
}).annotations(strict);
export type ValidationEvidenceRecorded = typeof ValidationEvidenceRecorded.Type;

/**
 * Event payload recorded when a validation report is finalized for a plan.
 * The aggregate is the validation plan (`planId`).
 */
export const ValidationReportCompleted = Schema.Struct({
  report: ValidationReport,
}).annotations(strict);
export type ValidationReportCompleted = typeof ValidationReportCompleted.Type;

export const decodeValidationPlanCreated = Schema.decodeUnknownSync(ValidationPlanCreated);
export const decodeValidationEvidenceRecorded = Schema.decodeUnknownSync(
  ValidationEvidenceRecorded,
);
export const decodeValidationReportCompleted = Schema.decodeUnknownSync(ValidationReportCompleted);
