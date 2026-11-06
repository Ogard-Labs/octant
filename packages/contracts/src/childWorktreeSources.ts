import { Schema } from "effect";
import { CodeCheckoutId, CodeRelativePath, CodeThreadId, WorktreeReceiptId } from "./code";

import { BindingRevisionId } from "./projects";
import { UtcTimestamp } from "./events";
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Revision = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/));
export const ChildWorktreeSnapshotId = Schema.UUID.pipe(Schema.brand("ChildWorktreeSnapshotId"));
export const ChildWorktreeSnapshot = Schema.Struct({
  id: ChildWorktreeSnapshotId,
  baseRevision: Revision,
  capturedAt: UtcTimestamp,
  files: Schema.Array(
    Schema.Struct({
      path: CodeRelativePath,
      previousPath: Schema.optional(CodeRelativePath),
      index: Schema.String.pipe(Schema.maxLength(1)),
      worktree: Schema.String.pipe(Schema.maxLength(1)),
    }).annotations(strict),
  ).pipe(Schema.maxItems(256)),
}).annotations(strict);
export type ChildWorktreeSnapshot = typeof ChildWorktreeSnapshot.Type;
export const ChildWorktreeSnapshotData = Schema.Struct({
  ...ChildWorktreeSnapshot.fields,
  worktree: Revision,
  index: Revision,
}).annotations(strict);
export type ChildWorktreeSnapshotData = typeof ChildWorktreeSnapshotData.Type;
export const decodeChildWorktreeSnapshotData = Schema.decodeUnknownSync(ChildWorktreeSnapshotData);
export const ChildWorktreeSourceReview = Schema.Struct({
  refusal: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
  selection: Schema.Literal("committed", "snapshot"),
  selected: Schema.optional(ChildWorktreeSnapshot),
  preview: Schema.optional(ChildWorktreeSnapshot),
}).annotations(strict);
export type ChildWorktreeSourceReview = typeof ChildWorktreeSourceReview.Type;
export const CHILD_WORKTREE_SOURCE_UPDATED = "code.child-worktree-source-updated@1";
export const ChildWorktreeSourceUpdated = Schema.Struct({
  kind: Schema.Literal("child-worktree-source-updated"),
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  bindingRevisionId: BindingRevisionId,
  root: Schema.String.pipe(Schema.maxLength(4096)),
  selected: Schema.optional(ChildWorktreeSnapshotData),
  preview: Schema.optional(ChildWorktreeSnapshotData),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export const decodeChildWorktreeSourceUpdated = Schema.decodeUnknownSync(
  ChildWorktreeSourceUpdated,
);
export const CHILD_WORKTREE_SEED_UPDATED = "code.child-worktree-seed-updated@1";
export const ChildWorktreeSeedUpdated = Schema.Struct({
  kind: Schema.Literal("child-worktree-seed-updated"),
  receiptId: WorktreeReceiptId,
  snapshotId: ChildWorktreeSnapshotId,
  state: Schema.Literal("applying", "applied", "failed"),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export const decodeChildWorktreeSeedUpdated = Schema.decodeUnknownSync(ChildWorktreeSeedUpdated);
