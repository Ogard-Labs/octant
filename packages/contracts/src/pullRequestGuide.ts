/**
 * Review guides and Viewed files for a pull request's reading pane.
 *
 * A guide is an ordered list of stops through one pull request head, written
 * by a read-only model run the person routes. Each stop anchors into the
 * diff at that head. The host keeps one guide per head and journals each run
 * on the `pull-request-guide` aggregate. Viewed state is GitHub's own and is
 * never journaled here; these shapes only carry it to the window.
 *
 * Kept out of the package index so the renderer loads it only with the Guide
 * tab.
 */

import { Schema } from "effect";
import { CodeRelativePath, CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { ProjectId } from "./projects";
import { TurnUsage } from "./turnMetrics";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();

const boundedText = (minimumChars: number, maximumBytes: number) =>
  Schema.String.pipe(
    Schema.filter(
      (value) =>
        value.trim().length >= minimumChars &&
        encoder.encode(value).byteLength <= maximumBytes &&
        !value.includes("\u0000"),
    ),
  );

const GitObjectId = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/));

/** Stops one guide may hold. */
export const MAX_PULL_REQUEST_GUIDE_STOPS = 30;
/** Anchors one stop may hold. */
export const MAX_PULL_REQUEST_GUIDE_ANCHORS = 8;
/** UTF-8 bytes of model output a guide run may return before it is refused. */
export const MAX_PULL_REQUEST_GUIDE_OUTPUT_BYTES = 16 * 1024;
/** Characters of a stop's title. */
export const MAX_PULL_REQUEST_GUIDE_TITLE_CHARS = 120;
/** UTF-8 bytes of a stop's "why it matters". */
export const MAX_PULL_REQUEST_GUIDE_WHY_BYTES = 1024;
/** Changed files one Viewed read returns. GitHub lists at most 3,000. */
export const MAX_PULL_REQUEST_VIEWED_FILES = 3_000;

/**
 * The pull request a guide or a Viewed change is for; the same shape as the
 * reviewer's target. Declared here rather than imported so the Guide tab's
 * lazy chunk does not pull the reviewer contracts (and the agent-run schemas
 * they import) out of their shared chunk: that split grew first paint by
 * about 860 bytes gzip.
 */
export const PullRequestGuideTarget = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type PullRequestGuideTarget = typeof PullRequestGuideTarget.Type;

export const PullRequestGuideId = Schema.UUID.pipe(Schema.brand("PullRequestGuideId"));
export type PullRequestGuideId = typeof PullRequestGuideId.Type;

/** A line range on the head side of the diff, at the guide's head commit. */
export const PullRequestGuideAnchor = Schema.Struct({
  path: CodeRelativePath,
  startLine: Schema.Int.pipe(Schema.positive()),
  endLine: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type PullRequestGuideAnchor = typeof PullRequestGuideAnchor.Type;

/** One stop. A stop whose anchors the host all dropped is kept and reads as unanchored. */
export const PullRequestGuideStop = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[a-z0-9-]{1,64}$/)),
  title: boundedText(1, MAX_PULL_REQUEST_GUIDE_TITLE_CHARS * 4).pipe(
    Schema.filter((value) => [...value].length <= MAX_PULL_REQUEST_GUIDE_TITLE_CHARS),
  ),
  why: boundedText(0, MAX_PULL_REQUEST_GUIDE_WHY_BYTES),
  needsDecision: Schema.Boolean,
  anchors: Schema.Array(PullRequestGuideAnchor).pipe(
    Schema.maxItems(MAX_PULL_REQUEST_GUIDE_ANCHORS),
  ),
}).annotations(strict);
export type PullRequestGuideStop = typeof PullRequestGuideStop.Type;

export const PullRequestGuideRequester = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("person") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: CodeThreadId }).annotations(strict),
);
export type PullRequestGuideRequester = typeof PullRequestGuideRequester.Type;

export const PullRequestGuideFailureReason = Schema.Literal(
  "no-model",
  "spend-ceiling",
  "head-stale",
  "invalid-output",
  "cancelled",
  "unavailable",
);
export type PullRequestGuideFailureReason = typeof PullRequestGuideFailureReason.Type;

/** Journal aggregate type and event names; one aggregate per pull-request link. */
export const PULL_REQUEST_GUIDE_AGGREGATE_TYPE = "pull-request-guide";
export const PULL_REQUEST_GUIDE_EVENT_NAMES = {
  runStarted: "pull-request-guide.run-started@1",
  recorded: "pull-request-guide.recorded@1",
  runFailed: "pull-request-guide.run-failed@1",
} as const;

export const PullRequestGuideRunStartedEvent = Schema.Struct({
  kind: Schema.Literal("pull-request-guide-run-started"),
  guideId: PullRequestGuideId,
  /** The pull-request link's key: Project, repository and number. */
  linkId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
  headSha: GitObjectId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  requestedBy: PullRequestGuideRequester,
  reservationId: Schema.UUID,
}).annotations(strict);
export type PullRequestGuideRunStartedEvent = typeof PullRequestGuideRunStartedEvent.Type;

export const PullRequestGuideRecordedEvent = Schema.Struct({
  kind: Schema.Literal("pull-request-guide-recorded"),
  guideId: PullRequestGuideId,
  headSha: GitObjectId,
  stops: Schema.Array(PullRequestGuideStop).pipe(Schema.maxItems(MAX_PULL_REQUEST_GUIDE_STOPS)),
  usage: Schema.optional(TurnUsage),
}).annotations(strict);
export type PullRequestGuideRecordedEvent = typeof PullRequestGuideRecordedEvent.Type;

export const PullRequestGuideRunFailedEvent = Schema.Struct({
  kind: Schema.Literal("pull-request-guide-run-failed"),
  guideId: PullRequestGuideId,
  reason: PullRequestGuideFailureReason,
}).annotations(strict);
export type PullRequestGuideRunFailedEvent = typeof PullRequestGuideRunFailedEvent.Type;

/** The guide a reader sees: the latest one written for this link. */
export const PullRequestGuide = Schema.Struct({
  guideId: PullRequestGuideId,
  headSha: GitObjectId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  stops: Schema.Array(PullRequestGuideStop).pipe(Schema.maxItems(MAX_PULL_REQUEST_GUIDE_STOPS)),
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type PullRequestGuide = typeof PullRequestGuide.Type;

export const PullRequestGuideView = Schema.Struct({
  guide: Schema.optional(PullRequestGuide),
  /** True when the guide was written for an older head than the one read. */
  stale: Schema.Boolean,
  running: Schema.Boolean,
  lastFailure: Schema.optional(PullRequestGuideFailureReason),
  /** Whether this Project has a guide model; without one nothing runs. */
  modelPicked: Schema.Boolean,
}).annotations(strict);
export type PullRequestGuideView = typeof PullRequestGuideView.Type;

export const PullRequestGuideQuery = Schema.Struct({
  target: PullRequestGuideTarget,
  /** The head the reader shows; the guide reads stale against it. */
  headSha: Schema.optional(GitObjectId),
}).annotations(strict);
export type PullRequestGuideQuery = typeof PullRequestGuideQuery.Type;

export const PullRequestGuideWriteCommand = Schema.Struct({
  target: PullRequestGuideTarget,
}).annotations(strict);
export type PullRequestGuideWriteCommand = typeof PullRequestGuideWriteCommand.Type;

/** GitHub's `viewerViewedState`; `changed` is GitHub's DISMISSED: the file moved after it was viewed. */
export const PullRequestViewedState = Schema.Literal("viewed", "unviewed", "changed");
export type PullRequestViewedState = typeof PullRequestViewedState.Type;

export const PullRequestViewedView = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({ path: CodeRelativePath, state: PullRequestViewedState }).annotations(strict),
  ).pipe(Schema.maxItems(MAX_PULL_REQUEST_VIEWED_FILES)),
}).annotations(strict);
export type PullRequestViewedView = typeof PullRequestViewedView.Type;

export const PullRequestViewedQuery = Schema.Struct({
  target: PullRequestGuideTarget,
}).annotations(strict);
export type PullRequestViewedQuery = typeof PullRequestViewedQuery.Type;

export const PullRequestViewedCommand = Schema.Struct({
  target: PullRequestGuideTarget,
  path: CodeRelativePath,
  viewed: Schema.Boolean,
  /**
   * The head the person reviewed. GitHub marks the file at whatever head it
   * has now, so a push since then refuses the mark instead of claiming the
   * newer changes were seen.
   */
  headSha: Schema.optional(GitObjectId),
}).annotations(strict);
export type PullRequestViewedCommand = typeof PullRequestViewedCommand.Type;

export const decodePullRequestGuideId = Schema.decodeUnknownSync(PullRequestGuideId);
export const decodePullRequestGuideStop = Schema.decodeUnknownSync(PullRequestGuideStop);
export const decodePullRequestGuideView = Schema.decodeUnknownSync(PullRequestGuideView);
export const decodePullRequestGuideQuery = Schema.decodeUnknownSync(PullRequestGuideQuery);
export const decodePullRequestGuideWriteCommand = Schema.decodeUnknownSync(
  PullRequestGuideWriteCommand,
);
export const decodePullRequestViewedView = Schema.decodeUnknownSync(PullRequestViewedView);
export const decodePullRequestViewedQuery = Schema.decodeUnknownSync(PullRequestViewedQuery);
export const decodePullRequestViewedCommand = Schema.decodeUnknownSync(PullRequestViewedCommand);
