import {
  ActorId,
  AggregateVersion,
  CorrelationId,
  EventActorProviderInstanceId,
  EventActorThreadId,
  EventId,
  UtcTimestamp,
  decodeCodeFailure,
  decodeCodePlannerCommand,
  decodeCodePlannerProposalCommand,
  decodeCodePlannerProposalDraft,
  decodeCodePlannerProposalId,
  decodeCodePlannerView,
  decodeCodePlannerWorkProposal,
  decodeProjectId,
  MAX_PENDING_CODE_PLANNER_PROPOSALS,
  type CodeCommandResult,
  type CodeFailure,
  type CodePlannerCommandOutcome,
  type CodePlannerDesignation,
  type CodePlannerProposalOutcome,
  type CodePlannerThreadCreation,
  type CodePlannerView,
  type CodePlannerWorkProposal,
  type CodeThreadId,
  type EventActor,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import {
  decideCodePlannerBoardAccess,
  decideCodePlannerDesignation,
  decideCodePlannerProposalResolution,
  decideCodePlannerProposalSubmission,
  decideCodePlannerUndesignation,
  type CodePlannerProjectFacts,
  type CodePlannerThreadFacts,
} from "@octant/domain/code-planner-policy";
import { readsAsCoordinator } from "@octant/domain";
import { ACCESS_POSTURE_RANK } from "@octant/domain/code-policy";
import { Schema } from "effect";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { PersistenceService } from "../persistence/persistenceService";
import {
  CODE_PLANNER_AGGREGATE_TYPE,
  CODE_PLANNER_PROPOSAL_AGGREGATE_TYPE,
  countPendingCodePlannerProposals,
  readCodePlannerAggregateVersion,
  readCodePlannerDesignation,
  readCodePlannerProposal,
  readCodePlannerProposals,
} from "../persistence/codeProjection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { CodeServiceExecutionContext } from "./codeService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeEventActorProviderInstanceId = Schema.decodeUnknownSync(EventActorProviderInstanceId);
const decodeEventActorThreadId = Schema.decodeUnknownSync(EventActorThreadId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);

const DESIGNATION_EVENT = "code.planner-designation-updated@1";
const PROPOSAL_EVENT = "code.planner-proposal-updated@1";

/** What the planner tool receives when it asks to read the board. */
export type CodePlannerBoardScope =
  | { readonly status: "allowed"; readonly projectId: ProjectId }
  | { readonly status: "refused"; readonly reason: string; readonly message: string };

/** What the planner tool receives back for a submitted proposal. */
export type CodePlannerProposeOutcome =
  | { readonly status: "proposed"; readonly proposal: CodePlannerWorkProposal }
  | { readonly status: "refused"; readonly reason: string; readonly message: string };

export interface CodePlannerServiceOptions {
  readonly persistence: PersistenceService;
  readonly uuid: () => string;
  readonly clock: () => string;
  /**
   * Whether an authenticated window may act on a Code Project — the same
   * workspace-scoped check the Code command service applies, so the planner
   * cannot be read or redirected from a window the Project is not open in.
   */
  readonly canAccessProject: (windowId: WindowId, projectId: ProjectId) => boolean;
  /**
   * The ordinary thread-creation command path, injected so a confirmed
   * proposal creates its thread exactly the way the create dialog does. The
   * planner has no creation path of its own.
   */
  readonly createThread: (
    authenticatedWindowId: WindowId,
    creation: CodePlannerThreadCreation,
    signal: AbortSignal | undefined,
    executionContext: CodeServiceExecutionContext,
  ) => Promise<
    CodeCommandResult | { readonly kind: "creation-not-started"; readonly failure: CodeFailure }
  >;
  /** Whether a thread is marked as having taken in outside content, as its mark reads now. */
  readonly isMarkedWithOutsideContent: (threadId: string) => boolean;
}

export class CodePlannerServiceError extends Error {
  override readonly name = "CodePlannerServiceError";

  constructor(readonly failure: CodeFailure) {
    super(failure.message);
  }
}

/**
 * Owns a Code Project's planner designation and its work proposals.
 *
 * The designation and every proposal are journaled aggregates rebuilt by the
 * Code projection; nothing here is independently mutable. Expected policy
 * refusals — the wrong Project, a missing thread, a second planner, a stale
 * version — are returned as values so every caller must handle them. Only
 * malformed input and an unavailable store throw.
 */
export class CodePlannerService {
  readonly #persistence: PersistenceService;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #createThread: CodePlannerServiceOptions["createThread"];
  readonly #canAccessProject: CodePlannerServiceOptions["canAccessProject"];
  readonly #isMarkedWithOutsideContent: CodePlannerServiceOptions["isMarkedWithOutsideContent"];
  readonly #creating = new Set<string>();

  constructor(options: CodePlannerServiceOptions) {
    this.#persistence = options.persistence;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#createThread = options.createThread;
    this.#canAccessProject = options.canAccessProject;
    this.#isMarkedWithOutsideContent = options.isMarkedWithOutsideContent;
  }

  readView(authenticatedWindowId: WindowId, projectIdInput: unknown): CodePlannerView {
    const projectId = this.#decodeProjectId(projectIdInput);
    if (this.#persistence.readProject(projectId) === undefined) {
      throw new CodePlannerServiceError(
        decodeCodeFailure({ category: "invalid", message: "Project was not found." }),
      );
    }
    this.#assertWindowAccess(authenticatedWindowId, projectId);
    for (const entry of readCodePlannerProposals(this.#persistence.connection, projectId)) {
      if (!this.#creating.has(String(entry.proposal.id)))
        this.#recoverCreatedProposal(entry.proposal, entry.proposalVersion);
    }
    return decodeCodePlannerView({
      designation: this.#designation(projectId),
      designationVersion: readCodePlannerAggregateVersion(this.#persistence.connection, projectId),
      proposals: readCodePlannerProposals(this.#persistence.connection, projectId),
    });
  }

  async execute(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<CodePlannerCommandOutcome> {
    let command: ReturnType<typeof decodeCodePlannerCommand>;
    try {
      command = decodeCodePlannerCommand(input);
    } catch {
      throw new CodePlannerServiceError(
        decodeCodeFailure({ category: "invalid", message: "Planner command is invalid." }),
      );
    }
    const project = this.#projectFacts(command.projectId);
    // A missing Project stays the policy's project-unavailable refusal; a
    // Project this window's workspace cannot act on is unauthorized.
    if (project !== undefined) {
      this.#assertWindowAccess(authenticatedWindowId, command.projectId);
    }
    const currentDesignation = readCodePlannerDesignation(
      this.#persistence.connection,
      command.projectId,
    );
    const currentVersion = readCodePlannerAggregateVersion(
      this.#persistence.connection,
      command.projectId,
    );
    if (currentVersion !== command.expectedVersion) {
      return designationChanged();
    }

    const timestamp = decodeTimestamp(this.#clock());
    if (command.kind === "designate-code-planner-thread") {
      const candidate = this.#persistence.readCodeThread(command.threadId);
      const decision = decideCodePlannerDesignation({
        project,
        thread: this.#threadFacts(command.threadId),
        currentDesignation,
        ...(candidate === undefined
          ? {}
          : {
              coordinatorFacts: {
                startedByCoordinator: candidate.coordinatorThreadId !== undefined,
                threadIsCoordinator: candidate.coordinator === true,
                // No planner is designated here (the policy refused that), so
                // the Project's coordinators are the threads holding the role.
                otherCoordinators: this.#persistence
                  .readCodeThreads()
                  .filter(
                    (thread) =>
                      String(thread.projectId) === String(command.projectId) &&
                      String(thread.id) !== String(command.threadId) &&
                      thread.coordinator === true &&
                      thread.lifecycle !== "archived",
                  ).length,
              },
            }),
      });
      if (decision.status === "refused") return decision;
      const designation: CodePlannerDesignation = {
        kind: "designated",
        projectId: command.projectId,
        plannerThreadId: command.threadId,
        designatedAt: timestamp,
      };
      const appended = this.#appendDesignation(
        command.projectId,
        command.expectedVersion,
        designation,
      );
      if (appended === "conflict") return designationChanged();
      return {
        status: "designated",
        designation: this.#requireDesignation(command.projectId),
        designationVersion: decodeAggregateVersion(
          readCodePlannerAggregateVersion(this.#persistence.connection, command.projectId),
        ),
      };
    }

    const decision = decideCodePlannerUndesignation({ project, currentDesignation });
    if (decision.status === "refused") return decision;
    const designation: CodePlannerDesignation = {
      kind: "none",
      projectId: command.projectId,
      updatedAt: timestamp,
    };
    const appended = this.#appendDesignation(
      command.projectId,
      command.expectedVersion,
      designation,
    );
    if (appended === "conflict") return designationChanged();
    return {
      status: "undesignated",
      designation: this.#requireDesignation(command.projectId),
      designationVersion: decodeAggregateVersion(
        readCodePlannerAggregateVersion(this.#persistence.connection, command.projectId),
      ),
    };
  }

  /**
   * Whether a thread's agent may read its Project's board, resolved from the
   * authoritative projection on every call — never from the turn that
   * advertised the tool.
   */
  boardScope(threadId: CodeThreadId): CodePlannerBoardScope {
    const thread = this.#threadFacts(threadId);
    return decideCodePlannerBoardAccess({
      thread,
      designation:
        thread === undefined
          ? undefined
          : readCodePlannerDesignation(this.#persistence.connection, thread.projectId),
    });
  }

  /** Used only to decide whether a turn advertises the planner's board operation and target. */
  isPlannerThread(threadId: CodeThreadId): boolean {
    return this.boardScope(threadId).status === "allowed";
  }

  /**
   * Records a planner-authored proposal as a pending, journaled item. The
   * proposal executes nothing: it waits for the user's confirm or decline.
   */
  propose(threadId: CodeThreadId, draftInput: unknown): CodePlannerProposeOutcome {
    let draft: ReturnType<typeof decodeCodePlannerProposalDraft>;
    try {
      draft = decodeCodePlannerProposalDraft(draftInput);
    } catch {
      return {
        status: "refused",
        reason: "invalid-proposal",
        message: "The proposal draft is invalid or over its bounds.",
      };
    }
    const thread = this.#threadFacts(threadId);
    const decision = decideCodePlannerProposalSubmission({
      thread,
      designation:
        thread === undefined
          ? undefined
          : readCodePlannerDesignation(this.#persistence.connection, thread.projectId),
      pendingProposals:
        thread === undefined
          ? 0
          : countPendingCodePlannerProposals(this.#persistence.connection, thread.projectId),
    });
    if (decision.status === "refused") return decision;
    const proposal: CodePlannerWorkProposal = {
      id: decodeCodePlannerProposalId(this.#uuid()),
      projectId: decision.projectId,
      plannerThreadId: threadId,
      title: draft.title,
      intent: draft.intent,
      ...(draft.rationale === undefined ? {} : { rationale: draft.rationale }),
      status: "pending",
      proposedAt: decodeTimestamp(this.#clock()),
    };
    try {
      this.#appendProposal(proposal, 0, this.#agentActor(threadId));
    } catch {
      return {
        status: "refused",
        reason: "planner-unavailable",
        message: "Planner storage is unavailable.",
      };
    }
    return { status: "proposed", proposal };
  }

  /**
   * Records a coordinator's `start` as a pending proposal because a person
   * chose Propose for approval, or because the caller is the designated
   * planner, which reads as a coordinator whose starts always need approval.
   * The pending cap is the planner's.
   */
  proposeForCoordinator(
    coordinatorThreadId: CodeThreadId,
    draftInput: { readonly title: string; readonly intent: string },
    workerOptions?: {
      readonly providerInstanceId?: string;
      readonly modelId?: string;
      readonly executionPolicy: string;
    },
  ):
    | { readonly status: "proposed"; readonly proposal: CodePlannerWorkProposal }
    | { readonly status: "refused"; readonly message: string } {
    let draft: ReturnType<typeof decodeCodePlannerProposalDraft>;
    try {
      draft = decodeCodePlannerProposalDraft(draftInput);
    } catch {
      return { status: "refused", message: "The proposal is invalid or over its bounds." };
    }
    const thread = this.#persistence.readCodeThread(coordinatorThreadId);
    if (
      thread === undefined ||
      !readsAsCoordinator({
        lifecycle: thread.lifecycle,
        coordinator: thread.coordinator === true,
        startedByCoordinator: thread.coordinatorThreadId !== undefined,
        designatedPlanner: this.isPlannerThread(coordinatorThreadId),
      })
    ) {
      return { status: "refused", message: "Only a coordinator thread may propose a worker." };
    }
    if (
      countPendingCodePlannerProposals(this.#persistence.connection, thread.projectId) >=
      MAX_PENDING_CODE_PLANNER_PROPOSALS
    ) {
      return {
        status: "refused",
        message: "This Project already has the maximum number of unresolved proposals.",
      };
    }
    const proposal: CodePlannerWorkProposal = {
      id: decodeCodePlannerProposalId(this.#uuid()),
      projectId: thread.projectId,
      plannerThreadId: coordinatorThreadId,
      title: draft.title,
      intent: draft.intent,
      fromCoordinator: true,
      status: "pending",
      proposedAt: decodeTimestamp(this.#clock()),
    };
    let withOptions: CodePlannerWorkProposal;
    try {
      withOptions =
        workerOptions === undefined
          ? proposal
          : decodeCodePlannerWorkProposal({ ...proposal, workerOptions });
    } catch {
      return { status: "refused", message: "The proposed worker's options are invalid." };
    }
    try {
      this.#appendProposal(withOptions, 0, this.#agentActor(coordinatorThreadId));
    } catch {
      return { status: "refused", message: "Planner storage is unavailable." };
    }
    return { status: "proposed", proposal: withOptions };
  }

  async resolveProposal(
    authenticatedWindowId: WindowId,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CodePlannerProposalOutcome> {
    let command: ReturnType<typeof decodeCodePlannerProposalCommand>;
    try {
      command = decodeCodePlannerProposalCommand(input);
    } catch {
      throw new CodePlannerServiceError(
        decodeCodeFailure({ category: "invalid", message: "Planner proposal command is invalid." }),
      );
    }
    let projected = readCodePlannerProposal(this.#persistence.connection, command.proposalId);
    if (projected !== undefined) {
      this.#assertWindowAccess(authenticatedWindowId, projected.proposal.projectId);
    }
    const key = String(command.proposalId);
    if (this.#creating.has(key))
      return {
        status: "refused",
        reason: "proposal-changed",
        message:
          "This proposal is already creating its task. Inspect the submitted task and wait for its current state; no replacement was started.",
      };
    if (
      projected !== undefined &&
      this.#recoverCreatedProposal(projected.proposal, projected.proposalVersion)
    )
      projected = readCodePlannerProposal(this.#persistence.connection, command.proposalId);
    const decision = decideCodePlannerProposalResolution({
      proposal: projected?.proposal,
      action: command.kind === "confirm-planner-work-proposal" ? "confirm" : "decline",
      ...(command.kind === "confirm-planner-work-proposal"
        ? { creationProjectId: creationProjectId(command.creation) }
        : {}),
    });
    if (decision.status === "refused") return decision;
    if (projected === undefined || projected.proposalVersion !== command.expectedVersion) {
      return {
        status: "refused",
        reason: "proposal-changed",
        message: "The proposal changed; reload and retry.",
      };
    }
    // A coordinator's start resolved a level; approving it cannot start the
    // worker any higher, whatever the creation controls were set to.
    const proposedLevel = decision.proposal.workerOptions?.executionPolicy;
    if (
      command.kind === "confirm-planner-work-proposal" &&
      proposedLevel !== undefined &&
      ACCESS_POSTURE_RANK[creationLevel(command.creation)] > ACCESS_POSTURE_RANK[proposedLevel]
    ) {
      return {
        status: "refused",
        reason: "creation-above-proposed-level",
        message: "This worker was proposed at a lower guardrail level. Choose that level or lower.",
      };
    }
    if (decision.proposal.creationAttempt?.status === "creating")
      return {
        status: "refused",
        reason: "proposal-changed",
        message:
          "The earlier creation outcome is unresolved. Inspect its submitted task; no replacement or decline was recorded.",
      };

    if (command.kind === "decline-planner-work-proposal") {
      const declined: CodePlannerWorkProposal = {
        ...decision.proposal,
        status: "declined",
        resolvedAt: decodeTimestamp(this.#clock()),
      };
      try {
        this.#appendProposal(declined, command.expectedVersion);
      } catch (error) {
        // A concurrent resolution between the version check and this append is
        // the same expected race the confirm path answers with a value.
        if (error instanceof ConcurrencyConflict) {
          return {
            status: "refused",
            reason: "proposal-changed",
            message: "The proposal changed; reload and retry.",
          };
        }
        throw this.#unavailable();
      }
      return { status: "declined", proposal: this.#requireProposal(declined.id) };
    }

    const submittedId = createdThreadId(command.creation);
    if (this.#persistence.readCodeThread(submittedId) !== undefined)
      return {
        status: "refused",
        reason: "proposal-changed",
        message:
          "That submitted task id is already in use. Refresh the proposal before continuing.",
      };
    const admitted: CodePlannerWorkProposal = {
      ...decision.proposal,
      creationAttempt: {
        threadId: submittedId,
        status: "creating",
        admittedAt: decodeTimestamp(this.#clock()),
      },
    };
    const executionContext = this.#inheritedMarkFor(decision.proposal);
    this.#creating.add(key);
    let admittedVersion: number | undefined;
    try {
      // The journal CAS is the admission owner across windows and restarts.
      // It runs synchronously before ordinary creation can await anything.
      this.#appendProposal(admitted, command.expectedVersion);
      admittedVersion = Number(command.expectedVersion) + 1;
      const creation = await this.#createThread(
        authenticatedWindowId,
        command.creation,
        signal,
        executionContext,
      );
      if (creation.kind === "creation-not-started") {
        if (this.#persistence.readCodeThread(submittedId) !== undefined) {
          this.#recoverCreatedProposal(admitted, admittedVersion);
          return {
            status: "refused",
            reason: "proposal-changed",
            message:
              "A submitted task exists. Inspect it; this approval did not start its first message.",
          };
        }
        this.#appendProposal(
          {
            ...admitted,
            creationAttempt: {
              threadId: submittedId,
              status: "failed",
              admittedAt: admitted.creationAttempt?.admittedAt ?? decodeTimestamp(this.#clock()),
              message: `The host refused this attempt (${creation.failure.category}). Review the provider, Project and checkout settings before approving again.`,
            },
          },
          admittedVersion,
        );
        return {
          status: "refused",
          reason: "creation-not-started",
          message: creation.failure.message,
        };
      }
      if (
        (creation.kind !== "thread-created" && creation.kind !== "managed-thread-created") ||
        String(creation.thread.id) !== String(submittedId) ||
        String(creation.thread.projectId) !== String(decision.proposal.projectId)
      )
        return {
          status: "refused",
          reason: "proposal-changed",
          message:
            "The host did not confirm the submitted task identity. Inspect the unresolved attempt before continuing.",
        };
      const confirmed: CodePlannerWorkProposal = {
        ...admitted,
        status: "confirmed",
        resolvedAt: decodeTimestamp(this.#clock()),
        createdThreadId: submittedId,
      };
      this.#appendProposal(confirmed, admittedVersion);
      return { status: "confirmed", proposal: this.#requireProposal(confirmed.id), creation };
    } catch (error) {
      if (admittedVersion !== undefined) this.#recoverCreatedProposal(admitted, admittedVersion);
      if (error instanceof ConcurrencyConflict) {
        return {
          status: "refused",
          reason: "proposal-changed",
          message: "The proposal changed while the thread was being created.",
        };
      }
      throw error;
    } finally {
      this.#creating.delete(key);
    }
  }

  /** A stored task is recovery evidence, never permission to send a first turn. */
  #recoverCreatedProposal(proposal: CodePlannerWorkProposal, version: number): boolean {
    if (proposal.status !== "pending" || proposal.creationAttempt?.status !== "creating")
      return false;
    const thread = this.#persistence.readCodeThread(proposal.creationAttempt.threadId);
    if (thread === undefined || String(thread.projectId) !== String(proposal.projectId))
      return false;
    try {
      this.#appendProposal(
        {
          ...proposal,
          status: "confirmed",
          resolvedAt: decodeTimestamp(this.#clock()),
          createdThreadId: thread.id,
        },
        version,
        { kind: "system", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The mark a thread confirmed from a proposal starts with. The planner agent
   * wrote the proposal's intent, which becomes the new thread's opening
   * prompt, after reading whatever marked its thread, so the text can carry
   * it. Read when the thread is made, like a fork's: a planner a person
   * cleared passes on nothing.
   */
  #inheritedMarkFor(proposal: CodePlannerWorkProposal): CodeServiceExecutionContext {
    const plannerThreadId = String(proposal.plannerThreadId);
    // A coordinator's proposal creates its worker: the host records the
    // lineage, and the mark carries the coordinator-start label.
    const lineage =
      proposal.fromCoordinator === true ? { coordinatorThreadId: proposal.plannerThreadId } : {};
    if (!this.#isMarkedWithOutsideContent(plannerThreadId)) return lineage;
    const label = proposal.fromCoordinator === true ? "coordinator-start" : "planner-proposal";
    return {
      ...lineage,
      inheritedMark: {
        sourceLabel: label,
        contentReference: `${label}-${plannerThreadId}-${String(proposal.id)}`,
      },
    };
  }

  #designation(projectId: ProjectId): CodePlannerDesignation {
    return (
      readCodePlannerDesignation(this.#persistence.connection, projectId) ?? {
        kind: "none",
        projectId,
        updatedAt: decodeTimestamp(this.#clock()),
      }
    );
  }

  #requireDesignation(projectId: ProjectId): CodePlannerDesignation {
    const designation = readCodePlannerDesignation(this.#persistence.connection, projectId);
    if (designation === undefined) throw this.#unavailable();
    return designation;
  }

  #requireProposal(proposalId: CodePlannerWorkProposal["id"]): CodePlannerWorkProposal {
    const projected = readCodePlannerProposal(this.#persistence.connection, proposalId);
    if (projected === undefined) throw this.#unavailable();
    return projected.proposal;
  }

  #projectFacts(projectId: ProjectId): CodePlannerProjectFacts | undefined {
    const project = this.#persistence.readProject(projectId);
    return project === undefined
      ? undefined
      : { id: project.id, type: project.type, lifecycle: project.lifecycle };
  }

  #threadFacts(threadId: CodeThreadId): CodePlannerThreadFacts | undefined {
    const thread = this.#persistence.readCodeThread(threadId);
    return thread === undefined
      ? undefined
      : { id: thread.id, projectId: thread.projectId, lifecycle: thread.lifecycle };
  }

  #appendDesignation(
    projectId: ProjectId,
    expectedVersion: number,
    designation: CodePlannerDesignation,
  ): "appended" | "conflict" {
    try {
      this.#persistence.journal.append({
        aggregate: { aggregateType: CODE_PLANNER_AGGREGATE_TYPE, aggregateId: projectId },
        expectedVersion,
        events: [
          this.#event(DESIGNATION_EVENT, { kind: "planner-designation-updated", designation }),
        ],
      });
      return "appended";
    } catch (error) {
      if (error instanceof ConcurrencyConflict) return "conflict";
      throw this.#unavailable();
    }
  }

  #appendProposal(
    proposal: CodePlannerWorkProposal,
    expectedVersion: number,
    actor?: EventActor,
  ): void {
    this.#persistence.journal.append({
      aggregate: { aggregateType: CODE_PLANNER_PROPOSAL_AGGREGATE_TYPE, aggregateId: proposal.id },
      expectedVersion,
      events: [this.#event(PROPOSAL_EVENT, { kind: "planner-proposal-updated", proposal }, actor)],
    });
  }

  /**
   * A proposal is authored by the planner thread's agent, and the journal
   * should say so; only a resolution is the user's act.
   */
  #agentActor(threadId: CodeThreadId): EventActor {
    const thread = this.#persistence.readCodeThread(threadId);
    if (thread === undefined) throw this.#unavailable();
    return {
      kind: "agent",
      actorId: decodeActorId(this.#uuid()),
      providerInstanceId: decodeEventActorProviderInstanceId(String(thread.providerInstanceId)),
      threadId: decodeEventActorThreadId(String(threadId)),
    };
  }

  #event(eventName: string, payload: unknown, actor?: EventActor) {
    return {
      eventId: decodeEventId(this.#uuid()),
      eventName,
      eventVersion: 1,
      correlationId: decodeCorrelationId(this.#uuid()),
      actor: actor ?? {
        kind: "local-user" as const,
        actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID),
      },
      occurredAt: decodeTimestamp(this.#clock()),
      payload,
    };
  }

  #assertWindowAccess(authenticatedWindowId: WindowId, projectId: ProjectId): void {
    if (!this.#canAccessProject(authenticatedWindowId, projectId)) {
      throw new CodePlannerServiceError(
        decodeCodeFailure({
          category: "unauthorized",
          message: "This window cannot act on that Project's planner.",
        }),
      );
    }
  }

  #decodeProjectId(input: unknown): ProjectId {
    try {
      return decodeProjectId(input);
    } catch {
      throw new CodePlannerServiceError(
        decodeCodeFailure({ category: "invalid", message: "Project ID is invalid." }),
      );
    }
  }

  #unavailable(): CodePlannerServiceError {
    return new CodePlannerServiceError(
      decodeCodeFailure({ category: "unavailable", message: "Planner storage is unavailable." }),
    );
  }
}

function designationChanged(): CodePlannerCommandOutcome {
  return {
    status: "refused",
    reason: "designation-changed",
    message: "Planner designation changed; reload and retry.",
  };
}

function creationProjectId(creation: CodePlannerThreadCreation): ProjectId {
  return creation.kind === "create-managed-code-thread"
    ? creation.projectId
    : creation.thread.projectId;
}

function creationLevel(creation: CodePlannerThreadCreation) {
  return creation.kind === "create-managed-code-thread"
    ? creation.executionPolicy
    : creation.thread.executionPolicy;
}

function createdThreadId(creation: CodePlannerThreadCreation): CodeThreadId {
  return creation.kind === "create-managed-code-thread" ? creation.threadId : creation.thread.id;
}
