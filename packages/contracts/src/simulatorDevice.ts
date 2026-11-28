import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { DeviceOrientation } from "./deviceHost";

/**
 * Apple workbench input handed from the server to the desktop, which delivers
 * it to a booted Simulator through its native device helper. This is a
 * host-only operation between two Octant processes: it is never a provider
 * tool argument, and the server has already checked authority and approval
 * before it is sent.
 */
const text = (max: number) => Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(max));
const destination = {
  udid: Schema.String.check(
    Schema.isPattern(/^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/),
  ),
  /**
   * The action's deadline. The desktop stops waiting inside it, so its answer
   * reaches the server before the server gives the action up as timed out.
   */
  budgetMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10 * 60 * 1000)),
};

const screenPoint = Schema.Struct({
  x: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  y: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
});

export const SimulatorDeviceInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tap"),
    ...destination,
    /** A point on a captured screen, in that capture's own pixels. */
    point: screenPoint,
  }),
  Schema.Struct({
    kind: Schema.Literal("swipe"),
    ...destination,
    /** Both ends are points on a captured screen, like a tap's. */
    from: screenPoint,
    to: screenPoint,
    durationMs: Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 5_000 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("type-text"),
    ...destination,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    kind: Schema.Literal("key-press"),
    ...destination,
    key: text(64),
  }),
  Schema.Struct({
    kind: Schema.Literal("repair-input"),
    ...destination,
  }),
  Schema.Struct({
    kind: Schema.Literal("rotate"),
    ...destination,
    /** Absent: turn the Simulator away from the way it sits now. */
    orientation: Schema.optional(DeviceOrientation),
  }),
  Schema.Struct({
    kind: Schema.Literal("read-orientation"),
    ...destination,
  }),
]);
export type SimulatorDeviceInput = typeof SimulatorDeviceInput.Type;

export const SimulatorDeviceInputResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("delivered"),
    /** After a rotate or an orientation read: which way the Simulator now sits, as the helper read it. */
    orientation: Schema.optional(DeviceOrientation),
  }),
  Schema.Struct({
    /** `refused`: the helper answered no. `unavailable`: no helper answered. */
    kind: Schema.Literals(["refused", "unavailable"]),
    reason: text(128),
    message: text(1_024),
  }),
]);
export type SimulatorDeviceInputResult = typeof SimulatorDeviceInputResult.Type;

/**
 * A request to watch one Simulator's screen. The answer is a stream of JPEG
 * frames, each behind a 4-byte big-endian length, sent only when the screen
 * changes. Watching is a read: it changes nothing on the device.
 */
export const SimulatorDeviceWatch = Schema.Struct({
  udid: destination.udid,
  /** Frames are scaled down to this height; a pane never needs device pixels. */
  maxHeight: Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 4_096 })),
  quality: Schema.Number.check(Schema.isBetween({ minimum: 0.3, maximum: 0.95 })),
  framesPerSecond: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
});
export type SimulatorDeviceWatch = typeof SimulatorDeviceWatch.Type;

/** Response header naming the device's screen in pixels, as `1206x2622`. */
export const SIMULATOR_SCREEN_HEADER = "x-octant-simulator-screen";

/** Response header naming which way the Simulator sat when the watch began: `portrait` or `landscape`. */
export const SIMULATOR_ORIENTATION_HEADER = "x-octant-simulator-orientation";

export const decodeSimulatorDeviceInput = Schema.decodeUnknownSync(
  SimulatorDeviceInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeSimulatorDeviceWatch = Schema.decodeUnknownSync(
  SimulatorDeviceWatch,
  STRICT_DECODE_OPTIONS,
);
export const decodeSimulatorDeviceInputResult = Schema.decodeUnknownSync(
  SimulatorDeviceInputResult,
  STRICT_DECODE_OPTIONS,
);
