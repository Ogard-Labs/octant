import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * A managed worktree whose Code thread is archived and that is still on disk:
 * one row in Settings › Code › Worktrees. The size is a bounded walk of the
 * folder, so `sizeComplete` is false when the walk stopped early and the real
 * size is larger.
 */
export const ArchivedWorktree = Schema.Struct({
  threadId: CodeThreadId,
  projectId: ProjectId,
  title: Schema.String.pipe(Schema.maxLength(512)),
  branch: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  path: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
  sizeBytes: Schema.NonNegativeInt,
  sizeComplete: Schema.Boolean,
}).annotations(strict);
export type ArchivedWorktree = typeof ArchivedWorktree.Type;

export const ArchivedWorktreeList = Schema.Struct({
  kind: Schema.Literal("archived-worktrees"),
  worktrees: Schema.Array(ArchivedWorktree).pipe(Schema.maxItems(1_000)),
}).annotations(strict);
export type ArchivedWorktreeList = typeof ArchivedWorktreeList.Type;

/** Removing carries `confirmed: true`: the window asks first. */
export const RemoveArchivedWorktreeRequest = Schema.Struct({
  threadId: CodeThreadId,
  confirmed: Schema.Literal(true),
}).annotations(strict);
export type RemoveArchivedWorktreeRequest = typeof RemoveArchivedWorktreeRequest.Type;

export const ArchivedWorktreeRefusalReason = Schema.Literal(
  "malformed",
  "unauthorized",
  "not-archived",
  "not-found",
  "dirty",
  "busy",
);
export type ArchivedWorktreeRefusalReason = typeof ArchivedWorktreeRefusalReason.Type;

export const RemoveArchivedWorktreeResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("archived-worktree-removed"),
    threadId: CodeThreadId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("archived-worktree-refused"),
    reason: ArchivedWorktreeRefusalReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type RemoveArchivedWorktreeResult = typeof RemoveArchivedWorktreeResult.Type;

export const decodeRemoveArchivedWorktreeRequest = Schema.decodeUnknownSync(
  RemoveArchivedWorktreeRequest,
);
export const decodeRemoveArchivedWorktreeResult = Schema.decodeUnknownSync(
  RemoveArchivedWorktreeResult,
);
export const decodeArchivedWorktreeList = Schema.decodeUnknownSync(ArchivedWorktreeList);
