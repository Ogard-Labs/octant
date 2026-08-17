import { Schema } from "effect";
import { CodeCheckoutId, CodeFileId, CodeRelativePath, CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Bound on one listing response. The file explorer renders a bounded window
 * and says so in words when the tree is incomplete, so an unbounded walk of a
 * large monorepo would only cost memory without ever reaching the user.
 */
export const MAX_CODE_FILE_LISTING_ENTRIES = 1_000;

/** Bound on how deep a single listing walk descends below the requested directory. */
export const MAX_CODE_FILE_LISTING_DEPTH = 12;

/**
 * Server-decided openability for one listed file. The renderer never derives
 * this: the host knows the editable byte budget and whether the entry resolved
 * to a regular file inside the bound checkout, and says so.
 */
export const CodeFileListingAvailability = Schema.Union(
  Schema.Struct({ status: Schema.Literal("available") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("read-only"),
    reason: Schema.Literal("oversized"),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type CodeFileListingAvailability = typeof CodeFileListingAvailability.Type;

/**
 * One listed entry. `path` is always relative to the thread's bound checkout
 * root — the host absolute path is never part of this contract, so a renderer
 * or remote client cannot learn where the repository lives on the host.
 */
export const CodeFileListingEntry = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("directory"),
    path: CodeRelativePath,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("file"),
    fileId: CodeFileId,
    path: CodeRelativePath,
    byteLength: Schema.Int.pipe(Schema.nonNegative()),
    availability: CodeFileListingAvailability,
  }).annotations(strict),
);
export type CodeFileListingEntry = typeof CodeFileListingEntry.Type;

/**
 * One bounded, ephemeral listing of the checkout bound to a Code thread.
 * `truncated` is authoritative: the renderer must tell the user the tree is
 * incomplete rather than presenting a partial walk as the whole repository.
 */
export const CodeFileListing = Schema.Struct({
  kind: Schema.Literal("code-file-listing"),
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  /** Absent when the listing starts at the checkout root. */
  directory: Schema.optional(CodeRelativePath),
  entries: Schema.Array(CodeFileListingEntry),
  truncated: Schema.Boolean,
  observedAt: UtcTimestamp,
}).annotations(strict);
export type CodeFileListing = typeof CodeFileListing.Type;

export const CodeFileListingFailure = Schema.Struct({
  category: Schema.Literal("invalid", "unauthorized", "unavailable", "not-found"),
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type CodeFileListingFailure = typeof CodeFileListingFailure.Type;

export const CodeFileListingResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("listed"),
    listing: CodeFileListing,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("failed"),
    failure: CodeFileListingFailure,
  }).annotations(strict),
);
export type CodeFileListingResult = typeof CodeFileListingResult.Type;

/**
 * Bound on how many changed paths one notice names. Past this the notice says
 * `truncated` and the renderer refetches the listing, which is cheaper and
 * more honest than streaming every path of a branch switch one at a time.
 */
export const MAX_CODE_FILE_CHANGE_PATHS = 64;

/**
 * One coalesced observation that files under a thread's checkout changed.
 *
 * The notice carries identity, never content: paths are relative to the
 * checkout root and nothing here says what changed or what the file now
 * contains. A renderer acts on it by refetching through the listing and open
 * routes, which apply the same confinement and authority they always did, so a
 * notice can never widen what a client may read.
 */
export const CodeFileChangeNotice = Schema.Struct({
  kind: Schema.Literal("code-file-change"),
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  paths: Schema.Array(CodeRelativePath).pipe(Schema.maxItems(MAX_CODE_FILE_CHANGE_PATHS)),
  /**
   * True when more changed than the notice can name, including a host that
   * reported a change without naming a file. `paths` is then a hint and the
   * whole surface has to be refreshed.
   */
  truncated: Schema.Boolean,
  observedAt: UtcTimestamp,
}).annotations(strict);
export type CodeFileChangeNotice = typeof CodeFileChangeNotice.Type;

export const decodeCodeFileChangeNotice = Schema.decodeUnknownSync(CodeFileChangeNotice);

export const decodeCodeFileListingEntry = Schema.decodeUnknownSync(CodeFileListingEntry);
export const decodeCodeFileListing = Schema.decodeUnknownSync(CodeFileListing);
export const decodeCodeFileListingFailure = Schema.decodeUnknownSync(CodeFileListingFailure);
export const decodeCodeFileListingResult = Schema.decodeUnknownSync(CodeFileListingResult);
