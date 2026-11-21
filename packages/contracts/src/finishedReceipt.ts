import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import {
  MAX_THREAD_GOAL_CHECK_LENGTH,
  MAX_THREAD_GOAL_CRITERIA,
  ThreadGoalCriterionId,
} from "./goal";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

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

export const FinishedReceiptCheckCommand = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_FINISHED_CHECK_COMMAND_LENGTH),
);
export type FinishedReceiptCheckCommand = typeof FinishedReceiptCheckCommand.Type;

/**
 * Input accepted by `octant_report_finished`. The summary describes what the
 * lead believes is finished; `checks` names up to 12 check commands the host
 * runs itself for proof. The agent's own words are never proof.
 */
export const ReportFinishedInput = Schema.Struct({
  summary: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_FINISHED_SUMMARY_LENGTH)),
  checks: Schema.optional(
    Schema.Array(FinishedReceiptCheckCommand).pipe(Schema.maxItems(MAX_FINISHED_CHECKS)),
  ),
}).annotations(strict);
export type ReportFinishedInput = typeof ReportFinishedInput.Type;

/**
 * Observed status of one check or goal criterion on a finished receipt.
 * - `proven`: the host ran the check command and observed a zero exit code.
 * - `failed`: the check exited non-zero, timed out, or was denied approval.
 * - `claimed`: a goal criterion with no check command; only a person can confirm it.
 * - `unavailable`: the host could not run the check (for example, a thread with no folder).
 */
export const FinishedReceiptCheckStatus = Schema.Literal(
  "proven",
  "failed",
  "claimed",
  "unavailable",
);
export type FinishedReceiptCheckStatus = typeof FinishedReceiptCheckStatus.Type;

/** Overall status of a finished receipt, including staleness from later journaled file changes. */
export const FinishedReceiptStatus = Schema.Literal(
  "proven",
  "failed",
  "claimed",
  "unavailable",
  "stale",
);
export type FinishedReceiptStatus = typeof FinishedReceiptStatus.Type;

export const FinishedReceiptItem = Schema.Struct({
  kind: Schema.Literal("check", "goal-criterion"),
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  command: Schema.optional(FinishedReceiptCheckCommand),
  criterionId: Schema.optional(ThreadGoalCriterionId),
  status: FinishedReceiptCheckStatus,
  exitCode: Schema.optional(Schema.Int),
  outputTail: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH)),
  ),
  reason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type FinishedReceiptItem = typeof FinishedReceiptItem.Type;

/** Diff file and line counts observed by the host, or why they were unavailable. */
export const FinishedReceiptDiff = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("observed"),
    changedFiles: NonNegativeInt,
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  }).annotations(strict),
);
export type FinishedReceiptDiff = typeof FinishedReceiptDiff.Type;

/**
 * Durable journal event payload for `thread.finished-receipt-recorded@1`.
 * Only recorded when no check failed; a failed check returns its output to the
 * agent in the same turn and writes nothing to the journal.
 */
export const FinishedReceiptRecorded = Schema.Struct({
  receiptId: FinishedReceiptId,
  threadId: Schema.UUID,
  mode: Schema.Literal("work", "code"),
  projectId: ProjectId,
  /** The turn or Code operation during which the lead reported finished. */
  turnId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  summary: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_FINISHED_SUMMARY_LENGTH)),
  items: Schema.Array(FinishedReceiptItem).pipe(Schema.maxItems(MAX_FINISHED_CHECKS * 2)),
  diff: FinishedReceiptDiff,
  recordedAt: UtcTimestamp,
}).annotations(strict);
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
}).annotations(strict);
export type ThreadFinishedReceipt = typeof ThreadFinishedReceipt.Type;

export const ThreadFinishedReceiptsResponse = Schema.Struct({
  receipts: Schema.Array(ThreadFinishedReceipt).pipe(
    Schema.maxItems(MAX_FINISHED_RECEIPTS_PER_THREAD),
  ),
}).annotations(strict);
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
}).annotations(strict);
export type ThreadBoardFinishedMark = typeof ThreadBoardFinishedMark.Type;

export const decodeFinishedReceiptId = Schema.decodeUnknownSync(FinishedReceiptId);
export const decodeReportFinishedInput = Schema.decodeUnknownSync(ReportFinishedInput);
export const decodeFinishedReceiptItem = Schema.decodeUnknownSync(FinishedReceiptItem);
export const decodeFinishedReceiptDiff = Schema.decodeUnknownSync(FinishedReceiptDiff);
export const decodeFinishedReceiptRecorded = Schema.decodeUnknownSync(FinishedReceiptRecorded);
export const decodeThreadFinishedReceipt = Schema.decodeUnknownSync(ThreadFinishedReceipt);
export const decodeThreadFinishedReceiptsResponse = Schema.decodeUnknownSync(
  ThreadFinishedReceiptsResponse,
);
export const decodeThreadBoardFinishedMark = Schema.decodeUnknownSync(ThreadBoardFinishedMark);
