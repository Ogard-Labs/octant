import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { WorkArtifactFormat, WorkArtifactId } from "./workArtifacts";
import { WorkThreadId } from "./workThreads";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Bound on one listing response. A Work folder is a person's documents
 * directory, not a repository, but it can still hold more than a panel can
 * usefully show; the panel renders a bounded window and says so in words.
 */
export const MAX_WORK_FILE_LISTING_ENTRIES = 1_000;

/** Bound on how deep a single listing walk descends below the bound root. */
export const MAX_WORK_FILE_LISTING_DEPTH = 8;

/**
 * Whether Work wrote this file, which is what lets the panel put the work's own
 * output above the rest of the folder it happens to sit in.
 *
 * The grain is the Project, not the thread: an artifact mutation frame records
 * the Project it changed and no thread, so the host cannot say which task wrote
 * a file without inventing the attribution. `untouched` therefore means "this
 * folder already held it", not "a different task wrote it".
 */
export const WorkFileListingOrigin = Schema.Literal("authored", "untouched");
export type WorkFileListingOrigin = typeof WorkFileListingOrigin.Type;

/**
 * The artifact facts the host holds for a listed file, present only for a file
 * Work itself wrote. A file the folder already contained has no artifact
 * identity, no version, and no format the host can state honestly — its
 * extension is a guess, and the panel is not entitled to present a guess as a
 * fact the host verified.
 */
export const WorkFileListingArtifact = Schema.Struct({
  artifactId: WorkArtifactId,
  format: WorkArtifactFormat,
  /** Monotonic version sequence, so "v3" in the panel is the host's count. */
  sequence: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type WorkFileListingArtifact = typeof WorkFileListingArtifact.Type;

/**
 * One listed entry. `path` is always relative to the Project's bound folder —
 * the host absolute path is never part of this contract, so a renderer or
 * remote client cannot learn where the folder lives on the host.
 */
export const WorkFileListingEntry = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("directory"),
    path: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.NonEmptyTrimmedString,
    byteLength: Schema.Int.pipe(Schema.nonNegative()),
    origin: WorkFileListingOrigin,
    artifact: Schema.optional(WorkFileListingArtifact),
  }).annotations(strict),
);
export type WorkFileListingEntry = typeof WorkFileListingEntry.Type;

/**
 * One bounded, ephemeral listing of the folder bound to a Work thread's
 * Project. `truncated` is authoritative: the panel must tell the user the
 * listing is incomplete rather than presenting a partial walk as the folder.
 */
export const WorkFileListing = Schema.Struct({
  kind: Schema.Literal("work-file-listing"),
  threadId: WorkThreadId,
  projectId: ProjectId,
  /** Absent when the listing starts at the bound folder itself. */
  directory: Schema.optional(Schema.NonEmptyTrimmedString),
  entries: Schema.Array(WorkFileListingEntry),
  truncated: Schema.Boolean,
  observedAt: UtcTimestamp,
}).annotations(strict);
export type WorkFileListing = typeof WorkFileListing.Type;

export const WorkFileListingFailure = Schema.Struct({
  category: Schema.Literal("invalid", "unauthorized", "unavailable", "not-found"),
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type WorkFileListingFailure = typeof WorkFileListingFailure.Type;

export const WorkFileListingResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("listed"),
    listing: WorkFileListing,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("failed"),
    failure: WorkFileListingFailure,
  }).annotations(strict),
);
export type WorkFileListingResult = typeof WorkFileListingResult.Type;

export const decodeWorkFileListingEntry = Schema.decodeUnknownSync(WorkFileListingEntry);
export const decodeWorkFileListing = Schema.decodeUnknownSync(WorkFileListing);
export const decodeWorkFileListingFailure = Schema.decodeUnknownSync(WorkFileListingFailure);
export const decodeWorkFileListingResult = Schema.decodeUnknownSync(WorkFileListingResult);
