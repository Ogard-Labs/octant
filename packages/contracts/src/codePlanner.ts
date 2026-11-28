import { personDecides } from "./hostAnswer";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { Schema } from "effect";
import {
  CodeCommandResult,
  CodeThreadId,
  CreateCodeThreadCommand,
  CreateManagedCodeThreadCommand,
  MAX_CODE_THREAD_TITLE_LENGTH,
} from "./code";
import { CoordinatorWorkerChoice } from "./coordinator";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { ProviderExecutionPolicy, ProviderInstanceId, ProviderModelId } from "./providers";

export const CodePlannerProposalId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("CodePlannerProposalId"),
);
export type CodePlannerProposalId = typeof CodePlannerProposalId.Type;

/**
 * Bound on the work a proposal describes. The intent becomes the new thread's
 * opening prompt when the user confirms, so it may be a paragraph or two, but
 * it is a proposal the user reads before anything runs — not a document.
 */
export const MAX_CODE_PLANNER_PROPOSAL_INTENT_LENGTH = 4_000;
export const MAX_CODE_PLANNER_PROPOSAL_RATIONALE_LENGTH = 1_024;

/**
 * Ceiling on unresolved proposals per Project. The planner surveys one board
 * and proposes discrete work items; a queue longer than this is the planner
 * looping, and every extra pending item is another journaled aggregate the
 * user has to decline one by one.
 */
export const MAX_PENDING_CODE_PLANNER_PROPOSALS = 10;

/**
 * Which Code thread, if any, a Code Project has designated as its planner.
 * At most one thread per Project holds the designation, and it is the only
 * thread whose agent may read the Project's board or propose work. The
 * designation lives on its own Project-scoped aggregate so replay rebuilds it
 * without touching the Project or thread records.
 */
export const CodePlannerDesignation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("designated"),
    projectId: ProjectId,
    plannerThreadId: CodeThreadId,
    designatedAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("none"),
    projectId: ProjectId,
    updatedAt: UtcTimestamp,
  }),
]);
export type CodePlannerDesignation = typeof CodePlannerDesignation.Type;

const CodePlannerProposalFields = {
  id: CodePlannerProposalId,
  projectId: ProjectId,
  plannerThreadId: CodeThreadId,
  title: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_CODE_THREAD_TITLE_LENGTH),
  ),
  intent: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_CODE_PLANNER_PROPOSAL_INTENT_LENGTH),
  ),
  rationale: Schema.optional(
    Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(MAX_CODE_PLANNER_PROPOSAL_RATIONALE_LENGTH),
    ),
  ),
  proposedAt: UtcTimestamp,
  /**
   * Set when a coordinator's `start` became this proposal because a person
   * chose Propose for approval; `plannerThreadId` then names that
   * coordinator, and confirming records the new thread as its worker.
   */
  fromCoordinator: Schema.optional(Schema.Literal(true)),
  /**
   * What the coordinator's `start` asked for: the worker's provider and
   * model when it named them, and the level it resolved. A confirm may not
   * start the worker above that level.
   */
  workerOptions: Schema.optional(
    Schema.Struct({
      providerInstanceId: Schema.optional(ProviderInstanceId),
      modelId: Schema.optional(ProviderModelId),
      executionPolicy: ProviderExecutionPolicy,
      /**
       * How the host chose the model from the roles, when it did: the card
       * shows the role, the model and the coordinator's why, and approving
       * on that model journals it on the worker.
       */
      choice: Schema.optional(CoordinatorWorkerChoice),
      /** The model's name as its provider reports it, for the card. */
      modelName: Schema.optional(
        Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
      ),
      /**
       * The request's filters, kept so **Use Builder instead** applies them
       * again: the work needs images, and the provider family a review must
       * avoid.
       */
      needsImages: Schema.optional(Schema.Literal(true)),
      reviewedProviderKind: Schema.optional(
        Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
      ),
    }),
  ),
  /** Host-authored admission; a draft cannot assert that creation did not start. */
  creationAttempt: Schema.optional(
    Schema.Struct({
      threadId: CodeThreadId,
      status: Schema.Literals(["creating", "failed"]),
      admittedAt: UtcTimestamp,
      message: Schema.optional(
        Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
      ),
    }),
  ),
} as const;

/**
 * A planner-authored, approval-gated proposal to create one new Code thread.
 * It is advisory until the user acts: confirming routes creation through the
 * ordinary thread-creation command, and declining discards it. The proposal
 * itself can never create, start, or redirect anything.
 */
export const CodePlannerWorkProposal = Schema.Union([
  Schema.Struct({
    ...CodePlannerProposalFields,
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({
    ...CodePlannerProposalFields,
    status: Schema.Literal("confirmed"),
    resolvedAt: UtcTimestamp,
    createdThreadId: CodeThreadId,
  }),
  Schema.Struct({
    ...CodePlannerProposalFields,
    status: Schema.Literal("declined"),
    resolvedAt: UtcTimestamp,
  }),
]).annotate(personDecides);
export type CodePlannerWorkProposal = typeof CodePlannerWorkProposal.Type;

/** What a planner agent submits; identity and timestamps are server-stamped. */
export const CodePlannerProposalDraft = Schema.Struct({
  title: CodePlannerProposalFields.title,
  intent: CodePlannerProposalFields.intent,
  rationale: CodePlannerProposalFields.rationale,
});
export type CodePlannerProposalDraft = typeof CodePlannerProposalDraft.Type;

export const CodePlannerCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("designate-code-planner-thread"),
    projectId: ProjectId,
    threadId: CodeThreadId,
    expectedVersion: AggregateVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("undesignate-code-planner-thread"),
    projectId: ProjectId,
    expectedVersion: AggregateVersion,
  }),
]);
export type CodePlannerCommand = typeof CodePlannerCommand.Type;

/**
 * Why a designation command was refused. Each refusal is an expected answer a
 * caller must handle, never an exception: the thread may live in another
 * Project, may not exist, or the Project may already have its one planner.
 */
export const CodePlannerDesignationRefusalReason = Schema.Literals([
  "project-unavailable",
  "thread-not-found",
  "thread-in-another-project",
  "thread-archived",
  "thread-is-worker",
  "coordinator-limit-reached",
  "planner-already-designated",
  "no-planner-designated",
  "designation-changed",
]);
export type CodePlannerDesignationRefusalReason = typeof CodePlannerDesignationRefusalReason.Type;

export const CodePlannerCommandOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("designated"),
    designation: CodePlannerDesignation,
    designationVersion: AggregateVersion,
  }),
  Schema.Struct({
    status: Schema.Literal("undesignated"),
    designation: CodePlannerDesignation,
    designationVersion: AggregateVersion,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: CodePlannerDesignationRefusalReason,
    message: NonEmptyTrimmedString,
  }),
]);
export type CodePlannerCommandOutcome = typeof CodePlannerCommandOutcome.Type;

/**
 * The two creation commands a confirmed proposal may route through. They are
 * the exact contracts the create dialog already sends, so confirming a
 * proposal takes no shortcut the user could not take by hand.
 */
export const CodePlannerThreadCreation = Schema.Union([
  CreateManagedCodeThreadCommand,
  CreateCodeThreadCommand,
]);
export type CodePlannerThreadCreation = typeof CodePlannerThreadCreation.Type;

export const CodePlannerProposalCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("confirm-planner-work-proposal"),
    proposalId: CodePlannerProposalId,
    expectedVersion: AggregateVersion,
    creation: CodePlannerThreadCreation,
  }),
  Schema.Struct({
    kind: Schema.Literal("decline-planner-work-proposal"),
    proposalId: CodePlannerProposalId,
    expectedVersion: AggregateVersion,
  }),
  Schema.Struct({
    kind: Schema.Literal("use-builder-for-planner-work-proposal"),
    proposalId: CodePlannerProposalId,
    expectedVersion: AggregateVersion,
  }),
]);
export type CodePlannerProposalCommand = typeof CodePlannerProposalCommand.Type;

export const CodePlannerProposalRefusalReason = Schema.Literals([
  "proposal-not-found",
  "proposal-not-pending",
  "creation-project-mismatch",
  "creation-above-proposed-level",
  "proposal-changed",
  "creation-not-started",
  "builder-unavailable",
]);
export type CodePlannerProposalRefusalReason = typeof CodePlannerProposalRefusalReason.Type;

export const CodePlannerProposalOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("confirmed"),
    proposal: CodePlannerWorkProposal,
    creation: CodeCommandResult,
  }),
  Schema.Struct({
    status: Schema.Literal("declined"),
    proposal: CodePlannerWorkProposal,
  }),
  Schema.Struct({
    status: Schema.Literal("rechosen"),
    proposal: CodePlannerWorkProposal,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: CodePlannerProposalRefusalReason,
    message: NonEmptyTrimmedString,
  }),
]);
export type CodePlannerProposalOutcome = typeof CodePlannerProposalOutcome.Type;

/**
 * One Project's planner state as the renderer reads it: the designation, its
 * aggregate version for optimistic commands, and every proposal with the
 * version a confirm or decline must echo back.
 */
export const CodePlannerView = Schema.Struct({
  designation: CodePlannerDesignation,
  designationVersion: AggregateVersion,
  proposals: Schema.Array(
    Schema.Struct({
      proposal: CodePlannerWorkProposal,
      proposalVersion: AggregateVersion,
    }),
  ),
});
export type CodePlannerView = typeof CodePlannerView.Type;

export const CodePlannerDesignationUpdated = Schema.Struct({
  kind: Schema.Literal("planner-designation-updated"),
  designation: CodePlannerDesignation,
});
export type CodePlannerDesignationUpdated = typeof CodePlannerDesignationUpdated.Type;

export const CodePlannerProposalUpdated = Schema.Struct({
  kind: Schema.Literal("planner-proposal-updated"),
  proposal: CodePlannerWorkProposal,
});
export type CodePlannerProposalUpdated = typeof CodePlannerProposalUpdated.Type;

export const decodeCodePlannerProposalId = Schema.decodeUnknownSync(
  CodePlannerProposalId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePlannerDesignation = Schema.decodeUnknownSync(
  CodePlannerDesignation,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePlannerWorkProposal = Schema.decodeUnknownSync(
  CodePlannerWorkProposal,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePlannerProposalDraft = Schema.decodeUnknownSync(
  CodePlannerProposalDraft,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePlannerCommand = Schema.decodeUnknownSync(
  CodePlannerCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePlannerCommandOutcome = Schema.decodeUnknownSync(
  CodePlannerCommandOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePlannerProposalCommand = Schema.decodeUnknownSync(
  CodePlannerProposalCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePlannerProposalOutcome = Schema.decodeUnknownSync(
  CodePlannerProposalOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePlannerView = Schema.decodeUnknownSync(
  CodePlannerView,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePlannerDesignationUpdated = Schema.decodeUnknownSync(
  CodePlannerDesignationUpdated,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePlannerProposalUpdated = Schema.decodeUnknownSync(
  CodePlannerProposalUpdated,
  STRICT_DECODE_OPTIONS,
);
