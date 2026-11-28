import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { HubMemberId } from "./hubAndSpokes";

const unique = <A>(items: ReadonlyArray<A>) => new Set(items.map(String)).size === items.length;
const uniqueMessage = { message: "Entries must not repeat." };

/**
 * The id a spoke makes up for one routine when it tells the hub when the
 * routine next runs. Random per spoke and mapped back only on that spoke, so
 * it names nothing: not the routine's own id, its Project, or its schedule.
 */
export const WakeRoutineId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{22,64}$/)),
  Schema.brand("WakeRoutineId"),
);
export type WakeRoutineId = typeof WakeRoutineId.Type;

/** A hardware (MAC) address as six lowercase hex pairs joined by colons. */
export const HardwareAddress = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/),
);
export type HardwareAddress = typeof HardwareAddress.Type;

/** One routine's next occurrence, as the hub learns it: an opaque id and a time. */
export const HubWakeTime = Schema.Struct({
  routineId: WakeRoutineId,
  nextAt: UtcTimestamp,
});
export type HubWakeTime = typeof HubWakeTime.Type;

/** How many routine times one spoke reports, and how many spokes a wake copy or a hand-back carries. */
export const HUB_WAKE_MAX_TIMES_PER_SPOKE = 256;
export const HUB_WAKE_MAX_SPOKES = 256;

const HubWakeSequence = PositiveInt;

const wakeTimes = Schema.Array(HubWakeTime).check(
  Schema.isMaxLength(HUB_WAKE_MAX_TIMES_PER_SPOKE),
  Schema.makeFilter((times) => unique(times.map((time) => time.routineId)), uniqueMessage),
);

/**
 * What a spoke whose hub grant ticks Wake sends the hub: every enabled
 * routine's next occurrence, replacing what the hub held. A routine that is
 * removed or disabled is withdrawn by leaving it out. The address is present
 * only when the person entered it on the spoke. Nothing else travels: the
 * hub never receives a routine's prompt, Project, profile, name, or schedule.
 * `sequence` is the spoke's own count, kept across restarts and never below the
 * clock in milliseconds; reports can overtake each other on the way, and the hub
 * ignores one that is not newer than the last it applied for that spoke.
 */
export const HubWakeReport = Schema.Struct({
  sequence: HubWakeSequence,
  times: wakeTimes,
  hardwareAddress: Schema.optional(HardwareAddress),
});
export type HubWakeReport = typeof HubWakeReport.Type;
export const decodeHubWakeReport = Schema.decodeUnknownSync(HubWakeReport, STRICT_DECODE_OPTIONS);

/** A nudge names only the opaque id and the occurrence it is for. */
export const HubWakeNudge = Schema.Struct({
  routineId: WakeRoutineId,
  occurrenceAt: UtcTimestamp,
});
export type HubWakeNudge = typeof HubWakeNudge.Type;
export const decodeHubWakeNudge = Schema.decodeUnknownSync(HubWakeNudge, STRICT_DECODE_OPTIONS);

export const WAKE_NUDGE_IGNORED_KINDS = ["unknown-routine", "too-early", "time-mismatch"] as const;
export const WakeNudgeIgnoredKind = Schema.Literals(WAKE_NUDGE_IGNORED_KINDS);
export type WakeNudgeIgnoredKind = typeof WakeNudgeIgnoredKind.Type;

/** What a spoke answers a nudge it believed or did not; neither starts a routine. */
export const HubWakeNudgeAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("accepted") }),
  Schema.Struct({ status: Schema.Literal("ignored"), kind: WakeNudgeIgnoredKind }),
]);
export type HubWakeNudgeAnswer = typeof HubWakeNudgeAnswer.Type;
export const decodeHubWakeNudgeAnswer = Schema.decodeUnknownSync(
  HubWakeNudgeAnswer,
  STRICT_DECODE_OPTIONS,
);

/** One spoke's wake times as the hub and a standby hold them. */
export const HubWakeSpokeTimes = Schema.Struct({
  memberId: HubMemberId,
  times: wakeTimes,
  hardwareAddress: Schema.optional(HardwareAddress),
  /** The sequence of the report these times came from, when they came from one. */
  sequence: Schema.optional(HubWakeSequence),
});
export type HubWakeSpokeTimes = typeof HubWakeSpokeTimes.Type;

/**
 * What the hub hands a standby so it can wake spokes while it stands in; empty
 * clears it. `enabled` is the hub's own wake switch: a standby that stands in
 * wakes spokes only while it was told the switch is on, so a copy from a hub
 * that predates the field counts as off. `revision` rises with every copy the
 * hub makes: copies are sent without waiting for each other, so a standby keeps
 * one only when it is newer than the one it holds. A copy without it is taken
 * as it comes, which is what a hub that predates the field sends.
 */
export const HubWakeCopy = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  revision: Schema.optional(PositiveInt),
  spokes: Schema.Array(HubWakeSpokeTimes).check(Schema.isMaxLength(HUB_WAKE_MAX_SPOKES)),
});
export type HubWakeCopy = typeof HubWakeCopy.Type;
export const decodeHubWakeCopy = Schema.decodeUnknownSync(HubWakeCopy, STRICT_DECODE_OPTIONS);

/** The person turning the hub's wake service on or off in a window. */
export const HubWakeSwitchRequest = Schema.Struct({ enabled: Schema.Boolean });
export type HubWakeSwitchRequest = typeof HubWakeSwitchRequest.Type;
export const decodeHubWakeSwitchRequest = Schema.decodeUnknownSync(
  HubWakeSwitchRequest,
  STRICT_DECODE_OPTIONS,
);

/** The person entering, or clearing with null, this spoke's hardware address in a window. */
export const HubWakeHardwareAddressRequest = Schema.Struct({
  address: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
});
export type HubWakeHardwareAddressRequest = typeof HubWakeHardwareAddressRequest.Type;
export const decodeHubWakeHardwareAddressRequest = Schema.decodeUnknownSync(
  HubWakeHardwareAddressRequest,
  STRICT_DECODE_OPTIONS,
);

export const HubWakeResult = Schema.Literals(["nudged", "ignored", "refused", "unreachable"]);
export type HubWakeResult = typeof HubWakeResult.Type;
