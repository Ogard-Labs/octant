import { Schema } from "effect";

/** The pull requests and issues one sent message may record. */
export const MAX_TRACKER_MENTIONS_PER_TURN = 20;

export const TrackerMentionKind = Schema.Literals(["pull-request", "github-issue", "linear-issue"]);
export type TrackerMentionKind = typeof TrackerMentionKind.Type;

export const TrackerMentionSource = Schema.Literals(["github", "linear"]);
export type TrackerMentionSource = typeof TrackerMentionSource.Type;

/** A web page on one of the two trackers, never another site and never a credential. */
export const TrackerMentionUrl = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^https:\/\/(?:github\.com|linear\.app)\/[A-Za-z0-9_.\-%/]+$/),
);

/** A GitHub number (`2901`) or a Linear key (`ENG-12`). */
export const TrackerMentionItemId = Schema.String.check(
  Schema.isPattern(/^(?:[1-9]\d{0,8}|[A-Z][A-Z0-9]{0,9}-\d{1,9})$/),
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
});
export type TrackerMention = typeof TrackerMention.Type;

export const TrackerMentions = Schema.Array(TrackerMention).check(
  Schema.isMaxLength(MAX_TRACKER_MENTIONS_PER_TURN),
);
