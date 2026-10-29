import { Schema } from "effect";
import {
  AppleActionRequest,
  AppleBuildEvidence,
  AppleDiscoveryRequest,
  AppleEvidenceReference,
  AppleProjectPath,
  AppleRuntimeSnapshot,
  AppleSimulatorId,
  AppleSimulatorRecord,
  AppleToolchainDiscovery,
  AppleTeamId,
  AppleToolchainFailure,
  AppleStoreVersion,
  AppleUploadBuild,
  AppleWorkspaceDiscovery,
} from "./appleToolchain";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { ToolActionAuthority, ToolActionCancellation } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const AppleAuthorityScopeRequest = Schema.Struct({
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
}).annotations(strict);
export type AppleAuthorityScopeRequest = typeof AppleAuthorityScopeRequest.Type;

export const AppleCancelRequest = Schema.Struct({
  kind: Schema.Literal("apple-cancel-request"),
  cancellation: ToolActionCancellation,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
}).annotations(strict);
export type AppleCancelRequest = typeof AppleCancelRequest.Type;

export const AppleSnapshotRequest = Schema.Struct({
  kind: Schema.Literal("apple-snapshot-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
}).annotations(strict);
export type AppleSnapshotRequest = typeof AppleSnapshotRequest.Type;

export const AppleArtifactRequest = Schema.Struct({
  kind: Schema.Literal("apple-artifact-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  reference: AppleEvidenceReference,
}).annotations(strict);
export type AppleArtifactRequest = typeof AppleArtifactRequest.Type;

/**
 * Asks what an upload of this project to App Store Connect would send: the
 * exact build and App Store signature, read before anyone is asked to confirm
 * it. Only a window on the Mac asks; nothing runs that writes.
 */
export const AppleUploadPreparationRequest = Schema.Struct({
  kind: Schema.Literal("apple-upload-preparation"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  projectPath: AppleProjectPath,
  /** Passed to `xcodebuild` after `-scheme` as given, so it never begins with `-`. */
  scheme: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(256),
      Schema.filter((value) => !value.startsWith("-")),
    ),
  ),
  teamId: AppleTeamId,
}).annotations(strict);
export type AppleUploadPreparationRequest = typeof AppleUploadPreparationRequest.Type;

export const AppleUploadPreparation = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("prepared"), upload: AppleUploadBuild }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    message: Schema.String.pipe(Schema.maxLength(2_048)),
  }).annotations(strict),
);
export type AppleUploadPreparation = typeof AppleUploadPreparation.Type;

/**
 * Asks what App Store Connect holds for this project's version: the app and
 * version the scheme declares, the build App Store Connect has for that
 * version, and which person-confirmed step it is ready for. It only reads;
 * only a window on the Mac asks.
 */
export const AppleStoreVersionPreparationRequest = Schema.Struct({
  kind: Schema.Literal("apple-store-version-preparation"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  projectPath: AppleProjectPath,
  /** Passed to `xcodebuild` after `-scheme` as given, so it never begins with `-`. */
  scheme: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(256),
      Schema.filter((value) => !value.startsWith("-")),
    ),
  ),
}).annotations(strict);
export type AppleStoreVersionPreparationRequest = typeof AppleStoreVersionPreparationRequest.Type;

export const AppleStoreVersionPreparation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("prepared"),
    storeVersion: AppleStoreVersion,
    /**
     * The one step App Store Connect's state admits now: a submission for a
     * version whose build finished processing, a release for a version
     * approved and waiting for a manual release, or neither.
     */
    ready: Schema.Literal("submit-for-review", "release-version", "neither"),
    /** App Store Connect's own name for the version's state, as it answered. */
    state: Schema.String.pipe(Schema.pattern(/^[A-Z_]{1,64}$/)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    message: Schema.String.pipe(Schema.maxLength(2_048)),
  }).annotations(strict),
);
export type AppleStoreVersionPreparation = typeof AppleStoreVersionPreparation.Type;

/**
 * Asks to watch a booted Simulator's screen. The answer is not an envelope
 * but a stream of length-prefixed JPEG frames; size, quality and rate are the
 * host's to choose. Watching is a read, authorized like a screenshot.
 */
export const AppleScreenStreamRequest = Schema.Struct({
  kind: Schema.Literal("apple-screen-stream-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  simulatorId: AppleSimulatorId,
}).annotations(strict);
export type AppleScreenStreamRequest = typeof AppleScreenStreamRequest.Type;

export const AppleDiscoverySnapshot = Schema.Struct({
  toolchain: AppleToolchainDiscovery,
  workspace: AppleWorkspaceDiscovery,
  simulators: Schema.Array(AppleSimulatorRecord).pipe(Schema.maxItems(256)),
}).annotations(strict);
export type AppleDiscoverySnapshot = typeof AppleDiscoverySnapshot.Type;

export const AppleRpcEnvelope = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("apple-discovery-request"),
    request: AppleDiscoveryRequest,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("apple-action-request"),
    request: AppleActionRequest,
  }).annotations(strict),
  AppleCancelRequest,
  AppleSnapshotRequest,
  Schema.Struct({
    kind: Schema.Literal("apple-discovery-snapshot"),
    snapshot: AppleDiscoverySnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("apple-action-evidence"),
    evidence: AppleBuildEvidence,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("apple-runtime-snapshot"),
    snapshot: AppleRuntimeSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("apple-cancelled"),
    cancelled: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("apple-failure"),
    failure: AppleToolchainFailure,
  }).annotations(strict),
);
export type AppleRpcEnvelope = typeof AppleRpcEnvelope.Type;

export const decodeAppleAuthorityScopeRequest = Schema.decodeUnknownSync(
  AppleAuthorityScopeRequest,
);
export const decodeAppleCancelRequest = Schema.decodeUnknownSync(AppleCancelRequest);
export const decodeAppleSnapshotRequest = Schema.decodeUnknownSync(AppleSnapshotRequest);
export const decodeAppleArtifactRequest = Schema.decodeUnknownSync(AppleArtifactRequest);
export const decodeAppleUploadPreparationRequest = Schema.decodeUnknownSync(
  AppleUploadPreparationRequest,
);
export const decodeAppleUploadPreparation = Schema.decodeUnknownSync(AppleUploadPreparation);
export const decodeAppleStoreVersionPreparationRequest = Schema.decodeUnknownSync(
  AppleStoreVersionPreparationRequest,
);
export const decodeAppleStoreVersionPreparation = Schema.decodeUnknownSync(
  AppleStoreVersionPreparation,
);
export const decodeAppleScreenStreamRequest = Schema.decodeUnknownSync(AppleScreenStreamRequest);
export const decodeAppleDiscoverySnapshot = Schema.decodeUnknownSync(AppleDiscoverySnapshot);
export const decodeAppleRpcEnvelope = Schema.decodeUnknownSync(AppleRpcEnvelope);
