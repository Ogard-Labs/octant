import { Schema } from "effect";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { CorrelationId, EventActor, UtcTimestamp } from "./events";
import { ToolActionApproval, ToolActionAuthority, ToolActionId } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const opaqueReference = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.filter((value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0")),
);

/** AVD name. Not a UUID: the SDK names destinations this way. */
export const AndroidEmulatorId = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z][A-Za-z0-9._-]*$/),
  Schema.brand("AndroidEmulatorId"),
);
export type AndroidEmulatorId = typeof AndroidEmulatorId.Type;

export const AndroidSdkId = Schema.UUID.pipe(Schema.brand("AndroidSdkId"));
export type AndroidSdkId = typeof AndroidSdkId.Type;

export const AndroidEmulatorState = Schema.Literal(
  "booted",
  "shutdown",
  "booting",
  "shutting-down",
  "unavailable",
);
export type AndroidEmulatorState = typeof AndroidEmulatorState.Type;

export const AndroidEmulatorRecord = Schema.Struct({
  emulatorId: AndroidEmulatorId,
  name: Schema.NonEmptyTrimmedString,
  apiLevel: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32))),
  state: AndroidEmulatorState,
  serial: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(64),
      Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    ),
  ),
}).annotations(strict);
export type AndroidEmulatorRecord = typeof AndroidEmulatorRecord.Type;

export const AndroidSdkDiscovery = Schema.Struct({
  sdkId: AndroidSdkId,
  sdkRoot: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  adbPath: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  emulatorPath: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  available: Schema.Boolean,
  discoveredAt: UtcTimestamp,
}).annotations(strict);
export type AndroidSdkDiscovery = typeof AndroidSdkDiscovery.Type;

export const AndroidEmulatorActionKind = Schema.Literal(
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
);
export type AndroidEmulatorActionKind = typeof AndroidEmulatorActionKind.Type;

export const AndroidPoint = Schema.Struct({
  x: Schema.Number.pipe(Schema.finite()),
  y: Schema.Number.pipe(Schema.finite()),
}).annotations(strict);
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
  toPoint: Schema.optional(AndroidPoint),
  durationMs: Schema.optional(Schema.Int.pipe(Schema.between(50, 5_000))),
  text: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096))),
  key: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64))),
  apkPath: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(1024),
      Schema.filter((value) => {
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
    Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(255),
      Schema.pattern(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/),
    ),
  ),
  timeoutMs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(10 * 60 * 1000)),
  approval: ToolActionApproval,
})
  .annotations(strict)
  .pipe(
    Schema.filter((request) => {
      if (request.kind === "open-input") return request.requestedBy !== undefined;
      if (request.kind === "tap") {
        return request.requestedBy !== undefined && request.point !== undefined;
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
      if (request.kind === "launch") return request.packageName !== undefined;
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
}).annotations(strict);
export type AndroidDiscoveryRequest = typeof AndroidDiscoveryRequest.Type;

export const AndroidBuildOutcome = Schema.Literal(
  "succeeded",
  "failed",
  "cancelled",
  "timed-out",
  "interrupted",
  "unavailable",
  "unauthorized",
  "invalid-destination",
  "process-died",
);
export type AndroidBuildOutcome = typeof AndroidBuildOutcome.Type;

export const AndroidDiagnostic = Schema.Struct({
  severity: Schema.Literal("error", "warning", "note"),
  message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
}).annotations(strict);
export type AndroidDiagnostic = typeof AndroidDiagnostic.Type;

export const AndroidEvidenceArtifact = Schema.Struct({
  kind: Schema.Literal("log", "screenshot", "application"),
  reference: opaqueReference,
}).annotations(strict);
export type AndroidEvidenceArtifact = typeof AndroidEvidenceArtifact.Type;

export const AndroidCleanupState = Schema.Literal("not-required", "complete", "uncertain");
export type AndroidCleanupState = typeof AndroidCleanupState.Type;

export const AndroidEmulatorEvidence = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: AndroidEmulatorActionKind,
  outcome: AndroidBuildOutcome,
  emulatorId: Schema.optional(AndroidEmulatorId),
  requestedBy: Schema.optional(EventActor),
  diagnostics: Schema.Array(AndroidDiagnostic).pipe(Schema.maxItems(64)),
  artifacts: Schema.Array(AndroidEvidenceArtifact).pipe(Schema.maxItems(16)),
  cleanup: AndroidCleanupState,
  durationMs: Schema.Int.pipe(Schema.nonNegative()),
  completedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter((evidence) => {
      if (
        evidence.kind === "open-input" ||
        evidence.kind === "tap" ||
        evidence.kind === "swipe" ||
        evidence.kind === "type-text" ||
        evidence.kind === "key-press"
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
  state: Schema.Literal("queued", "running", "cleaning-up", "completed"),
  step: Schema.Literal(
    "authorizing",
    "discovering",
    "preparing-destination",
    "installing",
    "launching",
    "capturing-screen",
    "injecting-input",
    "cleaning-up",
    "completed",
  ),
  sequence: Schema.Int.pipe(Schema.positive()),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type AndroidActionProgress = typeof AndroidActionProgress.Type;

export const AndroidRuntimeSnapshot = Schema.Struct({
  sequence: Schema.Int.pipe(Schema.nonNegative()),
  snapshotAt: UtcTimestamp,
  sdk: AndroidSdkDiscovery,
  emulators: Schema.Array(AndroidEmulatorRecord).pipe(Schema.maxItems(256)),
  active: Schema.Array(AndroidActionProgress).pipe(Schema.maxItems(64)),
  recentEvidence: Schema.Array(AndroidEmulatorEvidence).pipe(Schema.maxItems(64)),
  inputGrants: Schema.optional(
    Schema.Array(
      Schema.Struct({ emulatorId: AndroidEmulatorId, expiresAt: UtcTimestamp }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  ),
  paneOpenRequest: Schema.optional(
    Schema.Struct({
      requestId: Schema.UUID,
      emulatorId: AndroidEmulatorId,
      requestedAt: UtcTimestamp,
    }).annotations(strict),
  ),
}).annotations(strict);
export type AndroidRuntimeSnapshot = typeof AndroidRuntimeSnapshot.Type;

export const AndroidToolchainFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("sdk-not-found"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("emulator-not-found"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
).annotations(strict);
export type AndroidToolchainFailure = typeof AndroidToolchainFailure.Type;

export const decodeAndroidEmulatorId = Schema.decodeUnknownSync(AndroidEmulatorId);
export const decodeAndroidSdkId = Schema.decodeUnknownSync(AndroidSdkId);
export const decodeAndroidEmulatorState = Schema.decodeUnknownSync(AndroidEmulatorState);
export const decodeAndroidEmulatorRecord = Schema.decodeUnknownSync(AndroidEmulatorRecord);
export const decodeAndroidSdkDiscovery = Schema.decodeUnknownSync(AndroidSdkDiscovery);
export const decodeAndroidEmulatorActionKind = Schema.decodeUnknownSync(AndroidEmulatorActionKind);
export const decodeAndroidEmulatorRequest = Schema.decodeUnknownSync(AndroidEmulatorRequest);
export const decodeAndroidDiscoveryRequest = Schema.decodeUnknownSync(AndroidDiscoveryRequest);
export const decodeAndroidEmulatorEvidence = Schema.decodeUnknownSync(AndroidEmulatorEvidence);
export const decodeAndroidRuntimeSnapshot = Schema.decodeUnknownSync(AndroidRuntimeSnapshot);
export const decodeAndroidToolchainFailure = Schema.decodeUnknownSync(AndroidToolchainFailure);
