import { Schema } from "effect";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { WorkThreadId } from "./workThreads";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const textEncoder = new TextEncoder();

/**
 * Correlation id for one file-mention command/result pair. The renderer mints
 * it; the server echoes it so a reconnect can reconcile an in-flight typeahead
 * or resolve without ambiguity.
 */
export const FileMentionRequestId = brandedUuid("FileMentionRequestId");
export type FileMentionRequestId = typeof FileMentionRequestId.Type;

export const MAX_FILE_MENTION_RELATIVE_PATH_BYTES = 4_096;

/**
 * A confined POSIX relative path a file mention may name. Absolute paths,
 * parent traversal, backslashes, and the other Work/Code relative-path
 * refusals are rejected here so a mention can never even *name* a location
 * outside the bound root on the wire.
 *
 * Turn commands carry raw strings and re-run this classification in policy
 * before any read, so a renderer that bypasses the typeahead is still refused.
 */
export const FileMentionPath = Schema.String.pipe(
  Schema.filter((value) => {
    if (
      value.length === 0 ||
      value.includes("\0") ||
      value.includes("\\") ||
      value.startsWith("/") ||
      value.endsWith("/") ||
      value.normalize("NFC") !== value ||
      textEncoder.encode(value).byteLength > MAX_FILE_MENTION_RELATIVE_PATH_BYTES
    ) {
      return false;
    }
    const components = value.split("/");
    return components.every(
      (component) => component !== "" && component !== "." && component !== "..",
    );
  }),
  Schema.brand("FileMentionPath"),
);
export type FileMentionPath = typeof FileMentionPath.Type;

/** Maximum `@file` mentions one turn may carry. */
export const MAX_FILE_MENTIONS_PER_TURN = 8;

/** Maximum typeahead hits the server returns for one query. */
export const MAX_FILE_MENTION_CANDIDATES = 8;

/** Maximum characters one mentioned file contributes to a turn. */
export const MAX_FILE_MENTION_CHARACTERS = 8_000;

/**
 * The thread whose bound root a file mention resolves against. Chat is not a
 * variant: Chat Projects have no filesystem authority, so this surface cannot
 * even be expressed there.
 */
export const FileMentionScope = Schema.Union(
  Schema.Struct({
    mode: Schema.Literal("code"),
    threadId: CodeThreadId,
    checkoutId: CodeCheckoutId,
  }).annotations(strict),
  Schema.Struct({
    mode: Schema.Literal("work"),
    threadId: WorkThreadId,
  }).annotations(strict),
);
export type FileMentionScope = typeof FileMentionScope.Type;

export const FileMentionCandidate = Schema.Struct({
  path: FileMentionPath,
  kind: Schema.Literal("file", "directory"),
}).annotations(strict);
export type FileMentionCandidate = typeof FileMentionCandidate.Type;

export const ResolvedFileMention = Schema.Struct({
  path: FileMentionPath,
  text: Schema.String.pipe(Schema.maxLength(MAX_FILE_MENTION_CHARACTERS)),
  truncated: Schema.Boolean,
}).annotations(strict);
export type ResolvedFileMention = typeof ResolvedFileMention.Type;

/**
 * A mentioned path as the user named it. Leading and trailing spaces are
 * significant POSIX name bytes, so this must not trim. Parent traversal is
 * still accepted here so policy can refuse it as `out-of-root` rather than
 * failing the command as invalid.
 */
export const FileMentionPathInput = Schema.String.pipe(
  Schema.filter(
    (value) =>
      value.length > 0 &&
      textEncoder.encode(value).byteLength <= MAX_FILE_MENTION_RELATIVE_PATH_BYTES,
  ),
);
export type FileMentionPathInput = typeof FileMentionPathInput.Type;

/**
 * A mention the server refused. `out-of-root` is the confinement failure: the
 * host classified the path as outside the bound root and did not read it.
 */
export const UnavailableFileMention = Schema.Struct({
  path: FileMentionPathInput,
  reason: Schema.Literal("out-of-root", "not-found", "unauthorized", "unsupported-mode"),
}).annotations(strict);
export type UnavailableFileMention = typeof UnavailableFileMention.Type;

/**
 * Authoritative file-mention command. `complete-file-mentions` powers the `@`
 * typeahead inside the bound root. `resolve-file-mentions` turns selected
 * paths into bounded read-only contents at send time. Both refuse a path
 * outside the root before any file bytes are read.
 */
export const FileMentionCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("complete-file-mentions"),
    requestId: FileMentionRequestId,
    scope: FileMentionScope,
    query: Schema.String.pipe(Schema.maxLength(200)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("resolve-file-mentions"),
    requestId: FileMentionRequestId,
    scope: FileMentionScope,
    paths: Schema.Array(FileMentionPathInput).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_FILE_MENTIONS_PER_TURN),
    ),
  }).annotations(strict),
);
export type FileMentionCommand = typeof FileMentionCommand.Type;

export const FileMentionCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("file-mentions-completed"),
    requestId: FileMentionRequestId,
    candidates: Schema.Array(FileMentionCandidate).pipe(
      Schema.maxItems(MAX_FILE_MENTION_CANDIDATES),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("file-mentions-resolved"),
    requestId: FileMentionRequestId,
    mentions: Schema.Array(ResolvedFileMention).pipe(Schema.maxItems(MAX_FILE_MENTIONS_PER_TURN)),
    unavailable: Schema.Array(UnavailableFileMention).pipe(
      Schema.maxItems(MAX_FILE_MENTIONS_PER_TURN),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    requestId: FileMentionRequestId,
    reason: Schema.Literal(
      "unauthorized",
      "not-found",
      "unsupported-mode",
      "unavailable",
      "invalid",
    ),
  }).annotations(strict),
);
export type FileMentionCommandResult = typeof FileMentionCommandResult.Type;

export const decodeFileMentionRequestId = Schema.decodeUnknownSync(FileMentionRequestId);
export const decodeFileMentionPath = Schema.decodeUnknownSync(FileMentionPath);
export const decodeFileMentionCommand = Schema.decodeUnknownSync(FileMentionCommand);
export const decodeFileMentionCommandResult = Schema.decodeUnknownSync(FileMentionCommandResult);
export const decodeFileMentionCandidate = Schema.decodeUnknownSync(FileMentionCandidate);
export const decodeResolvedFileMention = Schema.decodeUnknownSync(ResolvedFileMention);
