import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateVersion, CorrelationId, UtcTimestamp } from "./events";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ThreadPlanId = brandedUuid("ThreadPlanId");
export type ThreadPlanId = typeof ThreadPlanId.Type;
export const ThreadPlanStepId = brandedUuid("ThreadPlanStepId");
export type ThreadPlanStepId = typeof ThreadPlanStepId.Type;
/**
 * The exact wording of a plan at one moment.
 *
 * Approval names a revision, never a plan: what was approved is the list of
 * steps the user actually read, and rewriting them mints a new revision the
 * approval no longer covers.
 */
export const ThreadPlanRevisionId = brandedUuid("ThreadPlanRevisionId");
export type ThreadPlanRevisionId = typeof ThreadPlanRevisionId.Type;

/** How many steps one plan may carry. Beyond this it is a project, not a plan. */
export const MAX_THREAD_PLAN_STEPS = 40;
export const MAX_THREAD_PLAN_HISTORY_ENTRIES = 32;

export const ThreadPlanStepStatus = Schema.Literals(["pending", "in-progress", "done", "dropped"]);
export type ThreadPlanStepStatus = typeof ThreadPlanStepStatus.Type;

export const ThreadPlanStatus = Schema.Literals(["proposed", "approved", "withdrawn"]);
export type ThreadPlanStatus = typeof ThreadPlanStatus.Type;

export const ThreadPlanStep = Schema.Struct({
  stepId: ThreadPlanStepId,
  position: NonNegativeInt,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  /** Why this step is here, in the plan's own words. */
  rationale: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048))),
  status: ThreadPlanStepStatus,
});
export type ThreadPlanStep = typeof ThreadPlanStep.Type;

/**
 * A step as it is proposed: a title and a reason, and nothing else.
 *
 * Position comes from the order the steps arrive in and status from the plan's
 * own transitions, so a proposal cannot claim a step is already done.
 */
export const ThreadPlanStepDraft = Schema.Struct({
  stepId: ThreadPlanStepId,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  rationale: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048))),
});
export type ThreadPlanStepDraft = typeof ThreadPlanStepDraft.Type;

export const ThreadPlan = Schema.Struct({
  id: ThreadPlanId,
  threadId: GuidString,
  revisionId: ThreadPlanRevisionId,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  status: ThreadPlanStatus,
  steps: Schema.Array(ThreadPlanStep).check(Schema.isMaxLength(MAX_THREAD_PLAN_STEPS)),
  /**
   * The revision the user approved. Present only while that revision is still
   * the plan's own, so a revised plan reads as proposed again rather than
   * carrying an approval of text nobody agreed to.
   */
  approvedRevisionId: Schema.optional(ThreadPlanRevisionId),
  proposedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  approvedAt: Schema.optional(UtcTimestamp),
  version: AggregateVersion,
});
export type ThreadPlan = typeof ThreadPlan.Type;

export const ThreadPlanHistoryEntry = Schema.Struct({
  revisionId: ThreadPlanRevisionId,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  status: ThreadPlanStatus,
  stepCount: NonNegativeInt,
  recordedAt: UtcTimestamp,
});
export type ThreadPlanHistoryEntry = typeof ThreadPlanHistoryEntry.Type;

const ThreadPlanCommandFields = {
  threadId: GuidString,
  expectedVersion: AggregateVersion,
  planId: ThreadPlanId,
  correlationId: Schema.optional(CorrelationId),
} as const;

export const ProposeThreadPlanCommand = Schema.Struct({
  kind: Schema.Literal("propose-thread-plan"),
  ...ThreadPlanCommandFields,
  revisionId: ThreadPlanRevisionId,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  steps: Schema.Array(ThreadPlanStepDraft).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_THREAD_PLAN_STEPS),
  ),
});
export type ProposeThreadPlanCommand = typeof ProposeThreadPlanCommand.Type;

export const ReviseThreadPlanCommand = Schema.Struct({
  kind: Schema.Literal("revise-thread-plan"),
  ...ThreadPlanCommandFields,
  revisionId: ThreadPlanRevisionId,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  steps: Schema.Array(ThreadPlanStepDraft).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_THREAD_PLAN_STEPS),
  ),
});
export type ReviseThreadPlanCommand = typeof ReviseThreadPlanCommand.Type;

/**
 * The approval gesture.
 *
 * It names the revision that was read. Nothing else approves a plan: changing
 * a thread's access posture says what the thread may do, never that its plan
 * was agreed.
 */
export const ApproveThreadPlanCommand = Schema.Struct({
  kind: Schema.Literal("approve-thread-plan"),
  ...ThreadPlanCommandFields,
  revisionId: ThreadPlanRevisionId,
});
export type ApproveThreadPlanCommand = typeof ApproveThreadPlanCommand.Type;

export const WithdrawThreadPlanCommand = Schema.Struct({
  kind: Schema.Literal("withdraw-thread-plan"),
  ...ThreadPlanCommandFields,
});
export type WithdrawThreadPlanCommand = typeof WithdrawThreadPlanCommand.Type;

export const SetThreadPlanStepStatusCommand = Schema.Struct({
  kind: Schema.Literal("set-thread-plan-step-status"),
  ...ThreadPlanCommandFields,
  stepId: ThreadPlanStepId,
  status: ThreadPlanStepStatus,
});
export type SetThreadPlanStepStatusCommand = typeof SetThreadPlanStepStatusCommand.Type;

export const ThreadPlanCommand = Schema.Union([
  ProposeThreadPlanCommand,
  ReviseThreadPlanCommand,
  ApproveThreadPlanCommand,
  WithdrawThreadPlanCommand,
  SetThreadPlanStepStatusCommand,
]);
export type ThreadPlanCommand = typeof ThreadPlanCommand.Type;

export const ThreadPlanUpdated = Schema.Struct({
  plan: ThreadPlan,
  history: Schema.Array(ThreadPlanHistoryEntry).check(
    Schema.isMaxLength(MAX_THREAD_PLAN_HISTORY_ENTRIES),
  ),
});
export type ThreadPlanUpdated = typeof ThreadPlanUpdated.Type;

export const THREAD_PLAN_EVENT_NAMES = {
  updated: "thread.plan-updated@1",
} as const;

export const decodeThreadPlanId = Schema.decodeUnknownSync(ThreadPlanId, STRICT_DECODE_OPTIONS);
export const decodeThreadPlanStepId = Schema.decodeUnknownSync(
  ThreadPlanStepId,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadPlanRevisionId = Schema.decodeUnknownSync(
  ThreadPlanRevisionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadPlanStep = Schema.decodeUnknownSync(ThreadPlanStep, STRICT_DECODE_OPTIONS);
export const decodeThreadPlan = Schema.decodeUnknownSync(ThreadPlan, STRICT_DECODE_OPTIONS);
export const decodeThreadPlanCommand = Schema.decodeUnknownSync(
  ThreadPlanCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadPlanUpdated = Schema.decodeUnknownSync(
  ThreadPlanUpdated,
  STRICT_DECODE_OPTIONS,
);
