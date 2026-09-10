import { Schema } from "effect";
import { OctantMode } from "./modes";
import { ProviderInstanceId, ProviderModelId, ProviderExecutionPolicy } from "./providers";
import { WindowId } from "./shell";
export { ComputerUseSettings, decodeComputerUseSettings } from "./computerUseSettings";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const text = (max: number) => Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(max));
const appId = text(256).pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9.-]*$/));
export const ComputerObservationId = Schema.UUID.pipe(Schema.brand("ComputerObservationId"));
export type ComputerObservationId = typeof ComputerObservationId.Type;
export const ComputerWindowId = Schema.Int.pipe(
  Schema.positive(),
  Schema.brand("ComputerWindowId"),
);
export type ComputerWindowId = typeof ComputerWindowId.Type;

const observedElement = {
  observationId: ComputerObservationId,
  elementIndex: Schema.Int.pipe(Schema.nonNegative()),
};
export const ComputerControlCommand = Schema.Union(
  Schema.Struct({ operation: Schema.Literal("apps") }).annotations(strict),
  Schema.Struct({ operation: Schema.Literal("launch", "windows"), appId }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("observe"),
    appId,
    windowId: ComputerWindowId,
  }).annotations(strict),
  Schema.Struct({ operation: Schema.Literal("click"), ...observedElement }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("click"),
    observationId: ComputerObservationId,
    x: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
    y: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("type"),
    ...observedElement,
    text: Schema.String.pipe(Schema.maxLength(16_384)),
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("press"),
    ...observedElement,
    key: Schema.Literal(
      "Enter",
      "Return",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Backspace",
      "Delete",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ),
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("scroll"),
    observationId: ComputerObservationId,
    direction: Schema.Literal("up", "down", "left", "right"),
    amount: Schema.Int.pipe(Schema.between(1, 10)),
  }).annotations(strict),
  Schema.Struct({ operation: Schema.Literal("stop") }).annotations(strict),
);
export type ComputerControlCommand = typeof ComputerControlCommand.Type;

/** Bound by the host at turn admission, never supplied as tool arguments. */
export const ComputerUseOwner = Schema.Struct({
  windowId: WindowId,
  threadId: Schema.UUID,
  mode: OctantMode,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  executionPolicy: ProviderExecutionPolicy,
}).annotations(strict);
export type ComputerUseOwner = typeof ComputerUseOwner.Type;

export const ComputerUseImage = Schema.Struct({
  mimeType: Schema.Literal("image/png", "image/jpeg"),
  data: text(2_097_152).pipe(Schema.pattern(/^[A-Za-z0-9+/]+={0,2}$/)),
}).annotations(strict);
export type ComputerUseImage = typeof ComputerUseImage.Type;

export const ComputerUseApp = Schema.Struct({ appId, name: text(256) }).annotations(strict);
export const ComputerUseWindow = Schema.Struct({
  windowId: ComputerWindowId,
  title: Schema.String.pipe(Schema.maxLength(1_024)),
}).annotations(strict);
export const ComputerUseElement = Schema.Struct({
  index: Schema.Int.pipe(Schema.nonNegative()),
  role: text(128),
  label: Schema.String.pipe(Schema.maxLength(2_048)),
  value: Schema.optional(Schema.String.pipe(Schema.maxLength(4_096))),
  protected: Schema.Boolean,
}).annotations(strict);
export const ComputerControlResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("apps"),
    apps: Schema.Array(ComputerUseApp).pipe(Schema.maxItems(256)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("windows"),
    appId,
    windows: Schema.Array(ComputerUseWindow).pipe(Schema.maxItems(128)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("observation"),
    observationId: ComputerObservationId,
    appId,
    windowId: ComputerWindowId,
    elements: Schema.Array(ComputerUseElement).pipe(Schema.maxItems(512)),
    truncated: Schema.Boolean,
    image: Schema.optional(ComputerUseImage),
    imageWidth: Schema.optional(Schema.Int.pipe(Schema.positive())),
    imageHeight: Schema.optional(Schema.Int.pipe(Schema.positive())),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("stopped") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused", "failed"),
    reason: text(128),
    message: text(1_024),
  }).annotations(strict),
);
export type ComputerControlResult = typeof ComputerControlResult.Type;

export const ComputerUseStatus = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  automaticUpdates: Schema.Boolean,
  permissions: Schema.Struct({
    accessibility: Schema.Boolean,
    screenRecording: Schema.Boolean,
  }).annotations(strict),
  driver: Schema.Literal("unavailable", "stopped", "starting", "ready", "failed"),
  version: Schema.optional(text(64)),
  activeSessions: Schema.Int.pipe(Schema.nonNegative()),
  update: Schema.Literal("idle", "checking", "downloading", "staged", "current", "failed"),
  availableVersion: Schema.optional(text(64)),
  message: Schema.optional(text(1_024)),
}).annotations(strict);
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

export const decodeComputerControlCommand = Schema.decodeUnknownSync(ComputerControlCommand);
export const decodeComputerControlResult = Schema.decodeUnknownSync(ComputerControlResult);
export const decodeComputerUseOwner = Schema.decodeUnknownSync(ComputerUseOwner);
export const decodeComputerUseStatus = Schema.decodeUnknownSync(ComputerUseStatus);
