import {
  AgentRunAuthority,
  GOAL_LOOP_AGGREGATE_TYPE,
  GOAL_LOOP_EVENT_NAMES,
  GoalLoop,
  GoalLoopPauseReason,
  GoalLoopRound,
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

export function registerGoalLoopEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(GOAL_LOOP_EVENT_NAMES.started, 1, GoalLoopStarted)
    .register(GOAL_LOOP_EVENT_NAMES.roundRecorded, 1, GoalLoopRoundRecorded)
    .register(GOAL_LOOP_EVENT_NAMES.paused, 1, GoalLoopPaused)
    .register(GOAL_LOOP_EVENT_NAMES.resumed, 1, GoalLoopResumed)
    .register(GOAL_LOOP_EVENT_NAMES.stopped, 1, GoalLoopStopped);
}

export interface GoalLoopEventStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  readonly actor: { readonly kind: "system" | "local-user"; readonly actorId: string };
}

/**
 * Appends the loop's frames.
 *
 * Written with `expectedVersion: 0` against the loop's own aggregate id: these
 * are records of what happened rather than transitions competing for one head,
 * and a round that ran must never be lost to a conflict with the pause frame
 * that follows it.
 */
export class GoalLoopEventStore {
  readonly #options: GoalLoopEventStoreOptions;

  constructor(options: GoalLoopEventStoreOptions) {
    this.#options = options;
  }

  append(input: {
    readonly aggregateId: string;
    readonly eventName: string;
    readonly payload: unknown;
  }): void {
    this.#options.journal.append({
      aggregate: { aggregateType: GOAL_LOOP_AGGREGATE_TYPE, aggregateId: input.aggregateId },
      expectedVersion: 0,
      events: [
        {
          eventId: this.#options.uuid(),
          eventName: input.eventName,
          eventVersion: 1,
          actor: this.#options.actor,
          occurredAt: this.#options.clock(),
          payload: input.payload,
        },
      ],
    });
  }
}
