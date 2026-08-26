import { Schema } from "effect";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { CorrelationId, UtcTimestamp } from "./events";
import { ToolActionApproval, ToolActionAuthority, ToolActionId } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
export const AppleProjectPath = Schema.NonEmptyTrimmedString.pipe(
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
);
export type AppleProjectPath = typeof AppleProjectPath.Type;
export const AppleEvidenceReference = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.filter((value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0")),
);
export type AppleEvidenceReference = typeof AppleEvidenceReference.Type;
const opaqueReference = AppleEvidenceReference;

export const AppleToolchainId = brandedUuid("AppleToolchainId");
export type AppleToolchainId = typeof AppleToolchainId.Type;

export const AppleSimulatorId = brandedUuid("AppleSimulatorId");
export type AppleSimulatorId = typeof AppleSimulatorId.Type;

export const ApplePlatform = Schema.Literal("ios", "macos", "watchos", "tvos", "visionos");
export type ApplePlatform = typeof ApplePlatform.Type;

export const AppleBuildConfiguration = Schema.Literal("debug", "release");
export type AppleBuildConfiguration = typeof AppleBuildConfiguration.Type;

export const AppleSdkRecord = Schema.Struct({
  canonicalName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  platform: ApplePlatform,
  version: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
}).annotations(strict);
export type AppleSdkRecord = typeof AppleSdkRecord.Type;

export const AppleToolchainDiscovery = Schema.Struct({
  toolchainId: AppleToolchainId,
  xcodeVersion: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32))),
  xcodePath: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  developerDirectory: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
  swiftVersion: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32))),
  sdks: Schema.optionalWith(Schema.Array(AppleSdkRecord).pipe(Schema.maxItems(64)), {
    default: () => [],
  }),
  available: Schema.Boolean,
  discoveredAt: UtcTimestamp,
}).annotations(strict);
export type AppleToolchainDiscovery = typeof AppleToolchainDiscovery.Type;

export const AppleSimulatorState = Schema.Literal(
  "booted",
  "shutdown",
  "booting",
  "shutting-down",
  "unavailable",
);
export type AppleSimulatorState = typeof AppleSimulatorState.Type;

export const AppleSimulatorRecord = Schema.Struct({
  simulatorId: AppleSimulatorId,
  name: Schema.NonEmptyTrimmedString,
  platform: ApplePlatform,
  runtimeVersion: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  state: AppleSimulatorState,
  udid: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
}).annotations(strict);
export type AppleSimulatorRecord = typeof AppleSimulatorRecord.Type;

export const AppleBuildActionKind = Schema.Literal("build", "test", "run", "clean", "archive");
export type AppleBuildActionKind = typeof AppleBuildActionKind.Type;

export const AppleSimulatorActionKind = Schema.Literal(
  "boot",
  "shutdown",
  "terminate",
  "logs",
  "screenshot",
);
export type AppleSimulatorActionKind = typeof AppleSimulatorActionKind.Type;

export const AppleActionKind = Schema.Literal(
  "build",
  "test",
  "run",
  "clean",
  "archive",
  "boot",
  "shutdown",
  "terminate",
  "logs",
  "screenshot",
);
export type AppleActionKind = typeof AppleActionKind.Type;

/** Build/run/test request for Apple toolchain actions.
 *  `simulatorId` is optional; when omitted for `run` or `test` on non-macOS
 *  platforms, the adapter selects the default booted simulator or the first
 *  available simulator for the target platform. The adapter must report which
 *  simulator was used in the resulting AppleBuildEvidence. */
export const AppleBuildRequest = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  kind: AppleBuildActionKind,
  platform: ApplePlatform,
  scheme: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
  configuration: Schema.optional(AppleBuildConfiguration),
  simulatorId: Schema.optional(AppleSimulatorId),
  projectPath: AppleProjectPath,
  timeoutMs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(60 * 60 * 1000)),
  approval: ToolActionApproval,
}).annotations(strict);
export type AppleBuildRequest = typeof AppleBuildRequest.Type;

export const AppleSimulatorRequest = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  kind: AppleSimulatorActionKind,
  simulatorId: AppleSimulatorId,
  bundleIdentifier: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(255),
      Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9.-]+$/),
    ),
  ),
  timeoutMs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(10 * 60 * 1000)),
  approval: ToolActionApproval,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (request) =>
        (request.kind !== "terminate" && request.kind !== "logs") ||
        request.bundleIdentifier !== undefined,
    ),
  );
export type AppleSimulatorRequest = typeof AppleSimulatorRequest.Type;

export const AppleActionRequest = Schema.Union(AppleBuildRequest, AppleSimulatorRequest);
export type AppleActionRequest = typeof AppleActionRequest.Type;

export const AppleDiscoveryRequest = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  projectPath: AppleProjectPath,
}).annotations(strict);
export type AppleDiscoveryRequest = typeof AppleDiscoveryRequest.Type;

export const AppleWorkspaceDiscovery = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  projectPath: AppleProjectPath,
  projectKind: Schema.Literal("xcode-project", "xcode-workspace", "swift-package"),
  schemes: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))).pipe(
    Schema.maxItems(128),
  ),
  configurations: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))).pipe(
    Schema.maxItems(64),
  ),
  targets: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))).pipe(
    Schema.maxItems(256),
  ),
  sourceRevision: Schema.NonEmptyTrimmedString.pipe(Schema.pattern(/^[a-f0-9]{40,64}$/)),
  discoveredAt: UtcTimestamp,
}).annotations(strict);
export type AppleWorkspaceDiscovery = typeof AppleWorkspaceDiscovery.Type;

export const AppleBuildOutcome = Schema.Literal(
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
export type AppleBuildOutcome = typeof AppleBuildOutcome.Type;

export const AppleDiagnostic = Schema.Struct({
  severity: Schema.Literal("error", "warning", "note"),
  message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  location: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type AppleDiagnostic = typeof AppleDiagnostic.Type;

export const AppleEvidenceArtifact = Schema.Struct({
  kind: Schema.Literal("log", "xcresult", "application", "screenshot"),
  reference: opaqueReference,
}).annotations(strict);
export type AppleEvidenceArtifact = typeof AppleEvidenceArtifact.Type;

export const AppleCleanupState = Schema.Literal("not-required", "complete", "uncertain");
export type AppleCleanupState = typeof AppleCleanupState.Type;

export const AppleBuildEvidence = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: AppleActionKind,
  outcome: AppleBuildOutcome,
  simulatorId: Schema.optional(AppleSimulatorId),
  diagnostics: Schema.Array(AppleDiagnostic).pipe(Schema.maxItems(64)),
  artifacts: Schema.Array(AppleEvidenceArtifact).pipe(Schema.maxItems(16)),
  cleanup: AppleCleanupState,
  durationMs: Schema.Int.pipe(Schema.nonNegative()),
  completedAt: UtcTimestamp,
}).annotations(strict);
export type AppleBuildEvidence = typeof AppleBuildEvidence.Type;

export const AppleActionProgress = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: AppleActionKind,
  state: Schema.Literal("queued", "running", "cleaning-up", "completed"),
  step: Schema.Literal(
    "authorizing",
    "discovering",
    "preparing-destination",
    "building",
    "testing",
    "installing",
    "launching",
    "terminating",
    "collecting-logs",
    "capturing-screen",
    "cleaning-up",
    "completed",
  ),
  sequence: Schema.Int.pipe(Schema.positive()),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type AppleActionProgress = typeof AppleActionProgress.Type;

export const AppleRuntimeSnapshot = Schema.Struct({
  sequence: Schema.Int.pipe(Schema.nonNegative()),
  snapshotAt: UtcTimestamp,
  toolchain: AppleToolchainDiscovery,
  simulators: Schema.Array(AppleSimulatorRecord).pipe(Schema.maxItems(256)),
  active: Schema.Array(AppleActionProgress).pipe(Schema.maxItems(64)),
  recentEvidence: Schema.Array(AppleBuildEvidence).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type AppleRuntimeSnapshot = typeof AppleRuntimeSnapshot.Type;

export const AppleToolchainFailure = Schema.Union(
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
    category: Schema.Literal("xcode-not-found"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("simulator-not-found"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("build-failed"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("approval-denied"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
).annotations(strict);
export type AppleToolchainFailure = typeof AppleToolchainFailure.Type;

export const decodeAppleToolchainId = Schema.decodeUnknownSync(AppleToolchainId);
export const decodeAppleSimulatorId = Schema.decodeUnknownSync(AppleSimulatorId);
export const decodeApplePlatform = Schema.decodeUnknownSync(ApplePlatform);
export const decodeAppleBuildConfiguration = Schema.decodeUnknownSync(AppleBuildConfiguration);
export const decodeAppleSdkRecord = Schema.decodeUnknownSync(AppleSdkRecord);
export const decodeAppleToolchainDiscovery = Schema.decodeUnknownSync(AppleToolchainDiscovery);
export const decodeAppleSimulatorState = Schema.decodeUnknownSync(AppleSimulatorState);
export const decodeAppleSimulatorRecord = Schema.decodeUnknownSync(AppleSimulatorRecord);
export const decodeAppleBuildActionKind = Schema.decodeUnknownSync(AppleBuildActionKind);
export const decodeAppleSimulatorActionKind = Schema.decodeUnknownSync(AppleSimulatorActionKind);
export const decodeAppleActionKind = Schema.decodeUnknownSync(AppleActionKind);
export const decodeAppleBuildRequest = Schema.decodeUnknownSync(AppleBuildRequest);
export const decodeAppleSimulatorRequest = Schema.decodeUnknownSync(AppleSimulatorRequest);
export const decodeAppleActionRequest = Schema.decodeUnknownSync(AppleActionRequest);
export const decodeAppleDiscoveryRequest = Schema.decodeUnknownSync(AppleDiscoveryRequest);
export const decodeAppleWorkspaceDiscovery = Schema.decodeUnknownSync(AppleWorkspaceDiscovery);
export const decodeAppleBuildOutcome = Schema.decodeUnknownSync(AppleBuildOutcome);
export const decodeAppleDiagnostic = Schema.decodeUnknownSync(AppleDiagnostic);
export const decodeAppleEvidenceArtifact = Schema.decodeUnknownSync(AppleEvidenceArtifact);
export const decodeAppleCleanupState = Schema.decodeUnknownSync(AppleCleanupState);
export const decodeAppleBuildEvidence = Schema.decodeUnknownSync(AppleBuildEvidence);
export const decodeAppleActionProgress = Schema.decodeUnknownSync(AppleActionProgress);
export const decodeAppleRuntimeSnapshot = Schema.decodeUnknownSync(AppleRuntimeSnapshot);
export const decodeAppleToolchainFailure = Schema.decodeUnknownSync(AppleToolchainFailure);
