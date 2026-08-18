import { Schema } from "effect";
import { ChatThreadId, ChatTurnId } from "./chat";
import { CodeThreadId } from "./code";
import { CodeOperationId } from "./codeOperations";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const GitObjectId = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/));

export const ThreadCheckpointId = Schema.UUID.pipe(Schema.brand("ThreadCheckpointId"));
export type ThreadCheckpointId = typeof ThreadCheckpointId.Type;

/**
 * A label is how the user finds this point again in a list, so it is a short
 * name rather than a note. Longer text belongs in the conversation it marks.
 */
export const MAX_THREAD_CHECKPOINT_LABEL_LENGTH = 120;
const ThreadCheckpointLabel = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_THREAD_CHECKPOINT_LABEL_LENGTH),
);

/**
 * The point in a thread a checkpoint names, as the caller asks for it.
 *
 * The request carries identity only. Everything a restore later depends on —
 * the Code revision above all — is read from the server's own copy of the
 * thread when the checkpoint is marked, so a caller can neither name a
 * revision the thread never ran on nor pin a checkpoint to another thread's
 * work.
 */
export const ThreadCheckpointAnchorRequest = Schema.Union(
  Schema.Struct({
    mode: Schema.Literal("chat"),
    threadId: ChatThreadId,
    turnId: ChatTurnId,
  }).annotations(strict),
  Schema.Struct({
    mode: Schema.Literal("code"),
    threadId: CodeThreadId,
    operationId: CodeOperationId,
  }).annotations(strict),
);
export type ThreadCheckpointAnchorRequest = typeof ThreadCheckpointAnchorRequest.Type;

/**
 * The point a marked checkpoint holds, as the server recorded it.
 *
 * A Code anchor always carries the revision the checkout was on before that
 * turn ran, because that revision is the whole of what a Code restore starts
 * from. A turn whose revision the host never caught cannot be checkpointed at
 * all rather than being marked as a point that would refuse to restore.
 */
export const ThreadCheckpointAnchor = Schema.Union(
  Schema.Struct({
    mode: Schema.Literal("chat"),
    threadId: ChatThreadId,
    turnId: ChatTurnId,
  }).annotations(strict),
  Schema.Struct({
    mode: Schema.Literal("code"),
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    revision: GitObjectId,
  }).annotations(strict),
);
export type ThreadCheckpointAnchor = typeof ThreadCheckpointAnchor.Type;

/**
 * A point in a thread the user marked so they can come back to it, and the
 * record of what coming back produced.
 *
 * A checkpoint is a marker, never a saved copy of state: the journal already
 * holds every turn, and restoring reads it rather than a snapshot held here.
 * `restoreCount` and `lastRestoredAt` state how often this point was taken up
 * again without listing the threads it produced — each of those carries its own
 * provenance back to this thread, and the journal carries the full history.
 */
export const ThreadCheckpoint = Schema.Struct({
  id: ThreadCheckpointId,
  anchor: ThreadCheckpointAnchor,
  label: ThreadCheckpointLabel,
  /** The Project the marked thread was filed under, when it had one. */
  projectId: Schema.optional(ProjectId),
  lifecycle: Schema.Literal("marked", "forgotten"),
  restoreCount: Schema.Int.pipe(Schema.nonNegative()),
  lastRestoredAt: Schema.optional(UtcTimestamp),
  markedAt: UtcTimestamp,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (checkpoint) => (checkpoint.restoreCount === 0) === (checkpoint.lastRestoredAt === undefined),
    ),
  );
export type ThreadCheckpoint = typeof ThreadCheckpoint.Type;

export const MarkThreadCheckpointCommand = Schema.Struct({
  kind: Schema.Literal("mark-thread-checkpoint"),
  /** Optional caller-chosen id; the server allocates one otherwise. */
  checkpointId: Schema.optional(ThreadCheckpointId),
  anchor: ThreadCheckpointAnchorRequest,
  label: ThreadCheckpointLabel,
}).annotations(strict);
export type MarkThreadCheckpointCommand = typeof MarkThreadCheckpointCommand.Type;

/**
 * Stop offering this point. The turn it named stays exactly where it was: a
 * checkpoint is a marker on the journal, so forgetting one removes the marker
 * and nothing else.
 */
export const ForgetThreadCheckpointCommand = Schema.Struct({
  kind: Schema.Literal("forget-thread-checkpoint"),
  checkpointId: ThreadCheckpointId,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ForgetThreadCheckpointCommand = typeof ForgetThreadCheckpointCommand.Type;

/**
 * Take the thread up again from this point, in a new thread.
 *
 * A restore never rewrites the thread it came from and never rewinds the
 * journal. Chat restores by branching the conversation through the marked turn;
 * Code restores by starting a thread on its own managed worktree at the
 * revision the marked turn ran on, so the source thread's checkout is left
 * exactly as it stands.
 */
export const RestoreFromThreadCheckpointCommand = Schema.Struct({
  kind: Schema.Literal("restore-from-thread-checkpoint"),
  checkpointId: ThreadCheckpointId,
  expectedVersion: AggregateVersion,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200)),
}).annotations(strict);
export type RestoreFromThreadCheckpointCommand = typeof RestoreFromThreadCheckpointCommand.Type;

export const ThreadCheckpointCommand = Schema.Union(
  MarkThreadCheckpointCommand,
  ForgetThreadCheckpointCommand,
  RestoreFromThreadCheckpointCommand,
);
export type ThreadCheckpointCommand = typeof ThreadCheckpointCommand.Type;

/**
 * Why a checkpoint could not be marked or restored. Every reason names a state
 * the user can act on, and none of them discloses a path, a ref, or a provider
 * message.
 */
export const ThreadCheckpointRefusalReason = Schema.Literal(
  "thread-unavailable",
  "anchor-unavailable",
  "revision-unavailable",
  "checkpoint-forgotten",
  "project-unavailable",
  "restore-unavailable",
  "restore-refused",
);
export type ThreadCheckpointRefusalReason = typeof ThreadCheckpointRefusalReason.Type;

/** The thread a restore produced, in the mode the checkpoint was marked in. */
export const ThreadCheckpointRestore = Schema.Union(
  Schema.Struct({
    mode: Schema.Literal("chat"),
    threadId: ChatThreadId,
  }).annotations(strict),
  Schema.Struct({
    mode: Schema.Literal("code"),
    threadId: CodeThreadId,
  }).annotations(strict),
);
export type ThreadCheckpointRestore = typeof ThreadCheckpointRestore.Type;

export const ThreadCheckpointCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("checkpoint-marked"),
    checkpoint: ThreadCheckpoint,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("checkpoint-forgotten"),
    checkpoint: ThreadCheckpoint,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("checkpoint-restored"),
    checkpoint: ThreadCheckpoint,
    restore: ThreadCheckpointRestore,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("checkpoint-refused"),
    reason: ThreadCheckpointRefusalReason,
  }).annotations(strict),
);
export type ThreadCheckpointCommandResult = typeof ThreadCheckpointCommandResult.Type;

export const ThreadCheckpointList = Schema.Struct({
  checkpoints: Schema.Array(ThreadCheckpoint),
}).annotations(strict);
export type ThreadCheckpointList = typeof ThreadCheckpointList.Type;

export const ThreadCheckpointMarked = Schema.Struct({
  kind: Schema.Literal("checkpoint-marked"),
  checkpoint: ThreadCheckpoint,
}).annotations(strict);
export type ThreadCheckpointMarked = typeof ThreadCheckpointMarked.Type;

export const ThreadCheckpointForgotten = Schema.Struct({
  kind: Schema.Literal("checkpoint-forgotten"),
  checkpoint: ThreadCheckpoint,
}).annotations(strict);
export type ThreadCheckpointForgotten = typeof ThreadCheckpointForgotten.Type;

export const ThreadCheckpointRestored = Schema.Struct({
  kind: Schema.Literal("checkpoint-restored"),
  checkpoint: ThreadCheckpoint,
  restore: ThreadCheckpointRestore,
}).annotations(strict);
export type ThreadCheckpointRestored = typeof ThreadCheckpointRestored.Type;

export const THREAD_CHECKPOINT_EVENT_SCHEMAS = {
  "checkpoint.marked@1": ThreadCheckpointMarked,
  "checkpoint.forgotten@1": ThreadCheckpointForgotten,
  "checkpoint.restored@1": ThreadCheckpointRestored,
} as const;

export const THREAD_CHECKPOINT_EVENT_NAMES = Object.freeze(
  Object.keys(THREAD_CHECKPOINT_EVENT_SCHEMAS),
) as ReadonlyArray<keyof typeof THREAD_CHECKPOINT_EVENT_SCHEMAS>;

export const THREAD_CHECKPOINT_AGGREGATE_TYPE = "thread-checkpoint";

export const decodeThreadCheckpointId = Schema.decodeUnknownSync(ThreadCheckpointId);
export const decodeThreadCheckpointAnchor = Schema.decodeUnknownSync(ThreadCheckpointAnchor);
export const decodeThreadCheckpoint = Schema.decodeUnknownSync(ThreadCheckpoint);
export const decodeThreadCheckpointCommand = Schema.decodeUnknownSync(ThreadCheckpointCommand);
export const decodeThreadCheckpointCommandResult = Schema.decodeUnknownSync(
  ThreadCheckpointCommandResult,
);
export const decodeThreadCheckpointList = Schema.decodeUnknownSync(ThreadCheckpointList);
