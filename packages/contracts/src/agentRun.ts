import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { MultiModelRouteDecisionReceipt } from "./multiModelPool";
import { ProjectId } from "./projects";
import {
  PermissionPersistence,
  ProviderContextBlock,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
} from "./providers";
import { HostId } from "./shell";
import { ExecutionResolutionReceipt } from "./agentProfile";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const AgentRunId = brandedUuid("AgentRunId");
export type AgentRunId = typeof AgentRunId.Type;

export const AgentRunRequestId = brandedUuid("AgentRunRequestId");
export type AgentRunRequestId = typeof AgentRunRequestId.Type;

export const AgentRunParentThreadId = brandedUuid("AgentRunParentThreadId");
export type AgentRunParentThreadId = typeof AgentRunParentThreadId.Type;

export const AgentRunContextSnapshotId = brandedUuid("AgentRunContextSnapshotId");
export type AgentRunContextSnapshotId = typeof AgentRunContextSnapshotId.Type;

/**
 * Maximum context blocks one child may be admitted with.
 *
 * A child's admitted input is its bounded task plus, at most, a bounded slice
 * of the parent conversation it was created from. The bound is small on
 * purpose: a child is given the question, not the parent's whole history, and
 * the selection is journaled with the admission, so an unbounded one would
 * grow the event journal by whatever the parent happened to hold.
 */
export const MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS = 24;

/** Maximum characters one admitted context block may carry. */
export const MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS = 4_000;

/**
 * The immutable parent-thread selection one child was admitted with.
 *
 * The blocks are the parent thread's own conversation, so they are that
 * thread's content and must be destroyable when it is permanently deleted:
 * they are written to the subject-owned AgentRun content store under the
 * admission's `contextSnapshotId`, and no event ever carries them. This schema
 * is the one boundary every admitted selection crosses before it is stored, so
 * both bounds are enforced here rather than on a journal payload.
 */
export const AgentRunAdmittedContext = Schema.Array(ProviderContextBlock).pipe(
  Schema.minItems(1),
  Schema.maxItems(MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS),
  Schema.filter((blocks) =>
    blocks.every((block) => block.text.length <= MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS),
  ),
);
export type AgentRunAdmittedContext = typeof AgentRunAdmittedContext.Type;

export const AgentRunRole = Schema.Literal("research", "implementation", "review", "custom");
export type AgentRunRole = typeof AgentRunRole.Type;

export const AgentRunCreationPosture = Schema.Literal("off", "ask", "automatic");
export type AgentRunCreationPosture = typeof AgentRunCreationPosture.Type;

export const AgentRunExecutionKind = Schema.Literal("provider-native", "octant-managed");
export type AgentRunExecutionKind = typeof AgentRunExecutionKind.Type;

export const AgentRunLifecycleStatus = Schema.Literal(
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
);
export type AgentRunLifecycleStatus = typeof AgentRunLifecycleStatus.Type;

export const AGENT_RUN_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies ReadonlyArray<AgentRunLifecycleStatus>;

export const AgentRunUsageQuality = Schema.Literal(
  "provider-reported",
  "estimated",
  "unavailable",
  "stale",
);
export type AgentRunUsageQuality = typeof AgentRunUsageQuality.Type;

export const AgentRunAuthority = Schema.Struct({
  filesystem: Schema.Boolean,
  shell: Schema.Boolean,
  git: Schema.Boolean,
  network: Schema.Boolean,
  tools: Schema.Boolean,
  subagents: Schema.Boolean,
  executionPolicy: ProviderExecutionPolicy,
  permissionPersistence: PermissionPersistence,
}).annotations(strict);
export type AgentRunAuthority = typeof AgentRunAuthority.Type;

export const AgentRunWorkspaceReceipt = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("chat-virtual"),
    mode: Schema.Literal("chat"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("work-root"),
    mode: Schema.Literal("work"),
    projectId: ProjectId,
    canonicalRoot: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("code-worktree"),
    mode: Schema.Literal("code"),
    projectId: ProjectId,
    checkoutRoot: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
    worktreeRoot: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
    verified: Schema.Boolean,
  }).annotations(strict),
);
export type AgentRunWorkspaceReceipt = typeof AgentRunWorkspaceReceipt.Type;

/**
 * Immutable pool-derived route for one accepted child AgentRun.
 * Recorded exactly once when the child is admitted; restart, replay, and
 * recovery preserve the original decision and routing reason unchanged.
 */
export const AgentRunPoolRoute = Schema.Struct({
  decision: MultiModelRouteDecisionReceipt,
  decidedAt: UtcTimestamp,
}).annotations(strict);
export type AgentRunPoolRoute = typeof AgentRunPoolRoute.Type;

export const AgentRunRoutingReceipt = Schema.Struct({
  executionResolution: ExecutionResolutionReceipt,
  selectedExecutionKind: AgentRunExecutionKind,
  attemptedExecutionKind: AgentRunExecutionKind,
  selectedProviderInstanceId: ProviderInstanceId,
  selectedModelId: ProviderModelId,
  rawReasoning: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  normalizedReasoning: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  fallbackCandidates: Schema.Array(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      modelId: ProviderModelId,
      rejectedReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
    }).annotations(strict),
  ),
  selectedFallback: Schema.optional(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      modelId: ProviderModelId,
      reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
    }).annotations(strict),
  ),
  capabilityDegradations: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  contextSnapshotId: AgentRunContextSnapshotId,
  /**
   * How many parent-thread blocks were admitted under `contextSnapshotId`.
   *
   * The blocks themselves are the parent's conversation, so they cannot ride
   * in this journaled payload: deleting that thread has to destroy them. They
   * are stored under `contextSnapshotId` instead — the id recorded here is the
   * primary key of the very record that holds them, so execution still
   * verifies the selection it resolves against the admission that authorized
   * it, and still resolves it from this run's own immutable receipt.
   *
   * Absent means the parent selected no context, which is not the same as a
   * selection that could not be resolved: admission refuses that outright
   * rather than recording an empty one. Present with no stored blocks means
   * the parent thread was deleted, and execution fails closed rather than
   * running a child under less context than it was approved for.
   */
  admittedContextBlocks: Schema.optional(
    Schema.Int.pipe(
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS),
    ),
  ),
  effectiveAuthorityDigest: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  capacityReservationId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  usageQuality: AgentRunUsageQuality,
  hostId: HostId,
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
  poolRoute: Schema.optional(AgentRunPoolRoute),
})
  .annotations(strict)
  .pipe(
    Schema.filter((receipt) => {
      if (receipt.poolRoute === undefined) return true;
      const decision = receipt.poolRoute.decision;
      const requested = decision.request.requestedCandidate ?? decision.request.pool.candidates[0]!;
      // The receipt primary selection is the immutable pool-requested
      // candidate; the pool decision may not be re-scoped to another host,
      // mode, or primary provider/model.
      const primaryMatches =
        String(requested.hostId) === String(receipt.hostId) &&
        requested.providerInstanceId === receipt.selectedProviderInstanceId &&
        requested.modelId === receipt.selectedModelId;
      const scopeMatches =
        decision.mode === receipt.mode && String(decision.activeHostId) === String(receipt.hostId);
      if (!primaryMatches || !scopeMatches) return false;
      if (decision.kind === "waiting" || decision.selectionKind === "requested") {
        return receipt.selectedFallback === undefined;
      }
      // A pool fallback route must surface the explicit fallback it selected.
      return (
        receipt.selectedFallback !== undefined &&
        receipt.selectedFallback.providerInstanceId ===
          decision.selectedCandidate.providerInstanceId &&
        receipt.selectedFallback.modelId === decision.selectedCandidate.modelId
      );
    }),
  );
export type AgentRunRoutingReceipt = typeof AgentRunRoutingReceipt.Type;

/**
 * Maximum persisted characters of a completed AgentRun reply.
 *
 * A child reply is untrusted provider output appended to an append-only
 * journal, so it is bounded before it is recorded. The bound stays below the
 * managed session's own response accumulation cap, so a reply long enough to
 * hit that cap is always recorded as truncated rather than silently shortened.
 */
export const MAX_AGENT_RUN_RESULT_CHARACTERS = 16_384;

/**
 * The reply text a completed AgentRun produced.
 *
 * A child answers a question about its parent thread's conversation, so its
 * reply is that thread's content: it is written to the subject-owned AgentRun
 * content store under the completion's `reference`, never into an event, so a
 * permanent thread deletion can destroy it. This schema is the one boundary
 * every stored reply crosses, so the bound is enforced here.
 */
export const AgentRunResultText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_AGENT_RUN_RESULT_CHARACTERS),
);
export type AgentRunResultText = typeof AgentRunResultText.Type;

/**
 * The recorded identity of a completed AgentRun reply.
 *
 * Completed is honest only when the reply the child produced is durable, so
 * this identity is journaled with the completion itself and replay rebuilds it
 * for whoever can already read the run. `reference` is the stable identity of
 * the stored reply — the primary key of the record that holds the text — and
 * `truncated` records that the stored text is a bounded prefix of a longer one.
 * The text is deliberately absent: it is stored, not journaled, and a run whose
 * parent thread was deleted keeps this identity with nothing behind it.
 */
export const AgentRunResult = Schema.Struct({
  reference: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048)),
  truncated: Schema.Boolean,
}).annotations(strict);
export type AgentRunResult = typeof AgentRunResult.Type;

export const AgentRunResultAcknowledgement = Schema.Struct({
  required: Schema.Boolean,
  acknowledged: Schema.Boolean,
  acknowledgedAt: Schema.optional(UtcTimestamp),
  followUpReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
}).annotations(strict);
export type AgentRunResultAcknowledgement = typeof AgentRunResultAcknowledgement.Type;

export const AgentRun = Schema.Struct({
  id: AgentRunId,
  requestId: AgentRunRequestId,
  parentThreadId: AgentRunParentThreadId,
  parentRunId: Schema.optional(AgentRunId),
  depth: Schema.Int.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(2)),
  role: AgentRunRole,
  task: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8192)),
  creationPosture: AgentRunCreationPosture,
  executionKind: AgentRunExecutionKind,
  lifecycleStatus: AgentRunLifecycleStatus,
  authority: AgentRunAuthority,
  routingReceipt: AgentRunRoutingReceipt,
  workspaceReceipt: AgentRunWorkspaceReceipt,
  resultAcknowledgement: AgentRunResultAcknowledgement,
  /** Present only once the run completed with a persisted reply. */
  result: Schema.optional(AgentRunResult),
  recoveryReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type AgentRun = typeof AgentRun.Type;

export const AgentRunCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("request-agent-run"),
    requestId: AgentRunRequestId,
    parentThreadId: AgentRunParentThreadId,
    parentRunId: Schema.optional(AgentRunId),
    role: AgentRunRole,
    task: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8192)),
    creationPosture: AgentRunCreationPosture,
    requestedAuthority: AgentRunAuthority,
    routingReceipt: AgentRunRoutingReceipt,
    workspaceReceipt: AgentRunWorkspaceReceipt,
    /**
     * The parent-thread selection to store under the receipt's
     * `contextSnapshotId`. Server-resolved from the parent thread the caller
     * was already authorized against; a client never supplies context. Present
     * exactly when the receipt records `admittedContextBlocks`.
     */
    admittedContext: Schema.optional(AgentRunAdmittedContext),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("confirm-agent-run"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("start-agent-run"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("mark-agent-run-running"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("wait-agent-run"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
    recoveryReason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("complete-agent-run"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
    result: AgentRunResult,
    /** Stored under `result.reference`; never journaled with the completion. */
    resultText: AgentRunResultText,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("fail-agent-run"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
    recoveryReason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cancel-agent-run"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
    scope: Schema.Literal("self", "subtree", "hierarchy"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("interrupt-agent-run"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
    recoveryReason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("acknowledge-agent-run-result"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
);
export type AgentRunCommand = typeof AgentRunCommand.Type;

export const AgentRunCommandResult = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("run-accepted"), run: AgentRun }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("run-updated"), run: AgentRun }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("run-command-failed"),
    reason: Schema.Literal(
      "invalid",
      "stale-version",
      "unauthorized",
      "limit-reached",
      "unsupported-transition",
      "posture-rejected",
      "authority-widening",
      "fallback-forbidden",
    ),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type AgentRunCommandResult = typeof AgentRunCommandResult.Type;

export const AgentRunRequested = Schema.Struct({
  run: AgentRun,
}).annotations(strict);
export type AgentRunRequested = typeof AgentRunRequested.Type;

export const AgentRunStatusChanged = Schema.Struct({
  runId: AgentRunId,
  fromStatus: AgentRunLifecycleStatus,
  toStatus: AgentRunLifecycleStatus,
  version: AggregateVersion,
  recoveryReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  /**
   * The identity of the reply a completion carries. It travels in the same
   * append as the status change, so a journal that records Completed always
   * records the result that completion claims — and the reply text is written
   * to the AgentRun content store by that same transaction.
   */
  result: Schema.optional(AgentRunResult),
}).annotations(strict);
export type AgentRunStatusChanged = typeof AgentRunStatusChanged.Type;

export const AgentRunResultAcknowledged = Schema.Struct({
  runId: AgentRunId,
  version: AggregateVersion,
  acknowledgedAt: UtcTimestamp,
}).annotations(strict);
export type AgentRunResultAcknowledged = typeof AgentRunResultAcknowledged.Type;

export const AGENT_RUN_EVENT_NAMES = [
  "agent.run-requested@1",
  "agent.run-status-changed@1",
  "agent.run-result-acknowledged@1",
] as const;
export type AgentRunEventName = (typeof AGENT_RUN_EVENT_NAMES)[number];

export const decodeAgentRunId = Schema.decodeUnknownSync(AgentRunId);
export const decodeAgentRunRequestId = Schema.decodeUnknownSync(AgentRunRequestId);
export const decodeAgentRunParentThreadId = Schema.decodeUnknownSync(AgentRunParentThreadId);
export const decodeAgentRunContextSnapshotId = Schema.decodeUnknownSync(AgentRunContextSnapshotId);
export const decodeAgentRunRole = Schema.decodeUnknownSync(AgentRunRole);
export const decodeAgentRunCreationPosture = Schema.decodeUnknownSync(AgentRunCreationPosture);
export const decodeAgentRunExecutionKind = Schema.decodeUnknownSync(AgentRunExecutionKind);
export const decodeAgentRunLifecycleStatus = Schema.decodeUnknownSync(AgentRunLifecycleStatus);
export const decodeAgentRunAuthority = Schema.decodeUnknownSync(AgentRunAuthority);
export const decodeAgentRunWorkspaceReceipt = Schema.decodeUnknownSync(AgentRunWorkspaceReceipt);
export const decodeAgentRunPoolRoute = Schema.decodeUnknownSync(AgentRunPoolRoute);
export const decodeAgentRunRoutingReceipt = Schema.decodeUnknownSync(AgentRunRoutingReceipt);
export const decodeAgentRunResult = Schema.decodeUnknownSync(AgentRunResult);
export const decodeAgentRunResultText = Schema.decodeUnknownSync(AgentRunResultText);
export const decodeAgentRunAdmittedContext = Schema.decodeUnknownSync(AgentRunAdmittedContext);
export const decodeAgentRunResultAcknowledgement = Schema.decodeUnknownSync(
  AgentRunResultAcknowledgement,
);
export const decodeAgentRun = Schema.decodeUnknownSync(AgentRun);
export const decodeAgentRunCommand = Schema.decodeUnknownSync(AgentRunCommand);
export const decodeAgentRunCommandResult = Schema.decodeUnknownSync(AgentRunCommandResult);
export const decodeAgentRunRequested = Schema.decodeUnknownSync(AgentRunRequested);
export const decodeAgentRunStatusChanged = Schema.decodeUnknownSync(AgentRunStatusChanged);
export const decodeAgentRunResultAcknowledged = Schema.decodeUnknownSync(
  AgentRunResultAcknowledged,
);
