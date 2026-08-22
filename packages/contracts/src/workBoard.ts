import { Schema } from "effect";
import { ThreadGoalStatus } from "./goal";
import { BindingRevisionId, ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { ThreadBoardReason, ThreadBoardStatus } from "./threadBoard";
import { ThreadBoardPullRequestSummaries } from "./threadBoardPullRequests";
import { UtcTimestamp } from "./events";
import { ThreadWorkingDirectory } from "./workingDirectory";
import { WorkThreadId } from "./workThreads";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes));
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );
const uniqueArray = <A, I, R>(schema: Schema.Schema<A, I, R>, maximum: number) =>
  Schema.Array(schema).pipe(
    Schema.filter((values) => values.length <= maximum && new Set(values).size === values.length),
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

export const WorkBoardFollowUpFilter = Schema.Literal("any", "only", "excluded");
export type WorkBoardFollowUpFilter = typeof WorkBoardFollowUpFilter.Type;

export const WorkBoardPendingRequestFilter = Schema.Literal("any", "only", "excluded");
export type WorkBoardPendingRequestFilter = typeof WorkBoardPendingRequestFilter.Type;

export const WorkThreadDeliverySatisfaction = Schema.Literal("pending", "waiting", "done");
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
}).annotations(strict);
export type WorkBoardQuery = typeof WorkBoardQuery.Type;

export const WorkBoardBinding = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("unbound") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("bound"),
    workingDirectory: ThreadWorkingDirectory,
    bindingRevisionId: Schema.optional(BindingRevisionId),
  }).annotations(strict),
);
export type WorkBoardBinding = typeof WorkBoardBinding.Type;

export const WorkBoardActiveRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pending"),
    requestKind: Schema.Literal("approval", "user-input"),
    summary: boundedNonEmptyText(MAX_WORK_BOARD_CARD_SUMMARY_BYTES),
  }).annotations(strict),
);
export type WorkBoardActiveRequest = typeof WorkBoardActiveRequest.Type;

export const WorkBoardArtifactSummary = Schema.Struct({
  count: Schema.Int.pipe(Schema.nonNegative()),
  latestDisplayName: Schema.optional(boundedNonEmptyText(MAX_WORK_BOARD_CARD_SUMMARY_BYTES)),
}).annotations(strict);
export type WorkBoardArtifactSummary = typeof WorkBoardArtifactSummary.Type;

export const WorkBoardCitationSummary = Schema.Struct({
  count: Schema.Int.pipe(Schema.nonNegative()),
  staleCount: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type WorkBoardCitationSummary = typeof WorkBoardCitationSummary.Type;

export const WorkBoardGoalState = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("present"),
    status: ThreadGoalStatus,
    objective: boundedNonEmptyText(MAX_WORK_BOARD_CARD_SUMMARY_BYTES),
  }).annotations(strict),
);
export type WorkBoardGoalState = typeof WorkBoardGoalState.Type;

export const WorkBoardChildRunSummary = Schema.Struct({
  active: Schema.Int.pipe(Schema.nonNegative()),
  completed: Schema.Int.pipe(Schema.nonNegative()),
  failed: Schema.Int.pipe(Schema.nonNegative()),
  unacknowledgedResults: Schema.Int.pipe(Schema.nonNegative()),
  latestSummary: Schema.optional(boundedNonEmptyText(2_048)),
}).annotations(strict);
export type WorkBoardChildRunSummary = typeof WorkBoardChildRunSummary.Type;

export const WorkBoardRecoveryReason = Schema.Literal(
  "project-projection-missing",
  "binding-revision-mismatch",
);
export type WorkBoardRecoveryReason = typeof WorkBoardRecoveryReason.Type;

export const WorkBoardRecovery = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("ok") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("recovering"),
    reasons: Schema.NonEmptyArray(WorkBoardRecoveryReason),
  }).annotations(strict),
);
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
}).annotations(strict);
export type WorkBoardCard = typeof WorkBoardCard.Type;

export const WorkBoardView = Schema.Struct({
  version: Schema.Literal(1),
  query: WorkBoardQuery,
  cards: Schema.Array(WorkBoardCard).pipe(
    Schema.filter(
      (cards) =>
        cards.length <= MAX_WORK_BOARD_CARDS &&
        new Set(cards.map((card) => card.threadId)).size === cards.length,
    ),
  ),
  generatedAt: UtcTimestamp,
}).annotations(strict);
export type WorkBoardView = typeof WorkBoardView.Type;

export const decodeWorkBoardStatus = Schema.decodeUnknownSync(WorkBoardStatus);
export const decodeWorkBoardStatusReason = Schema.decodeUnknownSync(WorkBoardStatusReason);
export const decodeWorkBoardQuery = Schema.decodeUnknownSync(WorkBoardQuery);
export const decodeWorkBoardCard = Schema.decodeUnknownSync(WorkBoardCard);
export const decodeWorkBoardView = Schema.decodeUnknownSync(WorkBoardView);
