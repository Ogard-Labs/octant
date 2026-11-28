import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeCheckoutId, CodeRelativePath, CodeThreadId, WorktreeReceiptId } from "./code";

import { BindingRevisionId } from "./projects";
import { UtcTimestamp } from "./events";
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/));
export const ChildWorktreeSnapshotId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("ChildWorktreeSnapshotId"),
);
export const ChildWorktreeSnapshot = Schema.Struct({
  id: ChildWorktreeSnapshotId,
  baseRevision: Revision,
  capturedAt: UtcTimestamp,
  files: Schema.Array(
    Schema.Struct({
      path: CodeRelativePath,
      previousPath: Schema.optional(CodeRelativePath),
      index: Schema.String.check(Schema.isMaxLength(1)),
      worktree: Schema.String.check(Schema.isMaxLength(1)),
    }),
  ).check(Schema.isMaxLength(256)),
});
export type ChildWorktreeSnapshot = typeof ChildWorktreeSnapshot.Type;
export const ChildWorktreeSnapshotData = Schema.Struct({
  ...ChildWorktreeSnapshot.fields,
  worktree: Revision,
  index: Revision,
});
export type ChildWorktreeSnapshotData = typeof ChildWorktreeSnapshotData.Type;
export const decodeChildWorktreeSnapshotData = Schema.decodeUnknownSync(
  ChildWorktreeSnapshotData,
  STRICT_DECODE_OPTIONS,
);
export const ChildWorktreeSourceReview = Schema.Struct({
  refusal: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  selection: Schema.Literals(["committed", "snapshot"]),
  selected: Schema.optional(ChildWorktreeSnapshot),
  preview: Schema.optional(ChildWorktreeSnapshot),
});
export type ChildWorktreeSourceReview = typeof ChildWorktreeSourceReview.Type;
export const CHILD_WORKTREE_SOURCE_UPDATED = "code.child-worktree-source-updated@1";
export const ChildWorktreeSourceUpdated = Schema.Struct({
  kind: Schema.Literal("child-worktree-source-updated"),
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  bindingRevisionId: BindingRevisionId,
  root: Schema.String.check(Schema.isMaxLength(4096)),
  selected: Schema.optional(ChildWorktreeSnapshotData),
  preview: Schema.optional(ChildWorktreeSnapshotData),
  updatedAt: UtcTimestamp,
});
export const decodeChildWorktreeSourceUpdated = Schema.decodeUnknownSync(
  ChildWorktreeSourceUpdated,
  STRICT_DECODE_OPTIONS,
);
export const CHILD_WORKTREE_SEED_UPDATED = "code.child-worktree-seed-updated@1";
export const ChildWorktreeSeedUpdated = Schema.Struct({
  kind: Schema.Literal("child-worktree-seed-updated"),
  receiptId: WorktreeReceiptId,
  snapshotId: ChildWorktreeSnapshotId,
  state: Schema.Literals(["applying", "applied", "failed"]),
  updatedAt: UtcTimestamp,
});
export const decodeChildWorktreeSeedUpdated = Schema.decodeUnknownSync(
  ChildWorktreeSeedUpdated,
  STRICT_DECODE_OPTIONS,
);
