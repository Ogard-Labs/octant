/**
 * Moving a thread from one hub member to another before a planned shutdown,
 * and the Code handover that stands in when a move cannot finish.
 *
 * The source freezes the thread before anything leaves it, the destination
 * opens what arrives as a new thread under its own journal, and the source
 * erases its copy only after the destination commits. Every request carries
 * the move id so a lost answer is asked again rather than repeated.
 */

import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { HubMemberId } from "./hubAndSpokes";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const bounded = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maxLength));

export const ThreadMoveId = Schema.UUID.pipe(Schema.brand("ThreadMoveId"));
export type ThreadMoveId = typeof ThreadMoveId.Type;

export const HandoverId = Schema.UUID.pipe(Schema.brand("HandoverId"));
export type HandoverId = typeof HandoverId.Type;

/** A thread named by its mode and its id; each mode brands its own id. */
export const MovedThreadReference = Schema.Struct({
  mode: OctantMode,
  threadId: Schema.UUID,
}).annotations(strict);
export type MovedThreadReference = typeof MovedThreadReference.Type;

/**
 * Why a move could not finish. Every failed move journals exactly one of
 * these and shows it to the person; `refused` answers a missing Move in item,
 * Owners unticked, and a source the destination no longer lists in the same
 * words, so the answer reveals nothing about which.
 */
export const THREAD_MOVE_FAILURE_REASONS = [
  "busy",
  "delegated",
  "unlock-required",
  "refused",
  "no-eligible-project",
  "destination-unreachable",
  "transfer-failed",
] as const;
export const ThreadMoveFailureReason = Schema.Literal(...THREAD_MOVE_FAILURE_REASONS);
export type ThreadMoveFailureReason = typeof ThreadMoveFailureReason.Type;

/** Why a handover finished without reaching any other computer. */
export const HandoverShortfall = Schema.Literal("push-failed", "no-remote");
export type HandoverShortfall = typeof HandoverShortfall.Type;

/**
 * What a move carries. `index-snapshot` and `working-tree-snapshot` travel
 * inside the Git bundle as two commits, because one commit holds one tree and
 * a file staged at one version and edited again holds two.
 */
export const ThreadMovePartKind = Schema.Literal(
  "thread-bundle",
  "attachment",
  "original-input",
  "generated-image",
  "browser-capture",
  "canvas",
  "git-bundle",
);
export type ThreadMovePartKind = typeof ThreadMovePartKind.Type;

export const ThreadMovePart = Schema.Struct({
  partId: bounded(64),
  kind: ThreadMovePartKind,
  bytes: NonNegativeInt,
  sha256: digest,
}).annotations(strict);
export type ThreadMovePart = typeof ThreadMovePart.Type;

/** Every part of one move, with its size and digest. There is no size limit. */
export const ThreadMoveManifest = Schema.Struct({
  parts: Schema.Array(ThreadMovePart).pipe(
    Schema.minItems(1),
    Schema.filter((parts) =>
      new Set(parts.map((part) => part.partId)).size === parts.length
        ? true
        : "Part ids must not repeat.",
    ),
    Schema.filter((parts) =>
      parts.filter((part) => part.kind === "thread-bundle").length === 1
        ? true
        : "A move carries exactly one thread bundle.",
    ),
  ),
}).annotations(strict);
export type ThreadMoveManifest = typeof ThreadMoveManifest.Type;

/**
 * The signed offer the source sends after the person's unlock. A Chat thread
 * may name no Project; Work and Code always name one on the destination.
 */
export const ThreadMoveOffer = Schema.Struct({
  moveId: ThreadMoveId,
  source: MovedThreadReference,
  title: bounded(256),
  destinationProjectId: Schema.optional(ProjectId),
  /** For Code: the remote URLs the source checkout has, to match the destination's clone. */
  repositoryRemotes: Schema.optional(Schema.Array(bounded(2_048)).pipe(Schema.maxItems(16))),
  manifest: ThreadMoveManifest,
})
  .pipe(
    Schema.filter((offer) =>
      offer.source.mode === "chat" || offer.destinationProjectId !== undefined
        ? true
        : "A Work or Code thread moves into a Project.",
    ),
    Schema.filter((offer) =>
      offer.source.mode !== "code" || (offer.repositoryRemotes?.length ?? 0) > 0
        ? true
        : "A Code thread names the repository it belongs to.",
    ),
  )
  .annotations(strict);
export type ThreadMoveOffer = typeof ThreadMoveOffer.Type;

/** The destination's answers, one per step; every one names the move. */
export const ThreadMoveReady = Schema.Struct({
  status: Schema.Literal("ready"),
  moveId: ThreadMoveId,
  /** A one-use receiving ticket bound to this move id. */
  ticket: bounded(128),
}).annotations(strict);
export type ThreadMoveReady = typeof ThreadMoveReady.Type;

export const ThreadMoveRefused = Schema.Struct({
  status: Schema.Literal("refused"),
  moveId: ThreadMoveId,
  reason: Schema.Literal("refused", "unlock-required", "no-eligible-project", "transfer-failed"),
}).annotations(strict);
export type ThreadMoveRefused = typeof ThreadMoveRefused.Type;

export const ThreadMoveArrived = Schema.Struct({
  status: Schema.Literal("arrived"),
  moveId: ThreadMoveId,
  thread: MovedThreadReference,
}).annotations(strict);
export type ThreadMoveArrived = typeof ThreadMoveArrived.Type;

export const ThreadMoveCommitted = Schema.Struct({
  status: Schema.Literal("committed"),
  moveId: ThreadMoveId,
  thread: MovedThreadReference,
}).annotations(strict);
export type ThreadMoveCommitted = typeof ThreadMoveCommitted.Type;

/**
 * What the destination holds for a move, read by a source that lost an answer
 * or restarted. `receiving` names the chunks already acknowledged so the
 * transfer resumes after the last of them.
 */
export const ThreadMoveDestinationState = Schema.Union(
  Schema.Struct({
    state: Schema.Literal("receiving"),
    moveId: ThreadMoveId,
    acknowledged: Schema.Array(
      Schema.Struct({ partId: bounded(64), chunks: NonNegativeInt }).annotations(strict),
    ),
  }).annotations(strict),
  Schema.Struct({
    state: Schema.Literal("arrived", "committed"),
    moveId: ThreadMoveId,
    thread: MovedThreadReference,
  }).annotations(strict),
  Schema.Struct({
    state: Schema.Literal("discarded", "unknown"),
    moveId: ThreadMoveId,
  }).annotations(strict),
);
export type ThreadMoveDestinationState = typeof ThreadMoveDestinationState.Type;

/** A handover notice: where the person can continue the work, never the work itself. */
export const HandoverNotice = Schema.Struct({
  handoverId: HandoverId,
  title: bounded(256),
  repositoryRemote: bounded(2_048),
  branch: bounded(255),
}).annotations(strict);
export type HandoverNotice = typeof HandoverNotice.Type;

/** What a person chooses for one thread in Prepare to shut down. */
export const ShutdownChoice = Schema.Literal(
  "move",
  "move-after-turn",
  "stop-and-move",
  "hand-over",
  "leave-here",
);
export type ShutdownChoice = typeof ShutdownChoice.Type;

export const THREAD_MOVE_EVENT_NAMES = {
  moveStarted: "thread.move-started@1",
  movedIn: "thread.moved-in@1",
  moveCommitted: "thread.move-committed@1",
  movedOut: "thread.moved-out@1",
  moveFailed: "thread.move-failed@1",
  handoverStarted: "thread.handover-started@1",
} as const;

/** The source froze the thread; nothing left the source before this was recorded. */
export const ThreadMoveStarted = Schema.Struct({
  moveId: ThreadMoveId,
  thread: MovedThreadReference,
  destinationMemberId: HubMemberId,
  startedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadMoveStarted = typeof ThreadMoveStarted.Type;

/** The destination opened what arrived as a new thread; it adopts no journal. */
export const ThreadMovedIn = Schema.Struct({
  moveId: ThreadMoveId,
  thread: MovedThreadReference,
  origin: Schema.Struct({
    memberId: HubMemberId,
    thread: MovedThreadReference,
  }).annotations(strict),
  /** The owner device whose unlock signed the move. */
  ownerMemberId: HubMemberId,
  arrivedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadMovedIn = typeof ThreadMovedIn.Type;

export const ThreadMoveCommittedEvent = Schema.Struct({
  moveId: ThreadMoveId,
  thread: MovedThreadReference,
  /** `source` when the source sent the commit; `activated-anyway` when a person on the destination did. */
  by: Schema.Literal("source", "activated-anyway"),
  committedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadMoveCommittedEvent = typeof ThreadMoveCommittedEvent.Type;

/** The source learned `committed`; the erase follows through the ordinary purge. */
export const ThreadMovedOut = Schema.Struct({
  moveId: ThreadMoveId,
  thread: MovedThreadReference,
  destination: Schema.Struct({
    memberId: HubMemberId,
    thread: MovedThreadReference,
  }).annotations(strict),
  /** True when the managed worktree stays because it holds files that did not move. */
  worktreeKept: Schema.Boolean,
  movedOutAt: UtcTimestamp,
}).annotations(strict);
export type ThreadMovedOut = typeof ThreadMovedOut.Type;

export const ThreadMoveFailed = Schema.Struct({
  moveId: ThreadMoveId,
  thread: MovedThreadReference,
  reason: ThreadMoveFailureReason,
  failedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadMoveFailed = typeof ThreadMoveFailed.Type;

export const ThreadHandoverStarted = Schema.Struct({
  handoverId: HandoverId,
  thread: MovedThreadReference,
  branch: bounded(255),
  startedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadHandoverStarted = typeof ThreadHandoverStarted.Type;

export const decodeThreadMoveOffer = Schema.decodeUnknownSync(ThreadMoveOffer);
export const decodeThreadMoveDestinationState = Schema.decodeUnknownSync(
  ThreadMoveDestinationState,
);
export const decodeHandoverNotice = Schema.decodeUnknownSync(HandoverNotice);
