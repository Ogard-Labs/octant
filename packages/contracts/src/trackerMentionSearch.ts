import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ProjectId } from "./projects";
import { MentionableThreadId } from "./threadMentionIdentity";
import {
  TrackerMentionItemId,
  TrackerMentionKind,
  TrackerMentionSource,
  TrackerMentionUrl,
} from "./trackerMention";

/*
 * The `#` search's own wire shapes. They are imported by subpath alone, so the
 * window loads them with the search and not at startup.
 */

/** The pull requests and issues one `#` search may offer. */
export const MAX_TRACKER_MENTION_CANDIDATES = 10;

const shortText = (limit: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(limit));

const trackerSourceMatchesKind = (value: {
  readonly kind: typeof TrackerMentionKind.Type;
  readonly source: typeof TrackerMentionSource.Type;
}) => (value.kind === "linear-issue") === (value.source === "linear");

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
}).check(Schema.makeFilter(trackerSourceMatchesKind));
export type TrackerMentionCandidate = typeof TrackerMentionCandidate.Type;

/**
 * A search of the `#` list. The composer names its thread, or the Project a new
 * thread would start in; the host decides the repository and team from that.
 */
export const TrackerMentionSearchRequest = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(128)),
  readerThreadId: Schema.optional(MentionableThreadId),
  projectId: Schema.optional(ProjectId),
});
export type TrackerMentionSearchRequest = typeof TrackerMentionSearchRequest.Type;

export const TrackerMentionSearchResponse = Schema.Struct({
  candidates: Schema.Array(TrackerMentionCandidate).check(
    Schema.isMaxLength(MAX_TRACKER_MENTION_CANDIDATES),
  ),
});
export type TrackerMentionSearchResponse = typeof TrackerMentionSearchResponse.Type;

export const decodeTrackerMentionCandidate = Schema.decodeUnknownSync(
  TrackerMentionCandidate,
  STRICT_DECODE_OPTIONS,
);
export const decodeTrackerMentionSearchRequest = Schema.decodeUnknownSync(
  TrackerMentionSearchRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeTrackerMentionSearchResponse = Schema.decodeUnknownSync(
  TrackerMentionSearchResponse,
  STRICT_DECODE_OPTIONS,
);
