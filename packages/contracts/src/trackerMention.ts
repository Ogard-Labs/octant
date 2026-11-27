import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The pull requests and issues one sent message may record. */
export const MAX_TRACKER_MENTIONS_PER_TURN = 20;

export const TrackerMentionKind = Schema.Literal("pull-request", "github-issue", "linear-issue");
export type TrackerMentionKind = typeof TrackerMentionKind.Type;

export const TrackerMentionSource = Schema.Literal("github", "linear");
export type TrackerMentionSource = typeof TrackerMentionSource.Type;

/** A web page on one of the two trackers, never another site and never a credential. */
export const TrackerMentionUrl = Schema.String.pipe(
  Schema.maxLength(512),
  Schema.pattern(/^https:\/\/(?:github\.com|linear\.app)\/[A-Za-z0-9_.\-%/]+$/),
);

/** A GitHub number (`2901`) or a Linear key (`ENG-12`). */
export const TrackerMentionItemId = Schema.String.pipe(
  Schema.pattern(/^(?:[1-9]\d{0,8}|[A-Z][A-Z0-9]{0,9}-\d{1,9})$/),
);

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
}).annotations(strict);
export type TrackerMention = typeof TrackerMention.Type;

export const TrackerMentions = Schema.Array(TrackerMention).pipe(
  Schema.maxItems(MAX_TRACKER_MENTIONS_PER_TURN),
);
