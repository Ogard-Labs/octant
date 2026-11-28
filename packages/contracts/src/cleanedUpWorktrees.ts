import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeThreadId } from "./code";
import { ProjectId } from "./projects";

/**
 * A Code thread whose worktree folder the host removed to save space and can
 * bring back: its branch, history and checkpoints are kept. `cleaning-up` and
 * `restoring` are a cleanup or restore a restart interrupted; the thread takes
 * no turn in any of the three states until the checkout is restored.
 */
export const CleanedUpWorktree = Schema.Struct({
  threadId: CodeThreadId,
  projectId: ProjectId,
  title: Schema.String.check(Schema.isMaxLength(512)),
  branch: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  path: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  state: Schema.Literals(["cleaned-up", "cleaning-up", "restoring"]),
});
export type CleanedUpWorktree = typeof CleanedUpWorktree.Type;

export const CleanedUpWorktreeList = Schema.Struct({
  kind: Schema.Literal("cleaned-up-worktrees"),
  worktrees: Schema.Array(CleanedUpWorktree).check(Schema.isMaxLength(1_000)),
});
export type CleanedUpWorktreeList = typeof CleanedUpWorktreeList.Type;

/** Restoring carries `confirmed: true`: the window asks first. */
export const RestoreCleanedUpWorktreeRequest = Schema.Struct({
  threadId: CodeThreadId,
  confirmed: Schema.Literal(true),
});
export type RestoreCleanedUpWorktreeRequest = typeof RestoreCleanedUpWorktreeRequest.Type;

export const CleanedUpWorktreeRefusalReason = Schema.Literals([
  "malformed",
  "unauthorized",
  "not-found",
  "not-cleaned-up",
  "branch-changed",
  "folder-in-use",
  "cleanup-running",
  "restore-running",
  "files-missing",
  "partial-folder",
  "needs-attention",
  "unverified",
  "busy",
]);
export type CleanedUpWorktreeRefusalReason = typeof CleanedUpWorktreeRefusalReason.Type;

export const RestoreCleanedUpWorktreeResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cleaned-up-worktree-restored"),
    threadId: CodeThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("cleaned-up-worktree-refused"),
    reason: CleanedUpWorktreeRefusalReason,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type RestoreCleanedUpWorktreeResult = typeof RestoreCleanedUpWorktreeResult.Type;

export const decodeRestoreCleanedUpWorktreeRequest = Schema.decodeUnknownSync(
  RestoreCleanedUpWorktreeRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeRestoreCleanedUpWorktreeResult = Schema.decodeUnknownSync(
  RestoreCleanedUpWorktreeResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeCleanedUpWorktreeList = Schema.decodeUnknownSync(
  CleanedUpWorktreeList,
  STRICT_DECODE_OPTIONS,
);
