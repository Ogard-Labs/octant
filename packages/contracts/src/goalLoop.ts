/**
 * Letting a thread keep working on its own.
 *
 * A goal loop is a thread-scoped iteration over a `ThreadGoal` that already
 * exists. It introduces no new place work happens: each round is an ordinary
 * turn in the thread that owns the goal, checkpointed before it starts and
 * journaled like every other.
 *
 * Everything here describes supervision rather than capability. The loop
 * carries a ceiling it may only narrow, a budget that stops it, and a status
 * that says why it is not running. Nothing in this file grants anything.
 */

import { Schema } from "effect";
import { GuidString, NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AgentRunAuthority } from "./agentRun";
import { AutomationId } from "./automation";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ThreadGoalId } from "./goal";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

/** Enough to review an overnight loop without turning one read into a dump. */
export const MAX_GOAL_LOOP_ROUNDS_RETURNED = 200;

export const GoalLoopId = brandedUuid("GoalLoopId");
export type GoalLoopId = typeof GoalLoopId.Type;

export const GoalLoopRoundId = brandedUuid("GoalLoopRoundId");
export type GoalLoopRoundId = typeof GoalLoopRoundId.Type;

/**
 * Why a loop is not currently taking rounds.
 *
 * `awaiting-approval` is separate from `paused` because they end differently:
 * one waits for a person to answer a request the loop recorded, the other for
 * a person to say go again.
 */
export const GoalLoopStatus = Schema.Literals([
  "running",
  "paused",
  "awaiting-approval",
  "budget-limited",
  "stopped",
  "complete",
]);
export type GoalLoopStatus = typeof GoalLoopStatus.Type;

export const GoalLoopPauseReason = Schema.Literals([
  "budget-exhausted",
  "budget-required",
  "goal-paused",
  "goal-complete",
  "authority-widened",
  "approval-required",
  "checkpoint-unavailable",
  "spend-unreported",
  "paused-by-user",
  "stopped-by-user",
  "held-after-restart",
]);
export type GoalLoopPauseReason = typeof GoalLoopPauseReason.Type;

/**
 * What decides when a round may begin.
 *
 * A schedule is a trigger and never a second authority: it says *when*, and
 * every other rule applies to the round it started exactly as it would to a
 * continuous one.
 */
export const GoalLoopTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("continuous") }),
  Schema.Struct({
    kind: Schema.Literal("scheduled"),
    automationId: AutomationId,
  }),
]);
export type GoalLoopTrigger = typeof GoalLoopTrigger.Type;

export const GoalLoop = Schema.Struct({
  id: GoalLoopId,
  threadId: GuidString,
  goalId: ThreadGoalId,
  /** The ceiling declared when the person started it. It may only narrow. */
  ceiling: AgentRunAuthority,
  trigger: GoalLoopTrigger,
  status: GoalLoopStatus,
  /** Why it is not running, when it is not. */
  pauseReason: Schema.optional(GoalLoopPauseReason),
  roundsRun: NonNegativeInt,
  startedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  lastRoundAt: Schema.optional(UtcTimestamp),
  version: AggregateVersion,
})
  // A loop that is running has nothing to explain; one that is not always does,
  // so "why did it stop" is never a question the journal has to be read to
  // answer.
  .check(
    Schema.makeFilter((loop) => (loop.status === "running") === (loop.pauseReason === undefined)),
  );
export type GoalLoop = typeof GoalLoop.Type;

/** What one round did, kept so an overnight loop is reviewable round by round. */
export const GoalLoopRound = Schema.Struct({
  roundId: GoalLoopRoundId,
  loopId: GoalLoopId,
  sequence: PositiveInt,
  /**
   * The checkpoint taken before the round, which is what makes it reviewable.
   * Absent records that the round ran with none: a Work folder has no
   * checkpoint to mark, so such a round runs only when a person approves every
   * write it makes.
   */
  checkpointId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
  /** The intersection the round actually ran under, never the declared ceiling. */
  authority: AgentRunAuthority,
  /** `interrupted`: a host restart cut the round off; it carries the spend journaled before then. */
  outcome: Schema.Literals(["ran", "paused", "failed", "interrupted"]),
  detail: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
  tokensSpent: NonNegativeInt,
  startedAt: UtcTimestamp,
  endedAt: UtcTimestamp,
}).check(
  Schema.makeFilter(
    (round) =>
      round.checkpointId !== undefined || round.authority.executionPolicy === "approval-gated",
  ),
);
export type GoalLoopRound = typeof GoalLoopRound.Type;

const GoalLoopCommandFields = {
  threadId: GuidString,
  expectedVersion: AggregateVersion,
} as const;

export const GoalLoopCommand = Schema.Union([
  Schema.Struct({
    ...GoalLoopCommandFields,
    kind: Schema.Literal("start-goal-loop"),
    loopId: GoalLoopId,
    goalId: ThreadGoalId,
    ceiling: AgentRunAuthority,
    trigger: GoalLoopTrigger,
  }),
  Schema.Struct({
    ...GoalLoopCommandFields,
    kind: Schema.Literal("pause-goal-loop"),
  }),
  Schema.Struct({
    ...GoalLoopCommandFields,
    kind: Schema.Literal("resume-goal-loop"),
  }),
  Schema.Struct({
    ...GoalLoopCommandFields,
    kind: Schema.Literal("stop-goal-loop"),
  }),
  Schema.Struct({
    ...GoalLoopCommandFields,
    kind: Schema.Literal("narrow-goal-loop-ceiling"),
    ceiling: AgentRunAuthority,
  }),
]);
export type GoalLoopCommand = typeof GoalLoopCommand.Type;

export const GoalLoopResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("goal-loop"),
    loop: GoalLoop,
    rounds: Schema.Array(GoalLoopRound).check(Schema.isMaxLength(MAX_GOAL_LOOP_ROUNDS_RETURNED)),
  }),
  Schema.Struct({
    kind: Schema.Literal("goal-loop-refused"),
    reason: Schema.Literals([
      "stale-version",
      "goal-not-found",
      "loop-not-found",
      "loop-already-running",
      "would-widen",
      "budget-required",
      "ceiling-unenforceable",
      "not-authorized",
    ]),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type GoalLoopResult = typeof GoalLoopResult.Type;

export const GOAL_LOOP_AGGREGATE_TYPE = "goal-loop";
export const GOAL_LOOP_EVENT_NAMES = {
  started: "goal-loop-started@1",
  roundRecorded: "goal-loop-round-recorded@1",
  paused: "goal-loop-paused@1",
  resumed: "goal-loop-resumed@1",
  stopped: "goal-loop-stopped@1",
  ceilingNarrowed: "goal-loop-ceiling-narrowed@1",
  roundStarted: "goal-loop-round-started@1",
  roundSpend: "goal-loop-round-spend@1",
} as const;

export const decodeGoalLoopId = Schema.decodeUnknownSync(GoalLoopId, STRICT_DECODE_OPTIONS);
export const decodeGoalLoop = Schema.decodeUnknownSync(GoalLoop, STRICT_DECODE_OPTIONS);
export const decodeGoalLoopRound = Schema.decodeUnknownSync(GoalLoopRound, STRICT_DECODE_OPTIONS);
export const decodeGoalLoopCommand = Schema.decodeUnknownSync(
  GoalLoopCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeGoalLoopResult = Schema.decodeUnknownSync(GoalLoopResult, STRICT_DECODE_OPTIONS);
