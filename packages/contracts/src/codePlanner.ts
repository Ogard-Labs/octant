import { Schema } from "effect";
import {
  CodeCommandResult,
  CodeThreadId,
  CreateCodeThreadCommand,
  CreateManagedCodeThreadCommand,
  MAX_CODE_THREAD_TITLE_LENGTH,
} from "./code";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const CodePlannerProposalId = Schema.UUID.pipe(Schema.brand("CodePlannerProposalId"));
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
export const CodePlannerDesignation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("designated"),
    projectId: ProjectId,
    plannerThreadId: CodeThreadId,
    designatedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("none"),
    projectId: ProjectId,
    updatedAt: UtcTimestamp,
  }).annotations(strict),
);
export type CodePlannerDesignation = typeof CodePlannerDesignation.Type;

const CodePlannerProposalFields = {
  id: CodePlannerProposalId,
  projectId: ProjectId,
  plannerThreadId: CodeThreadId,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_CODE_THREAD_TITLE_LENGTH)),
  intent: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(MAX_CODE_PLANNER_PROPOSAL_INTENT_LENGTH),
  ),
  rationale: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_CODE_PLANNER_PROPOSAL_RATIONALE_LENGTH)),
  ),
  proposedAt: UtcTimestamp,
} as const;

/**
 * A planner-authored, approval-gated proposal to create one new Code thread.
 * It is advisory until the user acts: confirming routes creation through the
 * ordinary thread-creation command, and declining discards it. The proposal
 * itself can never create, start, or redirect anything.
 */
export const CodePlannerWorkProposal = Schema.Union(
  Schema.Struct({
    ...CodePlannerProposalFields,
    status: Schema.Literal("pending"),
  }).annotations(strict),
  Schema.Struct({
    ...CodePlannerProposalFields,
    status: Schema.Literal("confirmed"),
    resolvedAt: UtcTimestamp,
    createdThreadId: CodeThreadId,
  }).annotations(strict),
  Schema.Struct({
    ...CodePlannerProposalFields,
    status: Schema.Literal("declined"),
    resolvedAt: UtcTimestamp,
  }).annotations(strict),
);
export type CodePlannerWorkProposal = typeof CodePlannerWorkProposal.Type;

/** What a planner agent submits; identity and timestamps are server-stamped. */
export const CodePlannerProposalDraft = Schema.Struct({
  title: CodePlannerProposalFields.title,
  intent: CodePlannerProposalFields.intent,
  rationale: CodePlannerProposalFields.rationale,
}).annotations(strict);
export type CodePlannerProposalDraft = typeof CodePlannerProposalDraft.Type;

export const CodePlannerCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("designate-code-planner-thread"),
    projectId: ProjectId,
    threadId: CodeThreadId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("undesignate-code-planner-thread"),
    projectId: ProjectId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
);
export type CodePlannerCommand = typeof CodePlannerCommand.Type;

/**
 * Why a designation command was refused. Each refusal is an expected answer a
 * caller must handle, never an exception: the thread may live in another
 * Project, may not exist, or the Project may already have its one planner.
 */
export const CodePlannerDesignationRefusalReason = Schema.Literal(
  "project-unavailable",
  "thread-not-found",
  "thread-in-another-project",
  "thread-archived",
  "planner-already-designated",
  "no-planner-designated",
  "designation-changed",
);
export type CodePlannerDesignationRefusalReason = typeof CodePlannerDesignationRefusalReason.Type;

export const CodePlannerCommandOutcome = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("designated"),
    designation: CodePlannerDesignation,
    designationVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("undesignated"),
    designation: CodePlannerDesignation,
    designationVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: CodePlannerDesignationRefusalReason,
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type CodePlannerCommandOutcome = typeof CodePlannerCommandOutcome.Type;

/**
 * The two creation commands a confirmed proposal may route through. They are
 * the exact contracts the create dialog already sends, so confirming a
 * proposal takes no shortcut the user could not take by hand.
 */
export const CodePlannerThreadCreation = Schema.Union(
  CreateManagedCodeThreadCommand,
  CreateCodeThreadCommand,
);
export type CodePlannerThreadCreation = typeof CodePlannerThreadCreation.Type;

export const CodePlannerProposalCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("confirm-planner-work-proposal"),
    proposalId: CodePlannerProposalId,
    expectedVersion: AggregateVersion,
    creation: CodePlannerThreadCreation,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("decline-planner-work-proposal"),
    proposalId: CodePlannerProposalId,
    expectedVersion: AggregateVersion,
  }).annotations(strict),
);
export type CodePlannerProposalCommand = typeof CodePlannerProposalCommand.Type;

export const CodePlannerProposalRefusalReason = Schema.Literal(
  "proposal-not-found",
  "proposal-not-pending",
  "creation-project-mismatch",
  "proposal-changed",
);
export type CodePlannerProposalRefusalReason = typeof CodePlannerProposalRefusalReason.Type;

export const CodePlannerProposalOutcome = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("confirmed"),
    proposal: CodePlannerWorkProposal,
    creation: CodeCommandResult,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("declined"),
    proposal: CodePlannerWorkProposal,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: CodePlannerProposalRefusalReason,
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
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
    }).annotations(strict),
  ),
}).annotations(strict);
export type CodePlannerView = typeof CodePlannerView.Type;

export const CodePlannerDesignationUpdated = Schema.Struct({
  kind: Schema.Literal("planner-designation-updated"),
  designation: CodePlannerDesignation,
}).annotations(strict);
export type CodePlannerDesignationUpdated = typeof CodePlannerDesignationUpdated.Type;

export const CodePlannerProposalUpdated = Schema.Struct({
  kind: Schema.Literal("planner-proposal-updated"),
  proposal: CodePlannerWorkProposal,
}).annotations(strict);
export type CodePlannerProposalUpdated = typeof CodePlannerProposalUpdated.Type;

export const CODE_PLANNER_EVENT_NAMES = [
  "code.planner-designation-updated@1",
  "code.planner-proposal-updated@1",
] as const;

export const decodeCodePlannerProposalId = Schema.decodeUnknownSync(CodePlannerProposalId);
export const decodeCodePlannerDesignation = Schema.decodeUnknownSync(CodePlannerDesignation);
export const decodeCodePlannerWorkProposal = Schema.decodeUnknownSync(CodePlannerWorkProposal);
export const decodeCodePlannerProposalDraft = Schema.decodeUnknownSync(CodePlannerProposalDraft);
export const decodeCodePlannerCommand = Schema.decodeUnknownSync(CodePlannerCommand);
export const decodeCodePlannerCommandOutcome = Schema.decodeUnknownSync(CodePlannerCommandOutcome);
export const decodeCodePlannerProposalCommand = Schema.decodeUnknownSync(
  CodePlannerProposalCommand,
);
export const decodeCodePlannerProposalOutcome = Schema.decodeUnknownSync(
  CodePlannerProposalOutcome,
);
export const decodeCodePlannerView = Schema.decodeUnknownSync(CodePlannerView);
export const decodeCodePlannerDesignationUpdated = Schema.decodeUnknownSync(
  CodePlannerDesignationUpdated,
);
export const decodeCodePlannerProposalUpdated = Schema.decodeUnknownSync(
  CodePlannerProposalUpdated,
);
