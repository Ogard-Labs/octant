import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  AppleActionRequest,
  AppleBuildEvidence,
  AppleDiscoveryRequest,
  AppleEvidenceReference,
  AppleRuntimeSnapshot,
  AppleSimulatorId,
  AppleSimulatorRecord,
  AppleToolchainDiscovery,
  AppleToolchainFailure,
  AppleWorkspaceDiscovery,
} from "./appleToolchain";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { ToolActionAuthority, ToolActionCancellation } from "./toolActions";

export const AppleAuthorityScopeRequest = Schema.Struct({
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
});
export type AppleAuthorityScopeRequest = typeof AppleAuthorityScopeRequest.Type;

export const AppleCancelRequest = Schema.Struct({
  kind: Schema.Literal("apple-cancel-request"),
  cancellation: ToolActionCancellation,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
});
export type AppleCancelRequest = typeof AppleCancelRequest.Type;

export const AppleSnapshotRequest = Schema.Struct({
  kind: Schema.Literal("apple-snapshot-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
});
export type AppleSnapshotRequest = typeof AppleSnapshotRequest.Type;

export const AppleArtifactRequest = Schema.Struct({
  kind: Schema.Literal("apple-artifact-request"),
  authority: ToolActionAuthority,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  reference: AppleEvidenceReference,
});
export type AppleArtifactRequest = typeof AppleArtifactRequest.Type;

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
});
export type AppleScreenStreamRequest = typeof AppleScreenStreamRequest.Type;

export const AppleDiscoverySnapshot = Schema.Struct({
  toolchain: AppleToolchainDiscovery,
  workspace: AppleWorkspaceDiscovery,
  simulators: Schema.Array(AppleSimulatorRecord).check(Schema.isMaxLength(256)),
});
export type AppleDiscoverySnapshot = typeof AppleDiscoverySnapshot.Type;

export const AppleRpcEnvelope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("apple-discovery-request"),
    request: AppleDiscoveryRequest,
  }),
  Schema.Struct({
    kind: Schema.Literal("apple-action-request"),
    request: AppleActionRequest,
  }),
  AppleCancelRequest,
  AppleSnapshotRequest,
  Schema.Struct({
    kind: Schema.Literal("apple-discovery-snapshot"),
    snapshot: AppleDiscoverySnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("apple-action-evidence"),
    evidence: AppleBuildEvidence,
  }),
  Schema.Struct({
    kind: Schema.Literal("apple-runtime-snapshot"),
    snapshot: AppleRuntimeSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("apple-cancelled"),
    cancelled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("apple-failure"),
    failure: AppleToolchainFailure,
  }),
]);
export type AppleRpcEnvelope = typeof AppleRpcEnvelope.Type;

export const decodeAppleAuthorityScopeRequest = Schema.decodeUnknownSync(
  AppleAuthorityScopeRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleCancelRequest = Schema.decodeUnknownSync(
  AppleCancelRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleSnapshotRequest = Schema.decodeUnknownSync(
  AppleSnapshotRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleArtifactRequest = Schema.decodeUnknownSync(
  AppleArtifactRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleScreenStreamRequest = Schema.decodeUnknownSync(
  AppleScreenStreamRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleDiscoverySnapshot = Schema.decodeUnknownSync(
  AppleDiscoverySnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeAppleRpcEnvelope = Schema.decodeUnknownSync(
  AppleRpcEnvelope,
  STRICT_DECODE_OPTIONS,
);
