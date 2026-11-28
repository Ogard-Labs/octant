import { Schema } from "effect";
import { NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeThreadId } from "./code";
import { ProjectId } from "./projects";

/**
 * A managed worktree whose Code thread is archived and that is still on disk:
 * one row in Settings › Code › Worktrees. The size is a bounded walk of the
 * folder, so `sizeComplete` is false when the walk stopped early and the real
 * size is larger.
 */
export const ArchivedWorktree = Schema.Struct({
  threadId: CodeThreadId,
  projectId: ProjectId,
  title: Schema.String.check(Schema.isMaxLength(512)),
  branch: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  path: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  sizeBytes: NonNegativeInt,
  sizeComplete: Schema.Boolean,
});
export type ArchivedWorktree = typeof ArchivedWorktree.Type;

export const ArchivedWorktreeList = Schema.Struct({
  kind: Schema.Literal("archived-worktrees"),
  worktrees: Schema.Array(ArchivedWorktree).check(Schema.isMaxLength(1_000)),
});
export type ArchivedWorktreeList = typeof ArchivedWorktreeList.Type;

/** Removing carries `confirmed: true`: the window asks first. */
export const RemoveArchivedWorktreeRequest = Schema.Struct({
  threadId: CodeThreadId,
  confirmed: Schema.Literal(true),
});
export type RemoveArchivedWorktreeRequest = typeof RemoveArchivedWorktreeRequest.Type;

export const ArchivedWorktreeRefusalReason = Schema.Literals([
  "malformed",
  "unauthorized",
  "not-archived",
  "not-found",
  "dirty",
  "turn-running",
  "busy",
]);
export type ArchivedWorktreeRefusalReason = typeof ArchivedWorktreeRefusalReason.Type;

export const RemoveArchivedWorktreeResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("archived-worktree-removed"),
    threadId: CodeThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("archived-worktree-refused"),
    reason: ArchivedWorktreeRefusalReason,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type RemoveArchivedWorktreeResult = typeof RemoveArchivedWorktreeResult.Type;

export const decodeRemoveArchivedWorktreeRequest = Schema.decodeUnknownSync(
  RemoveArchivedWorktreeRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemoveArchivedWorktreeResult = Schema.decodeUnknownSync(
  RemoveArchivedWorktreeResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeArchivedWorktreeList = Schema.decodeUnknownSync(
  ArchivedWorktreeList,
  STRICT_DECODE_OPTIONS,
);
