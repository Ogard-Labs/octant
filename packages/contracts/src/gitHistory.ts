import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeCheckoutId, CodeThreadId } from "./code";

export const MAX_GIT_HISTORY_PAGE = 100;
export const MAX_GIT_HISTORY_DIFF_BYTES = 1024 * 1024;
export const GitHistoryOid = Schema.String.check(
  Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
);
const text = (limit: number) => Schema.String.check(Schema.isMaxLength(limit));
const revision = text(512).check(
  Schema.isPattern(/^(?:HEAD|refs\/(?:heads|remotes|tags)\/.+)$/u),
  Schema.makeFilter(
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
  tips: Schema.Array(GitHistoryOid).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
});
export type GitHistoryCursor = typeof GitHistoryCursor.Type;

export const GitHistoryQuery = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("history"),
    ...scope,
    revision: Schema.optional(revision),
    search: Schema.optional(text(200)),
    cursor: Schema.optional(GitHistoryCursor),
  }),
  Schema.Struct({
    kind: Schema.Literal("commit"),
    ...scope,
    oid: GitHistoryOid,
    parent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 63 })),
    ignoreWhitespace: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("local-commits"),
    ...scope,
  }),
]);
export type GitHistoryQuery = typeof GitHistoryQuery.Type;

export const GitHistoryCommit = Schema.Struct({
  oid: GitHistoryOid,
  parents: Schema.Array(GitHistoryOid).check(Schema.isMaxLength(64)),
  subject: text(4096),
  author: text(512),
  authoredAt: text(64),
});
export type GitHistoryCommit = typeof GitHistoryCommit.Type;

export const GitHistoryRef = Schema.Struct({
  name: text(512),
  oid: GitHistoryOid,
  kind: Schema.Literals(["branch", "remote", "tag"]),
});
export type GitHistoryRef = typeof GitHistoryRef.Type;

export const GitHistoryPage = Schema.Struct({
  status: Schema.Literal("history"),
  ...scope,
  /** Local-commits only: the ref the commits are measured against, as the host resolved it. */
  comparedWith: Schema.optional(text(512)),
  /** Local-commits only: true when older commits exist than the listing holds. */
  commitsTruncated: Schema.optional(Schema.Boolean),
  commits: Schema.Array(GitHistoryCommit).check(Schema.isMaxLength(MAX_GIT_HISTORY_PAGE)),
  refs: Schema.Array(GitHistoryRef).check(Schema.isMaxLength(256)),
  head: Schema.NullOr(GitHistoryOid),
  branch: Schema.NullOr(text(512)),
  shallow: Schema.Boolean,
  refsTruncated: Schema.Boolean,
  nextCursor: Schema.NullOr(GitHistoryCursor),
});
export type GitHistoryPage = typeof GitHistoryPage.Type;

export const GitHistoryDetail = Schema.Struct({
  status: Schema.Literal("commit"),
  ...scope,
  commit: GitHistoryCommit,
  message: text(65536),
  parent: Schema.NullOr(GitHistoryOid),
  diff: text(MAX_GIT_HISTORY_DIFF_BYTES),
  truncated: Schema.Boolean,
  files: NonNegativeInt,
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type GitHistoryDetail = typeof GitHistoryDetail.Type;

export const GitHistoryResult = Schema.Union([
  GitHistoryPage,
  GitHistoryDetail,
  Schema.Struct({ status: Schema.Literal("unavailable"), message: text(512) }),
]);
export type GitHistoryResult = typeof GitHistoryResult.Type;
export const decodeGitHistoryQuery = Schema.decodeUnknownSync(
  GitHistoryQuery,
  STRICT_DECODE_OPTIONS,
);
export const decodeGitHistoryResult = Schema.decodeUnknownSync(
  GitHistoryResult,
  STRICT_DECODE_OPTIONS,
);
