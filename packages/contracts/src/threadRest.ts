import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * A snooze hides a thread from the active list until `until` passes. The
 * thread stays active in every other respect: a running turn keeps running
 * and its transcript keeps journaling. `duringTurn` records that a turn was
 * running when the snooze was set, so that turn ending is the "something
 * happened" that wakes the thread early.
 */
export const ThreadSnooze = Schema.Struct({
  until: UtcTimestamp,
  at: UtcTimestamp,
  duringTurn: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type ThreadSnooze = typeof ThreadSnooze.Type;

/**
 * The two resting states a Chat, Work, or Code thread can carry beside
 * archive. Both are optional so a journal written before they existed
 * replays as "in play"; absent means the same.
 *
 * `completedAt` is when the person completed the thread: put away in the
 * Completed shelf, still readable, not archived. `snooze` is the thread's
 * current snooze, if any; absent means the thread is awake.
 */
export const ThreadRestFields = {
  completedAt: Schema.optional(UtcTimestamp),
  snooze: Schema.optional(ThreadSnooze),
} as const;
