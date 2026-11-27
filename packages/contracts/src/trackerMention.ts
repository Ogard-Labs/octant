import { Schema } from "effect";
import { ProjectId } from "./projects";
import { MentionableThreadId } from "./threadMentionIdentity";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The pull requests and issues one sent message may record. */
export const MAX_TRACKER_MENTIONS_PER_TURN = 20;
/** The pull requests and issues one `#` search may offer. */
export const MAX_TRACKER_MENTION_CANDIDATES = 10;

export const TrackerMentionKind = Schema.Literal("pull-request", "github-issue", "linear-issue");
export type TrackerMentionKind = typeof TrackerMentionKind.Type;

export const TrackerMentionSource = Schema.Literal("github", "linear");
export type TrackerMentionSource = typeof TrackerMentionSource.Type;

/** A web page of the item on its own tracker; never another site, never a credential. */
export const TrackerMentionUrl = Schema.String.pipe(
  Schema.maxLength(512),
  Schema.pattern(
    /^https:\/\/(?:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/[1-9]\d{0,8}|linear\.app\/[A-Za-z0-9_.-]+\/issue\/[A-Z][A-Z0-9]{0,9}-\d{1,9}(?:\/[A-Za-z0-9_.\-%]*)?)$/,
  ),
);

/** A GitHub number (`2901`) or a Linear key (`OCT-1042`). */
export const TrackerMentionItemId = Schema.String.pipe(
  Schema.pattern(/^(?:[1-9]\d{0,8}|[A-Z][A-Z0-9]{0,9}-\d{1,9})$/),
);

const sourceMatchesKind = (value: {
  readonly kind: TrackerMentionKind;
  readonly source: TrackerMentionSource;
}) => (value.kind === "linear-issue") === (value.source === "linear");

/**
 * One pull request or issue a sent message mentioned. The turn keeps exactly
 * this, so its chip survives a reload and a replay without asking the tracker,
 * and nothing here grants the agent any read.
 */
export const TrackerMention = Schema.Struct({
  kind: TrackerMentionKind,
  source: TrackerMentionSource,
  id: TrackerMentionItemId,
  url: TrackerMentionUrl,
})
  .annotations(strict)
  .pipe(Schema.filter(sourceMatchesKind));
export type TrackerMention = typeof TrackerMention.Type;

export const TrackerMentions = Schema.Array(TrackerMention).pipe(
  Schema.maxItems(MAX_TRACKER_MENTIONS_PER_TURN),
);

const shortText = (limit: number) => Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(limit));

/** One hit of the `#` list, with the facts its card shows. */
export const TrackerMentionCandidate = Schema.Struct({
  kind: TrackerMentionKind,
  source: TrackerMentionSource,
  id: TrackerMentionItemId,
  url: TrackerMentionUrl,
  title: shortText(256),
  /** `open`, `draft`, `merged` or `closed` on GitHub; the workflow state's name on Linear. */
  state: shortText(64),
  /** `owner/name` on GitHub; the team's key on Linear. */
  container: shortText(160),
  /** The author on GitHub; the assignee on Linear, absent while nobody is assigned. */
  person: Schema.optional(shortText(128)),
})
  .annotations(strict)
  .pipe(Schema.filter(sourceMatchesKind));
export type TrackerMentionCandidate = typeof TrackerMentionCandidate.Type;

/**
 * A search of the `#` list. The composer names its thread, or the Project a new
 * thread would start in; the host decides the repository and team from that.
 */
export const TrackerMentionSearchRequest = Schema.Struct({
  query: Schema.String.pipe(Schema.maxLength(128)),
  readerThreadId: Schema.optional(MentionableThreadId),
  projectId: Schema.optional(ProjectId),
}).annotations(strict);
export type TrackerMentionSearchRequest = typeof TrackerMentionSearchRequest.Type;

export const TrackerMentionSearchResponse = Schema.Struct({
  candidates: Schema.Array(TrackerMentionCandidate).pipe(
    Schema.maxItems(MAX_TRACKER_MENTION_CANDIDATES),
  ),
}).annotations(strict);
export type TrackerMentionSearchResponse = typeof TrackerMentionSearchResponse.Type;

export const decodeTrackerMention = Schema.decodeUnknownSync(TrackerMention);
export const decodeTrackerMentionCandidate = Schema.decodeUnknownSync(TrackerMentionCandidate);
export const decodeTrackerMentionSearchRequest = Schema.decodeUnknownSync(
  TrackerMentionSearchRequest,
);
export const decodeTrackerMentionSearchResponse = Schema.decodeUnknownSync(
  TrackerMentionSearchResponse,
);
