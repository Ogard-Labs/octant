import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";

const SECRETISH =
  /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|bearer\s+|token=|authorization)/i;
const safeText = (limit: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(limit),
    Schema.makeFilter((value) => !SECRETISH.test(value) && !value.includes("\0")),
  );

/**
 * Claimed pattern kinds a resolver may register for. GitHub form is the first
 * shippable binding; tracker-key form is reserved so a later connected tracker
 * can claim it without a contract change.
 */
export const TrackerReferencePatternKind = Schema.Literals(["github-issue-or-pull", "tracker-key"]);
export type TrackerReferencePatternKind = typeof TrackerReferencePatternKind.Type;

/**
 * Canonical tracker-key identity without a leading `#`. The optional hash is
 * display-only on `raw`; resolvers key off this value.
 */
export const TrackerKey = Schema.String.check(
  Schema.makeFilter((value) => /^[A-Z][A-Z0-9]{1,9}-[0-9]+$/.test(value)),
);
export type TrackerKey = typeof TrackerKey.Type;

const githubIssueOrPullReference = Schema.Struct({
  patternKind: Schema.Literal("github-issue-or-pull"),
  raw: safeText(160),
  owner: GithubRepositoryOwner,
  name: GithubRepositoryName,
  number: PositiveInt,
}).check(
  Schema.makeFilter((value) => value.raw === `${value.owner}/${value.name}#${value.number}`, {
    jsonSchema: {},
  }),
);

const trackerKeyReference = Schema.Struct({
  patternKind: Schema.Literal("tracker-key"),
  raw: safeText(32),
  key: TrackerKey,
}).check(
  Schema.makeFilter((value) => value.raw === value.key || value.raw === `#${value.key}`, {
    jsonSchema: {},
  }),
);

/**
 * One recognized tracker shorthand. `raw` is the exact typed token; parsed
 * fields are the identity a resolver looks up. They must agree so a client
 * cannot display one token while resolving another.
 */
export const TrackerReference = Schema.Union([githubIssueOrPullReference, trackerKeyReference]);
export type TrackerReference = typeof TrackerReference.Type;

/** Maximum references one resolution request may carry. */
export const MAX_TRACKER_REFERENCES_PER_RESOLUTION = 32;

/**
 * Bounded batch of references to resolve. Empty is allowed so a client that
 * found nothing does not invent a sentinel; the server returns an empty
 * result list for it.
 */
export const TrackerReferenceResolutionRequest = Schema.Struct({
  references: Schema.Array(TrackerReference).check(
    Schema.isMaxLength(MAX_TRACKER_REFERENCES_PER_RESOLUTION),
  ),
});
export type TrackerReferenceResolutionRequest = typeof TrackerReferenceResolutionRequest.Type;

export const TrackerReferenceItemKind = Schema.Literals(["issue", "pull-request"]);
export type TrackerReferenceItemKind = typeof TrackerReferenceItemKind.Type;

export const TrackerReferenceUnavailableReason = Schema.Literals([
  "unauthorized",
  "scope-limited",
  "rate-limited",
  "unavailable",
]);
export type TrackerReferenceUnavailableReason = typeof TrackerReferenceUnavailableReason.Type;

/**
 * Display URL for a resolved item. https only, no userinfo, and the same
 * secret-shaped filter as catalogue rows so a resolver cannot smuggle
 * credential material through a chip link.
 */
const trackerUrl = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) =>
      /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_.\-/#?=&%]*)?$/.test(value) &&
      !value.includes("@") &&
      !SECRETISH.test(value) &&
      !value.includes("\0"),
  ),
);

const resolvedFields = {
  status: Schema.Literal("resolved"),
  reference: TrackerReference,
  title: safeText(256),
  url: trackerUrl,
};

/**
 * Per-reference outcome. `unclaimed` means no connected tracker registered
 * for this pattern kind — the renderer leaves the raw text as-is. Failures
 * are values so a missing item or a disconnected tracker never becomes an
 * exception or a retry storm.
 */
export const TrackerReferenceResolution = Schema.Union([
  Schema.Struct({
    ...resolvedFields,
    kind: Schema.Literal("issue"),
    state: Schema.Literals(["open", "closed"]),
  }),
  Schema.Struct({
    ...resolvedFields,
    kind: Schema.Literal("pull-request"),
    state: Schema.Literals(["open", "draft", "merged", "closed"]),
  }),
  Schema.Struct({
    status: Schema.Literal("unclaimed"),
    reference: TrackerReference,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reference: TrackerReference,
    reason: TrackerReferenceUnavailableReason,
    remediation: Schema.optional(safeText(256)),
    retryAfterSeconds: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
    ),
  }),
  Schema.Struct({
    status: Schema.Literal("not-found"),
    reference: TrackerReference,
  }),
]);
export type TrackerReferenceResolution = typeof TrackerReferenceResolution.Type;

export const TrackerReferenceResolutionResponse = Schema.Struct({
  results: Schema.Array(TrackerReferenceResolution).check(
    Schema.isMaxLength(MAX_TRACKER_REFERENCES_PER_RESOLUTION),
  ),
});
export type TrackerReferenceResolutionResponse = typeof TrackerReferenceResolutionResponse.Type;

export const decodeTrackerReference = Schema.decodeUnknownSync(
  TrackerReference,
  STRICT_DECODE_OPTIONS,
);
export const decodeTrackerReferenceResolutionRequest = Schema.decodeUnknownSync(
  TrackerReferenceResolutionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeTrackerReferenceResolution = Schema.decodeUnknownSync(
  TrackerReferenceResolution,
  STRICT_DECODE_OPTIONS,
);
export const decodeTrackerReferenceResolutionResponse = Schema.decodeUnknownSync(
  TrackerReferenceResolutionResponse,
  STRICT_DECODE_OPTIONS,
);
