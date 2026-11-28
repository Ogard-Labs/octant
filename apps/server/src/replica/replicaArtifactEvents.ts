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
  ReplicaChoiceAnswerChange,
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

const Sequence = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));

export const REPLICA_ARTIFACT_EVENT_NAMES = {
  queued: "replica.artifact-queued@2",
  publishRefused: "replica.artifact-publish-refused@2",
  published: "replica.artifact-published@2",
  publishFailed: "replica.artifact-publish-failed@2",
  reconciled: "replica.artifact-reconciled@2",
  slotErased: "replica.artifact-slot-erased@2",
  commentQueued: "replica.comment-queued@2",
  choiceAnswerQueued: "replica.choice-answer-queued@2",
  restoreStarted: "replica.restore-started@2",
  restoreProgress: "replica.restore-progress@2",
  restoreStopped: "replica.restore-stopped@2",
  restoreResumed: "replica.restore-resumed@2",
  restoreFinished: "replica.restore-finished@2",
  backfillStarted: "replica.backfill-started@1",
  backfillStopped: "replica.backfill-stopped@1",
  backfillResumed: "replica.backfill-resumed@1",
  backfillQueued: "replica.backfill-version-queued@1",
  backfillRestoring: "replica.backfill-restore-requested@1",
} as const;

export const ReplicaArtifactKind = Schema.Literals(["artifact-version", "artifact-tombstone"]);
export type ReplicaArtifactKind = typeof ReplicaArtifactKind.Type;

/**
 * A committed version or a deletion this host will publish. It waits here,
 * in journal order, until a publish lands: a host that is offline, or stops,
 * publishes it on a later drain. Its sequence is chosen when it is published,
 * so a squatted slot skipped in between never reorders the queue.
 */
export const ReplicaArtifactQueued = Schema.Struct({
  queueId: Schema.String.check(Schema.isGUID()),
  kind: ReplicaArtifactKind,
  artifact: ReplicaArtifactOrigin,
  parents: ReplicaParents,
  bundle: ArtifactBundle,
});
export type ReplicaArtifactQueued = typeof ReplicaArtifactQueued.Type;

export const ReplicaBackfillStarted = Schema.Struct({
  backfillId: Schema.String.check(Schema.isGUID()),
  instanceId: ReplicaInstanceId,
  canvasId: CanvasId,
  versionIds: Schema.Array(CanvasVersionId).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(24)),
  ),
});
export type ReplicaBackfillStarted = typeof ReplicaBackfillStarted.Type;
export const ReplicaBackfillRestoring = Schema.Struct({
  backfillId: Schema.String.check(Schema.isGUID()),
  versionId: CanvasVersionId,
  deletionDigest: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});
export type ReplicaBackfillRestoring = typeof ReplicaBackfillRestoring.Type;
export const ReplicaBackfillMarked = Schema.Struct({
  backfillId: Schema.String.check(Schema.isGUID()),
});
export const ReplicaBackfillQueued = Schema.Struct({
  ...ReplicaArtifactQueued.fields,
  backfillId: Schema.String.check(Schema.isGUID()),
});

/**
 * A change to a Canvas's comments this host will publish, in the same queue
 * and order as its versions. `after` is what the writer had seen of other
 * computers' comments on that Canvas when the change was made.
 */
export const ReplicaCommentQueued = Schema.Struct({
  queueId: Schema.String.check(Schema.isGUID()),
  kind: Schema.Literal("canvas-comment"),
  artifact: ReplicaArtifactOrigin,
  after: Schema.Array(ReplicaSlotRef).pipe(Schema.check(Schema.isMaxLength(64))),
  change: ReplicaCommentChange,
});
export type ReplicaCommentQueued = typeof ReplicaCommentQueued.Type;

/**
 * A change to a Canvas decision form's saved answers this host will publish,
 * in the same queue and order as its versions and comments. `after` is what
 * the writer had seen of other computers' choice-answer entries on that Canvas
 * when the change was made.
 */
export const ReplicaChoiceAnswerQueued = Schema.Struct({
  queueId: Schema.String.check(Schema.isGUID()),
  kind: Schema.Literal("canvas-choice-answer"),
  artifact: ReplicaArtifactOrigin,
  after: Schema.Array(ReplicaSlotRef).pipe(Schema.check(Schema.isMaxLength(64))),
  change: ReplicaChoiceAnswerChange,
});
export type ReplicaChoiceAnswerQueued = typeof ReplicaChoiceAnswerQueued.Type;

/**
 * A restore of this identity's whole library began: the store listed `total`
 * slots this computer had not read.
 */
export const ReplicaRestoreStarted = Schema.Struct({
  restoreId: Schema.String.check(Schema.isGUID()),
  instanceId: ReplicaInstanceId,
  total: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

/**
 * How far a restore got: `done` slots read out of `total`. Journaled after
 * each batch, once that batch's entries are journaled, so a restart resumes
 * at the next unread slot and the count never runs ahead of what is held.
 */
export const ReplicaRestoreProgressed = Schema.Struct({
  restoreId: Schema.String.check(Schema.isGUID()),
  done: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  total: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

/** The person stopped, resumed, or the restore read every listed slot. */
export const ReplicaRestoreMarked = Schema.Struct({
  restoreId: Schema.String.check(Schema.isGUID()),
});

/**
 * A version that never enters the queue: its text would carry a credential,
 * a secret-shaped value, or an absolute path out of this host, or it is past
 * the bundle size bound.
 */
export const ReplicaArtifactPublishRefused = Schema.Union([
  Schema.Struct({
    canvasId: CanvasId,
    versionId: CanvasVersionId,
    kind: ReplicaArtifactKind,
    reason: Schema.Literals(["unsafe-content", "too-large"]),
  }),
  Schema.Struct({
    canvasId: CanvasId,
    kind: Schema.Literal("canvas-comment"),
    reason: Schema.Literal("unsafe-content"),
  }),
  Schema.Struct({
    canvasId: CanvasId,
    kind: Schema.Literal("canvas-choice-answer"),
    reason: Schema.Literal("unsafe-content"),
  }),
]);

/** A queued entry landed in this host's slot at `sequence`. */
export const ReplicaArtifactPublished = Schema.Struct({
  queueId: Schema.String.check(Schema.isGUID()),
  instanceId: ReplicaInstanceId,
  displayName: ReplicaDisplayName,
  sequence: Sequence,
  contentHash: ReplicaContentHash,
});
export type ReplicaArtifactPublished = typeof ReplicaArtifactPublished.Type;

/**
 * A publish that did not land. The local version is unchanged and the entry
 * stays queued; this is the receipt that says why.
 */
export const ReplicaArtifactPublishFailure = Schema.Literals([
  "not-a-member",
  "key-unavailable",
  "not-connected",
  "refused",
  "slots-squatted",
]);
export type ReplicaArtifactPublishFailure = typeof ReplicaArtifactPublishFailure.Type;

export const ReplicaArtifactPublishFailed = Schema.Struct({
  queueId: Schema.String.check(Schema.isGUID()),
  reason: ReplicaArtifactPublishFailure,
});

/**
 * What one pulled artifact entry did here. A kept entry carries its exact
 * text, so a restart rebuilds the synced library from the journal alone. A
 * refusal carries its reason and no content.
 */
export const ReplicaArtifactReconciledEvent = Schema.Union([
  Schema.Struct({
    instanceId: ReplicaInstanceId,
    sequence: Sequence,
    outcome: ReplicaArtifactKeptOutcome,
    text: Schema.String.pipe(Schema.check(Schema.isMaxLength(2 * MAX_ARTIFACT_BUNDLE_BYTES))),
  }),
  Schema.Struct({
    instanceId: ReplicaInstanceId,
    sequence: Sequence,
    outcome: Schema.Literal("refused"),
    reason: ReplicaReadRefusalReason,
  }),
]);
export type ReplicaArtifactReconciledEvent = typeof ReplicaArtifactReconciledEvent.Type;

/**
 * What an imported entry becomes when a person erases its Canvas here: the
 * slot stays settled, so a later pull does not import the erased content
 * again, and nothing of the content remains.
 */
export const ReplicaArtifactSlotErased = Schema.Struct({
  instanceId: ReplicaInstanceId,
  sequence: Sequence,
});

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
    .register(names.backfillStarted, 1, ReplicaBackfillStarted)
    .register(names.backfillStopped, 1, ReplicaBackfillMarked)
    .register(names.backfillResumed, 1, ReplicaBackfillMarked)
    .register(names.backfillQueued, 1, ReplicaBackfillQueued)
    .register(names.backfillRestoring, 1, ReplicaBackfillRestoring)
    .register(names.queued, 1, ReplicaArtifactQueued)
    .register(names.publishRefused, 1, ReplicaArtifactPublishRefused)
    .register(names.published, 1, ReplicaArtifactPublished)
    .register(names.publishFailed, 1, ReplicaArtifactPublishFailed)
    .register(names.reconciled, 1, ReplicaArtifactReconciledEvent)
    .register(names.slotErased, 1, ReplicaArtifactSlotErased)
    .register(names.commentQueued, 1, ReplicaCommentQueued)
    .register(names.choiceAnswerQueued, 1, ReplicaChoiceAnswerQueued)
    .register(names.restoreStarted, 1, ReplicaRestoreStarted)
    .register(names.restoreProgress, 1, ReplicaRestoreProgressed)
    .register(names.restoreStopped, 1, ReplicaRestoreMarked)
    .register(names.restoreResumed, 1, ReplicaRestoreMarked)
    .register(names.restoreFinished, 1, ReplicaRestoreMarked);
}

export const decodeReplicaArtifactQueued = Schema.decodeUnknownSync(ReplicaArtifactQueued, {
  onExcessProperty: "error",
});
export const decodeReplicaBackfillRestoring = Schema.decodeUnknownSync(ReplicaBackfillRestoring, {
  onExcessProperty: "error",
});
export const decodeReplicaBackfillStarted = Schema.decodeUnknownSync(ReplicaBackfillStarted, {
  onExcessProperty: "error",
});
export const decodeReplicaBackfillMarked = Schema.decodeUnknownSync(ReplicaBackfillMarked, {
  onExcessProperty: "error",
});
export const decodeReplicaBackfillQueued = Schema.decodeUnknownSync(ReplicaBackfillQueued, {
  onExcessProperty: "error",
});
export const decodeReplicaArtifactPublished = Schema.decodeUnknownSync(ReplicaArtifactPublished, {
  onExcessProperty: "error",
});
export const decodeReplicaArtifactPublishFailed = Schema.decodeUnknownSync(
  ReplicaArtifactPublishFailed,
  { onExcessProperty: "error" },
);
export const decodeReplicaArtifactReconciled = Schema.decodeUnknownSync(
  ReplicaArtifactReconciledEvent,
  { onExcessProperty: "error" },
);
export const decodeReplicaArtifactSlotErased = Schema.decodeUnknownSync(ReplicaArtifactSlotErased, {
  onExcessProperty: "error",
});
export const decodeReplicaCommentQueued = Schema.decodeUnknownSync(ReplicaCommentQueued, {
  onExcessProperty: "error",
});
export const decodeReplicaChoiceAnswerQueued = Schema.decodeUnknownSync(ReplicaChoiceAnswerQueued, {
  onExcessProperty: "error",
});
export const decodeReplicaRestoreStarted = Schema.decodeUnknownSync(ReplicaRestoreStarted, {
  onExcessProperty: "error",
});
export const decodeReplicaRestoreProgressed = Schema.decodeUnknownSync(ReplicaRestoreProgressed, {
  onExcessProperty: "error",
});
export const decodeReplicaRestoreMarked = Schema.decodeUnknownSync(ReplicaRestoreMarked, {
  onExcessProperty: "error",
});
