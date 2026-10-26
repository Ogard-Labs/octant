import { Schema } from "effect";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { DeviceHostCapabilities, DeviceOpenUrl, DeviceOrientation } from "./deviceHost";
import { CorrelationId, EventActor, UtcTimestamp } from "./events";
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
);
export type AppleActionKind = typeof AppleActionKind.Type;

export const AppleBundleIdentifier = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(255),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9.-]+$/),
);
export type AppleBundleIdentifier = typeof AppleBundleIdentifier.Type;

/** Point in the live Simulator frame's image pixel space (origin top-left). */
export const AppleSimulatorPoint = Schema.Struct({
  x: Schema.Number.pipe(Schema.finite()),
  y: Schema.Number.pipe(Schema.finite()),
}).annotations(strict);
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
  bundleIdentifier: Schema.optional(AppleBundleIdentifier),
  /**
   * Who petitioned this Simulator action. Required for Allow input, tap,
   * type-text, and key-press so a pane click is never confused with an agent
   * tool call.
   */
  requestedBy: Schema.optional(EventActor),
  /** Prefer a stable accessibility identifier or role when the destination names one. */
  target: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
  /**
   * Coordinate tap in live-frame image pixels when no semantic target is named;
   * for a swipe, where the finger goes down.
   */
  point: Schema.optional(AppleSimulatorPoint),
  /** Where a swipe's finger comes up, in the same pixel space as `point`. */
  toPoint: Schema.optional(AppleSimulatorPoint),
  /** How long a swipe takes. A quick one flings; a slow one drags. */
  durationMs: Schema.optional(Schema.Int.pipe(Schema.between(50, 5_000))),
  /** Typed text for `type-text`. Never copied into durable evidence verbatim.
   *  Leading/trailing whitespace is preserved (passwords and spaced values). */
  text: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_096))),
  /** Hardware or named key for `key-press` (for example `return`, `escape`, `home`). */
  key: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64))),
  /** The address `open-url` opens. Shown whole in its confirmation; evidence keeps the origin. */
  url: Schema.optional(DeviceOpenUrl),
  /** The orientation `rotate` sets. Apple omits it: the host turns the Simulator the other way. */
  orientation: Schema.optional(DeviceOrientation),
  timeoutMs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(10 * 60 * 1000)),
  approval: ToolActionApproval,
})
  .annotations(strict)
  .pipe(
    Schema.filter((request) => {
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
  kind: Schema.Literal("log", "xcresult", "application", "screenshot", "recording"),
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
  requestedBy: Schema.optional(EventActor),
  diagnostics: Schema.Array(AppleDiagnostic).pipe(Schema.maxItems(64)),
  artifacts: Schema.Array(AppleEvidenceArtifact).pipe(Schema.maxItems(16)),
  cleanup: AppleCleanupState,
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
    "injecting-input",
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
  /**
   * Simulators this thread may send input to without a new approval, and until
   * when. The host decides; the pane reads this only to avoid raising a
   * confirmation the host would not ask for.
   */
  inputGrants: Schema.optional(
    Schema.Array(
      Schema.Struct({ simulatorId: AppleSimulatorId, expiresAt: UtcTimestamp }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  ),
  /**
   * The in-app Simulator pane this thread should show, when an agent just
   * asked to attach. The host decides; the renderer consumes each requestId
   * once and never infers authority from it.
   */
  paneOpenRequest: Schema.optional(
    Schema.Struct({
      requestId: Schema.UUID,
      simulatorId: AppleSimulatorId,
      projectPath: Schema.optional(AppleProjectPath),
      requestedAt: UtcTimestamp,
    }).annotations(strict),
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
      }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  ),
  /** Simulators this host is recording right now, so the pane offers Stop instead of Record. */
  recordings: Schema.optional(
    Schema.Array(
      Schema.Struct({ simulatorId: AppleSimulatorId, startedAt: UtcTimestamp }).annotations(strict),
    ).pipe(Schema.maxItems(256)),
  ),
}).annotations(strict);
export type AppleRuntimeSnapshot = typeof AppleRuntimeSnapshot.Type;

/**
 * Which discovery probe failed, so a setup checklist can point at the step to
 * fix. Optional and additive: a host that predates it omits it, and a failure
 * without one still reads as a general failure.
 */
export const AppleDiscoveryStep = Schema.Literal("xcode", "licence", "runtime", "project");
export type AppleDiscoveryStep = typeof AppleDiscoveryStep.Type;

export const AppleToolchainFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: Schema.NonEmptyTrimmedString,
    step: Schema.optional(AppleDiscoveryStep),
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: Schema.NonEmptyTrimmedString,
    step: Schema.optional(AppleDiscoveryStep),
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("xcode-not-found"),
    message: Schema.NonEmptyTrimmedString,
    step: Schema.optional(AppleDiscoveryStep),
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

// Physical Apple devices (docs/design/apple-devices.md). The host maps each
// AppleDeviceId to the CoreDevice identifier in its own runtime store; the
// UDID, serial number, and ECID never cross this boundary, so the record is
// strict and has no field to carry them.

export const AppleDeviceId = brandedUuid("AppleDeviceId");
export type AppleDeviceId = typeof AppleDeviceId.Type;

/** A development team, the only thing that selects a signing identity. */
export const AppleTeamId = Schema.String.pipe(
  Schema.pattern(/^[A-Z0-9]{10}$/),
  Schema.brand("AppleTeamId"),
);
export type AppleTeamId = typeof AppleTeamId.Type;

export const AppleDeviceConnection = Schema.Literal("wired", "network");
export type AppleDeviceConnection = typeof AppleDeviceConnection.Type;

/**
 * What the device can answer right now. Every state but `connected` is also
 * the reason an operation that needs the device is refused.
 */
export const AppleDeviceState = Schema.Literal(
  "connected",
  "locked",
  "developer-mode-off",
  "untrusted",
  "unavailable",
);
export type AppleDeviceState = typeof AppleDeviceState.Type;

export const AppleDeviceRecord = Schema.Struct({
  deviceId: AppleDeviceId,
  /** The name the person gave the device, as Xcode shows it. */
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  model: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  /** iPhone and iPad only; other paired hardware is not a destination. */
  platform: Schema.Literal("ios"),
  osVersion: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  connection: AppleDeviceConnection,
  state: AppleDeviceState,
}).annotations(strict);
export type AppleDeviceRecord = typeof AppleDeviceRecord.Type;

/**
 * Every operation in the device authority table. `provisioning-update` is
 * listed so that asking for one is refused by name; no posture offers it.
 * `upload` is the distribution layer's one operation and targets no device.
 */
export const AppleDeviceActionKind = Schema.Literal(
  "discover",
  "status",
  "use-device",
  "release-device",
  "screenshot",
  "logs",
  "build",
  "run",
  "install",
  "launch",
  "terminate",
  "uninstall",
  "provisioning-update",
  "upload",
);
export type AppleDeviceActionKind = typeof AppleDeviceActionKind.Type;

/**
 * Device operations the selected Xcode's own tooling offers, as the host
 * probed them. One the probe did not find is unavailable on that host and is
 * never approximated.
 */
export const AppleDeviceToolingOperation = Schema.Literal(
  "list-devices",
  "install-app",
  "launch-app",
  "terminate-process",
  "uninstall-app",
  "screenshot",
  "console-logs",
);
export type AppleDeviceToolingOperation = typeof AppleDeviceToolingOperation.Type;

export const AppleDeviceRequest = Schema.Struct({
  actionId: ToolActionId,
  correlationId: CorrelationId,
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  kind: AppleDeviceActionKind,
  /** Always named, so a pane click is never confused with an agent tool call. */
  requestedBy: EventActor,
  deviceId: Schema.optional(AppleDeviceId),
  /**
   * `use-device` only: the thread a local person is moving the lease from.
   * The confirmation names it, and a lease that changed hands since refuses.
   */
  fromThreadId: Schema.optional(CodeThreadId),
  projectPath: Schema.optional(AppleProjectPath),
  scheme: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
  configuration: Schema.optional(AppleBuildConfiguration),
  teamId: Schema.optional(AppleTeamId),
  /** `install` only: a product an Octant build held for this thread, by reference. */
  artifact: Schema.optional(AppleEvidenceReference),
  bundleIdentifier: Schema.optional(AppleBundleIdentifier),
  timeoutMs: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(60 * 60 * 1000)),
  approval: ToolActionApproval,
})
  .annotations(strict)
  .pipe(
    Schema.filter((request) => {
      const targetsNoDevice = request.kind === "discover" || request.kind === "upload";
      if (targetsNoDevice !== (request.deviceId === undefined)) return false;
      if (request.fromThreadId !== undefined && request.kind !== "use-device") return false;
      if (request.kind === "build" || request.kind === "run") {
        return request.projectPath !== undefined && request.teamId !== undefined;
      }
      if (request.kind === "install") return request.artifact !== undefined;
      if (
        request.kind === "launch" ||
        request.kind === "terminate" ||
        request.kind === "uninstall" ||
        request.kind === "logs"
      ) {
        return request.bundleIdentifier !== undefined;
      }
      return true;
    }),
  );
export type AppleDeviceRequest = typeof AppleDeviceRequest.Type;

/**
 * One thread's use of one device, held in host memory only. A person at the
 * Mac always granted it.
 */
export const AppleDeviceLease = Schema.Struct({
  deviceId: AppleDeviceId,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  grantedBy: EventActor,
  grantedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter((lease) => lease.grantedBy.kind === "local-user"));
export type AppleDeviceLease = typeof AppleDeviceLease.Type;

export const AppleDeviceLeaseEndReason = Schema.Literal(
  "released",
  "moved",
  "thread-archived",
  "thread-purged",
  "checkout-rebound",
  "device-disconnected",
);
export type AppleDeviceLeaseEndReason = typeof AppleDeviceLeaseEndReason.Type;

export const AppleDeviceRefusalReason = Schema.Literal(
  "core-capability-required",
  "code-mode-required",
  "authority-mismatch",
  "thread-mismatch",
  "checkout-mismatch",
  "toolchain-unavailable",
  "operation-unavailable",
  "provisioning-updates-not-offered",
  "distribution-not-enabled",
  "person-required",
  "local-person-required",
  "read-only-policy",
  "approval-required",
  "approval-denied",
  "confirmation-required",
  "invalid-destination",
  "destination-leased",
  "lease-required",
  "lease-changed",
  "locked",
  "developer-mode-off",
  "untrusted",
  "unavailable",
  "invalid-artifact",
  "foreign-bundle",
  "process-not-owned",
);
export type AppleDeviceRefusalReason = typeof AppleDeviceRefusalReason.Type;

export const decodeAppleProjectPath = Schema.decodeUnknownSync(AppleProjectPath);
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
export const decodeAppleSimulatorPoint = Schema.decodeUnknownSync(AppleSimulatorPoint);
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
export const decodeAppleDeviceRecord = Schema.decodeUnknownSync(AppleDeviceRecord);
export const decodeAppleDeviceRequest = Schema.decodeUnknownSync(AppleDeviceRequest);
export const decodeAppleDeviceLease = Schema.decodeUnknownSync(AppleDeviceLease);
