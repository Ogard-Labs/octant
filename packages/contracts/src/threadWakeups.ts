import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * A wake-up a thread's agent asked for: a prompt Octant sends back into the
 * same thread later, as a turn it starts on the runtime's behalf. Octant owns
 * it from the moment the agent asks. The runtime's own scheduler never holds
 * it, so nothing fires in a later session Octant does not see. It is
 * journaled on its own `thread-wakeup` aggregate, shown in its thread, and
 * cancelled by the person.
 */
export const ThreadWakeupId = Schema.UUID.pipe(Schema.brand("ThreadWakeupId"));
export type ThreadWakeupId = typeof ThreadWakeupId.Type;
export const decodeThreadWakeupId = Schema.decodeUnknownSync(ThreadWakeupId);

/** A wake-up's thread: Work and Code start turns this way; Chat has none. */
export const ThreadWakeupMode = Schema.Literal("work", "code");
export type ThreadWakeupMode = typeof ThreadWakeupMode.Type;

export const MAX_THREAD_WAKEUP_PROMPT_CHARACTERS = 4_096;
export const MAX_THREAD_WAKEUP_CRON_CHARACTERS = 128;

/**
 * When a wake-up fires. `delay` is a single fire a number of seconds after
 * it was asked for; `cron` follows a five-field cron expression in the
 * host's local time, once or on every match until it expires.
 */
export const ThreadWakeupSchedule = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("delay") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cron"),
    cron: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_THREAD_WAKEUP_CRON_CHARACTERS)),
    recurring: Schema.Boolean,
  }).annotations(strict),
);
export type ThreadWakeupSchedule = typeof ThreadWakeupSchedule.Type;

/**
 * Where a wake-up stands. `pending` waits for `nextFireAt`. `missed` came due
 * while the host was not running (or asleep past the grace window): it is
 * never fired late on its own; the person runs it or cancels it. `ended`
 * fires no more, for the reason `endedReason` names.
 */
export const ThreadWakeupStatus = Schema.Literal("pending", "missed", "ended");
export type ThreadWakeupStatus = typeof ThreadWakeupStatus.Type;

export const ThreadWakeupEndedReason = Schema.Literal(
  /** A one-time wake-up started its turn. */
  "fired",
  "cancelled-by-person",
  /** The agent deleted it (`CronDelete`) or ended its loop (`ScheduleWakeup` `stop`). */
  "cancelled-by-agent",
  /** The thread was archived, deleted, or left its Project. */
  "thread-closed",
  /** A recurring wake-up reached the end of its lifetime. */
  "expired",
  /** The turn could not be started; `detail` says why. */
  "refused",
);
export type ThreadWakeupEndedReason = typeof ThreadWakeupEndedReason.Type;

export const ThreadWakeup = Schema.Struct({
  id: ThreadWakeupId,
  mode: ThreadWakeupMode,
  threadId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  /** The provider tool the agent asked through, for the person's record. */
  providerToolName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  prompt: Schema.NonEmptyString.pipe(Schema.maxLength(MAX_THREAD_WAKEUP_PROMPT_CHARACTERS)),
  /** The agent's one-sentence reason, when it gave one. */
  reason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
  schedule: ThreadWakeupSchedule,
  /** The schedule in words, as the person and the agent read it. */
  humanSchedule: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  createdAt: UtcTimestamp,
  /** The next due time while pending; the time it came due while missed. */
  nextFireAt: UtcTimestamp,
  /** When a recurring wake-up stops on its own. */
  expiresAt: Schema.optional(UtcTimestamp),
  status: ThreadWakeupStatus,
  endedReason: Schema.optional(ThreadWakeupEndedReason),
  /** When it last started a turn, and which. */
  lastFiredAt: Schema.optional(UtcTimestamp),
  lastTurnId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type ThreadWakeup = typeof ThreadWakeup.Type;
export const decodeThreadWakeup = Schema.decodeUnknownSync(ThreadWakeup);

/**
 * The host's heading on the turn a wake-up starts, so the agent and the
 * transcript read the turn as one the runtime asked for earlier rather than
 * one the person typed. The journaled `fired` change is the evidence; the
 * heading is presentational.
 */
export const THREAD_WAKEUP_TURN_HEADING = "Wake-up you scheduled earlier in this thread:";

export function threadWakeupTurnPrompt(prompt: string): string {
  return `${THREAD_WAKEUP_TURN_HEADING}\n\n${prompt}`;
}

export const THREAD_WAKEUP_AGGREGATE = "thread-wakeup" as const;
export const THREAD_WAKEUP_CHANGED = "thread-wakeup.changed@1" as const;

/**
 * Every change to a wake-up journals its whole new state, so a replay of the
 * aggregate rebuilds it exactly. `change` says what moved it.
 */
export const ThreadWakeupChanged = Schema.Struct({
  wakeup: ThreadWakeup,
  change: Schema.Literal("scheduled", "fired", "missed", "run-requested", "ended"),
}).annotations(strict);
export type ThreadWakeupChanged = typeof ThreadWakeupChanged.Type;
export const decodeThreadWakeupChanged = Schema.decodeUnknownSync(ThreadWakeupChanged);

/** The wake-ups a thread shows: pending and missed ones, soonest first. */
export const ThreadWakeupList = Schema.Struct({
  wakeups: Schema.Array(ThreadWakeup),
}).annotations(strict);
export type ThreadWakeupList = typeof ThreadWakeupList.Type;
export const decodeThreadWakeupList = Schema.decodeUnknownSync(ThreadWakeupList);

/**
 * What the person may do with a wake-up from its thread: cancel it, or run a
 * missed one now (a pending one runs at its time).
 */
export const ThreadWakeupCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("cancel-thread-wakeup"),
    wakeupId: ThreadWakeupId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("run-missed-thread-wakeup"),
    wakeupId: ThreadWakeupId,
  }).annotations(strict),
);
export type ThreadWakeupCommand = typeof ThreadWakeupCommand.Type;
export const decodeThreadWakeupCommand = Schema.decodeUnknownSync(ThreadWakeupCommand);

export const ThreadWakeupCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("thread-wakeup-updated"),
    wakeup: ThreadWakeup,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("thread-wakeup-refused"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type ThreadWakeupCommandResult = typeof ThreadWakeupCommandResult.Type;
export const decodeThreadWakeupCommandResult = Schema.decodeUnknownSync(ThreadWakeupCommandResult);
