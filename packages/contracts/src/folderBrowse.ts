import { Schema } from "effect";
import { NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { HostId } from "./host";
import { UtcTimestamp } from "./events";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

export const FolderCandidateId = brandedUuid("FolderCandidateId");
export type FolderCandidateId = typeof FolderCandidateId.Type;

export const FolderBrowseMode = Schema.Literals(["work", "code"]);
export type FolderBrowseMode = typeof FolderBrowseMode.Type;

export const FolderBreadcrumb = Schema.Struct({
  label: NonEmptyTrimmedString,
  candidateId: Schema.optional(FolderCandidateId),
});
export type FolderBreadcrumb = typeof FolderBreadcrumb.Type;

export const FolderCandidate = Schema.Struct({
  candidateId: FolderCandidateId,
  displayName: NonEmptyTrimmedString,
  isGitRepository: Schema.Boolean,
  isSelectable: Schema.Boolean,
  unselectableReason: Schema.optional(NonEmptyTrimmedString),
});
export type FolderCandidate = typeof FolderCandidate.Type;

export const FolderBrowseRequest = Schema.Struct({
  hostId: HostId,
  mode: FolderBrowseMode,
  parentCandidateId: Schema.optional(FolderCandidateId),
  search: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
});
export type FolderBrowseRequest = typeof FolderBrowseRequest.Type;

export const FolderBrowseResult = Schema.Struct({
  candidates: Schema.Array(FolderCandidate),
  breadcrumbs: Schema.Array(FolderBreadcrumb),
  hasMore: Schema.Boolean,
  browsedAt: UtcTimestamp,
});
export type FolderBrowseResult = typeof FolderBrowseResult.Type;

export const FolderSelectionRequest = Schema.Struct({
  hostId: HostId,
  mode: FolderBrowseMode,
  candidateId: FolderCandidateId,
});
export type FolderSelectionRequest = typeof FolderSelectionRequest.Type;

export const FolderSelectionResult = Schema.Struct({
  receiptId: NonEmptyTrimmedString,
  displayName: NonEmptyTrimmedString,
  selectedAt: UtcTimestamp,
});
export type FolderSelectionResult = typeof FolderSelectionResult.Type;

export const FolderBrowseFailure = Schema.Union([
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("not-found"),
    message: NonEmptyTrimmedString,
  }),
]);
export type FolderBrowseFailure = typeof FolderBrowseFailure.Type;

export const decodeFolderCandidateId = Schema.decodeUnknownSync(
  FolderCandidateId,
  STRICT_DECODE_OPTIONS,
);
export const decodeFolderBrowseMode = Schema.decodeUnknownSync(
  FolderBrowseMode,
  STRICT_DECODE_OPTIONS,
);
export const decodeFolderBreadcrumb = Schema.decodeUnknownSync(
  FolderBreadcrumb,
  STRICT_DECODE_OPTIONS,
);
export const decodeFolderCandidate = Schema.decodeUnknownSync(
  FolderCandidate,
  STRICT_DECODE_OPTIONS,
);
export const decodeFolderBrowseRequest = Schema.decodeUnknownSync(
  FolderBrowseRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeFolderBrowseResult = Schema.decodeUnknownSync(
  FolderBrowseResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeFolderSelectionRequest = Schema.decodeUnknownSync(
  FolderSelectionRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeFolderSelectionResult = Schema.decodeUnknownSync(
  FolderSelectionResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeFolderBrowseFailure = Schema.decodeUnknownSync(
  FolderBrowseFailure,
  STRICT_DECODE_OPTIONS,
);
