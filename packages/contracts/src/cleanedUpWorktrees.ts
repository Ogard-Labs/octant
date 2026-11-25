import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * A Code thread whose worktree folder the host removed to save space and can
 * bring back: its branch, history and checkpoints are kept. `cleaning-up` and
 * `restoring` are a cleanup or restore a restart interrupted; the thread takes
 * no turn in any of the three states until the checkout is restored.
 */
export const CleanedUpWorktree = Schema.Struct({
  threadId: CodeThreadId,
  projectId: ProjectId,
  title: Schema.String.pipe(Schema.maxLength(512)),
  branch: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  path: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
  state: Schema.Literal("cleaned-up", "cleaning-up", "restoring"),
}).annotations(strict);
export type CleanedUpWorktree = typeof CleanedUpWorktree.Type;

export const CleanedUpWorktreeList = Schema.Struct({
  kind: Schema.Literal("cleaned-up-worktrees"),
  worktrees: Schema.Array(CleanedUpWorktree).pipe(Schema.maxItems(1_000)),
}).annotations(strict);
export type CleanedUpWorktreeList = typeof CleanedUpWorktreeList.Type;

/** Restoring carries `confirmed: true`: the window asks first. */
export const RestoreCleanedUpWorktreeRequest = Schema.Struct({
  threadId: CodeThreadId,
  confirmed: Schema.Literal(true),
}).annotations(strict);
export type RestoreCleanedUpWorktreeRequest = typeof RestoreCleanedUpWorktreeRequest.Type;

export const CleanedUpWorktreeRefusalReason = Schema.Literal(
  "malformed",
  "unauthorized",
  "not-found",
  "not-cleaned-up",
  "branch-changed",
  "folder-in-use",
  "unverified",
  "busy",
);
export type CleanedUpWorktreeRefusalReason = typeof CleanedUpWorktreeRefusalReason.Type;

export const RestoreCleanedUpWorktreeResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("cleaned-up-worktree-restored"),
    threadId: CodeThreadId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cleaned-up-worktree-refused"),
    reason: CleanedUpWorktreeRefusalReason,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type RestoreCleanedUpWorktreeResult = typeof RestoreCleanedUpWorktreeResult.Type;

export const decodeRestoreCleanedUpWorktreeRequest = Schema.decodeUnknownSync(
  RestoreCleanedUpWorktreeRequest,
);
export const decodeRestoreCleanedUpWorktreeResult = Schema.decodeUnknownSync(
  RestoreCleanedUpWorktreeResult,
);
export const decodeCleanedUpWorktreeList = Schema.decodeUnknownSync(CleanedUpWorktreeList);
