import { createHash } from "node:crypto";
import {
  LOCAL_HOST_ID,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS,
  UtcTimestamp,
  decodeAgentRunContextSnapshotId,
  decodeMultiModelRouteSelectionRequest,
  decodeMultiModelRoutingVendorId,
  decodeProjectId,
  type AgentRunCommand,
  type AgentRunCreationPosture,
  type AgentRunCreationRequest,
  type AgentRunParentThreadId,
  type AgentRunPoolRoute,
  type AgentRunRoutingReceipt,
  type AgentRunWorkspaceReceipt,
  type MultiModelPoolCandidate,
  type MultiModelRouteDecisionReceipt,
  type OctantMode,
  type ProviderContextBlock,
  type ProviderModelCapability,
  type WorktreeReceiptId,
} from "@octant/contracts";
import { assertAgentRunSandboxEqualOrNarrower } from "@octant/domain/agent-run-policy";
import {
  resolveMultiModelRoute,
  type MultiModelCandidateRuntimeFacts,
} from "@octant/domain/multi-model-pool-policy";
import { Schema } from "effect";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export type AgentRunCreationRejectionReason =
  | "code-worktree-unsupported"
  | "code-worktree-unverified"
  | "chat-role-unsupported"
  | "code-role-unsupported"
  | "provider-not-ready"
  | "pool-request-invalid"
  | "pool-routing-unavailable"
  | "parent-context-unavailable"
  | "workspace-unsupported"
  | "stale"
  | "expired"
  | "foreign-thread"
  | "foreign-project"
  | "parent-checkout"
  | "unavailable"
  | "wider-than-parent"
  | "unconfirmed"
  | "unauthorized";

export class AgentRunCreationRejected extends Error {
  override readonly name = "AgentRunCreationRejected";
  constructor(
    readonly reason: AgentRunCreationRejectionReason,
    message: string,
  ) {
    super(message);
  }
}

export interface ProviderReadinessPort {
  readonly isReady: (input: {
    readonly providerInstanceId: string;
    readonly modelId: string;
  }) => boolean;
}

/**
 * Server-side resolution of a managed worktree receipt into an immutable,
 * verified Code child workspace. Clients supply only the receipt id; this port
 * refuses missing, non-ready, parent-checkout, or foreign-thread receipts.
 */
export interface AgentRunWorktreeReceiptPort {
  readonly resolveVerifiedIsolation: (input: {
    readonly worktreeReceiptId: WorktreeReceiptId;
    readonly parentThreadId: string;
  }) =>
    | {
        readonly projectId: string;
        readonly checkoutRoot: string;
        readonly worktreeRoot: string;
      }
    | undefined;
}

/**
 * Resolves the parent thread's own recent conversation as the bounded
 * selection a child is admitted with.
 *
 * The caller has already authorized this creation against the parent thread,
 * so this reads exactly what that principal could read and nothing else:
 * authority is never re-derived here, and the client contributes no content.
 * `undefined` means this host cannot resolve the parent's conversation, which
 * fails the creation closed rather than admitting a child with nothing.
 */
export interface AgentRunParentContextPort {
  readonly resolve: (input: {
    readonly parentThreadId: AgentRunParentThreadId;
    readonly mode: OctantMode;
  }) => ReadonlyArray<ProviderContextBlock> | undefined;
}

/**
 * Server-resolved facts required to derive one immutable pool route for a
 * child. The caller (route layer) gathers runtime facts per candidate
 * before the command is built; clients can never supply eligibility.
 */
export interface AgentRunPoolRoutingContext {
  /** The parent's current route; the mixed-vendor clamp binds children to it. */
  readonly parentCandidate: MultiModelPoolCandidate;
  readonly runtimeFacts: ReadonlyArray<MultiModelCandidateRuntimeFacts>;
  readonly requiredCapabilities?: ReadonlyArray<ProviderModelCapability>;
}

export interface BuildAgentRunRequestCommandInput {
  readonly request: AgentRunCreationRequest;
  /** Server-resolved from `AgentRunSettingsStore.current()`; never a client value. */
  readonly creationPosture: AgentRunCreationPosture;
  readonly providerReadiness: ProviderReadinessPort;
  readonly uuid: () => string;
  readonly clock?: () => string;
  readonly poolRouting?: AgentRunPoolRoutingContext;
  /**
   * Required for Code children. Absent means this host cannot verify managed
   * worktree receipts, so Code creation fails closed.
   */
  readonly worktreeReceipts?: AgentRunWorktreeReceiptPort;
  /**
   * Server-admitted journaled workspace, already checked against the live
   * parent. When present it is used as-is; Chat/Code tests may still resolve
   * a workspace through the dedicated ports below.
   */
  readonly admittedWorkspace?: AgentRunWorkspaceReceipt;
  /**
   * Required when the request asks for parent context. Absent means this host
   * cannot resolve a parent thread's conversation, so such a request fails
   * closed instead of being admitted with an empty selection.
   */
  readonly parentContext?: AgentRunParentContextPort;
}

/**
 * Builds the immutable `AgentRunRoutingReceipt` and full `request-agent-run`
 * command for an explicit, one-off child creation request.
 *
 * Chat virtual children remain research-only. Work children stay inside the
 * current Project binding. Code children require a server-verified isolated
 * worktree receipt and equal-or-narrower sandbox relative to the parent
 * checkout.
 *
 * Execution kind is always `octant-managed`: native eligibility checking
 * is not wired into this creation path yet.
 */
export function buildAgentRunRequestCommand(
  input: BuildAgentRunRequestCommandInput,
): Extract<AgentRunCommand, { kind: "request-agent-run" }> {
  const { request } = input;
  const workspaceReceipt = resolveWorkspaceReceipt(input);

  if (request.mode === "chat") {
    if (request.role !== "research") {
      throw new AgentRunCreationRejected(
        "chat-role-unsupported",
        "Chat AgentRun children are limited to the research role in this slice.",
      );
    }
  } else if (request.mode === "code") {
    if (request.role !== "implementation" && request.role !== "review") {
      throw new AgentRunCreationRejected(
        "code-role-unsupported",
        "Code AgentRun children are limited to implementation or review roles in this slice.",
      );
    }
  } else if (request.mode !== "work") {
    throw new AgentRunCreationRejected(
      "workspace-unsupported",
      "AgentRun creation supports Chat virtual, Work binding, and verified Code worktree children.",
    );
  }

  const poolRoute = resolvePoolRoute(input);

  // A waiting pool route admits the child durably without any execution, so
  // provider readiness cannot gate it; every selected route (requested or
  // explicit fallback) must still pass the readiness gate on the candidate
  // that will actually execute.
  const executionCandidate =
    poolRoute?.decision.kind === "waiting"
      ? undefined
      : poolRoute?.decision.kind === "selected"
        ? {
            providerInstanceId: String(poolRoute.decision.selectedCandidate.providerInstanceId),
            modelId: String(poolRoute.decision.selectedCandidate.modelId),
          }
        : { providerInstanceId: request.providerInstanceId, modelId: request.modelId };
  if (executionCandidate !== undefined && !input.providerReadiness.isReady(executionCandidate)) {
    throw new AgentRunCreationRejected(
      "provider-not-ready",
      "The selected provider/model is not configured and ready. Configure it before creating this child.",
    );
  }

  const effectivePermissions = {
    filesystem: request.requestedAuthority.filesystem,
    shell: request.requestedAuthority.shell,
    git: request.requestedAuthority.git,
    network: request.requestedAuthority.network,
    tools: request.requestedAuthority.tools,
    subagents: request.requestedAuthority.subagents,
  };

  const effectiveAuthorityDigest = agentRunRequestAuthorityDigest(request.requestedAuthority);
  const admittedContext = resolveAdmittedContext(input);

  const routingReceipt: AgentRunRoutingReceipt = {
    executionResolution: {
      providerInstanceId: request.providerInstanceId,
      modelId: request.modelId,
      hostId: LOCAL_HOST_ID,
      executionPolicy: request.requestedAuthority.executionPolicy,
      permissionPersistence: request.requestedAuthority.permissionPersistence,
      effectivePermissions,
      source: "one-off-override",
      fallbackChain: ["one-off-override"],
      downgradeReasons: [],
    },
    selectedExecutionKind: "octant-managed",
    attemptedExecutionKind: "octant-managed",
    selectedProviderInstanceId: request.providerInstanceId,
    selectedModelId: request.modelId,
    ...(request.reasoning === undefined
      ? {}
      : {
          rawReasoning: request.reasoning,
          normalizedReasoning: normalizeReasoning(request.reasoning),
        }),
    fallbackCandidates: [],
    ...(poolRoute?.decision.kind === "selected" && poolRoute.decision.selectionKind === "fallback"
      ? {
          selectedFallback: {
            providerInstanceId: poolRoute.decision.selectedCandidate.providerInstanceId,
            modelId: poolRoute.decision.selectedCandidate.modelId,
            reason: poolRoute.decision.reason,
          },
        }
      : {}),
    capabilityDegradations: ["native-child-agents-not-wired-in-this-slice-managed-baseline-used"],
    contextSnapshotId: decodeAgentRunContextSnapshotId(input.uuid()),
    ...(admittedContext === undefined ? {} : { admittedContextBlocks: admittedContext.length }),
    effectiveAuthorityDigest,
    usageQuality: "unavailable",
    hostId: LOCAL_HOST_ID,
    mode: request.mode,
    ...(poolRoute === undefined ? {} : { poolRoute }),
  };

  return {
    kind: "request-agent-run",
    requestId: request.requestId,
    parentThreadId: request.parentThreadId,
    ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
    role: request.role,
    task: request.task,
    creationPosture: input.creationPosture,
    requestedAuthority: request.requestedAuthority,
    routingReceipt,
    workspaceReceipt,
    // The selection travels beside the receipt, not inside it: admission
    // stores it under the receipt's snapshot id, where deleting the parent
    // thread can destroy the conversation it came from.
    ...(admittedContext === undefined ? {} : { admittedContext }),
  };
}

/**
 * The bounded parent-thread selection this child is admitted with, or
 * `undefined` when the parent selected none.
 *
 * A request that asked for parent context and cannot get it is rejected: a
 * child silently admitted with nothing would answer a question about a
 * conversation it never saw, which is the outcome the snapshot was meant to
 * prevent.
 */
function resolveAdmittedContext(
  input: BuildAgentRunRequestCommandInput,
): ReadonlyArray<ProviderContextBlock> | undefined {
  if (input.request.includeParentContext !== true) return undefined;
  const resolved = input.parentContext?.resolve({
    parentThreadId: input.request.parentThreadId,
    mode: input.request.mode,
  });
  if (resolved === undefined || resolved.length === 0) {
    throw new AgentRunCreationRejected(
      "parent-context-unavailable",
      "The parent thread's context could not be resolved for this child.",
    );
  }
  return resolved.slice(0, MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS);
}

function resolveWorkspaceReceipt(
  input: BuildAgentRunRequestCommandInput,
): AgentRunWorkspaceReceipt {
  if (input.admittedWorkspace !== undefined) {
    try {
      assertAgentRunSandboxEqualOrNarrower({ childWorkspace: input.admittedWorkspace });
    } catch {
      throw new AgentRunCreationRejected(
        input.admittedWorkspace.kind === "code-worktree"
          ? "code-worktree-unverified"
          : "wider-than-parent",
        "The admitted child workspace is not equal-or-narrower than its parent.",
      );
    }
    return input.admittedWorkspace;
  }
  const { request } = input;
  if (request.mode === "chat" && request.workspace.kind === "chat-virtual") {
    return { kind: "chat-virtual", mode: "chat" };
  }

  if (request.mode === "code" && request.workspace.kind === "code-worktree") {
    if (input.worktreeReceipts === undefined) {
      throw new AgentRunCreationRejected(
        "code-worktree-unsupported",
        "This host cannot verify managed worktree receipts for Code AgentRun children.",
      );
    }
    const resolved = input.worktreeReceipts.resolveVerifiedIsolation({
      worktreeReceiptId: request.workspace.worktreeReceiptId,
      parentThreadId: String(request.parentThreadId),
    });
    if (resolved === undefined) {
      throw new AgentRunCreationRejected(
        "code-worktree-unverified",
        "Code AgentRun children require a verified isolated worktree receipt.",
      );
    }
    const workspaceReceipt: AgentRunWorkspaceReceipt = {
      kind: "code-worktree",
      mode: "code",
      projectId: decodeProjectId(resolved.projectId),
      checkoutRoot: resolved.checkoutRoot,
      worktreeRoot: resolved.worktreeRoot,
      verified: true,
    };
    try {
      assertAgentRunSandboxEqualOrNarrower({ childWorkspace: workspaceReceipt });
    } catch {
      throw new AgentRunCreationRejected(
        "code-worktree-unverified",
        "Code AgentRun children require an equal-or-narrower isolated worktree sandbox.",
      );
    }
    return workspaceReceipt;
  }

  throw new AgentRunCreationRejected(
    "workspace-unsupported",
    "AgentRun creation supports Chat virtual, Work binding, and verified Code worktree children.",
  );
}

/**
 * A receipt retains this digest so a retry can be matched to the immutable
 * authority proposal without rebuilding a provider-ready command first.
 */
export function agentRunRequestAuthorityDigest(
  authority: AgentRunCreationRequest["requestedAuthority"],
): string {
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

/**
 * Resolves exactly one immutable pool-derived route for a child creation
 * request. The request's explicit provider/model is the pool's
 * requested candidate; eligibility comes only from server-gathered runtime
 * facts. Returns undefined when no pool was selected.
 */
function resolvePoolRoute(input: BuildAgentRunRequestCommandInput): AgentRunPoolRoute | undefined {
  const { request } = input;
  if (request.pool === undefined) return undefined;
  if (input.poolRouting === undefined) {
    throw new AgentRunCreationRejected(
      "pool-routing-unavailable",
      "A multi-model pool was selected but this host cannot resolve pool routing for children.",
    );
  }

  const requestedCandidate: MultiModelPoolCandidate = {
    hostId: LOCAL_HOST_ID,
    providerInstanceId: request.providerInstanceId,
    modelId: request.modelId,
  };
  let selectionRequest: ReturnType<typeof decodeMultiModelRouteSelectionRequest>;
  try {
    selectionRequest = decodeMultiModelRouteSelectionRequest({
      pool: request.pool,
      requestedCandidate,
      requiredCapabilities: input.poolRouting.requiredCapabilities ?? [],
    });
  } catch {
    throw new AgentRunCreationRejected(
      "pool-request-invalid",
      "The selected pool must contain the requested provider/model for this host.",
    );
  }

  const parentCandidate = input.poolRouting.parentCandidate;
  const parentFacts = input.poolRouting.runtimeFacts.find(
    (facts) =>
      String(facts.candidate.hostId) === String(parentCandidate.hostId) &&
      facts.candidate.providerInstanceId === parentCandidate.providerInstanceId &&
      facts.candidate.modelId === parentCandidate.modelId,
  );
  const decision: MultiModelRouteDecisionReceipt = resolveMultiModelRoute({
    request: selectionRequest,
    activeHostId: LOCAL_HOST_ID,
    mode: request.mode,
    parentRoutingVendorId:
      parentFacts?.routingVendorId ?? decodeMultiModelRoutingVendorId("unresolved-vendor"),
    parentCandidate,
    runtimeFacts: input.poolRouting.runtimeFacts,
  });
  const clock = input.clock ?? (() => new Date().toISOString());
  return { decision, decidedAt: decodeTimestamp(clock()) };
}

function normalizeReasoning(value: string): "off" | "low" | "medium" | "high" | "max" | "unknown" {
  switch (value) {
    case "off":
    case "low":
    case "medium":
    case "high":
    case "max":
      return value;
    default:
      return "unknown";
  }
}
