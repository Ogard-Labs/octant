import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ExecutionResolutionReceipt } from "./agentProfile";
import { AgentRunAuthority } from "./agentRun";
import { CodeCheckoutId, CodeRepositoryId } from "./code";
import { AggregateVersion, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { BindingRevisionId, ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { ThreadCreationRootId } from "./threadCreation";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const brandedDigest = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)), Schema.brand<B>(brand));

export const MAX_LINKED_THREAD_CONTEXT_ITEMS = 32;
export const MAX_LINKED_THREAD_CONTEXT_BYTES = 128 * 1024;
export const MAX_LINKED_THREAD_TARGETS = 4;
export const LINKED_THREAD_MAX_NESTING_DEPTH = 2;
export const LINKED_THREAD_MAX_ACTIVE_GLOBAL = 4;
export const LINKED_THREAD_MAX_ACTIVE_PER_SOURCE = 3;
export const LINKED_THREAD_MAX_ACTIVE_PER_PROJECT = 4;
export const LINKED_THREAD_MAX_ACTIVE_PER_HOST = 4;

export const LinkedThreadSourceThreadId = brandedUuid("LinkedThreadSourceThreadId");
export type LinkedThreadSourceThreadId = typeof LinkedThreadSourceThreadId.Type;
export const LinkedThreadTargetThreadId = brandedUuid("LinkedThreadTargetThreadId");
export type LinkedThreadTargetThreadId = typeof LinkedThreadTargetThreadId.Type;
export const LinkedThreadRequestId = brandedUuid("LinkedThreadRequestId");
export type LinkedThreadRequestId = typeof LinkedThreadRequestId.Type;
export const LinkedThreadContextSnapshotId = brandedUuid("LinkedThreadContextSnapshotId");
export type LinkedThreadContextSnapshotId = typeof LinkedThreadContextSnapshotId.Type;
export const LinkedThreadReceiptId = brandedUuid("LinkedThreadReceiptId");
export type LinkedThreadReceiptId = typeof LinkedThreadReceiptId.Type;
export const LinkedThreadRequestFingerprint = brandedDigest("LinkedThreadRequestFingerprint");
export type LinkedThreadRequestFingerprint = typeof LinkedThreadRequestFingerprint.Type;
export const LinkedThreadContentDigest = brandedDigest("LinkedThreadContentDigest");
export type LinkedThreadContentDigest = typeof LinkedThreadContentDigest.Type;

const BoundedReferenceId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const BoundedLabel = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const BoundedReason = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const BoundedByteLength = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MAX_LINKED_THREAD_CONTEXT_BYTES),
);

export const LinkedThreadWorkspaceScope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat-virtual"),
    projectId: Schema.NullOr(ProjectId),
  }),
  Schema.Struct({
    kind: Schema.Literal("work-root"),
    projectId: ProjectId,
    rootId: ThreadCreationRootId,
  }),
  Schema.Struct({
    kind: Schema.Literal("code-worktree"),
    projectId: ProjectId,
    repositoryId: CodeRepositoryId,
    bindingRevisionId: BindingRevisionId,
    checkoutId: CodeCheckoutId,
    verified: Schema.Boolean,
  }),
]);
export type LinkedThreadWorkspaceScope = typeof LinkedThreadWorkspaceScope.Type;

export const LinkedThreadScope = Schema.Struct({
  hostId: HostId,
  mode: OctantMode,
  workspace: LinkedThreadWorkspaceScope,
}).check(
  Schema.makeFilter((scope) => {
    if (scope.mode === "chat") return scope.workspace.kind === "chat-virtual";
    if (scope.mode === "work") return scope.workspace.kind === "work-root";
    return scope.workspace.kind === "code-worktree";
  }),
);
export type LinkedThreadScope = typeof LinkedThreadScope.Type;

export const LinkedThreadContextItemKind = Schema.Literals([
  "summary",
  "decision",
  "message",
  "artifact",
  "plan",
  "method",
  "skill",
]);
export type LinkedThreadContextItemKind = typeof LinkedThreadContextItemKind.Type;

export const LinkedThreadContextItem = Schema.Struct({
  kind: LinkedThreadContextItemKind,
  referenceId: BoundedReferenceId,
  label: BoundedLabel,
  sourceVersion: AggregateVersion,
  byteLength: BoundedByteLength,
  contentDigest: Schema.optional(LinkedThreadContentDigest),
});
export type LinkedThreadContextItem = typeof LinkedThreadContextItem.Type;

export const LinkedThreadContextSnapshot = Schema.Struct({
  id: LinkedThreadContextSnapshotId,
  sourceThreadId: LinkedThreadSourceThreadId,
  sourceVersion: AggregateVersion,
  items: Schema.Array(LinkedThreadContextItem).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_LINKED_THREAD_CONTEXT_ITEMS),
  ),
  totalByteLength: BoundedByteLength,
  trust: Schema.Literal("untrusted-context"),
}).check(
  Schema.makeFilter((snapshot) => {
    const references = snapshot.items.map((item) => item.referenceId);
    return (
      new Set(references).size === references.length &&
      snapshot.items.every((item) => item.sourceVersion <= snapshot.sourceVersion) &&
      snapshot.items.reduce((total, item) => total + item.byteLength, 0) ===
        snapshot.totalByteLength
    );
  }),
);
export type LinkedThreadContextSnapshot = typeof LinkedThreadContextSnapshot.Type;

const LinkedThreadFallbackCandidate = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  rejectedReason: Schema.optional(BoundedReason),
});

export const LinkedThreadRoutingReceipt = Schema.Struct({
  executionResolution: ExecutionResolutionReceipt,
  selectedProviderInstanceId: ProviderInstanceId,
  selectedModelId: ProviderModelId,
  rawReasoning: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
  normalizedReasoning: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  ),
  fallbackCandidates: Schema.Array(LinkedThreadFallbackCandidate).check(Schema.isMaxLength(8)),
  selectedFallback: Schema.optional(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      modelId: ProviderModelId,
      reason: BoundedReason,
    }),
  ),
  capabilityDegradations: Schema.Array(BoundedReason).check(Schema.isMaxLength(16)),
  contextSnapshotId: LinkedThreadContextSnapshotId,
  effectiveAuthorityDigest: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  hostId: HostId,
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
});
export type LinkedThreadRoutingReceipt = typeof LinkedThreadRoutingReceipt.Type;

export const LinkedThreadContinuedFrom = Schema.Struct({
  sourceThreadId: LinkedThreadSourceThreadId,
  sourceScope: LinkedThreadScope,
  sourceVersion: AggregateVersion,
  contextSnapshotId: LinkedThreadContextSnapshotId,
  sourceRoutingReceipt: LinkedThreadRoutingReceipt,
});
export type LinkedThreadContinuedFrom = typeof LinkedThreadContinuedFrom.Type;

export const LinkedThreadScopeChange = Schema.Struct({
  confirmed: Schema.Literal(true),
  reason: BoundedReason,
});
export type LinkedThreadScopeChange = typeof LinkedThreadScopeChange.Type;

export const LinkedThreadTransferPolicy = Schema.Struct({
  approvalsTransferred: Schema.Literal(false),
  credentialsTransferred: Schema.Literal(false),
  authorityTransferred: Schema.Literal(false),
  completionTransferred: Schema.Literal(false),
  activeHandlesTransferred: Schema.Literal(false),
  rootsTransferred: Schema.Literal(false),
  worktreesTransferred: Schema.Literal(false),
});
export type LinkedThreadTransferPolicy = typeof LinkedThreadTransferPolicy.Type;

export const LINKED_THREAD_NO_IMPLICIT_TRANSFERS: LinkedThreadTransferPolicy = {
  approvalsTransferred: false,
  credentialsTransferred: false,
  authorityTransferred: false,
  completionTransferred: false,
  activeHandlesTransferred: false,
  rootsTransferred: false,
  worktreesTransferred: false,
};

export const LinkedThreadCreationRequest = Schema.Struct({
  kind: Schema.Literal("create-linked-thread"),
  requestId: LinkedThreadRequestId,
  requestFingerprint: LinkedThreadRequestFingerprint,
  targetThreadIds: Schema.Array(LinkedThreadTargetThreadId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_LINKED_THREAD_TARGETS),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
  continuedFrom: LinkedThreadContinuedFrom,
  contextSnapshot: LinkedThreadContextSnapshot,
  targetScope: LinkedThreadScope,
  routingReceipt: LinkedThreadRoutingReceipt,
  requestedAuthority: AgentRunAuthority,
  scopeChange: Schema.optional(LinkedThreadScopeChange),
  nestingDepth: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(LINKED_THREAD_MAX_NESTING_DEPTH),
  ),
});
export type LinkedThreadCreationRequest = typeof LinkedThreadCreationRequest.Type;

const AvailableProviderCapacity = Schema.Struct({
  status: Schema.Literal("available"),
  providerInstanceId: ProviderInstanceId,
  active: NonNegativeInt,
  limit: PositiveInt,
  remaining: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (capacity) =>
      capacity.active <= capacity.limit &&
      capacity.remaining <= capacity.limit &&
      capacity.active + capacity.remaining <= capacity.limit,
  ),
);
const UnavailableProviderCapacity = Schema.Struct({
  status: Schema.Literals(["unavailable", "stale", "exhausted"]),
  providerInstanceId: ProviderInstanceId,
});
export const LinkedThreadProviderCapacity = Schema.Union([
  AvailableProviderCapacity,
  UnavailableProviderCapacity,
]);
export type LinkedThreadProviderCapacity = typeof LinkedThreadProviderCapacity.Type;

export const LinkedThreadLimitSnapshot = Schema.Struct({
  requestedCount: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_LINKED_THREAD_TARGETS),
  ),
  nestingDepth: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(LINKED_THREAD_MAX_NESTING_DEPTH),
  ),
  activeGlobal: NonNegativeInt,
  activeForSource: NonNegativeInt,
  activeForProject: NonNegativeInt,
  activeForHost: NonNegativeInt,
  providerCapacity: LinkedThreadProviderCapacity,
});
export type LinkedThreadLimitSnapshot = typeof LinkedThreadLimitSnapshot.Type;

export const LinkedThreadCreationStatus = Schema.Literals([
  "accepted",
  "queued",
  "partial",
  "waiting",
  "failed",
  "interrupted",
]);
export type LinkedThreadCreationStatus = typeof LinkedThreadCreationStatus.Type;

export const LinkedThreadCreationReceipt = Schema.Struct({
  receiptId: LinkedThreadReceiptId,
  requestId: LinkedThreadRequestId,
  requestFingerprint: LinkedThreadRequestFingerprint,
  continuedFrom: LinkedThreadContinuedFrom,
  contextSnapshotId: LinkedThreadContextSnapshotId,
  targetThreadIds: Schema.Array(LinkedThreadTargetThreadId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_LINKED_THREAD_TARGETS),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
  createdThreadIds: Schema.Array(LinkedThreadTargetThreadId).check(
    Schema.isMaxLength(MAX_LINKED_THREAD_TARGETS),
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
  targetScope: LinkedThreadScope,
  routingReceipt: LinkedThreadRoutingReceipt,
  effectiveAuthority: AgentRunAuthority,
  transferPolicy: LinkedThreadTransferPolicy,
  scopeChange: Schema.optional(LinkedThreadScopeChange),
  nestingDepth: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(LINKED_THREAD_MAX_NESTING_DEPTH),
  ),
  status: LinkedThreadCreationStatus,
  recoveryReason: Schema.optional(BoundedReason),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).check(
  Schema.makeFilter((receipt) => {
    return (
      receipt.contextSnapshotId === receipt.continuedFrom.contextSnapshotId &&
      receipt.routingReceipt.contextSnapshotId === receipt.contextSnapshotId &&
      receipt.createdThreadIds.every((threadId) => receipt.targetThreadIds.includes(threadId)) &&
      (receipt.status !== "waiting" && receipt.status !== "interrupted"
        ? true
        : receipt.recoveryReason !== undefined)
    );
  }),
);
export type LinkedThreadCreationReceipt = typeof LinkedThreadCreationReceipt.Type;

export const LinkedThreadCreationRequested = Schema.Struct({
  request: LinkedThreadCreationRequest,
});
export type LinkedThreadCreationRequested = typeof LinkedThreadCreationRequested.Type;

export const LinkedThreadCreationReceiptRecorded = Schema.Struct({
  receipt: LinkedThreadCreationReceipt,
});
export type LinkedThreadCreationReceiptRecorded = typeof LinkedThreadCreationReceiptRecorded.Type;

export const LINKED_THREAD_EVENT_NAMES = [
  "linked.thread-creation-requested@1",
  "linked.thread-creation-receipt-recorded@1",
] as const;
export type LinkedThreadEventName = (typeof LINKED_THREAD_EVENT_NAMES)[number];

export const decodeLinkedThreadSourceThreadId = Schema.decodeUnknownSync(
  LinkedThreadSourceThreadId,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadTargetThreadId = Schema.decodeUnknownSync(
  LinkedThreadTargetThreadId,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadRequestId = Schema.decodeUnknownSync(
  LinkedThreadRequestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadContextSnapshotId = Schema.decodeUnknownSync(
  LinkedThreadContextSnapshotId,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadReceiptId = Schema.decodeUnknownSync(
  LinkedThreadReceiptId,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadScope = Schema.decodeUnknownSync(
  LinkedThreadScope,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadContextItem = Schema.decodeUnknownSync(
  LinkedThreadContextItem,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadContextSnapshot = Schema.decodeUnknownSync(
  LinkedThreadContextSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadRoutingReceipt = Schema.decodeUnknownSync(
  LinkedThreadRoutingReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadContinuedFrom = Schema.decodeUnknownSync(
  LinkedThreadContinuedFrom,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadCreationRequest = Schema.decodeUnknownSync(
  LinkedThreadCreationRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadLimitSnapshot = Schema.decodeUnknownSync(
  LinkedThreadLimitSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadCreationReceipt = Schema.decodeUnknownSync(
  LinkedThreadCreationReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadCreationRequested = Schema.decodeUnknownSync(
  LinkedThreadCreationRequested,
  STRICT_DECODE_OPTIONS,
);
export const decodeLinkedThreadCreationReceiptRecorded = Schema.decodeUnknownSync(
  LinkedThreadCreationReceiptRecorded,
  STRICT_DECODE_OPTIONS,
);
