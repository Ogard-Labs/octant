import { Schema } from "effect";
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

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const AndroidAuthorityScopeRequest = Schema.Struct({
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
}).annotations(strict);
export type AndroidAuthorityScopeRequest = typeof AndroidAuthorityScopeRequest.Type;

export const AndroidCancelRequest = Schema.Struct({
  kind: Schema.Literal("android-cancel-request"),
  cancellation: ToolActionCancellation,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
}).annotations(strict);
export type AndroidCancelRequest = typeof AndroidCancelRequest.Type;

export const AndroidSnapshotRequest = Schema.Struct({
  kind: Schema.Literal("android-snapshot-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
}).annotations(strict);
export type AndroidSnapshotRequest = typeof AndroidSnapshotRequest.Type;

export const AndroidArtifactRequest = Schema.Struct({
  kind: Schema.Literal("android-artifact-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  reference: AppleEvidenceReference,
}).annotations(strict);
export type AndroidArtifactRequest = typeof AndroidArtifactRequest.Type;

export const AndroidScreenStreamRequest = Schema.Struct({
  kind: Schema.Literal("android-screen-stream-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  emulatorId: AndroidEmulatorId,
}).annotations(strict);
export type AndroidScreenStreamRequest = typeof AndroidScreenStreamRequest.Type;

export const AndroidDiscoverySnapshot = Schema.Struct({
  sdk: AndroidSdkDiscovery,
  emulators: Schema.Array(AndroidEmulatorRecord).pipe(Schema.maxItems(256)),
}).annotations(strict);
export type AndroidDiscoverySnapshot = typeof AndroidDiscoverySnapshot.Type;

export const AndroidRpcEnvelope = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("android-discovery-request"),
    request: AndroidDiscoveryRequest,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("android-action-request"),
    request: AndroidEmulatorRequest,
  }).annotations(strict),
  AndroidCancelRequest,
  AndroidSnapshotRequest,
  Schema.Struct({
    kind: Schema.Literal("android-discovery-snapshot"),
    snapshot: AndroidDiscoverySnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("android-action-evidence"),
    evidence: AndroidEmulatorEvidence,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("android-runtime-snapshot"),
    snapshot: AndroidRuntimeSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("android-cancelled"),
    cancelled: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("android-failure"),
    failure: AndroidToolchainFailure,
  }).annotations(strict),
);
export type AndroidRpcEnvelope = typeof AndroidRpcEnvelope.Type;

export const decodeAndroidAuthorityScopeRequest = Schema.decodeUnknownSync(
  AndroidAuthorityScopeRequest,
);
export const decodeAndroidCancelRequest = Schema.decodeUnknownSync(AndroidCancelRequest);
export const decodeAndroidSnapshotRequest = Schema.decodeUnknownSync(AndroidSnapshotRequest);
export const decodeAndroidArtifactRequest = Schema.decodeUnknownSync(AndroidArtifactRequest);
export const decodeAndroidScreenStreamRequest = Schema.decodeUnknownSync(
  AndroidScreenStreamRequest,
);
export const decodeAndroidDiscoverySnapshot = Schema.decodeUnknownSync(AndroidDiscoverySnapshot);
export const decodeAndroidRpcEnvelope = Schema.decodeUnknownSync(AndroidRpcEnvelope);
