/**
 * Journal events for artifact sync through a replica store.
 *
 * They share the membership aggregate type, because an artifact entry takes a
 * slot in the same per-instance sequence as a membership record: the
 * membership projection reads `published` and `reconciled` to know which
 * slots this host wrote or settled, and the artifact projection reads all of
 * them to rebuild the outbox and the synced library. Like the membership
 * events these are inputs only. Heads, what is hidden, and what is still
 * queued are derived on every read.
 */

import { ArtifactBundle } from "@octant/contracts/artifact-bundle";
import { MAX_ARTIFACT_BUNDLE_BYTES } from "@octant/contracts/artifact-mirror";
import { CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import {
  ReplicaArtifactKeptOutcome,
  ReplicaArtifactOrigin,
  ReplicaCommentChange,
  ReplicaContentHash,
  ReplicaDisplayName,
  ReplicaInstanceId,
  ReplicaParents,
  ReplicaReadRefusalReason,
  ReplicaSlotRef,
} from "@octant/contracts/replica-entry";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Sequence = Schema.Int.pipe(Schema.positive());

export const REPLICA_ARTIFACT_EVENT_NAMES = {
  queued: "replica.artifact-queued@2",
  publishRefused: "replica.artifact-publish-refused@2",
  published: "replica.artifact-published@2",
  publishFailed: "replica.artifact-publish-failed@2",
  reconciled: "replica.artifact-reconciled@2",
  slotErased: "replica.artifact-slot-erased@2",
  commentQueued: "replica.comment-queued@2",
  restoreStarted: "replica.restore-started@2",
  restoreProgress: "replica.restore-progress@2",
  restoreStopped: "replica.restore-stopped@2",
  restoreResumed: "replica.restore-resumed@2",
  restoreFinished: "replica.restore-finished@2",
} as const;

export const ReplicaArtifactKind = Schema.Literal("artifact-version", "artifact-tombstone");
export type ReplicaArtifactKind = typeof ReplicaArtifactKind.Type;

/**
 * A committed version or a deletion this host will publish. It waits here,
 * in journal order, until a publish lands: a host that is offline, or stops,
 * publishes it on a later drain. Its sequence is chosen when it is published,
 * so a squatted slot skipped in between never reorders the queue.
 */
export const ReplicaArtifactQueued = Schema.Struct({
  queueId: Schema.UUID,
  kind: ReplicaArtifactKind,
  artifact: ReplicaArtifactOrigin,
  parents: ReplicaParents,
  bundle: ArtifactBundle,
}).annotations(strict);
export type ReplicaArtifactQueued = typeof ReplicaArtifactQueued.Type;

/**
 * A change to a Canvas's comments this host will publish, in the same queue
 * and order as its versions. `after` is what the writer had seen of other
 * computers' comments on that Canvas when the change was made.
 */
export const ReplicaCommentQueued = Schema.Struct({
  queueId: Schema.UUID,
  kind: Schema.Literal("canvas-comment"),
  artifact: ReplicaArtifactOrigin,
  after: Schema.Array(ReplicaSlotRef).pipe(Schema.maxItems(64)),
  change: ReplicaCommentChange,
}).annotations(strict);
export type ReplicaCommentQueued = typeof ReplicaCommentQueued.Type;

/**
 * A restore of this identity's whole library began: the store listed `total`
 * slots this computer had not read.
 */
export const ReplicaRestoreStarted = Schema.Struct({
  restoreId: Schema.UUID,
  instanceId: ReplicaInstanceId,
  total: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);

/**
 * How far a restore got: `done` slots read out of `total`. Journaled after
 * each batch, once that batch's entries are journaled, so a restart resumes
 * at the next unread slot and the count never runs ahead of what is held.
 */
export const ReplicaRestoreProgressed = Schema.Struct({
  restoreId: Schema.UUID,
  done: Schema.Int.pipe(Schema.nonNegative()),
  total: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);

/** The person stopped, resumed, or the restore read every listed slot. */
export const ReplicaRestoreMarked = Schema.Struct({
  restoreId: Schema.UUID,
}).annotations(strict);

/**
 * A version that never enters the queue: its text would carry a credential,
 * a secret-shaped value, or an absolute path out of this host, or it is past
 * the bundle size bound.
 */
export const ReplicaArtifactPublishRefused = Schema.Union(
  Schema.Struct({
    canvasId: CanvasId,
    versionId: CanvasVersionId,
    kind: ReplicaArtifactKind,
    reason: Schema.Literal("unsafe-content", "too-large"),
  }).annotations(strict),
  /** A comment or reply whose text the share filter would not let leave. */
  Schema.Struct({
    canvasId: CanvasId,
    kind: Schema.Literal("canvas-comment"),
    reason: Schema.Literal("unsafe-content"),
  }).annotations(strict),
);

/** A queued entry landed in this host's slot at `sequence`. */
export const ReplicaArtifactPublished = Schema.Struct({
  queueId: Schema.UUID,
  instanceId: ReplicaInstanceId,
  displayName: ReplicaDisplayName,
  sequence: Sequence,
  contentHash: ReplicaContentHash,
}).annotations(strict);
export type ReplicaArtifactPublished = typeof ReplicaArtifactPublished.Type;

/**
 * A publish that did not land. The local version is unchanged and the entry
 * stays queued; this is the receipt that says why.
 */
export const ReplicaArtifactPublishFailure = Schema.Literal(
  "not-a-member",
  "key-unavailable",
  "not-connected",
  "refused",
  "slots-squatted",
);
export type ReplicaArtifactPublishFailure = typeof ReplicaArtifactPublishFailure.Type;

export const ReplicaArtifactPublishFailed = Schema.Struct({
  queueId: Schema.UUID,
  reason: ReplicaArtifactPublishFailure,
}).annotations(strict);

/**
 * What one pulled artifact entry did here. A kept entry carries its exact
 * text, so a restart rebuilds the synced library from the journal alone. A
 * refusal carries its reason and no content.
 */
export const ReplicaArtifactReconciledEvent = Schema.Union(
  Schema.Struct({
    instanceId: ReplicaInstanceId,
    sequence: Sequence,
    outcome: ReplicaArtifactKeptOutcome,
    text: Schema.String.pipe(Schema.maxLength(2 * MAX_ARTIFACT_BUNDLE_BYTES)),
  }).annotations(strict),
  Schema.Struct({
    instanceId: ReplicaInstanceId,
    sequence: Sequence,
    outcome: Schema.Literal("refused"),
    reason: ReplicaReadRefusalReason,
  }).annotations(strict),
);
export type ReplicaArtifactReconciledEvent = typeof ReplicaArtifactReconciledEvent.Type;

/**
 * What an imported entry becomes when a person erases its Canvas here: the
 * slot stays settled, so a later pull does not import the erased content
 * again, and nothing of the content remains.
 */
export const ReplicaArtifactSlotErased = Schema.Struct({
  instanceId: ReplicaInstanceId,
  sequence: Sequence,
}).annotations(strict);

/**
 * Refusals that depend only on the entry's own bytes, so reading it again can
 * never change them. Its slot is settled. A refusal that depends on standing
 * or on another slot - an instance not admitted yet, a cut that may move, an
 * earlier slot still unread - is read again by a later pull.
 */
export const REPLICA_FINAL_ARTIFACT_REFUSALS: ReadonlySet<ReplicaReadRefusalReason> = new Set([
  "hash-mismatch",
  "names-local-artifact-as-foreign",
  "unsafe-content",
]);

export function registerReplicaArtifactEvents(registry: EventRegistry): EventRegistry {
  const names = REPLICA_ARTIFACT_EVENT_NAMES;
  return registry
    .register(names.queued, 1, ReplicaArtifactQueued)
    .register(names.publishRefused, 1, ReplicaArtifactPublishRefused)
    .register(names.published, 1, ReplicaArtifactPublished)
    .register(names.publishFailed, 1, ReplicaArtifactPublishFailed)
    .register(names.reconciled, 1, ReplicaArtifactReconciledEvent)
    .register(names.slotErased, 1, ReplicaArtifactSlotErased)
    .register(names.commentQueued, 1, ReplicaCommentQueued)
    .register(names.restoreStarted, 1, ReplicaRestoreStarted)
    .register(names.restoreProgress, 1, ReplicaRestoreProgressed)
    .register(names.restoreStopped, 1, ReplicaRestoreMarked)
    .register(names.restoreResumed, 1, ReplicaRestoreMarked)
    .register(names.restoreFinished, 1, ReplicaRestoreMarked);
}

export const decodeReplicaArtifactQueued = Schema.decodeUnknownSync(ReplicaArtifactQueued);
export const decodeReplicaArtifactPublished = Schema.decodeUnknownSync(ReplicaArtifactPublished);
export const decodeReplicaArtifactPublishFailed = Schema.decodeUnknownSync(
  ReplicaArtifactPublishFailed,
);
export const decodeReplicaArtifactReconciled = Schema.decodeUnknownSync(
  ReplicaArtifactReconciledEvent,
);
export const decodeReplicaArtifactSlotErased = Schema.decodeUnknownSync(ReplicaArtifactSlotErased);
export const decodeReplicaCommentQueued = Schema.decodeUnknownSync(ReplicaCommentQueued);
export const decodeReplicaRestoreStarted = Schema.decodeUnknownSync(ReplicaRestoreStarted);
export const decodeReplicaRestoreProgressed = Schema.decodeUnknownSync(ReplicaRestoreProgressed);
export const decodeReplicaRestoreMarked = Schema.decodeUnknownSync(ReplicaRestoreMarked);
