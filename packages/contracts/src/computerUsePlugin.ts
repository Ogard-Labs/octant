import { Schema } from "effect";
import { GuidString, NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { OctantMode } from "./modes";
import { ProviderInstanceId, ProviderModelId, ProviderExecutionPolicy } from "./providers";
import { WindowId } from "./shell";
import { DESKTOP_LEASE_MAXIMUM_MINUTES, DesktopLeaseId } from "./desktopLease";
import { UtcTimestamp } from "./events";
export { ComputerUseSettings, decodeComputerUseSettings } from "./computerUseSettings";

const text = (max: number) => Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(max));
const appId = text(256).check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.-]*$/));
export const ComputerObservationId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("ComputerObservationId"),
);
export type ComputerObservationId = typeof ComputerObservationId.Type;
export const ComputerWindowId = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.brand("ComputerWindowId"),
);
export type ComputerWindowId = typeof ComputerWindowId.Type;

const observedElement = {
  observationId: ComputerObservationId,
  elementIndex: NonNegativeInt,
};
const typedText = Schema.String.check(Schema.isMaxLength(16_384));
const pressKey = Schema.Literals([
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
]);
export const ComputerControlCommand = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("apps") }),
  Schema.Struct({ operation: Schema.Literals(["launch", "windows"]), appId }),
  Schema.Struct({
    operation: Schema.Literal("observe"),
    appId,
    windowId: ComputerWindowId,
  }),
  Schema.Struct({ operation: Schema.Literal("click"), ...observedElement }),
  Schema.Struct({
    operation: Schema.Literal("click"),
    observationId: ComputerObservationId,
    x: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
    y: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    operation: Schema.Literal("type"),
    ...observedElement,
    text: typedText,
  }),
  Schema.Struct({
    operation: Schema.Literal("press"),
    ...observedElement,
    key: pressKey,
  }),
  Schema.Struct({
    operation: Schema.Literal("type"),
    observationId: ComputerObservationId,
    text: typedText,
  }),
  Schema.Struct({
    operation: Schema.Literal("press"),
    observationId: ComputerObservationId,
    key: pressKey,
  }),
  Schema.Struct({
    operation: Schema.Literal("scroll"),
    observationId: ComputerObservationId,
    direction: Schema.Literals(["up", "down", "left", "right"]),
    amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  }),
  Schema.Struct({ operation: Schema.Literal("stop") }),
]);
export type ComputerControlCommand = typeof ComputerControlCommand.Type;

/** Bound by the host at turn admission, never supplied as tool arguments. */
export const ComputerUseOwner = Schema.Struct({
  windowId: WindowId,
  threadId: GuidString,
  mode: OctantMode,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  executionPolicy: ProviderExecutionPolicy,
  /** The thread's disposable desktop the send bound; absent, the destination is this Mac. */
  leaseId: Schema.optional(DesktopLeaseId),
});
export type ComputerUseOwner = typeof ComputerUseOwner.Type;

/**
 * An agent's request to send one checkout-relative file into its bound
 * desktop's inbox. It never reaches a driver as a command: the host's lease
 * service reads, hashes, asks, and journals the transfer first.
 */
export const ComputerSendFileCommand = Schema.Struct({
  operation: Schema.Literal("send-file"),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});
export type ComputerSendFileCommand = typeof ComputerSendFileCommand.Type;

/**
 * An agent's request to keep its bound desktop running longer. It never
 * reaches a driver as a command: the host's lease service decides whether
 * the agent may, asks when it must, and moves the provider's clock first.
 */
export const ComputerExtendDesktopCommand = Schema.Struct({
  operation: Schema.Literal("extend"),
  minutes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: DESKTOP_LEASE_MAXIMUM_MINUTES }),
  ),
});
export type ComputerExtendDesktopCommand = typeof ComputerExtendDesktopCommand.Type;

export const ComputerUseImage = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
  data: text(2_097_152).check(Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/)),
});
export type ComputerUseImage = typeof ComputerUseImage.Type;

export const ComputerUseApp = Schema.Struct({ appId, name: text(256) });
export const ComputerUseWindow = Schema.Struct({
  windowId: ComputerWindowId,
  title: Schema.String.check(Schema.isMaxLength(1_024)),
});
export const ComputerUseElement = Schema.Struct({
  index: NonNegativeInt,
  role: text(128),
  label: Schema.String.check(Schema.isMaxLength(2_048)),
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  protected: Schema.Boolean,
});
export const ComputerControlResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("apps"),
    apps: Schema.Array(ComputerUseApp).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    kind: Schema.Literal("windows"),
    appId,
    windows: Schema.Array(ComputerUseWindow).check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    kind: Schema.Literal("observation"),
    observationId: ComputerObservationId,
    appId,
    windowId: ComputerWindowId,
    elements: Schema.Array(ComputerUseElement).check(Schema.isMaxLength(512)),
    truncated: Schema.Boolean,
    image: Schema.optional(ComputerUseImage),
    imageWidth: Schema.optional(PositiveInt),
    imageHeight: Schema.optional(PositiveInt),
  }),
  Schema.Struct({ kind: Schema.Literal("stopped") }),
  Schema.Struct({
    kind: Schema.Literal("sent"),
    name: text(255),
    size: NonNegativeInt,
    sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  }),
  Schema.Struct({
    kind: Schema.Literal("extended"),
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literals(["refused", "failed"]),
    reason: text(128),
    message: text(1_024),
  }),
]);
export type ComputerControlResult = typeof ComputerControlResult.Type;

export const ComputerUseStatus = Schema.Struct({
  verification: Schema.optional(Schema.Literals(["not-tested", "running", "passed", "failed"])),
  verificationMessage: Schema.optional(text(1_024)),
  setupPending: Schema.optional(Schema.Boolean),
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  automaticUpdates: Schema.Boolean,
  permissionsUnavailable: Schema.optional(Schema.Boolean),
  permissions: Schema.Struct({
    accessibility: Schema.Boolean,
    screenRecording: Schema.Boolean,
  }),
  driver: Schema.Literals(["unavailable", "stopped", "starting", "ready", "failed"]),
  version: Schema.optional(text(64)),
  activeSessions: NonNegativeInt,
  update: Schema.Literals(["idle", "checking", "downloading", "staged", "current", "failed"]),
  availableVersion: Schema.optional(text(64)),
  message: Schema.optional(text(1_024)),
});
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

export const decodeComputerControlCommand = Schema.decodeUnknownSync(
  ComputerControlCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerControlResult = Schema.decodeUnknownSync(
  ComputerControlResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseOwner = Schema.decodeUnknownSync(
  ComputerUseOwner,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerSendFileCommand = Schema.decodeUnknownSync(
  ComputerSendFileCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerExtendDesktopCommand = Schema.decodeUnknownSync(
  ComputerExtendDesktopCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeComputerUseStatus = Schema.decodeUnknownSync(
  ComputerUseStatus,
  STRICT_DECODE_OPTIONS,
);
