import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

export const MAX_PROVIDER_FILE_REVIEW_TEXT = 262_144;
export const MAX_PROVIDER_FILE_REVIEW_SCOPES = 64;
export const MAX_PROVIDER_FILE_REVIEW_ANCHORS = 1_024;

export const ProviderFileReviewPath = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter(
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

export const ProviderFileReviewScopeId = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
);
export const ProviderFileReviewScope = Schema.Struct({
  id: ProviderFileReviewScopeId,
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  source: Schema.Literals(["provider-turn", "manual-edit"]),
});
export type ProviderFileReviewScope = typeof ProviderFileReviewScope.Type;

/** A provider checkpoint is supplementary data, never Git or an approval verdict. */
export const ProviderFileReviewSnapshot = Schema.Struct({
  path: ProviderFileReviewPath,
  checkpoint: Schema.String.check(Schema.isMaxLength(MAX_PROVIDER_FILE_REVIEW_TEXT)),
  scopes: Schema.Array(ProviderFileReviewScope).check(
    Schema.isMaxLength(MAX_PROVIDER_FILE_REVIEW_SCOPES),
  ),
  comparison: Schema.optional(
    Schema.Struct({
      scopeId: ProviderFileReviewScopeId,
      change: Schema.Literals(["created", "modified", "deleted", "opaque"]),
      before: Schema.String.check(Schema.isMaxLength(MAX_PROVIDER_FILE_REVIEW_TEXT)),
      after: Schema.String.check(Schema.isMaxLength(MAX_PROVIDER_FILE_REVIEW_TEXT)),
    }),
  ),
  anchors: Schema.Array(
    Schema.Struct({
      side: Schema.Literals(["before", "after"]),
      line: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })),
    }),
  ).check(Schema.isMaxLength(MAX_PROVIDER_FILE_REVIEW_ANCHORS)),
}).check(
  Schema.makeFilter(
    (file) =>
      new Set(file.scopes.map((scope) => scope.id)).size === file.scopes.length &&
      (file.comparison === undefined ||
        file.scopes.some((scope) => scope.id === file.comparison?.scopeId)),
  ),
);
export type ProviderFileReviewSnapshot = typeof ProviderFileReviewSnapshot.Type;

export const ProviderFileReviewRefusalReason = Schema.Literals([
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
]);
export const ProviderFileReviewRead = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), file: ProviderFileReviewSnapshot }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: ProviderFileReviewRefusalReason,
  }),
]);
export type ProviderFileReviewRead = typeof ProviderFileReviewRead.Type;
export const decodeProviderFileReviewPath = Schema.decodeUnknownSync(
  ProviderFileReviewPath,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderFileReviewRead = Schema.decodeUnknownSync(
  ProviderFileReviewRead,
  STRICT_DECODE_OPTIONS,
);
