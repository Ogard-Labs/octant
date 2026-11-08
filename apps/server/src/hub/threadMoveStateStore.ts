// What a host remembers about thread moves: the ones it is receiving (which
// parts have arrived, and the thread they became) and the ones it is sending
// (the frozen thread, where it is going, and how far it got). The journal
// records each step with its principal; this file is what a restart reads to
// resume a transfer or finish a commit. It sits beside the hub state in the
// Octant data folder where only the person's account reads it, and a file that
// cannot be read back exactly is treated as no state.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HubMemberId,
  MovedThreadReference,
  ThreadMoveId,
  ThreadMoveOffer,
  UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";

const SUBDIR = "hub";
const FILE = "thread-moves.json";
/** Where the parts of each move are staged, one folder per move id. */
export const THREAD_MOVE_PARTS_SUBDIR = join(SUBDIR, "thread-moves");
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

/**
 * A move this host is receiving. `receiving` counts the chunks each part has
 * delivered so a cut transfer resumes; `arrived` and `committed` name the
 * thread it became; `discarded` keeps the id so a late request is answered
 * rather than started again.
 */
export const ReceivedMove = Schema.Struct({
  moveId: ThreadMoveId,
  senderMemberId: HubMemberId,
  ownerMemberId: HubMemberId,
  offer: ThreadMoveOffer,
  state: Schema.Literal("receiving", "arrived", "committed", "discarded"),
  chunks: Schema.Record({ key: Schema.String, value: NonNegativeInt }),
  thread: Schema.optional(MovedThreadReference),
  receivedAt: UtcTimestamp,
  /** Updated on every request from the source, so Activate anyway can tell silence. */
  lastHeardAt: UtcTimestamp,
}).annotations(strict);
export type ReceivedMove = typeof ReceivedMove.Type;

/** A part this host packed for a move it is sending, staged until the move commits. */
export const SentMovePart = Schema.Struct({
  partId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  /** Chunks the destination acknowledged, so a resumed transfer starts after them. */
  acknowledgedChunks: NonNegativeInt,
}).annotations(strict);
export type SentMovePart = typeof SentMovePart.Type;

/**
 * A move this host is sending. The thread is frozen from `frozen` until the
 * move fails (and unfreezes) or commits (and the thread is erased).
 */
export const SentMove = Schema.Struct({
  moveId: ThreadMoveId,
  thread: MovedThreadReference,
  targetMemberId: HubMemberId,
  offer: Schema.optional(ThreadMoveOffer),
  parts: Schema.Array(SentMovePart),
  state: Schema.Literal("frozen", "offered", "arrived", "committed"),
  destinationThread: Schema.optional(MovedThreadReference),
  startedAt: UtcTimestamp,
}).annotations(strict);
export type SentMove = typeof SentMove.Type;

export const ThreadMoveState = Schema.Struct({
  received: Schema.Array(ReceivedMove),
  sent: Schema.Array(SentMove),
}).annotations(strict);
export type ThreadMoveState = typeof ThreadMoveState.Type;

export const EMPTY_THREAD_MOVE_STATE: ThreadMoveState = { received: [], sent: [] };

const decodeState = Schema.decodeUnknownSync(ThreadMoveState);

/**
 * The threads a move holds when the host starts: every thread a move is still
 * sending (frozen until it fails or commits) and every thread that arrived here
 * and is not yet committed.
 */
export function heldThreadsOf(state: ThreadMoveState): ReadonlyArray<MovedThreadReference> {
  return [
    ...state.sent.map((move) => move.thread),
    ...state.received.flatMap((move) =>
      move.state === "arrived" && move.thread !== undefined ? [move.thread] : [],
    ),
  ];
}

export interface ThreadMoveStatePort {
  readonly load: () => ThreadMoveState;
  readonly save: (state: ThreadMoveState) => void;
  /** The folder a move's parts are staged in; created on first use. */
  readonly partsDirectory: (moveId: string) => string;
}

export function createThreadMoveStateStore(dataDirectory: string): ThreadMoveStatePort {
  const directory = join(dataDirectory, SUBDIR);
  const path = join(directory, FILE);
  return {
    load: () => {
      try {
        return decodeState(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return EMPTY_THREAD_MOVE_STATE;
      }
    },
    save: (state) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const staging = `${path}.${process.pid}.tmp`;
      writeFileSync(staging, JSON.stringify(Schema.encodeSync(ThreadMoveState)(state)), {
        mode: 0o600,
      });
      chmodSync(staging, 0o600);
      renameSync(staging, path);
    },
    partsDirectory: (moveId) => {
      const folder = join(dataDirectory, THREAD_MOVE_PARTS_SUBDIR, String(moveId));
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      return folder;
    },
  };
}
