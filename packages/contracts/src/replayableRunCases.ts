import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { FinishedReceiptId, FinishedReceiptRecorded } from "./finishedReceipt";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Maximum number of newest replayable run cases retained by the projection. */
export const MAX_REPLAYABLE_RUN_CASES = 200;

/** Maximum character length of a stored run case's initial request text. */
export const MAX_REPLAYABLE_RUN_CASE_REQUEST_LENGTH = 200_000;

export const ReplayableRunCaseProject = Schema.Struct({
  id: ProjectId,
  name: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
});
export type ReplayableRunCaseProject = typeof ReplayableRunCaseProject.Type;

export const ReplayableRunCaseModel = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
});
export type ReplayableRunCaseModel = typeof ReplayableRunCaseModel.Type;

/**
 * One replayable run case derived from a recorded finished report
 * (`thread.finished-receipt-recorded@1`) for a non-untraced Work or Code thread.
 * Rebuilt idempotently from the journal and capped to the newest 200 cases.
 */
export const ReplayableRunCase = Schema.Struct({
  receiptId: FinishedReceiptId,
  threadId: GuidString,
  mode: Schema.Literals(["work", "code"]),
  request: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_REPLAYABLE_RUN_CASE_REQUEST_LENGTH),
  ),
  project: ReplayableRunCaseProject,
  model: Schema.optional(ReplayableRunCaseModel),
  receipt: FinishedReceiptRecorded,
  changedFileCount: Schema.optional(NonNegativeInt),
  recordedAt: UtcTimestamp,
});
export type ReplayableRunCase = typeof ReplayableRunCase.Type;

export const ReplayableRunCases = Schema.Array(ReplayableRunCase).check(
  Schema.isMaxLength(MAX_REPLAYABLE_RUN_CASES),
);
export type ReplayableRunCases = typeof ReplayableRunCases.Type;

export const decodeReplayableRunCase = Schema.decodeUnknownSync(
  ReplayableRunCase,
  STRICT_DECODE_OPTIONS,
);
export const decodeReplayableRunCases = Schema.decodeUnknownSync(
  ReplayableRunCases,
  STRICT_DECODE_OPTIONS,
);
