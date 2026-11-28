import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import {
  MAX_THREAD_GOAL_CHECK_LENGTH,
  MAX_THREAD_GOAL_CRITERIA,
  ThreadGoalCriterionId,
} from "./goal";
import { ProjectId } from "./projects";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const REPORT_FINISHED_TOOL_NAME = "octant_report_finished";
export const THREAD_FINISHED_RECEIPT_AGGREGATE_TYPE = "thread-finished-receipt";

export const THREAD_FINISHED_RECEIPT_EVENT_NAMES = {
  recorded: "thread.finished-receipt-recorded@1",
} as const;

/** Maximum character length of the lead agent's finished summary. */
export const MAX_FINISHED_SUMMARY_LENGTH = 1_000;
/** Maximum number of explicit check commands named in one report (matches thread goals). */
export const MAX_FINISHED_CHECKS = MAX_THREAD_GOAL_CRITERIA;
/** Maximum character length of one check command (matches thread goals). */
export const MAX_FINISHED_CHECK_COMMAND_LENGTH = MAX_THREAD_GOAL_CHECK_LENGTH;
/** Maximum character length kept from the end of a check command's output. */
export const MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH = 2_000;
/** Maximum number of receipts returned for one thread. */
export const MAX_FINISHED_RECEIPTS_PER_THREAD = 64;

export const FinishedReceiptId = brandedUuid("FinishedReceiptId");
export type FinishedReceiptId = typeof FinishedReceiptId.Type;

export const FinishedReceiptCheckCommand = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_FINISHED_CHECK_COMMAND_LENGTH),
);
export type FinishedReceiptCheckCommand = typeof FinishedReceiptCheckCommand.Type;

/**
 * Input accepted by `octant_report_finished`. The summary describes what the
 * lead believes is finished; `checks` names up to 12 check commands the host
 * runs itself for proof. The agent's own words are never proof.
 */
export const ReportFinishedInput = Schema.Struct({
  summary: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_FINISHED_SUMMARY_LENGTH),
  ),
  checks: Schema.optional(
    Schema.Array(FinishedReceiptCheckCommand).check(Schema.isMaxLength(MAX_FINISHED_CHECKS)),
  ),
});
export type ReportFinishedInput = typeof ReportFinishedInput.Type;

/**
 * Observed status of one check or goal criterion on a finished receipt.
 * - `proven`: the host ran the check command and observed a zero exit code.
 * - `failed`: the check exited non-zero, timed out, or was denied approval.
 * - `claimed`: a goal criterion with no check command; only a person can confirm it.
 * - `unavailable`: the host could not run the check (for example, a thread with no folder).
 */
export const FinishedReceiptCheckStatus = Schema.Literals([
  "proven",
  "failed",
  "claimed",
  "unavailable",
]);
export type FinishedReceiptCheckStatus = typeof FinishedReceiptCheckStatus.Type;

/** Overall status of a finished receipt, including staleness from later journaled file changes. */
export const FinishedReceiptStatus = Schema.Literals([
  "proven",
  "failed",
  "claimed",
  "unavailable",
  "stale",
]);
export type FinishedReceiptStatus = typeof FinishedReceiptStatus.Type;

export const FinishedReceiptItem = Schema.Struct({
  kind: Schema.Literals(["check", "goal-criterion"]),
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  command: Schema.optional(FinishedReceiptCheckCommand),
  criterionId: Schema.optional(ThreadGoalCriterionId),
  status: FinishedReceiptCheckStatus,
  exitCode: Schema.optional(Schema.Int),
  outputTail: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH)),
  ),
  reason: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
});
export type FinishedReceiptItem = typeof FinishedReceiptItem.Type;

/** Diff file and line counts observed by the host, or why they were unavailable. */
export const FinishedReceiptDiff = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("observed"),
    changedFiles: NonNegativeInt,
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  }),
]);
export type FinishedReceiptDiff = typeof FinishedReceiptDiff.Type;

/**
 * Durable journal event payload for `thread.finished-receipt-recorded@1`.
 * Only recorded when no check failed; a failed check returns its output to the
 * agent in the same turn and writes nothing to the journal.
 */
export const FinishedReceiptRecorded = Schema.Struct({
  receiptId: FinishedReceiptId,
  threadId: GuidString,
  mode: Schema.Literals(["work", "code"]),
  projectId: ProjectId,
  /** The turn or Code operation during which the lead reported finished. */
  turnId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
  summary: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_FINISHED_SUMMARY_LENGTH),
  ),
  items: Schema.Array(FinishedReceiptItem).check(Schema.isMaxLength(MAX_FINISHED_CHECKS * 2)),
  diff: FinishedReceiptDiff,
  recordedAt: UtcTimestamp,
});
export type FinishedReceiptRecorded = typeof FinishedReceiptRecorded.Type;

/**
 * Projected finished receipt served to thread views and the Review page.
 * Status and staleness are derived strictly from journal event order.
 */
export const ThreadFinishedReceipt = Schema.Struct({
  receipt: FinishedReceiptRecorded,
  status: FinishedReceiptStatus,
  stale: Schema.Boolean,
  provenCount: NonNegativeInt,
  claimedCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  unavailableCount: NonNegativeInt,
});
export type ThreadFinishedReceipt = typeof ThreadFinishedReceipt.Type;

export const ThreadFinishedReceiptsResponse = Schema.Struct({
  receipts: Schema.Array(ThreadFinishedReceipt).check(
    Schema.isMaxLength(MAX_FINISHED_RECEIPTS_PER_THREAD),
  ),
});
export type ThreadFinishedReceiptsResponse = typeof ThreadFinishedReceiptsResponse.Type;

/**
 * Compact board mark derived from a thread's latest fresh finished receipt.
 * Absent when the thread has no finished receipt or its latest receipt is stale.
 * Never changes the card's board column.
 */
export const ThreadBoardFinishedMark = Schema.Struct({
  receiptId: FinishedReceiptId,
  provenCount: NonNegativeInt,
  claimedCount: NonNegativeInt,
  recordedAt: UtcTimestamp,
});
export type ThreadBoardFinishedMark = typeof ThreadBoardFinishedMark.Type;

export const decodeFinishedReceiptId = Schema.decodeUnknownSync(
  FinishedReceiptId,
  STRICT_DECODE_OPTIONS,
);
export const decodeReportFinishedInput = Schema.decodeUnknownSync(
  ReportFinishedInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeFinishedReceiptItem = Schema.decodeUnknownSync(
  FinishedReceiptItem,
  STRICT_DECODE_OPTIONS,
);
export const decodeFinishedReceiptDiff = Schema.decodeUnknownSync(
  FinishedReceiptDiff,
  STRICT_DECODE_OPTIONS,
);
export const decodeFinishedReceiptRecorded = Schema.decodeUnknownSync(
  FinishedReceiptRecorded,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadFinishedReceipt = Schema.decodeUnknownSync(
  ThreadFinishedReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadFinishedReceiptsResponse = Schema.decodeUnknownSync(
  ThreadFinishedReceiptsResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadBoardFinishedMark = Schema.decodeUnknownSync(
  ThreadBoardFinishedMark,
  STRICT_DECODE_OPTIONS,
);
