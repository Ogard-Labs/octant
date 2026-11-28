import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

/**
 * A wake-up a thread's agent asked for: a prompt Octant sends back into the
 * same thread later, as a turn it starts on the runtime's behalf. Octant owns
 * it from the moment the agent asks. The runtime's own scheduler never holds
 * it, so nothing fires in a later session Octant does not see. It is
 * journaled on its own `thread-wakeup` aggregate, shown in its thread, and
 * cancelled by the person.
 */
export const ThreadWakeupId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("ThreadWakeupId"),
);
export type ThreadWakeupId = typeof ThreadWakeupId.Type;
export const decodeThreadWakeupId = Schema.decodeUnknownSync(ThreadWakeupId, STRICT_DECODE_OPTIONS);

/** A wake-up's thread: Work and Code start turns this way; Chat has none. */
export const ThreadWakeupMode = Schema.Literals(["work", "code"]);
export type ThreadWakeupMode = typeof ThreadWakeupMode.Type;

export { DEFAULT_THREAD_WAKEUPS_WAITING, MAX_THREAD_WAKEUPS_WAITING_SETTING } from "./octantLimits";

export const MAX_THREAD_WAKEUP_PROMPT_CHARACTERS = 4_096;
export const MAX_THREAD_WAKEUP_CRON_CHARACTERS = 128;

/**
 * When a wake-up fires. `delay` is a single fire a number of seconds after
 * it was asked for; `cron` follows a five-field cron expression in the
 * host's local time, once or on every match until it expires.
 */
export const ThreadWakeupSchedule = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("delay") }),
  Schema.Struct({
    kind: Schema.Literal("cron"),
    cron: Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(MAX_THREAD_WAKEUP_CRON_CHARACTERS),
    ),
    recurring: Schema.Boolean,
  }),
]);
export type ThreadWakeupSchedule = typeof ThreadWakeupSchedule.Type;

/**
 * Where a wake-up stands. `pending` waits for `nextFireAt`. `missed` came due
 * while the host was not running (or asleep past the grace window): it is
 * never fired late on its own; the person runs it or cancels it. `ended`
 * fires no more, for the reason `endedReason` names.
 */
export const ThreadWakeupStatus = Schema.Literals(["pending", "missed", "ended"]);
export type ThreadWakeupStatus = typeof ThreadWakeupStatus.Type;

export const ThreadWakeupEndedReason = Schema.Literals([
  "fired",
  "cancelled-by-person",
  "cancelled-by-agent",
  "thread-closed",
  "expired",
  "refused",
]);
export type ThreadWakeupEndedReason = typeof ThreadWakeupEndedReason.Type;

export const ThreadWakeup = Schema.Struct({
  id: ThreadWakeupId,
  mode: ThreadWakeupMode,
  threadId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  /** The provider tool the agent asked through, for the person's record. */
  providerToolName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  prompt: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_THREAD_WAKEUP_PROMPT_CHARACTERS)),
  /** The agent's one-sentence reason, when it gave one. */
  reason: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
  schedule: ThreadWakeupSchedule,
  /** The schedule in words, as the person and the agent read it. */
  humanSchedule: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  createdAt: UtcTimestamp,
  /** The next due time while pending; the time it came due while missed. */
  nextFireAt: UtcTimestamp,
  /** When a recurring wake-up stops on its own. */
  expiresAt: Schema.optional(UtcTimestamp),
  status: ThreadWakeupStatus,
  endedReason: Schema.optional(ThreadWakeupEndedReason),
  /** When it last started a turn, and which. */
  lastFiredAt: Schema.optional(UtcTimestamp),
  lastTurnId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255))),
  detail: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
});
export type ThreadWakeup = typeof ThreadWakeup.Type;
export const decodeThreadWakeup = Schema.decodeUnknownSync(ThreadWakeup, STRICT_DECODE_OPTIONS);

/**
 * The host's heading on the turn a wake-up starts, so the agent and the
 * transcript read the turn as one the runtime asked for earlier rather than
 * one the person typed. The journaled `fired` change is the evidence; the
 * heading is presentational.
 */
export const THREAD_WAKEUP_TURN_HEADING = "Wake-up you scheduled earlier in this thread:";

export const THREAD_WAKEUP_AGGREGATE = "thread-wakeup" as const;
export const THREAD_WAKEUP_CHANGED = "thread-wakeup.changed@1" as const;

/**
 * Every change to a wake-up journals its whole new state, so a replay of the
 * aggregate rebuilds it exactly. `change` says what moved it.
 */
export const ThreadWakeupChanged = Schema.Struct({
  wakeup: ThreadWakeup,
  change: Schema.Literals(["scheduled", "fired", "missed", "run-requested", "ended"]),
});
export type ThreadWakeupChanged = typeof ThreadWakeupChanged.Type;
export const decodeThreadWakeupChanged = Schema.decodeUnknownSync(
  ThreadWakeupChanged,
  STRICT_DECODE_OPTIONS,
);

/** The wake-ups a thread shows: pending and missed ones, soonest first. */
export const ThreadWakeupList = Schema.Struct({
  wakeups: Schema.Array(ThreadWakeup),
});
export type ThreadWakeupList = typeof ThreadWakeupList.Type;
export const decodeThreadWakeupList = Schema.decodeUnknownSync(
  ThreadWakeupList,
  STRICT_DECODE_OPTIONS,
);

/**
 * What the person may do with a wake-up from its thread: cancel it, or run a
 * missed one now (a pending one runs at its time).
 */
export const ThreadWakeupCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cancel-thread-wakeup"),
    wakeupId: ThreadWakeupId,
  }),
  Schema.Struct({
    kind: Schema.Literal("run-missed-thread-wakeup"),
    wakeupId: ThreadWakeupId,
  }),
]);
export type ThreadWakeupCommand = typeof ThreadWakeupCommand.Type;
export const decodeThreadWakeupCommand = Schema.decodeUnknownSync(
  ThreadWakeupCommand,
  STRICT_DECODE_OPTIONS,
);

export const ThreadWakeupCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread-wakeup-updated"),
    wakeup: ThreadWakeup,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-wakeup-refused"),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type ThreadWakeupCommandResult = typeof ThreadWakeupCommandResult.Type;
export const decodeThreadWakeupCommandResult = Schema.decodeUnknownSync(
  ThreadWakeupCommandResult,
  STRICT_DECODE_OPTIONS,
);
