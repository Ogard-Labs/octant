import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Runtime-derived status of a Work or Code thread on the thread board. It
 * mirrors the domain `deriveThreadBoardStatus` result: always projected from
 * authoritative runtime, recovery, and delivery-target evidence, never assigned
 * by hand. Ambiguous or stale evidence can never produce `done`.
 */
export const ThreadBoardStatus = Schema.Literal("ready", "in-progress", "waiting", "done");
export type ThreadBoardStatus = typeof ThreadBoardStatus.Type;

/**
 * Why the shared policy placed the thread in that status. Waiting keeps a
 * specific reason so columns and a grouped list can both show what is owed.
 */
export const ThreadBoardReason = Schema.Literal(
  "delivery-satisfied",
  "executing",
  "awaiting-input",
  "interrupted",
  "recovering",
  "delivery-waiting",
  "idle-unmet-delivery",
);
export type ThreadBoardReason = typeof ThreadBoardReason.Type;

export const ThreadBoardDerivation = Schema.Struct({
  status: ThreadBoardStatus,
  reason: ThreadBoardReason,
}).annotations(strict);
export type ThreadBoardDerivation = typeof ThreadBoardDerivation.Type;

export const decodeThreadBoardStatus = Schema.decodeUnknownSync(ThreadBoardStatus);
export const decodeThreadBoardReason = Schema.decodeUnknownSync(ThreadBoardReason);
