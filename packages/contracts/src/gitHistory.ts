import { Schema } from "effect";
import { CodeCheckoutId, CodeThreadId } from "./code";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const MAX_GIT_HISTORY_PAGE = 100;
export const MAX_GIT_HISTORY_DIFF_BYTES = 1024 * 1024;
export const GitHistoryOid = Schema.String.pipe(Schema.pattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const text = (limit: number) => Schema.String.pipe(Schema.maxLength(limit));
const revision = text(512).pipe(
  Schema.pattern(/^(?:HEAD|refs\/(?:heads|remotes|tags)\/.+)$/u),
  Schema.filter(
    (value) =>
      !value.includes("..") &&
      !value.includes("@{") &&
      !Array.from(value).some(
        (character) =>
          character.charCodeAt(0) <= 32 ||
          character.charCodeAt(0) === 127 ||
          "~^:?*[\\".includes(character),
      ),
  ),
);
const scope = { threadId: CodeThreadId, checkoutId: CodeCheckoutId };

export const GitHistoryCursor = Schema.Struct({
  tips: Schema.Array(GitHistoryOid).pipe(Schema.minItems(1), Schema.maxItems(128)),
  offset: Schema.Int.pipe(Schema.between(0, 1_000_000)),
}).annotations(strict);
export type GitHistoryCursor = typeof GitHistoryCursor.Type;

export const GitHistoryQuery = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("history"),
    ...scope,
    revision: Schema.optional(revision),
    search: Schema.optional(text(200)),
    cursor: Schema.optional(GitHistoryCursor),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    ...scope,
    oid: GitHistoryOid,
    parent: Schema.Int.pipe(Schema.between(0, 63)),
  }).annotations(strict),
);
export type GitHistoryQuery = typeof GitHistoryQuery.Type;

export const GitHistoryCommit = Schema.Struct({
  oid: GitHistoryOid,
  parents: Schema.Array(GitHistoryOid).pipe(Schema.maxItems(64)),
  subject: text(4096),
  author: text(512),
  authoredAt: text(64),
}).annotations(strict);
export type GitHistoryCommit = typeof GitHistoryCommit.Type;

export const GitHistoryRef = Schema.Struct({
  name: text(512),
  oid: GitHistoryOid,
  kind: Schema.Literal("branch", "remote", "tag"),
}).annotations(strict);
export type GitHistoryRef = typeof GitHistoryRef.Type;

export const GitHistoryPage = Schema.Struct({
  status: Schema.Literal("history"),
  ...scope,
  commits: Schema.Array(GitHistoryCommit).pipe(Schema.maxItems(MAX_GIT_HISTORY_PAGE)),
  refs: Schema.Array(GitHistoryRef).pipe(Schema.maxItems(256)),
  head: Schema.NullOr(GitHistoryOid),
  branch: Schema.NullOr(text(512)),
  shallow: Schema.Boolean,
  refsTruncated: Schema.Boolean,
  nextCursor: Schema.NullOr(GitHistoryCursor),
}).annotations(strict);
export type GitHistoryPage = typeof GitHistoryPage.Type;

export const GitHistoryDetail = Schema.Struct({
  status: Schema.Literal("commit"),
  ...scope,
  commit: GitHistoryCommit,
  message: text(65536),
  parent: Schema.NullOr(GitHistoryOid),
  diff: text(MAX_GIT_HISTORY_DIFF_BYTES),
  truncated: Schema.Boolean,
  files: Schema.Int.pipe(Schema.nonNegative()),
  insertions: Schema.Int.pipe(Schema.nonNegative()),
  deletions: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type GitHistoryDetail = typeof GitHistoryDetail.Type;

export const GitHistoryResult = Schema.Union(
  GitHistoryPage,
  GitHistoryDetail,
  Schema.Struct({ status: Schema.Literal("unavailable"), message: text(512) }).annotations(strict),
);
export type GitHistoryResult = typeof GitHistoryResult.Type;
export const decodeGitHistoryQuery = Schema.decodeUnknownSync(GitHistoryQuery);
export const decodeGitHistoryResult = Schema.decodeUnknownSync(GitHistoryResult);
