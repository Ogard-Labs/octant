import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  AndroidDiscoveryRequest,
  AndroidEmulatorEvidence,
  AndroidEmulatorId,
  AndroidEmulatorRecord,
  AndroidEmulatorRequest,
  AndroidRuntimeSnapshot,
  AndroidSdkDiscovery,
  AndroidToolchainFailure,
} from "./androidToolchain";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { ToolActionAuthority, ToolActionCancellation } from "./toolActions";
import { AppleEvidenceReference } from "./appleToolchain";

export const AndroidAuthorityScopeRequest = Schema.Struct({
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
});
export type AndroidAuthorityScopeRequest = typeof AndroidAuthorityScopeRequest.Type;

export const AndroidCancelRequest = Schema.Struct({
  kind: Schema.Literal("android-cancel-request"),
  cancellation: ToolActionCancellation,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
});
export type AndroidCancelRequest = typeof AndroidCancelRequest.Type;

export const AndroidSnapshotRequest = Schema.Struct({
  kind: Schema.Literal("android-snapshot-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
});
export type AndroidSnapshotRequest = typeof AndroidSnapshotRequest.Type;

export const AndroidArtifactRequest = Schema.Struct({
  kind: Schema.Literal("android-artifact-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  reference: AppleEvidenceReference,
});
export type AndroidArtifactRequest = typeof AndroidArtifactRequest.Type;

export const AndroidScreenStreamRequest = Schema.Struct({
  kind: Schema.Literal("android-screen-stream-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  emulatorId: AndroidEmulatorId,
});
export type AndroidScreenStreamRequest = typeof AndroidScreenStreamRequest.Type;

/**
 * Why the pane shows adb screencap snapshots instead of the serve-avd stream:
 * no desktop app hosts this server, the device is not an emulator, serve-avd
 * is not installed, exited or did not attach in time, the desktop did not
 * answer, or the stream sent no picture.
 */
export const AndroidScreenFallbackReason = Schema.Literals([
  "no-desktop",
  "not-emulator",
  "tool-missing",
  "tool-exited",
  "timed-out",
  "desktop-unreachable",
  "no-frames",
]);
export type AndroidScreenFallbackReason = typeof AndroidScreenFallbackReason.Type;

/** How the frames of one Android screen stream reach the pane. */
export const AndroidScreenTransport = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("stream") }),
  Schema.Struct({
    kind: Schema.Literal("screencap"),
    reason: AndroidScreenFallbackReason,
  }),
]);
export type AndroidScreenTransport = typeof AndroidScreenTransport.Type;

/** Response header naming the stream's `AndroidScreenTransport`, as JSON. */
export const ANDROID_SCREEN_TRANSPORT_HEADER = "x-octant-android-transport";

export const AndroidDiscoverySnapshot = Schema.Struct({
  sdk: AndroidSdkDiscovery,
  emulators: Schema.Array(AndroidEmulatorRecord).check(Schema.isMaxLength(256)),
});
export type AndroidDiscoverySnapshot = typeof AndroidDiscoverySnapshot.Type;

export const AndroidRpcEnvelope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("android-discovery-request"),
    request: AndroidDiscoveryRequest,
  }),
  Schema.Struct({
    kind: Schema.Literal("android-action-request"),
    request: AndroidEmulatorRequest,
  }),
  AndroidCancelRequest,
  AndroidSnapshotRequest,
  Schema.Struct({
    kind: Schema.Literal("android-discovery-snapshot"),
    snapshot: AndroidDiscoverySnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("android-action-evidence"),
    evidence: AndroidEmulatorEvidence,
  }),
  Schema.Struct({
    kind: Schema.Literal("android-runtime-snapshot"),
    snapshot: AndroidRuntimeSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("android-cancelled"),
    cancelled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("android-failure"),
    failure: AndroidToolchainFailure,
  }),
]);
export type AndroidRpcEnvelope = typeof AndroidRpcEnvelope.Type;

export const decodeAndroidAuthorityScopeRequest = Schema.decodeUnknownSync(
  AndroidAuthorityScopeRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidCancelRequest = Schema.decodeUnknownSync(
  AndroidCancelRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidSnapshotRequest = Schema.decodeUnknownSync(
  AndroidSnapshotRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidArtifactRequest = Schema.decodeUnknownSync(
  AndroidArtifactRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidScreenStreamRequest = Schema.decodeUnknownSync(
  AndroidScreenStreamRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidDiscoverySnapshot = Schema.decodeUnknownSync(
  AndroidDiscoverySnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidRpcEnvelope = Schema.decodeUnknownSync(
  AndroidRpcEnvelope,
  STRICT_DECODE_OPTIONS,
);
export const decodeAndroidScreenTransport = Schema.decodeUnknownSync(
  AndroidScreenTransport,
  STRICT_DECODE_OPTIONS,
);
