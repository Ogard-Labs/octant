import { Schema } from "effect";

/**
 * Event names this build no longer produces and no projection reads.
 *
 * The journal is authoritative and append-only, so events written by an
 * earlier build stay in it forever. Replay decodes every row through the
 * registry: an unregistered name raises `ReplayEventInvalid` and quarantines
 * the projection that hit it. Registering the retired names against an
 * unconstrained payload keeps history replayable without pretending the
 * feature still exists — nothing consumes what they decode to.
 *
 * Rootless threads were retired by decision 0035.
 */
export const RETIRED_EVENT_NAMES = [
  "rootless.thread-created@1",
  "rootless.turn-accepted@1",
  "rootless.turn-updated@1",
  "rootless.folder-attached@1",
  "rootless.folder-attachment-denied@1",
] as const;

export const RetiredEventPayload = Schema.Unknown;
