import { Schema } from "effect";

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

export const SimulatorDeviceInput = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("tap"),
    ...destination,
    /** A point on a captured screen, in that capture's own pixels. */
    point: Schema.Struct({
      x: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
      y: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
    }).annotations(strict),
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
);
export type SimulatorDeviceInput = typeof SimulatorDeviceInput.Type;

export const SimulatorDeviceInputResult = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("delivered") }).annotations(strict),
  Schema.Struct({
    /** `refused`: the helper answered no. `unavailable`: no helper answered. */
    kind: Schema.Literal("refused", "unavailable"),
    reason: text(128),
    message: text(1_024),
  }).annotations(strict),
);
export type SimulatorDeviceInputResult = typeof SimulatorDeviceInputResult.Type;

export const decodeSimulatorDeviceInput = Schema.decodeUnknownSync(SimulatorDeviceInput);
export const decodeSimulatorDeviceInputResult = Schema.decodeUnknownSync(
  SimulatorDeviceInputResult,
);
