import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ThreadGoalStatus } from "./goal";
import { ThreadBoardFinishedMark } from "./finishedReceipt";
import { BindingRevisionId, ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { ThreadBoardReason, ThreadBoardStatus } from "./threadBoard";
import { ThreadBoardPullRequestSummaries } from "./threadBoardPullRequests";
import { UtcTimestamp } from "./events";
import { ThreadWorkingDirectory } from "./workingDirectory";
import { WorkThreadId } from "./workThreads";

const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );
const uniqueArray = <S extends Schema.Top>(schema: S, maximum: number) =>
  Schema.Array(schema).check(
    Schema.makeFilter(
      (values) => values.length <= maximum && new Set(values).size === values.length,
    ),
  );

export const MAX_WORK_BOARD_SEARCH_BYTES = 1_024;
export const MAX_WORK_BOARD_QUERY_PROJECTS = 1_000;
export const MAX_WORK_BOARD_QUERY_PROVIDERS = 256;
export const MAX_WORK_BOARD_CARDS = 5_000;
export const MAX_WORK_BOARD_CARD_BLOCKING_REASON_BYTES = 2_048;
export const MAX_WORK_BOARD_CARD_SUMMARY_BYTES = 512;

/**
 * The runtime-derived status of a Work thread on the board. It is the shared
 * Work and Code `ThreadBoardStatus`: always projected from authoritative
 * runtime, recovery, and delivery-target evidence, never assigned by hand.
 * Ambiguous or stale evidence can never produce `done`.
 */
export const WorkBoardStatus = ThreadBoardStatus;
export type WorkBoardStatus = ThreadBoardStatus;
export const WorkBoardStatusReason = ThreadBoardReason;
export type WorkBoardStatusReason = ThreadBoardReason;

export const WorkBoardFollowUpFilter = Schema.Literals(["any", "only", "excluded"]);
export type WorkBoardFollowUpFilter = typeof WorkBoardFollowUpFilter.Type;

export const WorkBoardPendingRequestFilter = Schema.Literals(["any", "only", "excluded"]);
export type WorkBoardPendingRequestFilter = typeof WorkBoardPendingRequestFilter.Type;

export const WorkThreadDeliverySatisfaction = Schema.Literals(["pending", "waiting", "done"]);
export type WorkThreadDeliverySatisfaction = typeof WorkThreadDeliverySatisfaction.Type;

/**
 * The server-side Work board query. Every filter is optional; an omitted
 * `statuses` filter means the default all-status board, so completed threads
 * are never implicitly suppressed. Grouping is a client concern and is
 * deliberately not part of the query.
 */
export const WorkBoardQuery = Schema.Struct({
  version: Schema.Literal(1),
  text: Schema.optional(boundedText(MAX_WORK_BOARD_SEARCH_BYTES)),
  statuses: Schema.optional(uniqueArray(WorkBoardStatus, 4)),
  projectIds: Schema.optional(uniqueArray(ProjectId, MAX_WORK_BOARD_QUERY_PROJECTS)),
  providerInstanceIds: Schema.optional(
    uniqueArray(ProviderInstanceId, MAX_WORK_BOARD_QUERY_PROVIDERS),
  ),
  followUp: Schema.optional(WorkBoardFollowUpFilter),
  pendingRequest: Schema.optional(WorkBoardPendingRequestFilter),
});
export type WorkBoardQuery = typeof WorkBoardQuery.Type;

export const WorkBoardBinding = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unbound") }),
  Schema.Struct({
    kind: Schema.Literal("bound"),
    workingDirectory: ThreadWorkingDirectory,
    bindingRevisionId: Schema.optional(BindingRevisionId),
  }),
]);
export type WorkBoardBinding = typeof WorkBoardBinding.Type;

export const WorkBoardActiveRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("pending"),
    requestKind: Schema.Literals(["approval", "user-input"]),
    summary: boundedNonEmptyText(MAX_WORK_BOARD_CARD_SUMMARY_BYTES),
  }),
]);
export type WorkBoardActiveRequest = typeof WorkBoardActiveRequest.Type;

export const WorkBoardArtifactSummary = Schema.Struct({
  count: NonNegativeInt,
  latestDisplayName: Schema.optional(boundedNonEmptyText(MAX_WORK_BOARD_CARD_SUMMARY_BYTES)),
});
export type WorkBoardArtifactSummary = typeof WorkBoardArtifactSummary.Type;

export const WorkBoardCitationSummary = Schema.Struct({
  count: NonNegativeInt,
  staleCount: NonNegativeInt,
});
export type WorkBoardCitationSummary = typeof WorkBoardCitationSummary.Type;

export const WorkBoardGoalState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("present"),
    status: ThreadGoalStatus,
    objective: boundedNonEmptyText(MAX_WORK_BOARD_CARD_SUMMARY_BYTES),
  }),
]);
export type WorkBoardGoalState = typeof WorkBoardGoalState.Type;

export const WorkBoardChildRunSummary = Schema.Struct({
  active: NonNegativeInt,
  completed: NonNegativeInt,
  failed: NonNegativeInt,
  unacknowledgedResults: NonNegativeInt,
  latestSummary: Schema.optional(boundedNonEmptyText(2_048)),
});
export type WorkBoardChildRunSummary = typeof WorkBoardChildRunSummary.Type;

export const WorkBoardRecoveryReason = Schema.Literals([
  "project-projection-missing",
  "binding-revision-mismatch",
]);
export type WorkBoardRecoveryReason = typeof WorkBoardRecoveryReason.Type;

export const WorkBoardRecovery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ok") }),
  Schema.Struct({
    kind: Schema.Literal("recovering"),
    reasons: Schema.NonEmptyArray(WorkBoardRecoveryReason),
  }),
]);
export type WorkBoardRecovery = typeof WorkBoardRecovery.Type;

/**
 * One normalized, server-resolved Work board card per non-archived Work
 * thread that matches the active query. Work-specific facts (confined root
 * binding, active request, artifacts, citations, goal) live here rather than
 * as nullable fields on the Code card. Follow-up is carried but never
 * influences `status`. Client-specific unread is omitted.
 */
export const WorkBoardCard = Schema.Struct({
  threadId: WorkThreadId,
  projectId: ProjectId,
  title: boundedNonEmptyText(512),
  status: WorkBoardStatus,
  statusReason: WorkBoardStatusReason,
  deliveryTarget: boundedNonEmptyText(512),
  deliverySatisfaction: WorkThreadDeliverySatisfaction,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  executing: Schema.Boolean,
  binding: WorkBoardBinding,
  activeRequest: WorkBoardActiveRequest,
  artifacts: WorkBoardArtifactSummary,
  citations: WorkBoardCitationSummary,
  goal: WorkBoardGoalState,
  childRuns: WorkBoardChildRunSummary,
  pullRequestSummaries: ThreadBoardPullRequestSummaries,
  recovery: WorkBoardRecovery,
  staleEvidence: Schema.Boolean,
  blockingReason: Schema.optional(boundedNonEmptyText(MAX_WORK_BOARD_CARD_BLOCKING_REASON_BYTES)),
  followUp: Schema.Boolean,
  lastMeaningfulActivityAt: Schema.NullOr(UtcTimestamp),
  /** Fresh finished-with-proof mark; absent when none exists or when stale. Never moves the column. */
  finishedReceipt: Schema.optional(ThreadBoardFinishedMark),
});
export type WorkBoardCard = typeof WorkBoardCard.Type;

export const WorkBoardView = Schema.Struct({
  version: Schema.Literal(1),
  query: WorkBoardQuery,
  cards: Schema.Array(WorkBoardCard).check(
    Schema.makeFilter(
      (cards) =>
        cards.length <= MAX_WORK_BOARD_CARDS &&
        new Set(cards.map((card) => card.threadId)).size === cards.length,
    ),
  ),
  generatedAt: UtcTimestamp,
});
export type WorkBoardView = typeof WorkBoardView.Type;

export const decodeWorkBoardStatus = Schema.decodeUnknownSync(
  WorkBoardStatus,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkBoardStatusReason = Schema.decodeUnknownSync(
  WorkBoardStatusReason,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkBoardQuery = Schema.decodeUnknownSync(WorkBoardQuery, STRICT_DECODE_OPTIONS);
export const decodeWorkBoardCard = Schema.decodeUnknownSync(WorkBoardCard, STRICT_DECODE_OPTIONS);
export const decodeWorkBoardView = Schema.decodeUnknownSync(WorkBoardView, STRICT_DECODE_OPTIONS);
