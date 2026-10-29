import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { HubMemberId } from "./hubAndSpokes";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const unique = <A>(items: ReadonlyArray<A>) => new Set(items.map(String)).size === items.length;
const uniqueMessage = { message: () => "Entries must not repeat." };

/**
 * The id a spoke makes up for one routine when it tells the hub when the
 * routine next runs. Random per spoke and mapped back only on that spoke, so
 * it names nothing: not the routine's own id, its Project, or its schedule.
 */
export const WakeRoutineId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{22,64}$/),
  Schema.brand("WakeRoutineId"),
);
export type WakeRoutineId = typeof WakeRoutineId.Type;

/** A hardware (MAC) address as six lowercase hex pairs joined by colons. */
export const HardwareAddress = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/));
export type HardwareAddress = typeof HardwareAddress.Type;

/** One routine's next occurrence, as the hub learns it: an opaque id and a time. */
export const HubWakeTime = Schema.Struct({
  routineId: WakeRoutineId,
  nextAt: UtcTimestamp,
}).annotations(strict);
export type HubWakeTime = typeof HubWakeTime.Type;

const wakeTimes = Schema.Array(HubWakeTime).pipe(
  Schema.maxItems(256),
  Schema.filter((times) => unique(times.map((time) => time.routineId)), uniqueMessage),
);

/**
 * What a spoke whose hub grant ticks Wake sends the hub: every enabled
 * routine's next occurrence, replacing what the hub held. A routine that is
 * removed or disabled is withdrawn by leaving it out. The address is present
 * only when the person entered it on the spoke. Nothing else travels: the
 * hub never receives a routine's prompt, Project, profile, name, or schedule.
 */
export const HubWakeReport = Schema.Struct({
  times: wakeTimes,
  hardwareAddress: Schema.optional(HardwareAddress),
}).annotations(strict);
export type HubWakeReport = typeof HubWakeReport.Type;
export const decodeHubWakeReport = Schema.decodeUnknownSync(HubWakeReport);

/** A nudge names only the opaque id and the occurrence it is for. */
export const HubWakeNudge = Schema.Struct({
  routineId: WakeRoutineId,
  occurrenceAt: UtcTimestamp,
}).annotations(strict);
export type HubWakeNudge = typeof HubWakeNudge.Type;
export const decodeHubWakeNudge = Schema.decodeUnknownSync(HubWakeNudge);

export const WAKE_NUDGE_IGNORED_KINDS = ["unknown-routine", "too-early", "time-mismatch"] as const;
export const WakeNudgeIgnoredKind = Schema.Literal(...WAKE_NUDGE_IGNORED_KINDS);
export type WakeNudgeIgnoredKind = typeof WakeNudgeIgnoredKind.Type;

/** What a spoke answers a nudge it believed or did not; neither starts a routine. */
export const HubWakeNudgeAnswer = Schema.Union(
  Schema.Struct({ status: Schema.Literal("accepted") }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("ignored"), kind: WakeNudgeIgnoredKind }).annotations(
    strict,
  ),
);
export type HubWakeNudgeAnswer = typeof HubWakeNudgeAnswer.Type;
export const decodeHubWakeNudgeAnswer = Schema.decodeUnknownSync(HubWakeNudgeAnswer);

/** One spoke's wake times as the hub and a standby hold them. */
export const HubWakeSpokeTimes = Schema.Struct({
  memberId: HubMemberId,
  times: wakeTimes,
  hardwareAddress: Schema.optional(HardwareAddress),
}).annotations(strict);
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
  revision: Schema.optional(Schema.Int.pipe(Schema.positive())),
  spokes: Schema.Array(HubWakeSpokeTimes).pipe(Schema.maxItems(256)),
}).annotations(strict);
export type HubWakeCopy = typeof HubWakeCopy.Type;
export const decodeHubWakeCopy = Schema.decodeUnknownSync(HubWakeCopy);

/** The person turning the hub's wake service on or off in a window. */
export const HubWakeSwitchRequest = Schema.Struct({ enabled: Schema.Boolean }).annotations(strict);
export type HubWakeSwitchRequest = typeof HubWakeSwitchRequest.Type;
export const decodeHubWakeSwitchRequest = Schema.decodeUnknownSync(HubWakeSwitchRequest);

/** The person entering, or clearing with null, this spoke's hardware address in a window. */
export const HubWakeHardwareAddressRequest = Schema.Struct({
  address: Schema.NullOr(Schema.String.pipe(Schema.maxLength(64))),
}).annotations(strict);
export type HubWakeHardwareAddressRequest = typeof HubWakeHardwareAddressRequest.Type;
export const decodeHubWakeHardwareAddressRequest = Schema.decodeUnknownSync(
  HubWakeHardwareAddressRequest,
);

export const HubWakeResult = Schema.Literal("nudged", "ignored", "refused", "unreachable");
export type HubWakeResult = typeof HubWakeResult.Type;
