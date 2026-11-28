import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

/**
 * Runtime-derived status of a Work or Code thread on the thread board. It
 * mirrors the domain `deriveThreadBoardStatus` result: always projected from
 * authoritative runtime, recovery, and delivery-target evidence, never assigned
 * by hand. Ambiguous or stale evidence can never produce `done`.
 */
export const ThreadBoardStatus = Schema.Literals(["ready", "in-progress", "waiting", "done"]);
export type ThreadBoardStatus = typeof ThreadBoardStatus.Type;

/**
 * Why the shared policy placed the thread in that status. Waiting keeps a
 * specific reason so columns and a grouped list can both show what is owed.
 */
export const ThreadBoardReason = Schema.Literals([
  "delivery-satisfied",
  "executing",
  "awaiting-input",
  "decision-pending",
  "interrupted",
  "recovering",
  "delivery-waiting",
  "idle-unmet-delivery",
]);
export type ThreadBoardReason = typeof ThreadBoardReason.Type;

export const ThreadBoardDerivation = Schema.Struct({
  status: ThreadBoardStatus,
  reason: ThreadBoardReason,
});
export type ThreadBoardDerivation = typeof ThreadBoardDerivation.Type;

export const decodeThreadBoardStatus = Schema.decodeUnknownSync(
  ThreadBoardStatus,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadBoardReason = Schema.decodeUnknownSync(
  ThreadBoardReason,
  STRICT_DECODE_OPTIONS,
);
