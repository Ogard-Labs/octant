import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { AggregateVersion, UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { MultiModelRouteDecisionReceipt } from "./multiModelPool";
import { BindingRevisionId, ProjectId } from "./projects";
import {
  PermissionPersistence,
  ProviderContextBlock,
  ProviderChildActivityEvent,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
  ProviderUsageLimit,
} from "./providers";
import { HostId } from "./host";
import { UsageResumeThreadState } from "./usageResume";
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
 * Server-issued handle for a prepared Chat or Work child workspace.
 *
 * Code children keep using `WorktreeReceiptId` from the managed worktree
 * store. This id never carries a filesystem path; the server resolves the
 * bound root at admission.
 */
export const AgentRunWorkspaceReceiptId = brandedUuid("AgentRunWorkspaceReceiptId");
export type AgentRunWorkspaceReceiptId = typeof AgentRunWorkspaceReceiptId.Type;

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

/**
 * `ask` is no longer a choice a person can make: it meant "only when I start
 * them", and nobody starts a subagent by hand any more. It stays in this
 * literal because journaled settings and AgentRun requests recorded it, and
 * replay must still decode them; the settings store reads it back as `off`.
 */
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

/** Token counts a provider actually reported for this run. Absent when unknown. */
export const AgentRunTokenUsage = Schema.Struct({
  inputTokens: Schema.Int.pipe(Schema.nonNegative()),
  outputTokens: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type AgentRunTokenUsage = typeof AgentRunTokenUsage.Type;

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
    bindingRevisionId: BindingRevisionId,
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
 * Why a child workspace prepare, confirm, or admission step refused.
 *
 * These are expected failures a caller must handle. They never include
 * filesystem paths: the renderer only learns that the receipt is unusable.
 */
export const AgentRunWorkspaceRefusalReason = Schema.Literal(
  "unauthorized",
  "unavailable",
  "stale",
  "expired",
  "foreign-thread",
  "foreign-project",
  "parent-checkout",
  "wider-than-parent",
  "unconfirmed",
  "unsupported",
);
export type AgentRunWorkspaceRefusalReason = typeof AgentRunWorkspaceRefusalReason.Type;

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
export const AgentRunResultEvidence = Schema.Struct({
  files: Schema.Struct({
    reviewStatus: Schema.optional(Schema.Literal("unavailable")),
    status: Schema.Literal("recorded", "unavailable", "truncated"),
    items: Schema.Array(
      Schema.Struct({
        path: Schema.NonEmptyString.pipe(Schema.maxLength(2048)),
        change: Schema.Literal("created", "modified", "deleted"),
        reference: Schema.NonEmptyString.pipe(Schema.maxLength(2048)),
        source: Schema.Literal("provider-reported"),
        verified: Schema.Literal(false),
      }).annotations(strict),
    ).pipe(Schema.maxItems(32)),
  }).annotations(strict),
  checks: Schema.Struct({
    status: Schema.Literal("recorded", "unavailable", "truncated"),
    items: Schema.Array(
      Schema.Struct({
        label: Schema.NonEmptyString.pipe(Schema.maxLength(512)),
        outcome: Schema.Literal("passed", "failed", "unknown"),
        reference: Schema.NonEmptyString.pipe(Schema.maxLength(2048)),
        source: Schema.Literal("host-recorded"),
        toolExecution: Schema.optional(
          Schema.Struct({
            toolName: Schema.NonEmptyString.pipe(Schema.maxLength(255)),
            requestId: Schema.NonEmptyString.pipe(Schema.maxLength(255)),
            isError: Schema.Boolean,
            output: Schema.String.pipe(Schema.maxLength(2048)),
            truncated: Schema.Boolean,
          }).annotations(strict),
        ),
      }).annotations(strict),
    ).pipe(Schema.maxItems(32)),
  }).annotations(strict),
}).annotations(strict);
export type AgentRunResultEvidence = typeof AgentRunResultEvidence.Type;
export const decodeAgentRunResultEvidence = Schema.decodeUnknownSync(AgentRunResultEvidence);

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

/**
 * Bounds one parent wake to the results already finished. Legacy marks name
 * one run; batches include their primary run exactly once. Generation-less
 * marks cover generation 1 only, so a resumed child can deliver a new result.
 */
export const MAX_AGENT_RUN_RESULT_DELIVERY_BATCH_SIZE = 16;
export const AgentRunResultDeliveryRunIds = Schema.Array(AgentRunId).pipe(
  Schema.minItems(1),
  Schema.maxItems(MAX_AGENT_RUN_RESULT_DELIVERY_BATCH_SIZE),
  Schema.filter((ids) => new Set(ids.map(String)).size === ids.length),
);

export const AgentRunResultDeliveryGeneration = Schema.Struct({
  runId: AgentRunId,
  generation: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
}).annotations(strict);
export const AgentRunResultDeliveryGenerations = Schema.Array(
  AgentRunResultDeliveryGeneration,
).pipe(Schema.minItems(1), Schema.maxItems(MAX_AGENT_RUN_RESULT_DELIVERY_BATCH_SIZE));

export const AgentRunResultDeliveryMark = Schema.Struct({
  kind: Schema.Literal("agent-result"),
  runId: AgentRunId,
  runIds: Schema.optional(AgentRunResultDeliveryRunIds),
  runGenerations: Schema.optional(AgentRunResultDeliveryGenerations),
})
  .annotations(strict)
  .pipe(
    Schema.filter((mark) => {
      const ids = mark.runIds ?? [mark.runId];
      return (
        ids.some((id) => String(id) === String(mark.runId)) &&
        (mark.runGenerations === undefined ||
          (mark.runGenerations.length === ids.length &&
            new Set(mark.runGenerations.map((member) => String(member.runId))).size ===
              ids.length &&
            mark.runGenerations.every((member) =>
              ids.some((id) => String(id) === String(member.runId)),
            )))
      );
    }),
  );
export type AgentRunResultDeliveryMark = typeof AgentRunResultDeliveryMark.Type;

/**
 * How the host settled one finished run's result delivery. `delivered` means
 * a journaled turn now carries the result into the parent thread; `consumed`
 * means the parent's own managed tool already returned it; `invalidated`
 * means the parent could no longer take a turn; `failed` means delivery was
 * refused, with the reason kept in `detail`.
 */
export const AgentRunResultDeliveryOutcome = Schema.Literal(
  "delivered",
  "consumed",
  "invalidated",
  "failed",
);
export type AgentRunResultDeliveryOutcome = typeof AgentRunResultDeliveryOutcome.Type;

export const AgentRunResultDelivery = Schema.Struct({
  outcome: AgentRunResultDeliveryOutcome,
  detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  settledAt: UtcTimestamp,
}).annotations(strict);
export type AgentRunResultDelivery = typeof AgentRunResultDelivery.Type;

/**
 * Sibling runs a run waits for, under the same parent thread. The host starts
 * the run only once every one of them completed, hands it their results, and
 * fails it without running when any of them failed, was cancelled, or was
 * interrupted. Existing runs only, so a cycle cannot be expressed.
 */
export const MAX_AGENT_RUN_DEPENDENCIES = 8;
export const AgentRunDependencies = Schema.Array(AgentRunId).pipe(
  Schema.minItems(1),
  Schema.maxItems(MAX_AGENT_RUN_DEPENDENCIES),
  Schema.filter((ids) => new Set(ids.map(String)).size === ids.length, {
    message: () => "AgentRun dependencies must be distinct",
  }),
);
export type AgentRunDependencies = typeof AgentRunDependencies.Type;

export const AgentRun = Schema.Struct({
  id: AgentRunId,
  /** Absent on legacy runs, which belong to generation 1. */
  generation: Schema.optional(
    Schema.Int.pipe(
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
  requestId: AgentRunRequestId,
  parentThreadId: AgentRunParentThreadId,
  parentRunId: Schema.optional(AgentRunId),
  /** Optional so runs journaled before dependencies existed replay unchanged. */
  dependsOn: Schema.optional(AgentRunDependencies),
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
  /**
   * Present once the host settled how this run's result reached its parent —
   * as a journaled turn, through the parent's own tool call, or honestly
   * refused. Absent means a finished run's delivery is still owed.
   */
  resultDelivery: Schema.optional(AgentRunResultDelivery),
  /** Present only when a provider reported token usage for this run. */
  usage: Schema.optional(AgentRunTokenUsage),
  recoveryReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  /**
   * The provider's own limit signal, journaled verbatim when the run's
   * session stopped on a usage limit. Present only while that limit-bound
   * wait describes the run — a transition out of it drops the fact the way it
   * drops the recovery reason.
   */
  usageLimit: Schema.optional(ProviderUsageLimit),
  /**
   * The latest reset recovery a person opted this run into, as its
   * `usage-resume.*@1` events last settled it on this aggregate.
   */
  usageResume: Schema.optional(UsageResumeThreadState),
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
    dependsOn: Schema.optional(AgentRunDependencies),
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
    /** The provider's own limit signal when this wait is a usage-limit stop. */
    usageLimit: Schema.optional(ProviderUsageLimit),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("complete-agent-run"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
    result: AgentRunResult,
    /** Stored under `result.reference`; never journaled with the completion. */
    resultText: AgentRunResultText,
    resultEvidence: Schema.optional(AgentRunResultEvidence),
    usage: Schema.optional(AgentRunTokenUsage),
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
  /**
   * Journals how a finished run's result reached its parent. Written once per
   * result generation, only after the delivery actually happened — a turn carrying it, the
   * parent's tool returning it, or a refused/invalidated outcome — so a
   * restarted host can tell an owed delivery from a settled one.
   */
  Schema.Struct({
    kind: Schema.Literal("settle-agent-run-result-delivery"),
    runId: AgentRunId,
    /** Omission names generation 1, never the latest generation. */
    generation: Schema.optional(
      Schema.Int.pipe(
        Schema.greaterThanOrEqualTo(1),
        Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
      ),
    ),
    expectedVersion: AggregateVersion,
    outcome: AgentRunResultDeliveryOutcome,
    detail: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("retry-agent-run"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("resume-agent-run"),
    runId: AgentRunId,
    message: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  /**
   * The person's own opt-in to resume this limited run at the provider's
   * declared reset. The record it journals derives from the run's stored
   * limit fact, never from client-supplied fields, so the command carries
   * only the run it binds to.
   */
  Schema.Struct({
    kind: Schema.Literal("schedule-agent-run-usage-resume"),
    runId: AgentRunId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cancel-agent-run-usage-resume"),
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
  generation: Schema.optional(
    Schema.Int.pipe(
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
  fromStatus: AgentRunLifecycleStatus,
  toStatus: AgentRunLifecycleStatus,
  version: AggregateVersion,
  recoveryReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  /** The provider's own limit signal; present only on a usage-limit wait. */
  usageLimit: Schema.optional(ProviderUsageLimit),
  /**
   * The identity of the reply a completion carries. It travels in the same
   * append as the status change, so a journal that records Completed always
   * records the result that completion claims — and the reply text is written
   * to the AgentRun content store by that same transaction.
   */
  result: Schema.optional(AgentRunResult),
  /** Provider-reported token counts; present only on honest completions. */
  usage: Schema.optional(AgentRunTokenUsage),
}).annotations(strict);
export type AgentRunStatusChanged = typeof AgentRunStatusChanged.Type;

export const AgentRunResultAcknowledged = Schema.Struct({
  runId: AgentRunId,
  version: AggregateVersion,
  acknowledgedAt: UtcTimestamp,
}).annotations(strict);
export type AgentRunResultAcknowledged = typeof AgentRunResultAcknowledged.Type;

export const AgentRunResultDeliverySettled = Schema.Struct({
  runId: AgentRunId,
  version: AggregateVersion,
  delivery: AgentRunResultDelivery,
}).annotations(strict);
export type AgentRunResultDeliverySettled = typeof AgentRunResultDeliverySettled.Type;

/** Maximum rows one Agents Center query may return in a single page. */
export const MAX_AGENT_RUN_CENTER_QUERY_LIMIT = 100;

export const MAX_AGENT_RUN_CENTER_QUERY_CURSOR_LENGTH = 256;

export const AgentRunCenterStatusFilter = Schema.Literal("all", "active", "history");
export type AgentRunCenterStatusFilter = typeof AgentRunCenterStatusFilter.Type;

export const AgentRunCenterWorkspaceKind = Schema.Literal(
  "chat-virtual",
  "work-root",
  "code-worktree",
);
export type AgentRunCenterWorkspaceKind = typeof AgentRunCenterWorkspaceKind.Type;

export const AgentRunCenterRoute = Schema.Struct({
  requestedProviderInstanceId: ProviderInstanceId,
  requestedModelId: ProviderModelId,
  executionProviderInstanceId: ProviderInstanceId,
  executionModelId: ProviderModelId,
  poolDerived: Schema.Boolean,
  selectionKind: Schema.optional(Schema.Literal("requested", "fallback")),
  routingReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
}).annotations(strict);
export type AgentRunCenterRoute = typeof AgentRunCenterRoute.Type;

export const AgentRunCenterSummary = Schema.Struct({
  runId: AgentRunId,
  requestId: AgentRunRequestId,
  parentThreadId: AgentRunParentThreadId,
  parentThreadTitle: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  parentRunId: Schema.optional(AgentRunId),
  /** Present for Code child runs that occupy an isolated worktree thread. */
  childThreadId: Schema.optional(CodeThreadId),
  mode: OctantMode,
  projectId: Schema.optional(ProjectId),
  role: AgentRunRole,
  task: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8192)),
  lifecycleStatus: AgentRunLifecycleStatus,
  executionKind: AgentRunExecutionKind,
  authority: AgentRunAuthority,
  workspaceKind: AgentRunCenterWorkspaceKind,
  usageQuality: AgentRunUsageQuality,
  route: AgentRunCenterRoute,
  resultAcknowledgement: AgentRunResultAcknowledgement,
  recoveryReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  normalizedReasoning: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  usage: Schema.optional(AgentRunTokenUsage),
  usageLimit: Schema.optional(ProviderUsageLimit),
  usageResume: Schema.optional(UsageResumeThreadState),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type AgentRunCenterSummary = typeof AgentRunCenterSummary.Type;

export const AgentRunCenterQuery = Schema.Struct({
  status: AgentRunCenterStatusFilter,
  mode: Schema.Literal("all", "chat", "work", "code"),
  projectId: Schema.optional(ProjectId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  parentThreadId: Schema.optional(AgentRunParentThreadId),
  search: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  limit: Schema.Int.pipe(
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(MAX_AGENT_RUN_CENTER_QUERY_LIMIT),
  ),
  cursor: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_AGENT_RUN_CENTER_QUERY_CURSOR_LENGTH)),
  ),
}).annotations(strict);
export type AgentRunCenterQuery = typeof AgentRunCenterQuery.Type;

export const AgentRunCenterResponse = Schema.Struct({
  items: Schema.Array(AgentRunCenterSummary).pipe(
    Schema.maxItems(MAX_AGENT_RUN_CENTER_QUERY_LIMIT),
  ),
  nextCursor: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_AGENT_RUN_CENTER_QUERY_CURSOR_LENGTH)),
  ),
}).annotations(strict);
export type AgentRunCenterResponse = typeof AgentRunCenterResponse.Type;

/**
 * Ephemeral child-conversation read limits. Live text is a server snapshot,
 * not journal content; these bounds keep a reconnect or a hostile provider
 * from turning a small Environment disclosure into an unbounded stream.
 */
export const MAX_AGENT_RUN_CONVERSATION_ENTRIES = 128;
export const MAX_AGENT_RUN_CONVERSATION_ENTRY_CHARACTERS = 4_096;
export const MAX_AGENT_RUN_CONVERSATION_BYTES = 32 * 1024;
export const MAX_AGENT_RUN_CONVERSATION_CURSOR_LENGTH = 64;
/** Maximum encoded line size for one bounded conversation stream frame. */
export const MAX_AGENT_RUN_CONVERSATION_NDJSON_LINE_BYTES = 64 * 1024;

export const AgentRunConversationReadStatus = Schema.Literal(
  "live",
  "complete",
  "stale",
  "unavailable",
);
export type AgentRunConversationReadStatus = typeof AgentRunConversationReadStatus.Type;

export const AgentRunConversationEntry = Schema.Struct({
  childActivity: Schema.optional(ProviderChildActivityEvent),
  generation: Schema.optional(Schema.Int.pipe(Schema.positive())),
  sequence: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  kind: Schema.Literal("assistant", "status"),
  text: Schema.String.pipe(Schema.maxLength(MAX_AGENT_RUN_CONVERSATION_ENTRY_CHARACTERS)),
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type AgentRunConversationEntry = typeof AgentRunConversationEntry.Type;

const AgentRunConversationFields = {
  runId: AgentRunId,
  parentThreadId: AgentRunParentThreadId,
  executionKind: AgentRunExecutionKind,
  modelId: ProviderModelId,
  lifecycleStatus: AgentRunLifecycleStatus,
  status: AgentRunConversationReadStatus,
  entries: Schema.Array(AgentRunConversationEntry).pipe(
    Schema.maxItems(MAX_AGENT_RUN_CONVERSATION_ENTRIES),
  ),
  truncated: Schema.Boolean,
  nextCursor: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_AGENT_RUN_CONVERSATION_CURSOR_LENGTH)),
  ),
  staleReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
} as const;

export const AgentRunConversationResponse = Schema.Struct(AgentRunConversationFields).annotations(
  strict,
);
export type AgentRunConversationResponse = typeof AgentRunConversationResponse.Type;

/**
 * One authenticated NDJSON frame from the process-local managed-child
 * conversation stream. The first frame is a complete bounded snapshot;
 * subsequent delta frames contain only entries after the caller's cursor and
 * may carry a terminal/stale status with no entries.
 */
export const AgentRunConversationStreamFrame = Schema.Struct({
  kind: Schema.Literal("snapshot", "delta"),
  ...AgentRunConversationFields,
}).annotations(strict);
export type AgentRunConversationStreamFrame = typeof AgentRunConversationStreamFrame.Type;

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
export const decodeAgentRunWorkspaceReceiptId = Schema.decodeUnknownSync(
  AgentRunWorkspaceReceiptId,
);
export const decodeAgentRunWorkspaceRefusalReason = Schema.decodeUnknownSync(
  AgentRunWorkspaceRefusalReason,
);
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
export const decodeAgentRunResultDeliverySettled = Schema.decodeUnknownSync(
  AgentRunResultDeliverySettled,
);
export const decodeAgentRunResultAcknowledged = Schema.decodeUnknownSync(
  AgentRunResultAcknowledged,
);
export const decodeAgentRunCenterStatusFilter = Schema.decodeUnknownSync(
  AgentRunCenterStatusFilter,
);
export const decodeAgentRunCenterWorkspaceKind = Schema.decodeUnknownSync(
  AgentRunCenterWorkspaceKind,
);
export const decodeAgentRunCenterRoute = Schema.decodeUnknownSync(AgentRunCenterRoute);
export const decodeAgentRunCenterSummary = Schema.decodeUnknownSync(AgentRunCenterSummary);
export const decodeAgentRunCenterQuery = Schema.decodeUnknownSync(AgentRunCenterQuery);
export const decodeAgentRunCenterResponse = Schema.decodeUnknownSync(AgentRunCenterResponse);
export const decodeAgentRunConversationReadStatus = Schema.decodeUnknownSync(
  AgentRunConversationReadStatus,
);
export const decodeAgentRunConversationEntry = Schema.decodeUnknownSync(AgentRunConversationEntry);
export const decodeAgentRunConversationResponse = Schema.decodeUnknownSync(
  AgentRunConversationResponse,
);
export const decodeAgentRunConversationStreamFrame = Schema.decodeUnknownSync(
  AgentRunConversationStreamFrame,
);
