import { Schema } from "effect";
import { AggregateVersion, CorrelationId, UtcTimestamp } from "./events";
import { ProviderInstanceId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const ThreadGoalId = brandedUuid("ThreadGoalId");
export type ThreadGoalId = typeof ThreadGoalId.Type;
export const ThreadGoalRevisionId = brandedUuid("ThreadGoalRevisionId");
export type ThreadGoalRevisionId = typeof ThreadGoalRevisionId.Type;

export const ThreadGoalStatus = Schema.Literal("active", "paused", "budget-limited", "complete");
export type ThreadGoalStatus = typeof ThreadGoalStatus.Type;

export const ThreadGoalBudget = Schema.Struct({
  tokenBudget: Schema.optional(PositiveInt),
  timeBudgetMs: Schema.optional(PositiveInt),
  turnBudget: Schema.optional(PositiveInt),
}).annotations(strict);
export type ThreadGoalBudget = typeof ThreadGoalBudget.Type;

export const ThreadGoalUsage = Schema.Struct({
  tokensUsed: NonNegativeInt,
  elapsedMs: NonNegativeInt,
  turnsUsed: NonNegativeInt,
}).annotations(strict);
export type ThreadGoalUsage = typeof ThreadGoalUsage.Type;

export const ThreadGoalEvidenceRef = Schema.Struct({
  kind: Schema.Literal("event", "artifact", "test", "review", "user-confirmation"),
  referenceId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  summary: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadGoalEvidenceRef = typeof ThreadGoalEvidenceRef.Type;

export const ThreadGoal = Schema.Struct({
  id: ThreadGoalId,
  threadId: Schema.UUID,
  revisionId: ThreadGoalRevisionId,
  objective: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096)),
  status: ThreadGoalStatus,
  budget: ThreadGoalBudget,
  usage: ThreadGoalUsage,
  evidence: Schema.Array(ThreadGoalEvidenceRef).pipe(Schema.maxItems(64)),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  completedAt: Schema.optional(UtcTimestamp),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  version: AggregateVersion,
}).annotations(strict);
export type ThreadGoal = typeof ThreadGoal.Type;

export const ThreadGoalHistoryEntry = Schema.Struct({
  revisionId: ThreadGoalRevisionId,
  objective: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096)),
  status: ThreadGoalStatus,
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadGoalHistoryEntry = typeof ThreadGoalHistoryEntry.Type;

const ThreadGoalCommandFields = {
  threadId: Schema.UUID,
  expectedVersion: AggregateVersion,
  correlationId: Schema.optional(CorrelationId),
} as const;

export const CreateThreadGoalCommand = Schema.Struct({
  kind: Schema.Literal("create-thread-goal"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
  revisionId: ThreadGoalRevisionId,
  objective: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096)),
  budget: ThreadGoalBudget,
}).annotations(strict);
export type CreateThreadGoalCommand = typeof CreateThreadGoalCommand.Type;

export const PauseThreadGoalCommand = Schema.Struct({
  kind: Schema.Literal("pause-thread-goal"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
}).annotations(strict);
export type PauseThreadGoalCommand = typeof PauseThreadGoalCommand.Type;

export const ResumeThreadGoalCommand = Schema.Struct({
  kind: Schema.Literal("resume-thread-goal"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
}).annotations(strict);
export type ResumeThreadGoalCommand = typeof ResumeThreadGoalCommand.Type;

export const ReviseThreadGoalCommand = Schema.Struct({
  kind: Schema.Literal("revise-thread-goal"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
  revisionId: ThreadGoalRevisionId,
  objective: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096)),
  budget: Schema.optional(ThreadGoalBudget),
}).annotations(strict);
export type ReviseThreadGoalCommand = typeof ReviseThreadGoalCommand.Type;

export const CompleteThreadGoalCommand = Schema.Struct({
  kind: Schema.Literal("complete-thread-goal"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
  evidence: Schema.optional(Schema.Array(ThreadGoalEvidenceRef).pipe(Schema.maxItems(16))),
}).annotations(strict);
export type CompleteThreadGoalCommand = typeof CompleteThreadGoalCommand.Type;

export const RecordThreadGoalUsageCommand = Schema.Struct({
  kind: Schema.Literal("record-thread-goal-usage"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
  deltaTokens: NonNegativeInt,
  deltaElapsedMs: NonNegativeInt,
  deltaTurns: NonNegativeInt,
}).annotations(strict);
export type RecordThreadGoalUsageCommand = typeof RecordThreadGoalUsageCommand.Type;

export const ThreadGoalCommand = Schema.Union(
  CreateThreadGoalCommand,
  PauseThreadGoalCommand,
  ResumeThreadGoalCommand,
  ReviseThreadGoalCommand,
  CompleteThreadGoalCommand,
  RecordThreadGoalUsageCommand,
);
export type ThreadGoalCommand = typeof ThreadGoalCommand.Type;

/**
 * The durable history ceiling. A goal that reaches it keeps its most recent
 * entries and drops the oldest, so a long-lived goal stays revisable and
 * completable instead of becoming undecodable on its next write.
 */
export const MAX_THREAD_GOAL_HISTORY_ENTRIES = 64;

export const ThreadGoalUpdated = Schema.Struct({
  goal: ThreadGoal,
  history: Schema.Array(ThreadGoalHistoryEntry).pipe(
    Schema.maxItems(MAX_THREAD_GOAL_HISTORY_ENTRIES),
  ),
}).annotations(strict);
export type ThreadGoalUpdated = typeof ThreadGoalUpdated.Type;

export const THREAD_GOAL_EVENT_NAMES = {
  updated: "thread.goal-updated@1",
} as const;

export const decodeThreadGoalId = Schema.decodeUnknownSync(ThreadGoalId);
export const decodeThreadGoalRevisionId = Schema.decodeUnknownSync(ThreadGoalRevisionId);
export const decodeThreadGoalStatus = Schema.decodeUnknownSync(ThreadGoalStatus);
export const decodeThreadGoalBudget = Schema.decodeUnknownSync(ThreadGoalBudget);
export const decodeThreadGoalUsage = Schema.decodeUnknownSync(ThreadGoalUsage);
export const decodeThreadGoalEvidenceRef = Schema.decodeUnknownSync(ThreadGoalEvidenceRef);
export const decodeThreadGoal = Schema.decodeUnknownSync(ThreadGoal);
export const decodeThreadGoalCommand = Schema.decodeUnknownSync(ThreadGoalCommand);
export const decodeThreadGoalUpdated = Schema.decodeUnknownSync(ThreadGoalUpdated);
