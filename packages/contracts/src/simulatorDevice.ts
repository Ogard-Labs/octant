import { Schema } from "effect";
import { DeviceOrientation } from "./deviceHost";

/**
 * Apple workbench input handed from the server to the desktop, which delivers
 * it to a booted Simulator through its native device helper. This is a
 * host-only operation between two Octant processes: it is never a provider
 * tool argument, and the server has already checked authority and approval
 * before it is sent.
 */
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const text = (max: number) => Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(max));
const destination = {
  udid: Schema.String.pipe(
    Schema.pattern(/^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/),
  ),
  /**
   * The action's deadline. The desktop stops waiting inside it, so its answer
   * reaches the server before the server gives the action up as timed out.
   */
  budgetMs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(10 * 60 * 1000)),
};

const screenPoint = Schema.Struct({
  x: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  y: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
}).annotations(strict);

export const SimulatorDeviceInput = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("tap"),
    ...destination,
    /** A point on a captured screen, in that capture's own pixels. */
    point: screenPoint,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("swipe"),
    ...destination,
    /** Both ends are points on a captured screen, like a tap's. */
    from: screenPoint,
    to: screenPoint,
    durationMs: Schema.Int.pipe(Schema.between(50, 5_000)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("type-text"),
    ...destination,
    text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("key-press"),
    ...destination,
    key: text(64),
  }).annotations(strict),
  /**
   * Gives touch and buttons back to the Simulator's legacy input services
   * after Xcode's Device Hub took them. It restarts the guest's home screen
   * and closes running apps.
   */
  Schema.Struct({
    kind: Schema.Literal("repair-input"),
    ...destination,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("rotate"),
    ...destination,
    /** Absent: turn the Simulator away from the way it sits now. */
    orientation: Schema.optional(DeviceOrientation),
  }).annotations(strict),
  /**
   * Reads which way the Simulator shows its screen right now and changes
   * nothing. The answer is a `delivered` result that names the orientation.
   */
  Schema.Struct({
    kind: Schema.Literal("read-orientation"),
    ...destination,
  }).annotations(strict),
);
export type SimulatorDeviceInput = typeof SimulatorDeviceInput.Type;

export const SimulatorDeviceInputResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("delivered"),
    /** After a rotate or an orientation read: which way the Simulator now sits, as the helper read it. */
    orientation: Schema.optional(DeviceOrientation),
  }).annotations(strict),
  Schema.Struct({
    /** `refused`: the helper answered no. `unavailable`: no helper answered. */
    kind: Schema.Literal("refused", "unavailable"),
    reason: text(128),
    message: text(1_024),
  }).annotations(strict),
);
export type SimulatorDeviceInputResult = typeof SimulatorDeviceInputResult.Type;

/**
 * A request to watch one Simulator's screen. The answer is a stream of JPEG
 * frames, each behind a 4-byte big-endian length, sent only when the screen
 * changes. Watching is a read: it changes nothing on the device.
 */
export const SimulatorDeviceWatch = Schema.Struct({
  udid: destination.udid,
  /** Frames are scaled down to this height; a pane never needs device pixels. */
  maxHeight: Schema.Int.pipe(Schema.between(240, 4_096)),
  quality: Schema.Number.pipe(Schema.between(0.3, 0.95)),
  framesPerSecond: Schema.Int.pipe(Schema.between(1, 60)),
}).annotations(strict);
export type SimulatorDeviceWatch = typeof SimulatorDeviceWatch.Type;

/** Response header naming the device's screen in pixels, as `1206x2622`. */
export const SIMULATOR_SCREEN_HEADER = "x-octant-simulator-screen";

/** Response header naming which way the Simulator sat when the watch began: `portrait` or `landscape`. */
export const SIMULATOR_ORIENTATION_HEADER = "x-octant-simulator-orientation";

export const decodeSimulatorDeviceInput = Schema.decodeUnknownSync(SimulatorDeviceInput);
export const decodeSimulatorDeviceWatch = Schema.decodeUnknownSync(SimulatorDeviceWatch);
export const decodeSimulatorDeviceInputResult = Schema.decodeUnknownSync(
  SimulatorDeviceInputResult,
);
