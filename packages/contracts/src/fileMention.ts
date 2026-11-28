import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { ProjectId } from "./projects";
import { WorkThreadId } from "./workThreads";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
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
 * A confined POSIX path a file mention may name: relative to the main folder,
 * or absolute inside one of the Project's extra folders. Parent traversal,
 * backslashes, and the other Work/Code relative-path refusals are rejected
 * here. The schema cannot tell an extra folder from any other absolute path,
 * so the host checks an absolute path against the Project's extra folders
 * before it reads anything.
 * Turn commands carry raw strings and re-run this classification in policy
 * before any read, so a renderer that bypasses the typeahead is still refused.
 */
export const FileMentionPath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      if (
        value.length === 0 ||
        value.includes("\0") ||
        value.includes("\\") ||
        value === "/" ||
        value.startsWith("//") ||
        value.endsWith("/") ||
        value.normalize("NFC") !== value ||
        textEncoder.encode(value).byteLength > MAX_FILE_MENTION_RELATIVE_PATH_BYTES
      ) {
        return false;
      }
      const components = (value.startsWith("/") ? value.slice(1) : value).split("/");
      return components.every(
        (component) => component !== "" && component !== "." && component !== "..",
      );
    }),
  ),
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
export const FileMentionScope = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("code"),
    threadId: CodeThreadId,
    checkoutId: CodeCheckoutId,
  }),
  Schema.Struct({
    mode: Schema.Literal("work"),
    threadId: WorkThreadId,
  }),
]);
export type FileMentionScope = typeof FileMentionScope.Type;

export const FileMentionCandidate = Schema.Struct({
  path: FileMentionPath,
  kind: Schema.Literals(["file", "directory"]),
});
export type FileMentionCandidate = typeof FileMentionCandidate.Type;

export const ResolvedFileMention = Schema.Struct({
  path: FileMentionPath,
  text: Schema.String.check(Schema.isMaxLength(MAX_FILE_MENTION_CHARACTERS)),
  truncated: Schema.Boolean,
});
export type ResolvedFileMention = typeof ResolvedFileMention.Type;

/**
 * A mentioned path as the user named it. Leading and trailing spaces are
 * significant POSIX name bytes, so this must not trim. Parent traversal is
 * still accepted here so policy can refuse it as `out-of-root` rather than
 * failing the command as invalid.
 */
export const FileMentionPathInput = Schema.String.check(
  Schema.makeFilter(
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
  reason: Schema.Literals(["out-of-root", "not-found", "unauthorized", "unsupported-mode"]),
});
export type UnavailableFileMention = typeof UnavailableFileMention.Type;

/**
 * Authoritative file-mention command. `complete-file-mentions` powers the `@`
 * typeahead inside the bound root. `resolve-file-mentions` turns selected
 * paths into bounded read-only contents at send time. Both refuse a path
 * outside the root before any file bytes are read.
 */
export const FolderMentionScope = Schema.Union([
  FileMentionScope,
  Schema.Struct({
    mode: Schema.Literals(["code-draft", "work-draft"]),
    projectId: ProjectId,
  }),
]);
export type FolderMentionScope = typeof FolderMentionScope.Type;

export const FileMentionCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("inspect-folder-mentions"),
    requestId: FileMentionRequestId,
    scope: FolderMentionScope,
    paths: Schema.Array(FileMentionPathInput).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_FILE_MENTIONS_PER_TURN),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("complete-file-mentions"),
    requestId: FileMentionRequestId,
    scope: FileMentionScope,
    query: Schema.String.check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    kind: Schema.Literal("resolve-file-mentions"),
    requestId: FileMentionRequestId,
    scope: FileMentionScope,
    paths: Schema.Array(FileMentionPathInput).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_FILE_MENTIONS_PER_TURN),
    ),
  }),
]);
export type FileMentionCommand = typeof FileMentionCommand.Type;

export const FileMentionCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("folder-mentions-inspected"),
    requestId: FileMentionRequestId,
    folders: Schema.Array(
      Schema.Struct({ path: FileMentionPathInput, hostId: Schema.Literal("local") }),
    ).check(Schema.isMaxLength(MAX_FILE_MENTIONS_PER_TURN)),
    unavailable: Schema.Array(UnavailableFileMention).check(
      Schema.isMaxLength(MAX_FILE_MENTIONS_PER_TURN),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("file-mentions-completed"),
    requestId: FileMentionRequestId,
    candidates: Schema.Array(FileMentionCandidate).check(
      Schema.isMaxLength(MAX_FILE_MENTION_CANDIDATES),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("file-mentions-resolved"),
    requestId: FileMentionRequestId,
    mentions: Schema.Array(ResolvedFileMention).check(
      Schema.isMaxLength(MAX_FILE_MENTIONS_PER_TURN),
    ),
    unavailable: Schema.Array(UnavailableFileMention).check(
      Schema.isMaxLength(MAX_FILE_MENTIONS_PER_TURN),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    requestId: FileMentionRequestId,
    reason: Schema.Literals([
      "unauthorized",
      "not-found",
      "unsupported-mode",
      "unavailable",
      "invalid",
    ]),
  }),
]);
export type FileMentionCommandResult = typeof FileMentionCommandResult.Type;

export const decodeFileMentionRequestId = Schema.decodeUnknownSync(
  FileMentionRequestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeFileMentionPath = Schema.decodeUnknownSync(
  FileMentionPath,
  STRICT_DECODE_OPTIONS,
);
export const decodeFileMentionCommand = Schema.decodeUnknownSync(
  FileMentionCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeFileMentionCommandResult = Schema.decodeUnknownSync(
  FileMentionCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeFileMentionCandidate = Schema.decodeUnknownSync(
  FileMentionCandidate,
  STRICT_DECODE_OPTIONS,
);
export const decodeResolvedFileMention = Schema.decodeUnknownSync(
  ResolvedFileMention,
  STRICT_DECODE_OPTIONS,
);
