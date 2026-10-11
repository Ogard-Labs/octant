import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const MAX_FLEET_ACTIVITY_TITLE_LENGTH = 200;
export const MAX_FLEET_ACTIVITY_THREADS = 64;

/**
 * Where a fleet state was read from. `journal` is a projection over journaled
 * events (a turn the host recorded as running, a request or decision it
 * recorded as open); `session` is a live provider session the host holds (an
 * approval or question that session is parked on). `screen` is reserved for a
 * CLI seen only in a terminal pane: a guess from pixels or PTY output, which
 * may say a thread looks busy and nothing more.
 */
export const FleetActivitySource = Schema.Literal("journal", "session", "screen");
export type FleetActivitySource = typeof FleetActivitySource.Type;

/**
 * One thread that is waiting on the person or running, in a thread the reading
 * window can already open. There is no done state: a finish is a thread that
 * left this list, and only the reader knows when it last looked.
 */
export const FleetActivityThread = Schema.Struct({
  mode: Schema.Literal("chat", "work", "code"),
  threadId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_FLEET_ACTIVITY_TITLE_LENGTH)),
  /** Absent for a Chat thread filed under no Project. */
  projectName: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_FLEET_ACTIVITY_TITLE_LENGTH)),
  ),
  state: Schema.Literal("needs-you", "working"),
  activitySource: FleetActivitySource,
  /** When the request was raised or the turn started; absent when the host did not say. */
  since: Schema.optional(UtcTimestamp),
})
  .annotations(strict)
  .pipe(
    Schema.filter((thread) => thread.activitySource !== "screen" || thread.state === "working", {
      message: () => "A state seen only on screen can never say a thread needs the person.",
      jsonSchema: {},
    }),
  );
export type FleetActivityThread = typeof FleetActivityThread.Type;

/**
 * Every thread waiting on the person or running, needs-you first and oldest
 * first within each state. A host holding more than the bound keeps the
 * needs-you rows first and says so with `truncated`.
 */
export const FleetActivity = Schema.Struct({
  threads: Schema.Array(FleetActivityThread).pipe(Schema.maxItems(MAX_FLEET_ACTIVITY_THREADS)),
  truncated: Schema.Boolean,
}).annotations(strict);
export type FleetActivity = typeof FleetActivity.Type;

export const FleetActivityFailure = Schema.Struct({
  code: Schema.Literal("invalid", "unauthorized", "unavailable"),
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type FleetActivityFailure = typeof FleetActivityFailure.Type;

export const decodeFleetActivityThread = Schema.decodeUnknownSync(FleetActivityThread);
export const decodeFleetActivity = Schema.decodeUnknownSync(FleetActivity);
export const decodeFleetActivityFailure = Schema.decodeUnknownSync(FleetActivityFailure);
