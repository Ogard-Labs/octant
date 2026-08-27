import { Schema } from "effect";
import {
  AppleActionRequest,
  AppleBuildEvidence,
  AppleDiscoveryRequest,
  AppleEvidenceReference,
  AppleRuntimeSnapshot,
  AppleSimulatorRecord,
  AppleToolchainDiscovery,
  AppleToolchainFailure,
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
export const decodeAppleDiscoverySnapshot = Schema.decodeUnknownSync(AppleDiscoverySnapshot);
export const decodeAppleRpcEnvelope = Schema.decodeUnknownSync(AppleRpcEnvelope);
