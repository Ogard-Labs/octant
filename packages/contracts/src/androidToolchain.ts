import { Schema } from "effect";
import {
  GuidString,
  NonEmptyTrimmedString,
  NonNegativeInt,
  PositiveInt,
  STRICT_DECODE_OPTIONS,
} from "./schemaPrimitives";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { DeviceHostCapabilities, DeviceOpenUrl, DeviceOrientation } from "./deviceHost";
import { CorrelationId, EventActor, UtcTimestamp } from "./events";
import { ToolActionApproval, ToolActionAuthority, ToolActionId } from "./toolActions";

const opaqueReference = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0"),
  ),
);

/** AVD name. Not a UUID: the SDK names destinations this way. */
export const AndroidEmulatorId = Schema.Trimmed.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9._-]*$/),
  ),
  Schema.brand("AndroidEmulatorId"),
);
export type AndroidEmulatorId = typeof AndroidEmulatorId.Type;

export const AndroidSdkId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("AndroidSdkId"),
);
export type AndroidSdkId = typeof AndroidSdkId.Type;

export const AndroidEmulatorState = Schema.Literals([
  "booted",
  "shutdown",
  "booting",
  "shutting-down",
  "unavailable",
]);
export type AndroidEmulatorState = typeof AndroidEmulatorState.Type;

export const AndroidEmulatorRecord = Schema.Struct({
  emulatorId: AndroidEmulatorId,
  name: NonEmptyTrimmedString,
  apiLevel: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(32))),
  state: AndroidEmulatorState,
  serial: Schema.optional(
    Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(64),
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    ),
  ),
});
export type AndroidEmulatorRecord = typeof AndroidEmulatorRecord.Type;

export const AndroidSdkDiscovery = Schema.Struct({
  sdkId: AndroidSdkId,
  sdkRoot: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096))),
  adbPath: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096))),
  emulatorPath: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  ),
  available: Schema.Boolean,
  discoveredAt: UtcTimestamp,
});
export type AndroidSdkDiscovery = typeof AndroidSdkDiscovery.Type;

export const AndroidEmulatorActionKind = Schema.Literals([
  "boot",
  "shutdown",
  "screenshot",
  "open-input",
  "tap",
  "swipe",
  "type-text",
  "key-press",
  "install",
  "launch",
  "open-url",
  "start-recording",
  "stop-recording",
  "rotate",
  "describe-ui",
  "logs",
]);
export type AndroidEmulatorActionKind = typeof AndroidEmulatorActionKind.Type;

export const AndroidPoint = Schema.Struct({
  x: Schema.Number.check(Schema.isFinite()),
  y: Schema.Number.check(Schema.isFinite()),
});
export type AndroidPoint = typeof AndroidPoint.Type;

export const AndroidEmulatorRequest = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  kind: AndroidEmulatorActionKind,
  emulatorId: AndroidEmulatorId,
  requestedBy: Schema.optional(EventActor),
  point: Schema.optional(AndroidPoint),
  /**
   * The element a tap lands on, named by its resource-id, content-desc, or
   * text exactly, in place of a point. The host reads the screen and taps the
   * element's centre, or refuses when no element or several match.
   */
  target: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
  toPoint: Schema.optional(AndroidPoint),
  durationMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 5_000 }))),
  text: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))),
  key: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64))),
  /** How far back `logs` reads, in seconds; without it, the newest lines. */
  sinceSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 }))),
  /** Whether `logs` also reads the device's crash buffer. */
  includeCrashes: Schema.optional(Schema.Boolean),
  apkPath: Schema.optional(
    Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(1024),
      Schema.makeFilter((value) => {
        if (
          value.startsWith("/") ||
          value.startsWith("\\") ||
          /^[A-Za-z]:/.test(value) ||
          value.includes("\\") ||
          value.includes("\0")
        ) {
          return false;
        }
        return value
          .split("/")
          .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
      }),
    ),
  ),
  packageName: Schema.optional(
    Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(255),
      Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/),
    ),
  ),
  /** The address `open-url` opens. Shown whole in its confirmation; evidence keeps the origin. */
  url: Schema.optional(DeviceOpenUrl),
  /** The orientation `rotate` sets. */
  orientation: Schema.optional(DeviceOrientation),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10 * 60 * 1000)),
  approval: ToolActionApproval,
}).check(
  Schema.makeFilter((request) => {
    if (request.kind === "open-input") return request.requestedBy !== undefined;
    if (request.kind === "tap") {
      // A point or an element, never both: either one alone says where.
      return (
        request.requestedBy !== undefined &&
        (request.point === undefined) !== (request.target === undefined)
      );
    }
    if (request.kind === "swipe") {
      return (
        request.requestedBy !== undefined &&
        request.point !== undefined &&
        request.toPoint !== undefined
      );
    }
    if (request.kind === "type-text") {
      return (
        request.requestedBy !== undefined &&
        request.text !== undefined &&
        request.text.trim().length > 0
      );
    }
    if (request.kind === "key-press") {
      return request.requestedBy !== undefined && request.key !== undefined;
    }
    if (request.kind === "install") return request.apkPath !== undefined;
    if (request.kind === "launch" || request.kind === "logs") {
      return request.packageName !== undefined;
    }
    if (request.kind === "open-url") {
      return request.requestedBy !== undefined && request.url !== undefined;
    }
    if (request.kind === "rotate") {
      return request.requestedBy !== undefined && request.orientation !== undefined;
    }
    if (request.kind === "start-recording" || request.kind === "stop-recording") {
      return request.requestedBy !== undefined;
    }
    return true;
  }),
);
export type AndroidEmulatorRequest = typeof AndroidEmulatorRequest.Type;

export const AndroidDiscoveryRequest = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
});
export type AndroidDiscoveryRequest = typeof AndroidDiscoveryRequest.Type;

export const AndroidBuildOutcome = Schema.Literals([
  "succeeded",
  "failed",
  "cancelled",
  "timed-out",
  "interrupted",
  "unavailable",
  "unauthorized",
  "invalid-destination",
  "process-died",
]);
export type AndroidBuildOutcome = typeof AndroidBuildOutcome.Type;

export const AndroidDiagnostic = Schema.Struct({
  severity: Schema.Literals(["error", "warning", "note"]),
  message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
});
export type AndroidDiagnostic = typeof AndroidDiagnostic.Type;

export const AndroidEvidenceArtifact = Schema.Struct({
  kind: Schema.Literals(["log", "screenshot", "application", "recording"]),
  reference: opaqueReference,
});
export type AndroidEvidenceArtifact = typeof AndroidEvidenceArtifact.Type;

export const AndroidCleanupState = Schema.Literals(["not-required", "complete", "uncertain"]);
export type AndroidCleanupState = typeof AndroidCleanupState.Type;

export const AndroidEmulatorEvidence = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: AndroidEmulatorActionKind,
  outcome: AndroidBuildOutcome,
  emulatorId: Schema.optional(AndroidEmulatorId),
  requestedBy: Schema.optional(EventActor),
  diagnostics: Schema.Array(AndroidDiagnostic).check(Schema.isMaxLength(64)),
  artifacts: Schema.Array(AndroidEvidenceArtifact).check(Schema.isMaxLength(16)),
  cleanup: AndroidCleanupState,
  /** Set by `describe-ui` and `logs` when the host kept only part of what it read. */
  truncated: Schema.optional(Schema.Boolean),
  durationMs: NonNegativeInt,
  completedAt: UtcTimestamp,
}).check(
  Schema.makeFilter((evidence) => {
    if (
      evidence.kind === "open-input" ||
      evidence.kind === "tap" ||
      evidence.kind === "swipe" ||
      evidence.kind === "type-text" ||
      evidence.kind === "key-press" ||
      evidence.kind === "open-url" ||
      evidence.kind === "rotate" ||
      evidence.kind === "start-recording" ||
      evidence.kind === "stop-recording"
    ) {
      return evidence.requestedBy !== undefined;
    }
    return true;
  }),
);
export type AndroidEmulatorEvidence = typeof AndroidEmulatorEvidence.Type;

export const AndroidActionProgress = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: AndroidEmulatorActionKind,
  state: Schema.Literals(["queued", "running", "cleaning-up", "completed"]),
  step: Schema.Literals([
    "authorizing",
    "discovering",
    "preparing-destination",
    "installing",
    "launching",
    "capturing-screen",
    "collecting-logs",
    "injecting-input",
    "cleaning-up",
    "completed",
  ]),
  sequence: PositiveInt,
  updatedAt: UtcTimestamp,
});
export type AndroidActionProgress = typeof AndroidActionProgress.Type;

export const AndroidRuntimeSnapshot = Schema.Struct({
  sequence: NonNegativeInt,
  snapshotAt: UtcTimestamp,
  sdk: AndroidSdkDiscovery,
  emulators: Schema.Array(AndroidEmulatorRecord).check(Schema.isMaxLength(256)),
  active: Schema.Array(AndroidActionProgress).check(Schema.isMaxLength(64)),
  recentEvidence: Schema.Array(AndroidEmulatorEvidence).check(Schema.isMaxLength(64)),
  inputGrants: Schema.optional(
    Schema.Array(Schema.Struct({ emulatorId: AndroidEmulatorId, expiresAt: UtcTimestamp })).check(
      Schema.isMaxLength(256),
    ),
  ),
  paneOpenRequest: Schema.optional(
    Schema.Struct({
      requestId: GuidString,
      emulatorId: AndroidEmulatorId,
      requestedAt: UtcTimestamp,
    }),
  ),
  capabilities: Schema.optional(DeviceHostCapabilities),
  /** Emulators this host is recording right now, so the pane offers Stop instead of Record. */
  recordings: Schema.optional(
    Schema.Array(Schema.Struct({ emulatorId: AndroidEmulatorId, startedAt: UtcTimestamp })).check(
      Schema.isMaxLength(256),
    ),
  ),
});
export type AndroidRuntimeSnapshot = typeof AndroidRuntimeSnapshot.Type;

export const AndroidToolchainFailure = Schema.Union([
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("sdk-not-found"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("emulator-not-found"),
    message: NonEmptyTrimmedString,
  }),
]);
export type AndroidToolchainFailure = typeof AndroidToolchainFailure.Type;

export const decodeAndroidEmulatorId = Schema.decodeUnknownSync(
  AndroidEmulatorId,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidSdkId = Schema.decodeUnknownSync(AndroidSdkId, STRICT_DECODE_OPTIONS);
export const decodeAndroidEmulatorState = Schema.decodeUnknownSync(
  AndroidEmulatorState,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidEmulatorRecord = Schema.decodeUnknownSync(
  AndroidEmulatorRecord,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidSdkDiscovery = Schema.decodeUnknownSync(
  AndroidSdkDiscovery,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidEmulatorActionKind = Schema.decodeUnknownSync(
  AndroidEmulatorActionKind,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidEmulatorRequest = Schema.decodeUnknownSync(
  AndroidEmulatorRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidDiscoveryRequest = Schema.decodeUnknownSync(
  AndroidDiscoveryRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidEmulatorEvidence = Schema.decodeUnknownSync(
  AndroidEmulatorEvidence,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidRuntimeSnapshot = Schema.decodeUnknownSync(
  AndroidRuntimeSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidToolchainFailure = Schema.decodeUnknownSync(
  AndroidToolchainFailure,
  STRICT_DECODE_OPTIONS,
);
