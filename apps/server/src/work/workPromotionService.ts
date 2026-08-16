import { Schema } from "effect";
import {
  EventActor,
  UtcTimestamp,
  decodeWorkPromotionCommandResult,
  decodeWorkPromotionProposal,
  decodeWorkPromotionProposalId,
  type CodeDeliveryTarget,
  type CodeThreadId,
  type WorkArtifactRef,
  type WorkPromotionCommand,
  type WorkPromotionCommandResult,
  type WorkPromotionFailure,
  type WorkPromotionFailureCode,
  type WorkPromotionFrame,
  type WorkPromotionProposal,
  type WorkPromotionProposalId,
  type PermissionPersistence,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderModelId,
  type WindowId,
} from "@octant/contracts";
import {
  WORK_PROMOTION_REQUIRED_CODE_EXECUTION_POLICY,
  classifyPromotionAuthority,
  classifyPromotionTransition,
  validatePromotionContextAuthority,
} from "@octant/domain";
import { WorkPromotionEventStoreError } from "./workPromotionEventStore";
import type { WorkPromotionProjection } from "./workPromotionProjection";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeResult = decodeWorkPromotionCommandResult;

export interface WorkPromotionProjectPort {
  projectType(projectId: ProjectId): "chat" | "work" | "code" | "unknown";
  workCanonicalRoot(originProjectId: ProjectId): string | undefined;
  resolveArtifactRefs(
    originProjectId: ProjectId,
    artifactRefs: ReadonlyArray<WorkArtifactRef>,
  ): ReadonlyArray<WorkArtifactRef>;
  readonly listArtifactRefs?: (originProjectId: ProjectId) => ReadonlyArray<WorkArtifactRef>;
  readonly resolveDeliveryTarget?: (
    targetCodeProjectId: ProjectId,
  ) => Promise<CodeDeliveryTarget | undefined> | CodeDeliveryTarget | undefined;
}

/**
 * Port for creating the linked Code thread on approval. Implementations MUST
 * be idempotent on `proposalId`: calling `createApprovalGatedThread` twice
 * with the same `proposalId` returns the same `codeThreadId`. `cancelCodeThread`
 * is best-effort cleanup for the race where a concurrent dismiss/expire wins
 * after thread creation; it MUST be idempotent and safe to call even if no
 * thread was created. The promotion event journal remains the authoritative
 * record of the approval; the port merely creates and reclaims the side
 * effect that the journal records.
 */
export interface WorkPromotionCodeThreadPort {
  createApprovalGatedThread(input: {
    readonly authenticatedWindowId: WindowId;
    readonly proposalId: WorkPromotionProposalId;
    readonly targetCodeProjectId: ProjectId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly deliveryTarget: CodeDeliveryTarget;
    readonly permissionPersistence: PermissionPersistence;
    readonly originSummary: string;
    readonly originArtifactRefs: ReadonlyArray<WorkArtifactRef>;
  }): Promise<{ codeThreadId: CodeThreadId }>;
  cancelCodeThread(input: {
    readonly authenticatedWindowId: WindowId;
    readonly proposalId: WorkPromotionProposalId;
    readonly codeThreadId: CodeThreadId;
  }): Promise<void>;
}

export interface WorkPromotionEventStorePort {
  append(input: {
    readonly proposalId: WorkPromotionProposalId;
    readonly expectedVersion: number;
    readonly frame: WorkPromotionFrame;
  }): WorkPromotionFrame;
  replayAll():
    | { readonly status: "ok"; readonly frames: ReadonlyArray<WorkPromotionFrame> }
    | { readonly status: "snapshot-required"; readonly reason: "scan-limit" };
}

export interface WorkPromotionServiceOptions {
  readonly projects: WorkPromotionProjectPort;
  readonly codeThreads: WorkPromotionCodeThreadPort;
  readonly projection: WorkPromotionProjection;
  readonly eventStore: WorkPromotionEventStorePort;
  readonly actor: typeof EventActor.Type;
  readonly clock: () => string;
  readonly authenticatedWindowId?: () => WindowId | undefined;
}

export type WorkPromotionServiceResult =
  | { readonly status: "ok"; readonly result: WorkPromotionCommandResult }
  | { readonly status: "failure"; readonly failure: WorkPromotionFailure };

export class WorkPromotionServiceError extends Error {
  override readonly name = "WorkPromotionServiceError";
  readonly code: WorkPromotionFailureCode;

  constructor(code: WorkPromotionFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

function failure(
  code: WorkPromotionFailureCode,
  message: string,
): { readonly status: "failure"; readonly failure: WorkPromotionFailure } {
  return {
    status: "failure",
    failure: { code, message } as WorkPromotionFailure,
  };
}

function mapEventStoreFailure(
  error: unknown,
  conflictMessage: string,
): { readonly status: "failure"; readonly failure: WorkPromotionFailure } {
  if (error instanceof WorkPromotionEventStoreError && error.category === "invalid") {
    return failure("conflict", conflictMessage);
  }
  return failure(
    "unavailable",
    "Promotion event journal could not be written through the authoritative flow.",
  );
}

/**
 * Server-authoritative Work-to-Code promotion service. Creates an explicit
 * linked-promotion proposal when Work work becomes software engineering,
 * never switches mode silently, and never carries Work filesystem authority
 * into Code. The user approves the promotion; the approve command creates the
 * linked Code thread through the ordinary authoritative flow with an
 * approval-gated execution policy. Dismiss and expire are the user and system
 * terminal transitions. Every transition is journaled as a versioned
 * `work.promotion-recorded@1` event and applied to the rebuildable
 * projection; optimistic concurrency on `expectedVersion` rejects stale
 * commands. The selected context is validated for authority leakage against
 * the canonical Work root before any proposal is journaled.
 */
export class WorkPromotionService {
  readonly #projects: WorkPromotionProjectPort;
  readonly #codeThreads: WorkPromotionCodeThreadPort;
  readonly #projection: WorkPromotionProjection;
  readonly #eventStore: WorkPromotionEventStorePort;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  readonly #authenticatedWindowId: (() => WindowId | undefined) | undefined;

  constructor(options: WorkPromotionServiceOptions) {
    this.#projects = options.projects;
    this.#codeThreads = options.codeThreads;
    this.#projection = options.projection;
    this.#eventStore = options.eventStore;
    this.#clock = options.clock;
    this.#authenticatedWindowId = options.authenticatedWindowId;
    try {
      this.#actor = Schema.decodeUnknownSync(EventActor)(options.actor);
    } catch {
      throw new WorkPromotionServiceError("invalid", "Work promotion service actor is invalid.");
    }
  }

  /**
   * Replays all journaled promotion frames from the authoritative event store
   * into the projection. Call this once after restart or reconnect before
   * serving commands so proposals durably written before restart are not
   * treated as `not-found`. The projection's stale-frame guard ensures this
   * is idempotent and safe to call on an already-hydrated projection.
   * Throws if the journal exceeds the scan cap, so hydration fails closed
   * instead of serving with a partial projection.
   */
  hydrate(): void {
    const result = this.#eventStore.replayAll();
    if (result.status !== "ok") {
      throw new WorkPromotionServiceError(
        "unavailable",
        "Work promotion hydration exceeded the journal scan cap; a snapshot rebuild is required.",
      );
    }
    for (const frame of result.frames) {
      this.#projection.apply(frame);
    }
  }

  async execute(command: WorkPromotionCommand): Promise<WorkPromotionServiceResult> {
    switch (command.kind) {
      case "propose-work-promotion":
        if (this.#actor.kind !== "local-user") {
          return failure(
            "unauthorized",
            "Proposing a Work promotion is user-initiated and requires a local-user actor.",
          );
        }
        return this.#propose(command);
      case "approve-work-promotion":
        if (this.#actor.kind !== "local-user") {
          return failure(
            "unauthorized",
            "Approving a Work promotion is user-initiated and requires a local-user actor.",
          );
        }
        return this.#approve(command);
      case "dismiss-work-promotion":
        if (this.#actor.kind !== "local-user") {
          return failure(
            "unauthorized",
            "Dismissing a Work promotion is user-initiated and requires a local-user actor.",
          );
        }
        return this.#dismiss(command);
      case "expire-work-promotion":
        return this.#expire(command);
    }
  }

  async #propose(
    command: Extract<WorkPromotionCommand, { kind: "propose-work-promotion" }>,
  ): Promise<WorkPromotionServiceResult> {
    const originType = this.#projects.projectType(command.originProjectId);
    const targetType = this.#projects.projectType(command.targetCodeProjectId);
    if (originType === "unknown" || targetType === "unknown") {
      return failure("not-found", "Promotion origin or target Project is unknown.");
    }
    const canonicalRoot = this.#projects.workCanonicalRoot(command.originProjectId);
    if (canonicalRoot === undefined || canonicalRoot.length === 0) {
      return failure(
        "unauthorized",
        "Work canonical root is unavailable; promotion cannot verify context authority.",
      );
    }
    const leakage = validatePromotionContextAuthority({
      summary: command.selectedContext.summary,
      artifactRefs: command.selectedContext.artifactRefs,
      workCanonicalRoot: canonicalRoot,
    });
    const authority = classifyPromotionAuthority({
      originProjectType: originType,
      targetProjectType: targetType,
      proposedCodeExecutionPolicy: WORK_PROMOTION_REQUIRED_CODE_EXECUTION_POLICY,
      contextLeakage: leakage,
    });
    if (authority === "deny") {
      return failure(
        "unauthorized",
        "Promotion authority denied; origin must be Work, target must be Code, Code starts approval-gated, and no Work authority may leak.",
      );
    }

    const resolvedRefs = this.#projects.resolveArtifactRefs(
      command.originProjectId,
      command.selectedContext.artifactRefs,
    );
    if (resolvedRefs.length !== command.selectedContext.artifactRefs.length) {
      return failure(
        "unauthorized",
        "Selected artifact refs must all resolve to the origin Work Project.",
      );
    }

    const proposalId = decodeWorkPromotionProposalId(command.proposalId);
    if (this.#projection.lookup(proposalId) !== undefined) {
      return failure("conflict", "A promotion proposal with this id already exists.");
    }

    const proposedAt = decodeTimestamp(this.#clock());
    const proposal: WorkPromotionProposal = decodeWorkPromotionProposal({
      proposalId,
      originProjectId: command.originProjectId,
      targetCodeProjectId: command.targetCodeProjectId,
      selectedContext: command.selectedContext,
      status: "proposed",
      proposedCodeExecutionPolicy: WORK_PROMOTION_REQUIRED_CODE_EXECUTION_POLICY,
      proposedCodePermissionPersistence: command.proposedCodePermissionPersistence,
      proposedBy: this.#actor,
      proposedAt,
      version: 1,
    });
    const frame: WorkPromotionFrame = { kind: "proposed", proposal };
    try {
      this.#eventStore.append({ proposalId, expectedVersion: 0, frame });
    } catch (error) {
      return mapEventStoreFailure(error, "Promotion proposal was concurrently created.");
    }
    this.#projection.apply(frame);
    return ok({ kind: "work-promotion-proposed", proposal });
  }

  async #approve(
    command: Extract<WorkPromotionCommand, { kind: "approve-work-promotion" }>,
  ): Promise<WorkPromotionServiceResult> {
    const entry = this.#projection.lookup(command.proposalId);
    if (entry === undefined) {
      return failure("not-found", "Promotion proposal was not found.");
    }
    if (entry.proposal.version !== command.expectedVersion) {
      return failure("stale", "Promotion proposal version is stale.");
    }
    const transition = classifyPromotionTransition({
      currentStatus: entry.proposal.status,
      transition: "approve",
    });
    if (transition === "deny") {
      return failure("conflict", "Only a proposed promotion may be approved.");
    }

    const authoritativeDeliveryTarget = await this.#projects.resolveDeliveryTarget?.(
      entry.proposal.targetCodeProjectId,
    );
    if (this.#projects.resolveDeliveryTarget !== undefined) {
      if (authoritativeDeliveryTarget === undefined) {
        return failure(
          "unavailable",
          "The target Code Project has no authoritative delivery target.",
        );
      }
      if (!sameDeliveryTarget(authoritativeDeliveryTarget, command.deliveryTarget)) {
        return failure("stale", "The Code delivery target is stale; reload the promotion context.");
      }
    }

    let created: { codeThreadId: CodeThreadId };
    const authenticatedWindowId = this.#authenticatedWindowId?.();
    if (authenticatedWindowId === undefined) {
      return failure(
        "unauthorized",
        "Approving a Work promotion requires an authenticated window.",
      );
    }
    try {
      created = await this.#codeThreads.createApprovalGatedThread({
        authenticatedWindowId,
        proposalId: command.proposalId,
        targetCodeProjectId: entry.proposal.targetCodeProjectId,
        providerInstanceId: command.providerInstanceId,
        modelId: command.modelId,
        deliveryTarget: authoritativeDeliveryTarget ?? command.deliveryTarget,
        permissionPersistence: entry.proposal.proposedCodePermissionPersistence,
        originSummary: entry.proposal.selectedContext.summary,
        originArtifactRefs: entry.proposal.selectedContext.artifactRefs,
      });
    } catch {
      return failure(
        "unavailable",
        "Linked Code thread could not be created through the authoritative flow.",
      );
    }

    // The Code thread port is idempotent on proposalId. If the journal
    // append below fails because a concurrent dismiss/expire won the race,
    // we best-effort cancel the created thread to avoid an orphan. The
    // event journal remains the authoritative record of the approval.
    const decidedAt = decodeTimestamp(this.#clock());
    const nextVersion = entry.proposal.version + 1;
    const approvedProposal: WorkPromotionProposal = decodeWorkPromotionProposal({
      ...entry.proposal,
      status: "approved",
      decidedAt,
      linkedCodeThreadId: created.codeThreadId,
      version: nextVersion,
    });
    const frame: WorkPromotionFrame = {
      kind: "approved",
      proposal: approvedProposal,
      linkedCodeThreadId: created.codeThreadId,
    };
    try {
      this.#eventStore.append({
        proposalId: command.proposalId,
        expectedVersion: entry.proposal.version,
        frame,
      });
    } catch (error) {
      // Only cancel the created thread when a concurrent dismiss/expire
      // terminally won the race. If another approve won (same idempotent
      // thread), the projection shows approved with this codeThreadId and
      // the thread is legitimately linked. If the journal failed
      // transiently, the proposal is still proposed and a retry binds to
      // the same idempotent thread, so we must NOT cancel it.
      const current = this.#projection.lookup(command.proposalId);
      const terminallyDismissedOrExpired =
        current?.proposal.status === "dismissed" || current?.proposal.status === "expired";
      if (terminallyDismissedOrExpired) {
        await this.#cancelThread(command.proposalId, created.codeThreadId, authenticatedWindowId);
      }
      return mapEventStoreFailure(error, "Promotion proposal was concurrently modified.");
    }
    this.#projection.apply(frame);
    return ok({
      kind: "work-promotion-approved",
      proposal: approvedProposal,
      linkedCodeThreadId: created.codeThreadId,
    });
  }

  async #dismiss(
    command: Extract<WorkPromotionCommand, { kind: "dismiss-work-promotion" }>,
  ): Promise<WorkPromotionServiceResult> {
    return this.#terminate(command, "dismiss", "work-promotion-dismissed");
  }

  async #expire(
    command: Extract<WorkPromotionCommand, { kind: "expire-work-promotion" }>,
  ): Promise<WorkPromotionServiceResult> {
    return this.#terminate(command, "expire", "work-promotion-expired");
  }

  async #terminate(
    command:
      | Extract<WorkPromotionCommand, { kind: "dismiss-work-promotion" }>
      | Extract<WorkPromotionCommand, { kind: "expire-work-promotion" }>,
    transition: "dismiss" | "expire",
    resultKind: "work-promotion-dismissed" | "work-promotion-expired",
  ): Promise<WorkPromotionServiceResult> {
    const entry = this.#projection.lookup(command.proposalId);
    if (entry === undefined) {
      return failure("not-found", "Promotion proposal was not found.");
    }
    if (entry.proposal.version !== command.expectedVersion) {
      return failure("stale", "Promotion proposal version is stale.");
    }
    const decision = classifyPromotionTransition({
      currentStatus: entry.proposal.status,
      transition,
    });
    if (decision === "deny") {
      return failure("conflict", `Only a proposed promotion may be ${transition}ed.`);
    }
    const decidedAt = decodeTimestamp(this.#clock());
    const nextVersion = entry.proposal.version + 1;
    const terminalProposal: WorkPromotionProposal = decodeWorkPromotionProposal({
      ...entry.proposal,
      status: transition === "dismiss" ? "dismissed" : "expired",
      decidedAt,
      version: nextVersion,
    });
    const frame: WorkPromotionFrame = {
      kind: transition === "dismiss" ? "dismissed" : "expired",
      proposal: terminalProposal,
    };
    try {
      this.#eventStore.append({
        proposalId: command.proposalId,
        expectedVersion: entry.proposal.version,
        frame,
      });
    } catch (error) {
      return mapEventStoreFailure(error, "Promotion proposal was concurrently modified.");
    }
    this.#projection.apply(frame);
    return ok({ kind: resultKind, proposal: terminalProposal });
  }

  async #cancelThread(
    proposalId: WorkPromotionProposalId,
    codeThreadId: CodeThreadId,
    authenticatedWindowId: WindowId,
  ): Promise<void> {
    try {
      await this.#codeThreads.cancelCodeThread({
        authenticatedWindowId,
        proposalId,
        codeThreadId,
      });
    } catch {
      // Best-effort cleanup; an orphan thread is recoverable through GC.
    }
  }
}

function sameDeliveryTarget(left: CodeDeliveryTarget, right: CodeDeliveryTarget): boolean {
  return (
    left.branchIntent === right.branchIntent &&
    left.remoteName === right.remoteName &&
    left.proposedBaseRepository === right.proposedBaseRepository &&
    left.proposedBaseBranch === right.proposedBaseBranch
  );
}

function ok(result: WorkPromotionCommandResult): WorkPromotionServiceResult {
  return { status: "ok", result: decodeResult(result) };
}
