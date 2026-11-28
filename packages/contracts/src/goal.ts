import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateVersion, CorrelationId, UtcTimestamp } from "./events";
import { ProviderInstanceId } from "./providers";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const ThreadGoalId = brandedUuid("ThreadGoalId");
export type ThreadGoalId = typeof ThreadGoalId.Type;
export const ThreadGoalRevisionId = brandedUuid("ThreadGoalRevisionId");
export type ThreadGoalRevisionId = typeof ThreadGoalRevisionId.Type;

export const ThreadGoalStatus = Schema.Literals(["active", "paused", "budget-limited", "complete"]);
export type ThreadGoalStatus = typeof ThreadGoalStatus.Type;

export const ThreadGoalBudget = Schema.Struct({
  tokenBudget: Schema.optional(PositiveInt),
  timeBudgetMs: Schema.optional(PositiveInt),
  turnBudget: Schema.optional(PositiveInt),
});
export type ThreadGoalBudget = typeof ThreadGoalBudget.Type;

export const ThreadGoalUsage = Schema.Struct({
  tokensUsed: NonNegativeInt,
  elapsedMs: NonNegativeInt,
  turnsUsed: NonNegativeInt,
});
export type ThreadGoalUsage = typeof ThreadGoalUsage.Type;

export const ThreadGoalEvidenceRef = Schema.Struct({
  kind: Schema.Literals(["event", "artifact", "test", "review", "user-confirmation"]),
  referenceId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  summary: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  observedAt: UtcTimestamp,
});
export type ThreadGoalEvidenceRef = typeof ThreadGoalEvidenceRef.Type;

/**
 * One acceptance criterion and how it is verified. A criterion is met only by
 * a check the host ran and observed — a command that exited zero, a person's
 * confirmation — never by a model saying so.
 */
export const MAX_THREAD_GOAL_CRITERIA = 12;
/**
 * A check command fits whole in the approval a person reads before it runs
 * (240 characters, with its `goal-check:` label): a longer one would let a
 * hidden tail run unseen. A longer check belongs in a script the command names.
 */
export const MAX_THREAD_GOAL_CHECK_LENGTH = 200;
const ThreadGoalCheckCommand = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_THREAD_GOAL_CHECK_LENGTH),
);
export const ThreadGoalCriterionId = Schema.String.check(Schema.isPattern(/^c[1-9][0-9]?$/));
export type ThreadGoalCriterionId = typeof ThreadGoalCriterionId.Type;

export const ThreadGoalCriterionDraft = Schema.Struct({
  text: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  /** A command whose zero exit shows the criterion holds; absent means a person confirms it. */
  check: Schema.optional(ThreadGoalCheckCommand),
});
export type ThreadGoalCriterionDraft = typeof ThreadGoalCriterionDraft.Type;

export const ThreadGoalCriterion = Schema.Struct({
  id: ThreadGoalCriterionId,
  text: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  check: Schema.optional(ThreadGoalCheckCommand),
  status: Schema.Literals(["unmet", "met"]),
  /** What the last check observed, met or not. */
  evidence: Schema.optional(ThreadGoalEvidenceRef),
});
export type ThreadGoalCriterion = typeof ThreadGoalCriterion.Type;

const ThreadGoalCriterionDrafts = Schema.Array(ThreadGoalCriterionDraft).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_THREAD_GOAL_CRITERIA),
);

export const ThreadGoal = Schema.Struct({
  id: ThreadGoalId,
  threadId: GuidString,
  revisionId: ThreadGoalRevisionId,
  objective: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  status: ThreadGoalStatus,
  budget: ThreadGoalBudget,
  usage: ThreadGoalUsage,
  evidence: Schema.Array(ThreadGoalEvidenceRef).check(Schema.isMaxLength(64)),
  /** Optional so goals journaled before criteria existed replay unchanged. */
  criteria: Schema.optional(
    Schema.Array(ThreadGoalCriterion).check(Schema.isMaxLength(MAX_THREAD_GOAL_CRITERIA)),
  ),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  completedAt: Schema.optional(UtcTimestamp),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /**
   * The newest usage charges by their charge id (a goal-loop round id), so a
   * charge repeated after a restart is recognised and not added twice.
   */
  recentChargeIds: Schema.optional(Schema.Array(GuidString).check(Schema.isMaxLength(32))),
  version: AggregateVersion,
});
export type ThreadGoal = typeof ThreadGoal.Type;

export const ThreadGoalHistoryEntry = Schema.Struct({
  revisionId: ThreadGoalRevisionId,
  objective: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  status: ThreadGoalStatus,
  recordedAt: UtcTimestamp,
});
export type ThreadGoalHistoryEntry = typeof ThreadGoalHistoryEntry.Type;

const ThreadGoalCommandFields = {
  threadId: GuidString,
  expectedVersion: AggregateVersion,
  correlationId: Schema.optional(CorrelationId),
} as const;

export const CreateThreadGoalCommand = Schema.Struct({
  kind: Schema.Literal("create-thread-goal"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
  revisionId: ThreadGoalRevisionId,
  objective: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  budget: ThreadGoalBudget,
  criteria: Schema.optional(ThreadGoalCriterionDrafts),
});
export type CreateThreadGoalCommand = typeof CreateThreadGoalCommand.Type;

export const PauseThreadGoalCommand = Schema.Struct({
  kind: Schema.Literal("pause-thread-goal"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
});
export type PauseThreadGoalCommand = typeof PauseThreadGoalCommand.Type;

export const ResumeThreadGoalCommand = Schema.Struct({
  kind: Schema.Literal("resume-thread-goal"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
});
export type ResumeThreadGoalCommand = typeof ResumeThreadGoalCommand.Type;

export const ReviseThreadGoalCommand = Schema.Struct({
  kind: Schema.Literal("revise-thread-goal"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
  revisionId: ThreadGoalRevisionId,
  objective: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  budget: Schema.optional(ThreadGoalBudget),
  /** Replaces the criteria; one whose text and check are unchanged keeps its status. */
  criteria: Schema.optional(ThreadGoalCriterionDrafts),
});
export type ReviseThreadGoalCommand = typeof ReviseThreadGoalCommand.Type;

export const CompleteThreadGoalCommand = Schema.Struct({
  kind: Schema.Literal("complete-thread-goal"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
  evidence: Schema.optional(Schema.Array(ThreadGoalEvidenceRef).check(Schema.isMaxLength(16))),
});
export type CompleteThreadGoalCommand = typeof CompleteThreadGoalCommand.Type;

export const RecordThreadGoalUsageCommand = Schema.Struct({
  kind: Schema.Literal("record-thread-goal-usage"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
  deltaTokens: NonNegativeInt,
  deltaElapsedMs: NonNegativeInt,
  deltaTurns: NonNegativeInt,
  /** Identifies one charge; a charge id the goal already holds is refused, never added again. */
  chargeId: Schema.optional(GuidString),
});
export type RecordThreadGoalUsageCommand = typeof RecordThreadGoalUsageCommand.Type;

/** The observed outcome of one criterion's check, with what the host saw. */
export const RecordThreadGoalCheckCommand = Schema.Struct({
  kind: Schema.Literal("record-thread-goal-check"),
  ...ThreadGoalCommandFields,
  goalId: ThreadGoalId,
  criterionId: ThreadGoalCriterionId,
  outcome: Schema.Literals(["met", "unmet"]),
  evidence: ThreadGoalEvidenceRef,
});
export type RecordThreadGoalCheckCommand = typeof RecordThreadGoalCheckCommand.Type;

export const ThreadGoalCommand = Schema.Union([
  CreateThreadGoalCommand,
  PauseThreadGoalCommand,
  ResumeThreadGoalCommand,
  ReviseThreadGoalCommand,
  CompleteThreadGoalCommand,
  RecordThreadGoalUsageCommand,
  RecordThreadGoalCheckCommand,
]);
export type ThreadGoalCommand = typeof ThreadGoalCommand.Type;

/**
 * The durable history ceiling. A goal that reaches it keeps its most recent
 * entries and drops the oldest, so a long-lived goal stays revisable and
 * completable instead of becoming undecodable on its next write.
 */
export const MAX_THREAD_GOAL_HISTORY_ENTRIES = 64;

export const ThreadGoalUpdated = Schema.Struct({
  goal: ThreadGoal,
  history: Schema.Array(ThreadGoalHistoryEntry).check(
    Schema.isMaxLength(MAX_THREAD_GOAL_HISTORY_ENTRIES),
  ),
});
export type ThreadGoalUpdated = typeof ThreadGoalUpdated.Type;

export const THREAD_GOAL_EVENT_NAMES = {
  updated: "thread.goal-updated@1",
} as const;

export const decodeThreadGoalId = Schema.decodeUnknownSync(ThreadGoalId, STRICT_DECODE_OPTIONS);
export const decodeThreadGoalRevisionId = Schema.decodeUnknownSync(
  ThreadGoalRevisionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadGoalStatus = Schema.decodeUnknownSync(
  ThreadGoalStatus,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadGoalBudget = Schema.decodeUnknownSync(
  ThreadGoalBudget,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadGoalUsage = Schema.decodeUnknownSync(
  ThreadGoalUsage,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadGoalEvidenceRef = Schema.decodeUnknownSync(
  ThreadGoalEvidenceRef,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadGoal = Schema.decodeUnknownSync(ThreadGoal, STRICT_DECODE_OPTIONS);
export const decodeThreadGoalCommand = Schema.decodeUnknownSync(
  ThreadGoalCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadGoalUpdated = Schema.decodeUnknownSync(
  ThreadGoalUpdated,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadGoalCriterionDraft = Schema.decodeUnknownSync(
  ThreadGoalCriterionDraft,
  STRICT_DECODE_OPTIONS,
);
