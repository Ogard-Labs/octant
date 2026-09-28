import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId, ProviderUsageLimit } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The durable opt-in record a thread carries when a person asks the host to
 * resume a provider usage-limited stop once the provider's declared reset
 * arrives. The record rides the thread's own aggregate stream as
 * `usage-resume.*@1` events, so it survives restarts, replays identically on
 * every client, and is bounded to exactly the stop it was made against —
 * turn identity, provider instance, and the reset fact the adapter reported.
 *
 * Ids stay unbranded strings: the same record shape is journaled on the
 * `chat-thread`, `work-thread`, and `code-thread` aggregates, whose turn keys
 * brand differently per mode (Chat `turnId` + `attemptId`, Work `turnId`,
 * Code `operationId`).
 */
export const UsageResumeRecord = Schema.Struct({
  threadId: Schema.String,
  /**
   * The stopped turn or operation the opt-in is bound to. For Code threads
   * this is the provider-turn operation id.
   */
  turnId: Schema.String,
  /** The stopped attempt within the turn; only Chat turns carry attempts. */
  attemptId: Schema.optional(Schema.String),
  /** The provider account the stop came from; a provider change invalidates. */
  providerInstanceId: ProviderInstanceId,
  /** The provider's own limit signal, journaled verbatim from the stop. */
  usageLimit: ProviderUsageLimit,
  /** The declared reset the opt-in waits for; never invented when absent. */
  resetsAt: UtcTimestamp,
  scheduledAt: UtcTimestamp,
}).annotations(strict);
export type UsageResumeRecord = typeof UsageResumeRecord.Type;

export const decodeUsageResumeRecord = Schema.decodeUnknownSync(UsageResumeRecord);

/**
 * The latest recovery a thread opted into, as its projection last settled it.
 * `scheduled` is the one pending state; `dispatched` means the host handed the
 * continuation to normal turn admission, `invalidated` means a fact the opt-in
 * depended on stopped holding, and `failed` means admission refused — `detail`
 * carries the honest reason whenever the host can name one. A cancelled opt-in
 * leaves no state: withdrawing it is not a fact a surface needs to report.
 */
export const UsageResumeThreadStatus = Schema.Literal(
  "scheduled",
  "dispatched",
  "invalidated",
  "failed",
);
export type UsageResumeThreadStatus = typeof UsageResumeThreadStatus.Type;

export const UsageResumeThreadState = Schema.Struct({
  record: UsageResumeRecord,
  status: UsageResumeThreadStatus,
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type UsageResumeThreadState = typeof UsageResumeThreadState.Type;

export const decodeUsageResumeThreadState = Schema.decodeUnknownSync(UsageResumeThreadState);

export const USAGE_RESUME_SCHEDULED = "usage-resume.scheduled@1" as const;
export const USAGE_RESUME_CANCELLED = "usage-resume.cancelled@1" as const;
export const USAGE_RESUME_SETTLED = "usage-resume.settled@1" as const;

export const UsageResumeScheduled = Schema.Struct({
  resume: UsageResumeRecord,
}).annotations(strict);
export type UsageResumeScheduled = typeof UsageResumeScheduled.Type;

/**
 * The record a cancel supersedes, journaled whole so replay reads the exact
 * opt-in that ended — never a bare "something was cancelled".
 */
export const UsageResumeCancelled = Schema.Struct({
  resume: UsageResumeRecord,
}).annotations(strict);
export type UsageResumeCancelled = typeof UsageResumeCancelled.Type;

/**
 * How a scheduled recovery ended: `dispatched` means the host handed the
 * continuation to the thread's normal turn admission, `invalidated` means a
 * fact the opt-in depended on stopped holding, and `failed` means the
 * admission itself refused — the honest reason rides `detail` either way.
 */
export const UsageResumeSettled = Schema.Struct({
  resume: UsageResumeRecord,
  outcome: Schema.Literal("dispatched", "invalidated", "failed"),
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type UsageResumeSettled = typeof UsageResumeSettled.Type;

export const decodeUsageResumeScheduled = Schema.decodeUnknownSync(UsageResumeScheduled);
export const decodeUsageResumeCancelled = Schema.decodeUnknownSync(UsageResumeCancelled);
export const decodeUsageResumeSettled = Schema.decodeUnknownSync(UsageResumeSettled);
