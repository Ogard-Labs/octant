import { personDecides } from "./hostAnswer";
import { NonEmptyTrimmedString, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { Schema } from "effect";
import { ProjectId } from "./projects";
import { AggregateVersion, EventActor, UtcTimestamp } from "./events";
import { PermissionPersistence, ProviderInstanceId, ProviderModelId } from "./providers";
import { WorkArtifactRef } from "./workArtifacts";
import { CodeDeliveryTarget, CodeThreadId } from "./code";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

/**
 * Branded identity for a Work-to-Code promotion proposal. One proposal
 * owns one origin Work Project, one target Code Project, and one linked
 * Code thread (set when the user approves). The proposal never changes mode
 * silently and never carries Work filesystem authority into Code.
 */
export const WorkPromotionProposalId = brandedUuid("WorkPromotionProposalId");
export type WorkPromotionProposalId = typeof WorkPromotionProposalId.Type;

/**
 * Sanitized free-text summary of the selected Work context carried into the
 * promotion proposal. Rejects path separators and `file:`/`http(s):` schemes
 * so an absolute host path, source snippet, or authority URL can never leak
 * through the summary. Mirrors `WorkSafeDiagnostic` so the renderer reuses
 * one sanitized-text presentation across Work surfaces.
 */
const WorkPromotionSummaryText = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(8_000),
  Schema.makeFilter(
    (value) => !/[\\/]/.test(value) && !/(?:^|\s|[([{<])(file|https?):/i.test(value),
  ),
);

/**
 * Selected context carried from the Work thread into the promotion
 * proposal. The summary is sanitized free text; `artifactRefs` are opaque
 * renderer-facing refs (already path-separator-free via `WorkArtifactRef`)
 * the host re-resolves inside the Code Project only after the user approves.
 * No host path, no canonical root, no credential, no authority token, and no
 * Work binding receipt ever crosses into this selection.
 */
export const WorkPromotionContextSelection = Schema.Struct({
  summary: WorkPromotionSummaryText,
  artifactRefs: Schema.Array(WorkArtifactRef).check(Schema.isMaxLength(32)),
}).check(Schema.makeFilter((selection) => selection.artifactRefs.length > 0, { jsonSchema: {} }));
export type WorkPromotionContextSelection = typeof WorkPromotionContextSelection.Type;

export const WorkPromotionStatus = Schema.Literals([
  "proposed",
  "approved",
  "dismissed",
  "expired",
]);
export type WorkPromotionStatus = typeof WorkPromotionStatus.Type;

/**
 * The Code execution policy a promotion may propose. Structurally restricted
 * to `approval-gated` so a proposal can never carry `full-access` or `plan`
 * into Code. This enforces the product invariant that a promoted Code thread
 * starts approval-gated regardless of any remembered Code Project access.
 */
export const WorkPromotionCodeExecutionPolicy = Schema.Literal("approval-gated");
export type WorkPromotionCodeExecutionPolicy = typeof WorkPromotionCodeExecutionPolicy.Type;

/**
 * Work-to-Code promotion proposal. The `originProjectId` is the Work
 * Project whose work became software engineering; the `targetCodeProjectId`
 * is the Code Project the user would promote into. The
 * `proposedCodeExecutionPolicy` is structurally `approval-gated`, so the
 * proposal never silently starts Code with Full access. `linkedCodeThreadId`
 * is absent while the proposal is `proposed` and set when the user approves,
 * binding the proposal to the Code thread created through the ordinary
 * authoritative flow. The proposal never carries the Work binding root,
 * canonical root, binding receipt, or any host path; only the sanitized
 * `selectedContext` travels with it.
 */
export const WorkPromotionProposal = Schema.Struct({
  proposalId: WorkPromotionProposalId,
  originProjectId: ProjectId,
  targetCodeProjectId: ProjectId,
  selectedContext: WorkPromotionContextSelection,
  status: WorkPromotionStatus,
  proposedCodeExecutionPolicy: WorkPromotionCodeExecutionPolicy,
  proposedCodePermissionPersistence: PermissionPersistence,
  proposedBy: EventActor,
  proposedAt: UtcTimestamp,
  decidedAt: Schema.optional(UtcTimestamp),
  linkedCodeThreadId: Schema.optional(CodeThreadId),
  version: AggregateVersion,
})
  .check(
    Schema.makeFilter(
      (proposal) => {
        if (proposal.originProjectId === proposal.targetCodeProjectId) return false;
        if (proposal.status === "proposed") {
          return proposal.linkedCodeThreadId === undefined && proposal.decidedAt === undefined;
        }
        if (proposal.decidedAt === undefined) return false;
        return (proposal.linkedCodeThreadId !== undefined) === (proposal.status === "approved");
      },
      { jsonSchema: {} },
    ),
  )
  .annotate(personDecides);
export type WorkPromotionProposal = typeof WorkPromotionProposal.Type;

const ProposalTransitionFields = {
  proposalId: WorkPromotionProposalId,
  expectedVersion: AggregateVersion,
} as const;

/**
 * Authoritative Work promotion command. `propose-work-promotion` creates a
 * `proposed` proposal; `approve-work-promotion` is the only command that
 * transitions a proposal to `approved` and creates the linked Code thread, so
 * the mode never switches silently. `dismiss-work-promotion` and
 * `expire-work-promotion` are the user and system terminal transitions. The
 * approve command carries the Code thread configuration the user selects at
 * approval time; it never inherits Work filesystem authority. The server
 * derives `proposedBy`, `proposedAt`, and `decidedAt` from its own
 * authenticated actor and clock so callers cannot forge audit identity or
 * backdate transitions.
 */
export const WorkPromotionCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("propose-work-promotion"),
    proposalId: WorkPromotionProposalId,
    originProjectId: ProjectId,
    targetCodeProjectId: ProjectId,
    selectedContext: WorkPromotionContextSelection,
    proposedCodePermissionPersistence: PermissionPersistence,
  }),
  Schema.Struct({
    kind: Schema.Literal("approve-work-promotion"),
    ...ProposalTransitionFields,
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    deliveryTarget: CodeDeliveryTarget,
  }),
  Schema.Struct({
    kind: Schema.Literal("dismiss-work-promotion"),
    ...ProposalTransitionFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("expire-work-promotion"),
    ...ProposalTransitionFields,
  }),
]);
export type WorkPromotionCommand = typeof WorkPromotionCommand.Type;

export const WorkPromotionCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("work-promotion-proposed"),
    proposal: WorkPromotionProposal,
  }).check(
    Schema.makeFilter((result) => result.proposal.status === "proposed", { jsonSchema: {} }),
  ),
  Schema.Struct({
    kind: Schema.Literal("work-promotion-approved"),
    proposal: WorkPromotionProposal,
    linkedCodeThreadId: CodeThreadId,
  }).check(
    Schema.makeFilter(
      (result) =>
        result.proposal.status === "approved" &&
        result.proposal.linkedCodeThreadId === result.linkedCodeThreadId,
      { jsonSchema: {} },
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("work-promotion-dismissed"),
    proposal: WorkPromotionProposal,
  }).check(
    Schema.makeFilter((result) => result.proposal.status === "dismissed", { jsonSchema: {} }),
  ),
  Schema.Struct({
    kind: Schema.Literal("work-promotion-expired"),
    proposal: WorkPromotionProposal,
  }).check(Schema.makeFilter((result) => result.proposal.status === "expired", { jsonSchema: {} })),
]);
export type WorkPromotionCommandResult = typeof WorkPromotionCommandResult.Type;

export const WorkPromotionFailureCode = Schema.Literals([
  "invalid",
  "unauthorized",
  "stale",
  "not-found",
  "unsupported",
  "conflict",
  "unavailable",
  "interrupted",
]);
export type WorkPromotionFailureCode = typeof WorkPromotionFailureCode.Type;

export const WorkPromotionFailure = Schema.Struct({
  code: WorkPromotionFailureCode,
  message: NonEmptyTrimmedString,
  retryAfterMs: Schema.optional(PositiveInt),
});
export type WorkPromotionFailure = typeof WorkPromotionFailure.Type;

/**
 * Read-only Work promotion list for an authenticated window. Proposals
 * carry sanitized context only; no host path, binding receipt, or Work
 * filesystem authority crosses the wire.
 */
export const WorkPromotionList = Schema.Struct({
  proposals: Schema.Array(WorkPromotionProposal),
  artifactRefs: Schema.Array(WorkArtifactRef).check(Schema.isMaxLength(32)),
  deliveryTargets: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      deliveryTarget: CodeDeliveryTarget,
    }),
  ).check(Schema.isMaxLength(64)),
});
export type WorkPromotionList = typeof WorkPromotionList.Type;

/**
 * Journalable Work promotion frame. The server appends one frame per
 * promotion transition as a versioned `work.promotion-recorded@1` event;
 * the aggregate is the proposal and the aggregate version is the proposal
 * `version`, backing optimistic concurrency on `expectedVersion`. The frame
 * carries the sanitized proposal snapshot (no host path, no credential, no
 * Work binding authority) plus the transition kind; the approved frame also
 * carries the linked Code thread id, which must match the proposal's
 * `linkedCodeThreadId` and require `status === "approved"`. Projections replay
 * frames to rebuild proposal state idempotently.
 */
export const WorkPromotionFrame = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("proposed"),
    proposal: WorkPromotionProposal,
  }).check(Schema.makeFilter((frame) => frame.proposal.status === "proposed", { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("approved"),
    proposal: WorkPromotionProposal,
    linkedCodeThreadId: CodeThreadId,
  }).check(
    Schema.makeFilter(
      (frame) =>
        frame.proposal.status === "approved" &&
        frame.proposal.linkedCodeThreadId === frame.linkedCodeThreadId,
      { jsonSchema: {} },
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("dismissed"),
    proposal: WorkPromotionProposal,
  }).check(Schema.makeFilter((frame) => frame.proposal.status === "dismissed", { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("expired"),
    proposal: WorkPromotionProposal,
  }).check(Schema.makeFilter((frame) => frame.proposal.status === "expired", { jsonSchema: {} })),
]);
export type WorkPromotionFrame = typeof WorkPromotionFrame.Type;

export const WORK_PROMOTION_EVENT_NAMES = ["work.promotion-recorded@1"] as const;
export type WorkPromotionEventName = (typeof WORK_PROMOTION_EVENT_NAMES)[number];

export const decodeWorkPromotionProposalId = Schema.decodeUnknownSync(
  WorkPromotionProposalId,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkPromotionProposal = Schema.decodeUnknownSync(
  WorkPromotionProposal,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkPromotionContextSelection = Schema.decodeUnknownSync(
  WorkPromotionContextSelection,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkPromotionCommand = Schema.decodeUnknownSync(
  WorkPromotionCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkPromotionCommandResult = Schema.decodeUnknownSync(
  WorkPromotionCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkPromotionFailure = Schema.decodeUnknownSync(
  WorkPromotionFailure,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkPromotionList = Schema.decodeUnknownSync(
  WorkPromotionList,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkPromotionFrame = Schema.decodeUnknownSync(
  WorkPromotionFrame,
  STRICT_DECODE_OPTIONS,
);

export function decodeWorkPromotionEventPayload(
  eventName: WorkPromotionEventName | string,
  payload: unknown,
): unknown {
  switch (eventName) {
    case "work.promotion-recorded@1":
      return decodeWorkPromotionFrame(payload);
    default:
      throw new Error("Unknown Work promotion persistence event");
  }
}
