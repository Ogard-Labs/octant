import { Schema } from "effect";
import { NonEmptyTrimmedString, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeCheckoutId, CodeFileId, CodeRelativePath, CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";

/**
 * Bound on how many matches one search reports. A quick-open list nobody
 * scrolls past the first screen of gains nothing from a thousandth row, and
 * the bound is what lets the host stop walking rather than read the repository
 * to the end for results it would discard.
 */
export const MAX_CODE_SEARCH_MATCHES = 200;

/**
 * Bound on how many files one content search opens. A repository is walked
 * until this many files have been read, and the search then says it is
 * truncated rather than pretending the whole tree was examined.
 */
export const MAX_CODE_SEARCH_FILES = 5_000;

/** Bound on how much of one file a content search reads. */
export const MAX_CODE_SEARCH_FILE_BYTES = 512 * 1024;

/** Bound on the query itself, so a pathological pattern never reaches the walk. */
export const MAX_CODE_SEARCH_QUERY_LENGTH = 200;

/** Bound on one reported line, so a minified file cannot fill the response. */
export const MAX_CODE_SEARCH_PREVIEW_LENGTH = 240;

/**
 * What a search is looking at. `path` matches the names of files in the bound
 * checkout; `content` matches text inside them. They are one contract because
 * they answer the same question from the same walk under the same confinement,
 * and a client picks between them by intent, not by endpoint.
 */
export const CodeSearchScope = Schema.Literals(["path", "content"]);
export type CodeSearchScope = typeof CodeSearchScope.Type;

/**
 * One match. `path` is always relative to the checkout root; a content match
 * also states where in the file it was found and shows the line it was on,
 * clipped to the preview bound. Nothing here is a host absolute path.
 */
/**
 * The Project's extra folder a match lies in, as its absolute path; the match's
 * `path` is relative to it. Absent means the checkout. The explorer and editor
 * address the checkout only, so a match with a folder is shown but not opened.
 */
export const CodeSearchFolder = Schema.String.check(
  Schema.makeFilter((value) => value.startsWith("/") && value.length > 1 && !value.includes("\0")),
);
export type CodeSearchFolder = typeof CodeSearchFolder.Type;

export const CodeSearchMatch = Schema.Union([
  Schema.Struct({
    scope: Schema.Literal("path"),
    fileId: CodeFileId,
    path: CodeRelativePath,
    folder: Schema.optional(CodeSearchFolder),
  }),
  Schema.Struct({
    scope: Schema.Literal("content"),
    fileId: CodeFileId,
    path: CodeRelativePath,
    folder: Schema.optional(CodeSearchFolder),
    line: PositiveInt,
    column: PositiveInt,
    preview: Schema.String.check(Schema.isMaxLength(MAX_CODE_SEARCH_PREVIEW_LENGTH)),
  }),
]);
export type CodeSearchMatch = typeof CodeSearchMatch.Type;

/**
 * One bounded, ephemeral search of the checkout bound to a Code thread.
 *
 * `truncated` is authoritative in the same way the listing's is: the renderer
 * must say the results are incomplete rather than presenting a bounded walk as
 * everything the repository contains.
 */
export const CodeSearch = Schema.Struct({
  kind: Schema.Literal("code-search"),
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  scope: CodeSearchScope,
  query: Schema.String.check(Schema.isMaxLength(MAX_CODE_SEARCH_QUERY_LENGTH)),
  matches: Schema.Array(CodeSearchMatch).check(Schema.isMaxLength(MAX_CODE_SEARCH_MATCHES)),
  truncated: Schema.Boolean,
  observedAt: UtcTimestamp,
});
export type CodeSearch = typeof CodeSearch.Type;

export const CodeSearchFailure = Schema.Struct({
  category: Schema.Literals(["invalid", "unauthorized", "unavailable", "not-found"]),
  message: NonEmptyTrimmedString,
});
export type CodeSearchFailure = typeof CodeSearchFailure.Type;

export const CodeSearchResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("searched"),
    search: CodeSearch,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    failure: CodeSearchFailure,
  }),
]);
export type CodeSearchResult = typeof CodeSearchResult.Type;

export const decodeCodeSearchMatch = Schema.decodeUnknownSync(
  CodeSearchMatch,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodeSearch = Schema.decodeUnknownSync(CodeSearch, STRICT_DECODE_OPTIONS);
export const decodeCodeSearchResult = Schema.decodeUnknownSync(
  CodeSearchResult,
  STRICT_DECODE_OPTIONS,
);
