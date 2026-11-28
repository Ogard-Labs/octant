import { Schema } from "effect";
import { UtcTimestamp } from "./events";

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
  /**
   * Who parked the thread. A snooze the limit-recovery surface wrote carries
   * `usage-limit` so automated cleanup can drop exactly that record and never
   * erase a wake time the person chose; absent means an ordinary user snooze
   * (including every record written before this field existed).
   */
  origin: Schema.optional(Schema.Literals(["user", "usage-limit"])),
});
export type ThreadSnooze = typeof ThreadSnooze.Type;

/**
 * The latest turn is stopped on a provider usage limit, as a thread's
 * navigation row reports it. `resetsAt` is the provider's declared reset;
 * absent for a billing stop, which no clock clears, and when the provider did
 * not say. Absent from an older host, whose rows then say nothing of a limit.
 */
export const ThreadUsageLimited = Schema.Struct({
  resetsAt: Schema.optional(UtcTimestamp),
});
export type ThreadUsageLimited = typeof ThreadUsageLimited.Type;

export const ThreadLimitedFields = {
  limited: Schema.optional(ThreadUsageLimited),
} as const;

/**
 * The two resting states a Chat, Work, or Code thread can carry beside
 * archive. Both are optional so a journal written before they existed
 * replays as "in play"; absent means the same.
 *
 * `completedAt` is when the person put the thread away: in the
 * Put away shelf, still readable, not archived. `snooze` is the thread's
 * current snooze, if any; absent means the thread is awake.
 */
export const ThreadRestFields = {
  completedAt: Schema.optional(UtcTimestamp),
  snooze: Schema.optional(ThreadSnooze),
} as const;
