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

/**
 * One acceptance criterion and how it is verified. A criterion is met only by
 * a check the host ran and observed — a command that exited zero, a person's
 * confirmation — never by a model saying so.
 */
export const MAX_THREAD_GOAL_CRITERIA = 12;
export const ThreadGoalCriterionId = Schema.String.pipe(Schema.pattern(/^c[1-9][0-9]?$/));
export type ThreadGoalCriterionId = typeof ThreadGoalCriterionId.Type;

export const ThreadGoalCriterionDraft = Schema.Struct({
  text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  /** A command whose zero exit shows the criterion holds; absent means a person confirms it. */
  check: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_048))),
}).annotations(strict);
export type ThreadGoalCriterionDraft = typeof ThreadGoalCriterionDraft.Type;

export const ThreadGoalCriterion = Schema.Struct({
  id: ThreadGoalCriterionId,
  text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  check: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_048))),
  status: Schema.Literal("unmet", "met"),
  /** What the last check observed, met or not. */
  evidence: Schema.optional(ThreadGoalEvidenceRef),
}).annotations(strict);
export type ThreadGoalCriterion = typeof ThreadGoalCriterion.Type;

const ThreadGoalCriterionDrafts = Schema.Array(ThreadGoalCriterionDraft).pipe(
  Schema.minItems(1),
  Schema.maxItems(MAX_THREAD_GOAL_CRITERIA),
);

export const ThreadGoal = Schema.Struct({
  id: ThreadGoalId,
  threadId: Schema.UUID,
  revisionId: ThreadGoalRevisionId,
  objective: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4_096)),
  status: ThreadGoalStatus,
  budget: ThreadGoalBudget,
  usage: ThreadGoalUsage,
  evidence: Schema.Array(ThreadGoalEvidenceRef).pipe(Schema.maxItems(64)),
  /** Optional so goals journaled before criteria existed replay unchanged. */
  criteria: Schema.optional(
    Schema.Array(ThreadGoalCriterion).pipe(Schema.maxItems(MAX_THREAD_GOAL_CRITERIA)),
  ),
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
  criteria: Schema.optional(ThreadGoalCriterionDrafts),
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
  /** Replaces the criteria; one whose text and check are unchanged keeps its status. */
  criteria: Schema.optional(ThreadGoalCriterionDrafts),
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

/** The observed outcome of one criterion's check, with what the host saw. */
export const RecordThreadGoalCheckCommand = Schema.Struct({
  kind: Schema.Literal("record-thread-goal-check"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
  criterionId: ThreadGoalCriterionId,
  outcome: Schema.Literal("met", "unmet"),
  evidence: ThreadGoalEvidenceRef,
}).annotations(strict);
export type RecordThreadGoalCheckCommand = typeof RecordThreadGoalCheckCommand.Type;

export const ThreadGoalCommand = Schema.Union(
  CreateThreadGoalCommand,
  PauseThreadGoalCommand,
  ResumeThreadGoalCommand,
  ReviseThreadGoalCommand,
  CompleteThreadGoalCommand,
  RecordThreadGoalUsageCommand,
  RecordThreadGoalCheckCommand,
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
export const decodeThreadGoalCriterionDraft = Schema.decodeUnknownSync(ThreadGoalCriterionDraft);
