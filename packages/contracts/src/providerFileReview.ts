import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const MAX_PROVIDER_FILE_REVIEW_TEXT = 262_144;
export const MAX_PROVIDER_FILE_REVIEW_SCOPES = 64;
export const MAX_PROVIDER_FILE_REVIEW_ANCHORS = 1_024;

export const ProviderFileReviewPath = Schema.String.pipe(
  Schema.maxLength(4_096),
  Schema.filter(
    (path) =>
      path.length > 0 &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  ),
);
export type ProviderFileReviewPath = typeof ProviderFileReviewPath.Type;

export const ProviderFileReviewScopeId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));
export const ProviderFileReviewScope = Schema.Struct({
  id: ProviderFileReviewScopeId,
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  source: Schema.Literal("provider-turn", "manual-edit"),
}).annotations(strict);
export type ProviderFileReviewScope = typeof ProviderFileReviewScope.Type;

/** A provider checkpoint is supplementary data, never Git or an approval verdict. */
export const ProviderFileReviewSnapshot = Schema.Struct({
  path: ProviderFileReviewPath,
  checkpoint: Schema.String.pipe(Schema.maxLength(MAX_PROVIDER_FILE_REVIEW_TEXT)),
  scopes: Schema.Array(ProviderFileReviewScope).pipe(
    Schema.maxItems(MAX_PROVIDER_FILE_REVIEW_SCOPES),
  ),
  comparison: Schema.optional(
    Schema.Struct({
      scopeId: ProviderFileReviewScopeId,
      change: Schema.Literal("created", "modified", "deleted", "opaque"),
      before: Schema.String.pipe(Schema.maxLength(MAX_PROVIDER_FILE_REVIEW_TEXT)),
      after: Schema.String.pipe(Schema.maxLength(MAX_PROVIDER_FILE_REVIEW_TEXT)),
    }).annotations(strict),
  ),
  anchors: Schema.Array(
    Schema.Struct({
      side: Schema.Literal("before", "after"),
      line: Schema.Int.pipe(Schema.between(1, 2_147_483_647)),
    }).annotations(strict),
  ).pipe(Schema.maxItems(MAX_PROVIDER_FILE_REVIEW_ANCHORS)),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (file) =>
        new Set(file.scopes.map((scope) => scope.id)).size === file.scopes.length &&
        (file.comparison === undefined ||
          file.scopes.some((scope) => scope.id === file.comparison?.scopeId)),
    ),
  );
export type ProviderFileReviewSnapshot = typeof ProviderFileReviewSnapshot.Type;

export const ProviderFileReviewRefusalReason = Schema.Literal(
  "unsupported",
  "no-session",
  "turn-running",
  "stale",
  "unavailable",
  "malformed",
  "too-large",
  "path-refused",
  "unauthorized",
  "cold-unavailable",
  "cancelled",
  "timeout",
);
export const ProviderFileReviewRead = Schema.Union(
  Schema.Struct({ status: Schema.Literal("ready"), file: ProviderFileReviewSnapshot }).annotations(
    strict,
  ),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: ProviderFileReviewRefusalReason,
  }).annotations(strict),
);
export type ProviderFileReviewRead = typeof ProviderFileReviewRead.Type;
export const decodeProviderFileReviewPath = Schema.decodeUnknownSync(ProviderFileReviewPath);
export const decodeProviderFileReviewRead = Schema.decodeUnknownSync(ProviderFileReviewRead);
