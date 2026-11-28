import { Effect, Schema } from "effect";
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

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
export const AppleProjectPath = Schema.Trimmed.check(
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
);
export type AppleProjectPath = typeof AppleProjectPath.Type;
/**
 * A project path as a caller may send it: checkout-relative, or absolute. The
 * server turns an absolute path into the checkout-relative form, or refuses it
 * with a reason; the normalized form everywhere else stays `AppleProjectPath`.
 * Without this, the request decode rejected `/…` before the server could say why.
 */
export const AppleProjectPathInput = Schema.Union([
  AppleProjectPath,
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(1024),
    Schema.makeFilter(
      (value) =>
        value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        value
          .slice(1)
          .split("/")
          .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    ),
  ),
]);
export const AppleEvidenceReference = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0"),
  ),
);
export type AppleEvidenceReference = typeof AppleEvidenceReference.Type;
const opaqueReference = AppleEvidenceReference;

export const AppleToolchainId = brandedUuid("AppleToolchainId");
export type AppleToolchainId = typeof AppleToolchainId.Type;

export const AppleSimulatorId = brandedUuid("AppleSimulatorId");
export type AppleSimulatorId = typeof AppleSimulatorId.Type;

export const ApplePlatform = Schema.Literals(["ios", "macos", "watchos", "tvos", "visionos"]);
export type ApplePlatform = typeof ApplePlatform.Type;

export const AppleBuildConfiguration = Schema.Literals(["debug", "release"]);
export type AppleBuildConfiguration = typeof AppleBuildConfiguration.Type;

export const AppleSdkRecord = Schema.Struct({
  canonicalName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  platform: ApplePlatform,
  version: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
});
export type AppleSdkRecord = typeof AppleSdkRecord.Type;

export const AppleToolchainDiscovery = Schema.Struct({
  toolchainId: AppleToolchainId,
  xcodeVersion: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(32))),
  xcodePath: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096))),
  developerDirectory: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  ),
  swiftVersion: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(32))),
  sdks: Schema.Array(AppleSdkRecord).pipe(
    Schema.check(Schema.isMaxLength(64)),
    Schema.withDecodingDefaultType(Effect.sync(() => [])),
  ),
  available: Schema.Boolean,
  discoveredAt: UtcTimestamp,
});
export type AppleToolchainDiscovery = typeof AppleToolchainDiscovery.Type;

export const AppleSimulatorState = Schema.Literals([
  "booted",
  "shutdown",
  "booting",
  "shutting-down",
  "unavailable",
]);
export type AppleSimulatorState = typeof AppleSimulatorState.Type;

export const AppleSimulatorRecord = Schema.Struct({
  simulatorId: AppleSimulatorId,
  name: NonEmptyTrimmedString,
  platform: ApplePlatform,
  runtimeVersion: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  state: AppleSimulatorState,
  udid: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
});
export type AppleSimulatorRecord = typeof AppleSimulatorRecord.Type;

export const AppleBuildActionKind = Schema.Literals(["build", "test", "run", "clean", "archive"]);
export type AppleBuildActionKind = typeof AppleBuildActionKind.Type;

export const AppleSimulatorActionKind = Schema.Literals([
  "boot",
  "shutdown",
  "terminate",
  "logs",
  "screenshot",
  "open-input",
  "tap",
  "swipe",
  "type-text",
  "key-press",
  "repair-input",
  "open-url",
  "start-recording",
  "stop-recording",
  "rotate",
]);
export type AppleSimulatorActionKind = typeof AppleSimulatorActionKind.Type;

export const AppleActionKind = Schema.Literals([
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
  "open-input",
  "tap",
  "swipe",
  "type-text",
  "key-press",
  "repair-input",
  "open-url",
  "start-recording",
  "stop-recording",
  "rotate",
]);
export type AppleActionKind = typeof AppleActionKind.Type;

export const AppleBundleIdentifier = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.-]+$/),
);
export type AppleBundleIdentifier = typeof AppleBundleIdentifier.Type;

/** Point in the live Simulator frame's image pixel space (origin top-left). */
export const AppleSimulatorPoint = Schema.Struct({
  x: Schema.Number.check(Schema.isFinite()),
  y: Schema.Number.check(Schema.isFinite()),
});
export type AppleSimulatorPoint = typeof AppleSimulatorPoint.Type;

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
  scheme: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
  configuration: Schema.optional(AppleBuildConfiguration),
  simulatorId: Schema.optional(AppleSimulatorId),
  projectPath: AppleProjectPathInput,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(60 * 60 * 1000)),
  approval: ToolActionApproval,
});
export type AppleBuildRequest = typeof AppleBuildRequest.Type;

export const AppleSimulatorRequest = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  kind: AppleSimulatorActionKind,
  simulatorId: AppleSimulatorId,
  bundleIdentifier: Schema.optional(AppleBundleIdentifier),
  /**
   * Who petitioned this Simulator action. Required for Allow input, tap,
   * type-text, and key-press so a pane click is never confused with an agent
   * tool call.
   */
  requestedBy: Schema.optional(EventActor),
  /** Prefer a stable accessibility identifier or role when the destination names one. */
  target: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
  /**
   * Coordinate tap in live-frame image pixels when no semantic target is named;
   * for a swipe, where the finger goes down.
   */
  point: Schema.optional(AppleSimulatorPoint),
  /** Where a swipe's finger comes up, in the same pixel space as `point`. */
  toPoint: Schema.optional(AppleSimulatorPoint),
  /** How long a swipe takes. A quick one flings; a slow one drags. */
  durationMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 5_000 }))),
  /** Typed text for `type-text`. Never copied into durable evidence verbatim.
   *  Leading/trailing whitespace is preserved (passwords and spaced values). */
  text: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))),
  /** Hardware or named key for `key-press` (for example `return`, `escape`, `home`). */
  key: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64))),
  /** The address `open-url` opens. Shown whole in its confirmation; evidence keeps the origin. */
  url: Schema.optional(DeviceOpenUrl),
  /** The orientation `rotate` sets. Apple omits it: the host turns the Simulator the other way. */
  orientation: Schema.optional(DeviceOrientation),
  /** How far back `logs` reads, in seconds; without it, the last five minutes. */
  sinceSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 }))),
  /** Whether `logs` also reads the app's newest crash reports. */
  includeCrashes: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10 * 60 * 1000)),
  approval: ToolActionApproval,
}).check(
  Schema.makeFilter((request) => {
    if (
      (request.kind === "terminate" || request.kind === "logs") &&
      request.bundleIdentifier === undefined
    ) {
      return false;
    }
    if (request.kind === "open-input") {
      return request.requestedBy !== undefined;
    }
    if (request.kind === "tap") {
      return (
        request.requestedBy !== undefined &&
        (request.target !== undefined || request.point !== undefined)
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
    if (request.kind === "repair-input") {
      return request.requestedBy !== undefined;
    }
    if (request.kind === "open-url") {
      return request.requestedBy !== undefined && request.url !== undefined;
    }
    if (request.kind === "rotate") {
      return request.requestedBy !== undefined;
    }
    if (request.kind === "start-recording" || request.kind === "stop-recording") {
      return request.requestedBy !== undefined;
    }
    return true;
  }),
);
export type AppleSimulatorRequest = typeof AppleSimulatorRequest.Type;

export const AppleActionRequest = Schema.Union([AppleBuildRequest, AppleSimulatorRequest]);
export type AppleActionRequest = typeof AppleActionRequest.Type;

export const AppleDiscoveryRequest = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  projectPath: AppleProjectPathInput,
});
export type AppleDiscoveryRequest = typeof AppleDiscoveryRequest.Type;

export const AppleWorkspaceDiscovery = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  projectPath: AppleProjectPath,
  projectKind: Schema.Literals(["xcode-project", "xcode-workspace", "swift-package"]),
  schemes: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))).check(
    Schema.isMaxLength(128),
  ),
  configurations: Schema.Array(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  ).check(Schema.isMaxLength(64)),
  targets: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))).check(
    Schema.isMaxLength(256),
  ),
  sourceRevision: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  discoveredAt: UtcTimestamp,
});
export type AppleWorkspaceDiscovery = typeof AppleWorkspaceDiscovery.Type;

export const AppleBuildOutcome = Schema.Literals([
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
export type AppleBuildOutcome = typeof AppleBuildOutcome.Type;

export const AppleDiagnostic = Schema.Struct({
  severity: Schema.Literals(["error", "warning", "note"]),
  message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  location: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
});
export type AppleDiagnostic = typeof AppleDiagnostic.Type;

export const AppleEvidenceArtifact = Schema.Struct({
  kind: Schema.Literals(["log", "xcresult", "application", "screenshot", "recording"]),
  reference: opaqueReference,
});
export type AppleEvidenceArtifact = typeof AppleEvidenceArtifact.Type;

export const AppleCleanupState = Schema.Literals(["not-required", "complete", "uncertain"]);
export type AppleCleanupState = typeof AppleCleanupState.Type;

export const AppleBuildEvidence = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: AppleActionKind,
  outcome: AppleBuildOutcome,
  simulatorId: Schema.optional(AppleSimulatorId),
  requestedBy: Schema.optional(EventActor),
  diagnostics: Schema.Array(AppleDiagnostic).check(Schema.isMaxLength(64)),
  artifacts: Schema.Array(AppleEvidenceArtifact).check(Schema.isMaxLength(16)),
  cleanup: AppleCleanupState,
  /** Set by `logs` when the host kept only part of what it read. */
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
      evidence.kind === "repair-input" ||
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
export type AppleBuildEvidence = typeof AppleBuildEvidence.Type;

export const AppleActionProgress = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  kind: AppleActionKind,
  state: Schema.Literals(["queued", "running", "cleaning-up", "completed"]),
  step: Schema.Literals([
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
    "injecting-input",
    "cleaning-up",
    "completed",
  ]),
  sequence: PositiveInt,
  updatedAt: UtcTimestamp,
});
export type AppleActionProgress = typeof AppleActionProgress.Type;

export const AppleRuntimeSnapshot = Schema.Struct({
  sequence: NonNegativeInt,
  snapshotAt: UtcTimestamp,
  toolchain: AppleToolchainDiscovery,
  simulators: Schema.Array(AppleSimulatorRecord).check(Schema.isMaxLength(256)),
  active: Schema.Array(AppleActionProgress).check(Schema.isMaxLength(64)),
  recentEvidence: Schema.Array(AppleBuildEvidence).check(Schema.isMaxLength(64)),
  /**
   * Simulators this thread may send input to without a new approval, and until
   * when. The host decides; the pane reads this only to avoid raising a
   * confirmation the host would not ask for.
   */
  inputGrants: Schema.optional(
    Schema.Array(Schema.Struct({ simulatorId: AppleSimulatorId, expiresAt: UtcTimestamp })).check(
      Schema.isMaxLength(256),
    ),
  ),
  /**
   * The in-app Simulator pane this thread should show, when an agent just
   * asked to attach. The host decides; the renderer consumes each requestId
   * once and never infers authority from it.
   */
  paneOpenRequest: Schema.optional(
    Schema.Struct({
      requestId: GuidString,
      simulatorId: AppleSimulatorId,
      projectPath: Schema.optional(AppleProjectPath),
      requestedAt: UtcTimestamp,
    }),
  ),
  capabilities: Schema.optional(DeviceHostCapabilities),
  /**
   * Which way a Simulator sits, for the ones this host has turned. The
   * streamed picture stays portrait-sized after a turn, so the pane learns the
   * orientation here; a Simulator not listed sits in portrait as far as the
   * host knows.
   */
  orientations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        simulatorId: AppleSimulatorId,
        orientation: DeviceOrientation,
      }),
    ).check(Schema.isMaxLength(256)),
  ),
  /** Simulators this host is recording right now, so the pane offers Stop instead of Record. */
  recordings: Schema.optional(
    Schema.Array(Schema.Struct({ simulatorId: AppleSimulatorId, startedAt: UtcTimestamp })).check(
      Schema.isMaxLength(256),
    ),
  ),
});
export type AppleRuntimeSnapshot = typeof AppleRuntimeSnapshot.Type;

/**
 * Which discovery probe failed, so a setup checklist can point at the step to
 * fix. Optional and additive: a host that predates it omits it, and a failure
 * without one still reads as a general failure.
 */
export const AppleDiscoveryStep = Schema.Literals(["xcode", "licence", "runtime", "project"]);
export type AppleDiscoveryStep = typeof AppleDiscoveryStep.Type;

export const AppleToolchainFailure = Schema.Union([
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: NonEmptyTrimmedString,
    step: Schema.optional(AppleDiscoveryStep),
  }),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: NonEmptyTrimmedString,
    step: Schema.optional(AppleDiscoveryStep),
  }),
  Schema.Struct({
    category: Schema.Literal("xcode-not-found"),
    message: NonEmptyTrimmedString,
    step: Schema.optional(AppleDiscoveryStep),
  }),
  Schema.Struct({
    category: Schema.Literal("simulator-not-found"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("build-failed"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("approval-denied"),
    message: NonEmptyTrimmedString,
  }),
]);
export type AppleToolchainFailure = typeof AppleToolchainFailure.Type;

export const decodeAppleProjectPath = Schema.decodeUnknownSync(
  AppleProjectPath,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleToolchainId = Schema.decodeUnknownSync(
  AppleToolchainId,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleSimulatorId = Schema.decodeUnknownSync(
  AppleSimulatorId,
  STRICT_DECODE_OPTIONS,
);
export const decodeApplePlatform = Schema.decodeUnknownSync(ApplePlatform, STRICT_DECODE_OPTIONS);
export const decodeAppleBuildConfiguration = Schema.decodeUnknownSync(
  AppleBuildConfiguration,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleSdkRecord = Schema.decodeUnknownSync(AppleSdkRecord, STRICT_DECODE_OPTIONS);
export const decodeAppleToolchainDiscovery = Schema.decodeUnknownSync(
  AppleToolchainDiscovery,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleSimulatorState = Schema.decodeUnknownSync(
  AppleSimulatorState,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleSimulatorRecord = Schema.decodeUnknownSync(
  AppleSimulatorRecord,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleBuildActionKind = Schema.decodeUnknownSync(
  AppleBuildActionKind,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleSimulatorActionKind = Schema.decodeUnknownSync(
  AppleSimulatorActionKind,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleActionKind = Schema.decodeUnknownSync(
  AppleActionKind,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleSimulatorPoint = Schema.decodeUnknownSync(
  AppleSimulatorPoint,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleBuildRequest = Schema.decodeUnknownSync(
  AppleBuildRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleSimulatorRequest = Schema.decodeUnknownSync(
  AppleSimulatorRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleActionRequest = Schema.decodeUnknownSync(
  AppleActionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleDiscoveryRequest = Schema.decodeUnknownSync(
  AppleDiscoveryRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleWorkspaceDiscovery = Schema.decodeUnknownSync(
  AppleWorkspaceDiscovery,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleBuildOutcome = Schema.decodeUnknownSync(
  AppleBuildOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleDiagnostic = Schema.decodeUnknownSync(
  AppleDiagnostic,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleEvidenceArtifact = Schema.decodeUnknownSync(
  AppleEvidenceArtifact,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleCleanupState = Schema.decodeUnknownSync(
  AppleCleanupState,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleBuildEvidence = Schema.decodeUnknownSync(
  AppleBuildEvidence,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleActionProgress = Schema.decodeUnknownSync(
  AppleActionProgress,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleRuntimeSnapshot = Schema.decodeUnknownSync(
  AppleRuntimeSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleToolchainFailure = Schema.decodeUnknownSync(
  AppleToolchainFailure,
  STRICT_DECODE_OPTIONS,
);
