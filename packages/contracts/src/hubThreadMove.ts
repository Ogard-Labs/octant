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
  /** The destination has no provider of the kind the thread ran on, so it cannot continue it. */
  "no-matching-provider",
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
  reason: Schema.Literal(
    "refused",
    "unlock-required",
    "no-eligible-project",
    "transfer-failed",
    "no-matching-provider",
  ),
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

/**
 * A moved Work or Code thread's earlier conversation, kept on the thread it
 * arrived as and erased with it. Its first turn here carries it once, as a
 * disclosed handoff; it is the person's own conversation, not outside content.
 */
export const THREAD_MOVED_HISTORY_AGGREGATE = "thread-moved-history";
export const THREAD_MOVED_HISTORY_EVENT_NAMES = {
  imported: "thread.moved-history-imported@1",
  delivered: "thread.moved-history-delivered@1",
} as const;

export const MovedHistoryEntry = Schema.Struct({
  role: Schema.Literal("person", "assistant"),
  text: Schema.String.pipe(Schema.maxLength(1_000_000)),
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type MovedHistoryEntry = typeof MovedHistoryEntry.Type;

export const MovedHistoryImported = Schema.Struct({
  threadId: Schema.UUID,
  moveId: ThreadMoveId,
  entries: Schema.Array(MovedHistoryEntry).pipe(Schema.maxItems(10_000)),
  importedAt: UtcTimestamp,
}).annotations(strict);
export type MovedHistoryImported = typeof MovedHistoryImported.Type;

export const MovedHistoryDelivered = Schema.Struct({
  threadId: Schema.UUID,
  deliveredAt: UtcTimestamp,
}).annotations(strict);
export type MovedHistoryDelivered = typeof MovedHistoryDelivered.Type;

/**
 * The most threads one unlock moves. The batch's thread list rides inside the
 * destination's owner challenge, whose body the owner routes cap at 16 KiB, so
 * a longer list moves in further batches, each with its own unlock.
 */
export const SHUTDOWN_BATCH_MAX = 64;

/**
 * What an owner device asks the destination for after a fresh own-class
 * unlock: a one-use ticket letting one named computer move one thread here.
 */
export const OwnerThreadMoveTicketRequest = Schema.Struct({
  sourceMemberId: HubMemberId,
  /**
   * Prepare to shut down's batch: the threads this one unlock may move, each
   * once. Absent, the ticket opens one move of any thread from that source.
   */
  threads: Schema.optional(
    Schema.Array(MovedThreadReference).pipe(
      Schema.minItems(1),
      Schema.maxItems(SHUTDOWN_BATCH_MAX),
    ),
  ),
}).annotations(strict);
export type OwnerThreadMoveTicketRequest = typeof OwnerThreadMoveTicketRequest.Type;

/**
 * The source asks a member which of its Projects would take a thread of this
 * mode (for Code, which are bound to a clone of the same repository). The
 * answer names Projects only; it opens nothing.
 */
export const ThreadMoveProjectsRequest = Schema.Struct({
  mode: OctantMode,
  repositoryRemotes: Schema.optional(Schema.Array(bounded(2_048)).pipe(Schema.maxItems(16))),
}).annotations(strict);
export type ThreadMoveProjectsRequest = typeof ThreadMoveProjectsRequest.Type;

export const ThreadMoveProjectChoice = Schema.Struct({
  projectId: ProjectId,
  title: bounded(256),
}).annotations(strict);
export type ThreadMoveProjectChoice = typeof ThreadMoveProjectChoice.Type;

export const ThreadMoveProjects = Schema.Struct({
  status: Schema.Literal("listed"),
  projects: Schema.Array(ThreadMoveProjectChoice).pipe(Schema.maxItems(256)),
  /** A Chat thread may also arrive in no Project. */
  noProjectAllowed: Schema.Boolean,
}).annotations(strict);
export type ThreadMoveProjects = typeof ThreadMoveProjects.Type;

// ── Window routes ──────────────────────────────────────────────────────────
// A window on the source asks for these through the loopback desktop bridge.

/** The thread a window's Environment tool shows. */
export const ThreadMoveThreadRequest = Schema.Struct({
  thread: MovedThreadReference,
}).annotations(strict);
export type ThreadMoveThreadRequest = typeof ThreadMoveThreadRequest.Type;

/** One member computer as the Computer card lists it for one thread. */
export const ThreadMoveDestination = Schema.Struct({
  memberId: HubMemberId,
  name: bounded(256),
  role: Schema.Literal("hub", "spoke"),
  /** Whether it answered just now. */
  reachable: Schema.Boolean,
  /** Set when it answered but cannot take this thread. */
  refusal: Schema.optional(Schema.Literal("refused", "no-eligible-project")),
  projects: Schema.Array(ThreadMoveProjectChoice).pipe(Schema.maxItems(256)),
  noProjectAllowed: Schema.Boolean,
}).annotations(strict);
export type ThreadMoveDestination = typeof ThreadMoveDestination.Type;

export const ThreadMoveDestinations = Schema.Struct({
  status: Schema.Literal("listed"),
  /** Why the thread cannot move from here at all, before any destination is asked. */
  blocked: Schema.optional(Schema.Literal("busy", "delegated", "refused")),
  /** A turn runs or the thread waits on the person: Move after this turn is offered. */
  busy: Schema.Boolean,
  destinations: Schema.Array(ThreadMoveDestination).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type ThreadMoveDestinations = typeof ThreadMoveDestinations.Type;

export const ThreadMoveChallengeRequest = Schema.Struct({
  destinationMemberId: HubMemberId,
}).annotations(strict);
export type ThreadMoveChallengeRequest = typeof ThreadMoveChallengeRequest.Type;

/**
 * The destination's owner challenge for the move ticket, with every field the
 * unlock key signs, so this Mac's Touch ID prompt signs exactly that one action.
 */
export const ThreadMoveUnlockChallenge = Schema.Struct({
  challengeId: Schema.UUID,
  nonce: bounded(64),
  hostMemberId: HubMemberId,
  ownerMemberId: HubMemberId,
  method: Schema.Literal("POST"),
  path: bounded(128),
  bodyHash: digest,
  expiresAt: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type ThreadMoveUnlockChallenge = typeof ThreadMoveUnlockChallenge.Type;

export const ThreadMoveChallengeOutcome = Schema.Union(
  Schema.Struct({ status: Schema.Literal("challenge"), challenge: ThreadMoveUnlockChallenge }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    kind: Schema.Literal("unlock-required", "destination-unreachable", "refused"),
  }),
);
export type ThreadMoveChallengeOutcome = typeof ThreadMoveChallengeOutcome.Type;

/** When the move starts: now, or once the running turn ends. */
export const ThreadMoveTiming = Schema.Literal("now", "after-turn");
export type ThreadMoveTiming = typeof ThreadMoveTiming.Type;

export const ThreadMoveStartRequest = Schema.Struct({
  thread: MovedThreadReference,
  destinationMemberId: HubMemberId,
  destinationProjectId: Schema.optional(ProjectId),
  timing: ThreadMoveTiming,
  /** The raw ES256 signature this Mac's unlock key made over the challenge. */
  unlock: Schema.Struct({
    challengeId: Schema.UUID,
    signature: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,512}$/)),
  }).annotations(strict),
}).annotations(strict);
export type ThreadMoveStartRequest = typeof ThreadMoveStartRequest.Type;

export const ThreadMoveStartOutcome = Schema.Union(
  Schema.Struct({ status: Schema.Literal("started", "waiting-for-turn") }),
  Schema.Struct({ status: Schema.Literal("refused"), reason: ThreadMoveFailureReason }),
);
export type ThreadMoveStartOutcome = typeof ThreadMoveStartOutcome.Type;

export const ThreadMoveControlRequest = Schema.Struct({
  moveId: ThreadMoveId,
}).annotations(strict);
export type ThreadMoveControlRequest = typeof ThreadMoveControlRequest.Type;

/** A thread that moved away from this host, for its "Moved to" tombstone. */
export const ThreadMoveDeparture = Schema.Struct({
  moveId: ThreadMoveId,
  thread: MovedThreadReference,
  destinationMemberId: HubMemberId,
  destinationThread: MovedThreadReference,
  /** A worktree moved out of the managed folder because it held what the move did not carry. */
  keptWorktree: Schema.optional(bounded(4_096)),
  /** The Project's own checkout kept the thread's changes too. */
  changesRemainInCheckout: Schema.Boolean,
  movedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadMoveDeparture = typeof ThreadMoveDeparture.Type;

/** Where one thread stands, as its Environment tool and its notices show it. */
export const ThreadMoveThreadStatus = Schema.Struct({
  status: Schema.Literal("read"),
  /** Moving away: frozen here while the move runs. */
  sending: Schema.optional(
    Schema.Struct({
      moveId: ThreadMoveId,
      destinationMemberId: HubMemberId,
      destinationName: bounded(256),
      state: Schema.Literal("frozen", "offered", "arrived", "committed"),
      bytesSent: NonNegativeInt,
      bytesTotal: NonNegativeInt,
      startedAt: UtcTimestamp,
    }).annotations(strict),
  ),
  /** Set to move once the running turn ends. */
  waiting: Schema.optional(
    Schema.Struct({
      destinationMemberId: HubMemberId,
      destinationName: bounded(256),
    }).annotations(strict),
  ),
  /**
   * The last move or wait a window started for this thread has ended: it
   * moved, could not move, or the person pressed Don't move. Kept until the
   * thread starts another move and never dismissed, so a batch that named the
   * thread reads that it ended even after its failure notice is put away.
   */
  settled: Schema.optional(Schema.Struct({ settledAt: UtcTimestamp }).annotations(strict)),
  /** Arrived here and not yet committed by its source. */
  arriving: Schema.optional(
    Schema.Struct({
      moveId: ThreadMoveId,
      originMemberId: HubMemberId,
      originName: bounded(256),
      /** The source has been silent for five minutes: Activate anyway is offered. */
      mayActivateAnyway: Schema.Boolean,
    }).annotations(strict),
  ),
  /** The last move of this thread that could not finish, until the person dismisses it. */
  failure: Schema.optional(
    Schema.Struct({
      moveId: ThreadMoveId,
      reason: ThreadMoveFailureReason,
      failedAt: UtcTimestamp,
    }).annotations(strict),
  ),
  /** The thread moved away and was erased here: its "Moved to" tombstone. */
  departed: Schema.optional(
    Schema.Struct({ ...ThreadMoveDeparture.fields, destinationName: bounded(256) }).annotations(
      strict,
    ),
  ),
}).annotations(strict);
export type ThreadMoveThreadStatus = typeof ThreadMoveThreadStatus.Type;

/**
 * A window on the hub turning Accept moved threads on or off. The hub keeps
 * no peer grants, so this switch stands where a spoke's Move in item does;
 * every move still needs an owner's own fresh unlock on the hub.
 */
export const HubAcceptMovedThreadsRequest = Schema.Struct({
  enabled: Schema.Boolean,
}).annotations(strict);
export type HubAcceptMovedThreadsRequest = typeof HubAcceptMovedThreadsRequest.Type;
export const decodeHubAcceptMovedThreadsRequest = Schema.decodeUnknownSync(
  HubAcceptMovedThreadsRequest,
);

// ── Prepare to shut down ───────────────────────────────────────────────────

/** One member computer as Prepare to shut down lists it. */
export const ShutdownListedMember = Schema.Struct({
  memberId: HubMemberId,
  name: bounded(256),
  role: Schema.Literal("hub", "spoke"),
  reachable: Schema.Boolean,
  refusal: Schema.optional(Schema.Literal("refused")),
}).annotations(strict);
export type ShutdownListedMember = typeof ShutdownListedMember.Type;

/** Whether one member can take one listed thread, and into which Projects. */
export const ShutdownPlacement = Schema.Struct({
  memberId: HubMemberId,
  reason: Schema.optional(ThreadMoveFailureReason),
  projects: Schema.Array(ThreadMoveProjectChoice).pipe(Schema.maxItems(256)),
  noProjectAllowed: Schema.Boolean,
}).annotations(strict);
export type ShutdownPlacement = typeof ShutdownPlacement.Type;

export const ShutdownThreadRow = Schema.Struct({
  thread: MovedThreadReference,
  title: bounded(256),
  projectName: Schema.optional(bounded(256)),
  /** A turn runs or the thread waits on the person. */
  busy: Schema.Boolean,
  /** Open, but with no turn in the last 14 days: folded under Older threads. */
  older: Schema.Boolean,
  placements: Schema.Array(ShutdownPlacement).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type ShutdownThreadRow = typeof ShutdownThreadRow.Type;

export const ShutdownListing = Schema.Struct({
  status: Schema.Literal("listed"),
  members: Schema.Array(ShutdownListedMember).pipe(Schema.maxItems(64)),
  rows: Schema.Array(ShutdownThreadRow).pipe(Schema.maxItems(2_000)),
  /** The member the person last moved a thread to, for the starting destination. */
  lastMovedTo: Schema.optional(HubMemberId),
}).annotations(strict);
export type ShutdownListing = typeof ShutdownListing.Type;

const BatchThreads = Schema.Array(MovedThreadReference).pipe(
  Schema.minItems(1),
  Schema.maxItems(SHUTDOWN_BATCH_MAX),
);

/** The challenge for one destination's batch: one unlock covers exactly these threads. */
export const ShutdownChallengeRequest = Schema.Struct({
  destinationMemberId: HubMemberId,
  threads: BatchThreads,
}).annotations(strict);
export type ShutdownChallengeRequest = typeof ShutdownChallengeRequest.Type;

export const ShutdownBatchRow = Schema.Struct({
  thread: MovedThreadReference,
  destinationProjectId: Schema.optional(ProjectId),
  timing: ThreadMoveTiming,
}).annotations(strict);
export type ShutdownBatchRow = typeof ShutdownBatchRow.Type;

/** One destination's batch, unlocked once; the rows must name exactly the challenged threads. */
export const ShutdownStartRequest = Schema.Struct({
  destinationMemberId: HubMemberId,
  rows: Schema.Array(ShutdownBatchRow).pipe(
    Schema.minItems(1),
    Schema.maxItems(SHUTDOWN_BATCH_MAX),
  ),
  unlock: Schema.Struct({
    challengeId: Schema.UUID,
    signature: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,512}$/)),
  }).annotations(strict),
}).annotations(strict);
export type ShutdownStartRequest = typeof ShutdownStartRequest.Type;

export const ShutdownStartOutcome = Schema.Union(
  Schema.Struct({ status: Schema.Literal("started") }),
  Schema.Struct({ status: Schema.Literal("refused"), reason: ThreadMoveFailureReason }),
);
export type ShutdownStartOutcome = typeof ShutdownStartOutcome.Type;

export const decodeOwnerThreadMoveTicketRequest = Schema.decodeUnknownSync(
  OwnerThreadMoveTicketRequest,
);
export const decodeThreadMoveOffer = Schema.decodeUnknownSync(ThreadMoveOffer);
export const decodeThreadMoveDestinationState = Schema.decodeUnknownSync(
  ThreadMoveDestinationState,
);
export const decodeHandoverNotice = Schema.decodeUnknownSync(HandoverNotice);
export const decodeThreadMoveProjectsRequest = Schema.decodeUnknownSync(ThreadMoveProjectsRequest);
export const decodeThreadMoveProjects = Schema.decodeUnknownSync(ThreadMoveProjects);
export const decodeThreadMoveThreadRequest = Schema.decodeUnknownSync(ThreadMoveThreadRequest);
export const decodeThreadMoveChallengeRequest = Schema.decodeUnknownSync(
  ThreadMoveChallengeRequest,
);
export const decodeThreadMoveStartRequest = Schema.decodeUnknownSync(ThreadMoveStartRequest);
export const decodeThreadMoveControlRequest = Schema.decodeUnknownSync(ThreadMoveControlRequest);
export const decodeThreadMoveDestinations = Schema.decodeUnknownSync(ThreadMoveDestinations);
export const decodeThreadMoveChallengeOutcome = Schema.decodeUnknownSync(
  ThreadMoveChallengeOutcome,
);
export const decodeThreadMoveStartOutcome = Schema.decodeUnknownSync(ThreadMoveStartOutcome);
export const decodeThreadMoveThreadStatus = Schema.decodeUnknownSync(ThreadMoveThreadStatus);
export const decodeShutdownListing = Schema.decodeUnknownSync(ShutdownListing);
export const decodeShutdownChallengeRequest = Schema.decodeUnknownSync(ShutdownChallengeRequest);
export const decodeShutdownStartRequest = Schema.decodeUnknownSync(ShutdownStartRequest);
export const decodeShutdownStartOutcome = Schema.decodeUnknownSync(ShutdownStartOutcome);
