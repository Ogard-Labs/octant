import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { WindowId } from "./shell";

export const FLEET_OFFER_WINDOWS_MEDIA_TYPE = "application/vnd.octant.fleet-offer-windows+json";

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
export const FleetActivitySource = Schema.Literals(["journal", "session", "screen"]);
export type FleetActivitySource = typeof FleetActivitySource.Type;

/**
 * One thread that is waiting on the person or running, in a thread the reading
 * window can already open. There is no done state: a finish is a thread that
 * left this list, and only the reader knows when it last looked.
 */
export const FleetActivityThread = Schema.Struct({
  mode: Schema.Literals(["chat", "work", "code"]),
  threadId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  title: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_FLEET_ACTIVITY_TITLE_LENGTH),
  ),
  /** Navigation hint for the local menu bar; never a capability. */
  offerWindowId: Schema.optional(WindowId),
  /** Absent for a Chat thread filed under no Project. */
  projectName: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_FLEET_ACTIVITY_TITLE_LENGTH)),
  ),
  state: Schema.Literals(["needs-you", "working"]),
  activitySource: FleetActivitySource,
  /** When the request was raised or the turn started; absent when the host did not say. */
  since: Schema.optional(UtcTimestamp),
}).check(
  Schema.makeFilter((thread) => thread.activitySource !== "screen" || thread.state === "working", {
    message: "A state seen only on screen can never say a thread needs the person.",
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
  threads: Schema.Array(FleetActivityThread).check(Schema.isMaxLength(MAX_FLEET_ACTIVITY_THREADS)),
  truncated: Schema.Boolean,
});
export type FleetActivity = typeof FleetActivity.Type;

export const FleetActivityFailure = Schema.Struct({
  code: Schema.Literals(["invalid", "unauthorized", "unavailable"]),
  message: NonEmptyTrimmedString,
});
export type FleetActivityFailure = typeof FleetActivityFailure.Type;

export const decodeFleetActivityThread = Schema.decodeUnknownSync(
  FleetActivityThread,
  STRICT_DECODE_OPTIONS,
);
export const decodeFleetActivity = Schema.decodeUnknownSync(FleetActivity, STRICT_DECODE_OPTIONS);
export const decodeFleetActivityFailure = Schema.decodeUnknownSync(
  FleetActivityFailure,
  STRICT_DECODE_OPTIONS,
);
