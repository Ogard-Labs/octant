import {
  AgentRunAuthority,
  GOAL_LOOP_AGGREGATE_TYPE,
  GOAL_LOOP_EVENT_NAMES,
  GoalLoop,
  GoalLoopPauseReason,
  GoalLoopRound,
  UtcTimestamp as UtcTimestampSchema,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The journal frames a goal loop writes.
 *
 * A loop that is not running is the normal case, so every stop is a frame: a
 * budget spent, an approval waited on, an authority that widened underneath it.
 * Without them a stalled loop is indistinguishable from one nobody started, and
 * "why did nothing happen overnight" becomes a question the journal cannot
 * answer.
 */
export const GoalLoopStarted = Schema.Struct({
  loop: GoalLoop,
}).annotations(strict);

export const GoalLoopRoundRecorded = Schema.Struct({
  round: GoalLoopRound,
  /**
   * Whether the runner saw what the round charged. Absent on frames written
   * before it was kept, which read as seen, as they did before a restart.
   */
  spendObserved: Schema.optional(Schema.Boolean),
}).annotations(strict);

export const GoalLoopPaused = Schema.Struct({
  loopId: Schema.UUID,
  reason: GoalLoopPauseReason,
  /** What the round would have run under, so a resumed loop is comparable. */
  authority: Schema.optional(AgentRunAuthority),
}).annotations(strict);

export const GoalLoopResumed = Schema.Struct({
  loopId: Schema.UUID,
}).annotations(strict);

export const GoalLoopStopped = Schema.Struct({
  loopId: Schema.UUID,
  reason: GoalLoopPauseReason,
  roundsRun: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);

/**
 * A narrowed ceiling is journaled so a restart cannot widen a running loop
 * back to the ceiling it started with.
 */
export const GoalLoopCeilingNarrowed = Schema.Struct({
  loopId: Schema.UUID,
  ceiling: AgentRunAuthority,
}).annotations(strict);

/**
 * A round about to run. A started round with no recorded frame after it is
 * the round a restart cut off.
 */
export const GoalLoopRoundStarted = Schema.Struct({
  loopId: Schema.UUID,
  roundId: Schema.UUID,
  sequence: Schema.Int.pipe(Schema.positive()),
  authority: AgentRunAuthority,
  checkpointId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  startedAt: UtcTimestampSchema,
}).annotations(strict);

/** What a running round has charged so far, so a restart can charge it to the goal. */
export const GoalLoopRoundSpend = Schema.Struct({
  loopId: Schema.UUID,
  roundId: Schema.UUID,
  tokensSpent: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);

export function registerGoalLoopEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(GOAL_LOOP_EVENT_NAMES.started, 1, GoalLoopStarted)
    .register(GOAL_LOOP_EVENT_NAMES.roundRecorded, 1, GoalLoopRoundRecorded)
    .register(GOAL_LOOP_EVENT_NAMES.paused, 1, GoalLoopPaused)
    .register(GOAL_LOOP_EVENT_NAMES.resumed, 1, GoalLoopResumed)
    .register(GOAL_LOOP_EVENT_NAMES.stopped, 1, GoalLoopStopped)
    .register(GOAL_LOOP_EVENT_NAMES.ceilingNarrowed, 1, GoalLoopCeilingNarrowed)
    .register(GOAL_LOOP_EVENT_NAMES.roundStarted, 1, GoalLoopRoundStarted)
    .register(GOAL_LOOP_EVENT_NAMES.roundSpend, 1, GoalLoopRoundSpend);
}

/** One journaled goal-loop frame, decoded, in the order it was written. */
export type GoalLoopFrame = {
  readonly occurredAt: UtcTimestamp;
} & (
  | { readonly kind: "started"; readonly payload: typeof GoalLoopStarted.Type }
  | { readonly kind: "round-recorded"; readonly payload: typeof GoalLoopRoundRecorded.Type }
  | { readonly kind: "paused"; readonly payload: typeof GoalLoopPaused.Type }
  | { readonly kind: "resumed"; readonly payload: typeof GoalLoopResumed.Type }
  | { readonly kind: "stopped"; readonly payload: typeof GoalLoopStopped.Type }
  | { readonly kind: "ceiling-narrowed"; readonly payload: typeof GoalLoopCeilingNarrowed.Type }
  | { readonly kind: "round-started"; readonly payload: typeof GoalLoopRoundStarted.Type }
  | { readonly kind: "round-spend"; readonly payload: typeof GoalLoopRoundSpend.Type }
);

const decodeFrame = {
  [GOAL_LOOP_EVENT_NAMES.started]: (payload: unknown) => ({
    kind: "started" as const,
    payload: Schema.decodeUnknownSync(GoalLoopStarted)(payload),
  }),
  [GOAL_LOOP_EVENT_NAMES.roundRecorded]: (payload: unknown) => ({
    kind: "round-recorded" as const,
    payload: Schema.decodeUnknownSync(GoalLoopRoundRecorded)(payload),
  }),
  [GOAL_LOOP_EVENT_NAMES.paused]: (payload: unknown) => ({
    kind: "paused" as const,
    payload: Schema.decodeUnknownSync(GoalLoopPaused)(payload),
  }),
  [GOAL_LOOP_EVENT_NAMES.resumed]: (payload: unknown) => ({
    kind: "resumed" as const,
    payload: Schema.decodeUnknownSync(GoalLoopResumed)(payload),
  }),
  [GOAL_LOOP_EVENT_NAMES.stopped]: (payload: unknown) => ({
    kind: "stopped" as const,
    payload: Schema.decodeUnknownSync(GoalLoopStopped)(payload),
  }),
  [GOAL_LOOP_EVENT_NAMES.ceilingNarrowed]: (payload: unknown) => ({
    kind: "ceiling-narrowed" as const,
    payload: Schema.decodeUnknownSync(GoalLoopCeilingNarrowed)(payload),
  }),
  [GOAL_LOOP_EVENT_NAMES.roundStarted]: (payload: unknown) => ({
    kind: "round-started" as const,
    payload: Schema.decodeUnknownSync(GoalLoopRoundStarted)(payload),
  }),
  [GOAL_LOOP_EVENT_NAMES.roundSpend]: (payload: unknown) => ({
    kind: "round-spend" as const,
    payload: Schema.decodeUnknownSync(GoalLoopRoundSpend)(payload),
  }),
} satisfies Record<string, (payload: unknown) => Omit<GoalLoopFrame, "occurredAt">>;

const REPLAY_BATCH_SIZE = 1_000;

export interface GoalLoopEventStoreOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  readonly actor: { readonly kind: "system" | "local-user"; readonly actorId: string };
}

/**
 * Appends the loop's frames and reads them back after a restart.
 *
 * Each frame goes on at the loop aggregate's current head. These are records
 * of what happened rather than transitions competing for one head, so the
 * store follows the head it last wrote or replayed instead of asking callers
 * for a version. Appends used to claim version 0 and carry no correlation id,
 * so the journal refused every frame and a loop left no record a restart could
 * read.
 */
export class GoalLoopEventStore {
  readonly #options: GoalLoopEventStoreOptions;
  readonly #heads = new Map<string, number>();

  constructor(options: GoalLoopEventStoreOptions) {
    this.#options = options;
  }

  /** Every loop frame in the journal, oldest first; a frame that will not decode is skipped. */
  replay(): ReadonlyArray<GoalLoopFrame> {
    const frames: GoalLoopFrame[] = [];
    let afterSequence = 0;
    for (;;) {
      const batch = this.#options.journal.replayAggregateType({
        aggregateType: GOAL_LOOP_AGGREGATE_TYPE,
        afterSequence,
        limit: REPLAY_BATCH_SIZE,
      });
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        this.#heads.set(String(envelope.aggregateId), envelope.aggregateVersion);
        const decode = Object.hasOwn(decodeFrame, envelope.eventName)
          ? decodeFrame[envelope.eventName as keyof typeof decodeFrame]
          : undefined;
        if (decode === undefined) continue;
        try {
          frames.push({ ...decode(envelope.payload), occurredAt: envelope.occurredAt });
        } catch {
          // A frame this host cannot read says nothing it can act on.
        }
      }
      if (batch.length < REPLAY_BATCH_SIZE) return frames;
    }
  }

  append(input: {
    readonly aggregateId: string;
    readonly eventName: string;
    readonly payload: unknown;
  }): void {
    const committed = this.#options.journal.append({
      aggregate: { aggregateType: GOAL_LOOP_AGGREGATE_TYPE, aggregateId: input.aggregateId },
      expectedVersion: this.#heads.get(input.aggregateId) ?? 0,
      events: [
        {
          eventId: this.#options.uuid(),
          eventName: input.eventName,
          eventVersion: 1,
          correlationId: this.#options.uuid(),
          actor: this.#options.actor,
          occurredAt: this.#options.clock(),
          payload: input.payload,
        },
      ],
    });
    this.#heads.set(input.aggregateId, committed.aggregateVersion);
  }
}
