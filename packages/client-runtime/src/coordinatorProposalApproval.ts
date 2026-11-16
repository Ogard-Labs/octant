import {
  decodeCodeCommand,
  decodeCodeOperationCommand,
  type CodeCommand,
  type CodeCommandResult,
  type CodeEvidenceReference,
  type CodeOperationCommand,
  type CodeOperationResult,
  type CodePlannerProposalCommand,
  type CodePlannerProposalOutcome,
  type CodePlannerView,
  type CodeThread,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import { defaultDeliveryBranchIntent } from "@octant/domain";

/** One pending proposal as the planner view returns it, with the version a decision echoes. */
export type CoordinatorProposalEntry = CodePlannerView["proposals"][number];

/**
 * The host calls a decision needs. The paired browser passes its Code client;
 * the phone passes the same calls over its remote session. The worker's first
 * turn is started here through these calls, never through a controller that
 * drives the thread the person has selected: that controller's turn state is
 * the coordinator's, which would then read as running and refuse its sends.
 */
export interface CoordinatorProposalDecisionPort {
  readonly execute: (command: CodeCommand) => Promise<CodeCommandResult | undefined>;
  readonly executePlannerProposal: (
    command: CodePlannerProposalCommand,
  ) => Promise<CodePlannerProposalOutcome>;
  readonly putEvidence: (
    threadId: CodeThread["id"],
    text: string,
  ) => Promise<CodeEvidenceReference>;
  readonly executeOperation: (command: CodeOperationCommand) => Promise<CodeOperationResult>;
}

/**
 * `approved`: the worker exists and its first turn is running.
 * `not-started`: the worker exists but its first turn did not start (refused,
 * failed, interrupted or lost); the person opens it to retry.
 */
export type CoordinatorProposalApproval =
  | { readonly status: "approved"; readonly thread: CodeThread }
  | { readonly status: "not-started"; readonly thread: CodeThread; readonly message: string }
  | { readonly status: "refused"; readonly message: string };

/**
 * The level an approval from a paired client starts the worker at: the one
 * the coordinator asked for, never higher, since the host refuses a level
 * above it. A proposal that asked for no level starts at Ask first.
 */
export function coordinatorProposalLevel(entry: CoordinatorProposalEntry): ProviderExecutionPolicy {
  return entry.proposal.workerOptions?.executionPolicy ?? "approval-gated";
}

/**
 * Approve a coordinator's proposed worker from a device the host's own person
 * paired, as the coordinator's own start would have made it: a new managed
 * worktree in the coordinator's Project, from the coordinator's base branch,
 * on the provider and model the proposal names (else the coordinator's), at
 * the level it asked for. The host confirms the proposal and creates the
 * thread in one versioned command and journals the device as the actor, and
 * the proposal's request is then sent as the worker's first message.
 *
 * A paired client has no creation review, so it offers only what was asked;
 * choosing another provider, checkout or lower level stays with the review at
 * a window on the host.
 */
export async function approveCoordinatorProposal(input: {
  readonly port: CoordinatorProposalDecisionPort;
  readonly entry: CoordinatorProposalEntry;
  readonly coordinator: CodeThread;
  readonly uuid?: () => string;
  readonly now?: () => Date;
}): Promise<CoordinatorProposalApproval> {
  const { entry, coordinator } = input;
  const { proposal } = entry;
  if (
    proposal.status !== "pending" ||
    proposal.fromCoordinator !== true ||
    String(proposal.plannerThreadId) !== String(coordinator.id) ||
    String(proposal.projectId) !== String(coordinator.projectId)
  ) {
    return {
      status: "refused",
      message: "This proposal is no longer waiting in this coordinator. Refresh before deciding.",
    };
  }
  const prepared = await input.port.execute(
    decodeCodeCommand({ kind: "prepare-code-project-checkout", projectId: proposal.projectId }),
  );
  if (prepared?.kind !== "checkout-prepared") {
    return { status: "refused", message: "The host could not prepare the Project's checkout." };
  }
  const threadId = (input.uuid ?? (() => globalThis.crypto.randomUUID()))();
  // A worker starts from the base branch on a branch of its own; the
  // coordinator's own open outcome proposal stays with the coordinator.
  const { proposedOutcome: _proposal, ...deliveryTarget } = coordinator.deliveryTarget;
  const requested = proposal.workerOptions;
  const named =
    requested?.providerInstanceId !== undefined && requested.modelId !== undefined
      ? { providerInstanceId: requested.providerInstanceId, modelId: requested.modelId }
      : { providerInstanceId: coordinator.providerInstanceId, modelId: coordinator.modelId };
  let creation: CodeCommand;
  try {
    creation = decodeCodeCommand({
      kind: "create-managed-code-thread",
      threadId,
      projectId: proposal.projectId,
      bindingRevisionId: prepared.bindingRevisionId,
      title: proposal.title,
      ...named,
      executionPolicy: coordinatorProposalLevel(entry),
      permissionPersistence: "current-session",
      deliveryTarget: {
        ...deliveryTarget,
        branchIntent: defaultDeliveryBranchIntent(
          deliveryTarget.proposedBaseBranch,
          threadId.replace(/-/g, "").slice(0, 12),
        ),
        confirmedAt: (input.now ?? (() => new Date()))().toISOString(),
      },
      sourceBranch: deliveryTarget.proposedBaseBranch,
      startFromOrigin: false,
      ...(deliveryTarget.remoteName === undefined ? {} : { remoteName: deliveryTarget.remoteName }),
    });
  } catch {
    return { status: "refused", message: "The worker could not be described for this host." };
  }
  if (creation.kind !== "create-managed-code-thread") {
    return { status: "refused", message: "The worker could not be described for this host." };
  }
  const outcome = await input.port.executePlannerProposal({
    kind: "confirm-planner-work-proposal",
    proposalId: proposal.id,
    expectedVersion: entry.proposalVersion,
    creation,
  });
  if (outcome.status === "refused") return { status: "refused", message: outcome.message };
  if (
    outcome.status !== "confirmed" ||
    (outcome.creation.kind !== "managed-thread-created" &&
      outcome.creation.kind !== "thread-created") ||
    String(outcome.creation.thread.id) !== threadId
  ) {
    return { status: "refused", message: "The host did not confirm the worker it created." };
  }
  const thread = outcome.creation.thread;
  // The worker is durable whether or not its first turn starts.
  const notStarted = (message?: string): CoordinatorProposalApproval => ({
    status: "not-started",
    thread,
    message:
      message ??
      "The worker was created, but its first message could not be sent. Open it to retry.",
  });
  let started: CodeOperationResult;
  try {
    const prompt = await input.port.putEvidence(thread.id, proposal.intent);
    const uuid = input.uuid ?? (() => globalThis.crypto.randomUUID());
    started = await input.port.executeOperation(
      decodeCodeOperationCommand({
        kind: "start-provider-turn",
        operationId: uuid(),
        threadId: thread.id,
        checkoutId: thread.checkoutId,
        sessionId: uuid(),
        prompt,
      }),
    );
  } catch {
    return notStarted();
  }
  // Only a running turn is a started worker; the host answers a refused,
  // failed or interrupted start with the same kind and another state.
  if (started.kind === "provider-turn-state" && started.state === "running") {
    return { status: "approved", thread };
  }
  return notStarted(
    started.kind === "provider-turn-state" && started.failure !== undefined
      ? `The worker was created, but its first turn did not start: ${started.failure.message} Open it to retry.`
      : undefined,
  );
}

/** Decline a coordinator's proposed worker; nothing is created. */
export async function declineCoordinatorProposal(input: {
  readonly port: Pick<CoordinatorProposalDecisionPort, "executePlannerProposal">;
  readonly entry: CoordinatorProposalEntry;
}): Promise<
  { readonly status: "declined" } | { readonly status: "refused"; readonly message: string }
> {
  const outcome = await input.port.executePlannerProposal({
    kind: "decline-planner-work-proposal",
    proposalId: input.entry.proposal.id,
    expectedVersion: input.entry.proposalVersion,
  });
  if (outcome.status === "declined") return { status: "declined" };
  return {
    status: "refused",
    message:
      outcome.status === "refused" ? outcome.message : "The host did not record the decline.",
  };
}
