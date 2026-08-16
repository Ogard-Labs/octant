import { Schema } from "effect";
import { HostId } from "./host";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const FolderCandidateId = brandedUuid("FolderCandidateId");
export type FolderCandidateId = typeof FolderCandidateId.Type;

export const FolderBrowseMode = Schema.Literal("work", "code");
export type FolderBrowseMode = typeof FolderBrowseMode.Type;

export const FolderBreadcrumb = Schema.Struct({
  label: Schema.NonEmptyTrimmedString,
  candidateId: Schema.optional(FolderCandidateId),
}).annotations(strict);
export type FolderBreadcrumb = typeof FolderBreadcrumb.Type;

export const FolderCandidate = Schema.Struct({
  candidateId: FolderCandidateId,
  displayName: Schema.NonEmptyTrimmedString,
  isGitRepository: Schema.Boolean,
  isSelectable: Schema.Boolean,
  unselectableReason: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type FolderCandidate = typeof FolderCandidate.Type;

export const FolderBrowseRequest = Schema.Struct({
  hostId: HostId,
  mode: FolderBrowseMode,
  parentCandidateId: Schema.optional(FolderCandidateId),
  search: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
}).annotations(strict);
export type FolderBrowseRequest = typeof FolderBrowseRequest.Type;

export const FolderBrowseResult = Schema.Struct({
  candidates: Schema.Array(FolderCandidate),
  breadcrumbs: Schema.Array(FolderBreadcrumb),
  hasMore: Schema.Boolean,
  browsedAt: UtcTimestamp,
}).annotations(strict);
export type FolderBrowseResult = typeof FolderBrowseResult.Type;

export const FolderSelectionRequest = Schema.Struct({
  hostId: HostId,
  mode: FolderBrowseMode,
  candidateId: FolderCandidateId,
}).annotations(strict);
export type FolderSelectionRequest = typeof FolderSelectionRequest.Type;

export const FolderSelectionResult = Schema.Struct({
  receiptId: Schema.NonEmptyTrimmedString,
  displayName: Schema.NonEmptyTrimmedString,
  selectedAt: UtcTimestamp,
}).annotations(strict);
export type FolderSelectionResult = typeof FolderSelectionResult.Type;

export const FolderBrowseFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("not-found"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
).annotations(strict);
export type FolderBrowseFailure = typeof FolderBrowseFailure.Type;

export const decodeFolderCandidateId = Schema.decodeUnknownSync(FolderCandidateId);
export const decodeFolderBrowseMode = Schema.decodeUnknownSync(FolderBrowseMode);
export const decodeFolderBreadcrumb = Schema.decodeUnknownSync(FolderBreadcrumb);
export const decodeFolderCandidate = Schema.decodeUnknownSync(FolderCandidate);
export const decodeFolderBrowseRequest = Schema.decodeUnknownSync(FolderBrowseRequest);
export const decodeFolderBrowseResult = Schema.decodeUnknownSync(FolderBrowseResult);
export const decodeFolderSelectionRequest = Schema.decodeUnknownSync(FolderSelectionRequest);
export const decodeFolderSelectionResult = Schema.decodeUnknownSync(FolderSelectionResult);
export const decodeFolderBrowseFailure = Schema.decodeUnknownSync(FolderBrowseFailure);
