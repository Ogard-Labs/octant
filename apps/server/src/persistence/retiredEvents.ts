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
 * Rootless threads were retired by decision 0037. Remote SSH environments and
 * the provider-runtime egress records only they emitted were removed with the
 * feature.
 */
export const RETIRED_EVENT_NAMES = [
  "rootless.thread-created@1",
  "rootless.turn-accepted@1",
  "rootless.turn-updated@1",
  "rootless.folder-attached@1",
  "rootless.folder-attachment-denied@1",
  "ssh-target.registered@1",
  "ssh-target.repinned@1",
  "ssh-target.attested@1",
  "ssh-target.removed@1",
  "ssh-target.runtime-binary-set@1",
  "ssh-remote-project.bound@1",
  "ssh-remote-worktree.created@1",
  "ssh-remote-worktree.removed@1",
  "ssh-remote-terminal.started@1",
  "ssh-remote-terminal.ended@1",
  "provider-runtime-egress.launch-started@1",
  "provider-runtime-egress.decisions-recorded@1",
  "provider-runtime-egress.launch-summarized@1",
] as const;

export const RetiredEventPayload = Schema.Unknown;
