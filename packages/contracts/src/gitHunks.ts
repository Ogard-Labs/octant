import { Schema } from "effect";
import { CodeDigest, CodeRelativePath } from "./code";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const MAX_CODE_GIT_HUNK_PATCH_BYTES = 256 * 1024;
export const MAX_CODE_GIT_HUNKS = 2_048;
export const MAX_CODE_SELECTED_GIT_HUNKS = 128;
export const CodeGitHunkScope = Schema.Literal("unstaged", "staged");
export type CodeGitHunkScope = typeof CodeGitHunkScope.Type;
export const CodeGitHunk = Schema.Struct({
  id: CodeDigest,
  path: CodeRelativePath,
  index: Schema.Int.pipe(Schema.nonNegative()),
  oldStart: Schema.Int.pipe(Schema.nonNegative()),
  oldLines: Schema.Int.pipe(Schema.nonNegative()),
  newStart: Schema.Int.pipe(Schema.nonNegative()),
  newLines: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type CodeGitHunk = typeof CodeGitHunk.Type;
export const CodeGitHunkUnavailableReason = Schema.Literal(
  "binary",
  "rename",
  "conflict",
  "mode-change",
  "path-encoding",
  "truncated",
  "invalid-hunk",
  "too-many-hunks",
  "untracked",
);
export type CodeGitHunkUnavailableReason = typeof CodeGitHunkUnavailableReason.Type;
export const CodeGitHunkUnavailable = Schema.Struct({
  path: Schema.optional(CodeRelativePath),
  reason: CodeGitHunkUnavailableReason,
}).annotations(strict);
export type CodeGitHunkUnavailable = typeof CodeGitHunkUnavailable.Type;
