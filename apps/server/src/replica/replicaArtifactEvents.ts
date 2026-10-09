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
  ReplicaContentHash,
  ReplicaDisplayName,
  ReplicaInstanceId,
  ReplicaParents,
  ReplicaReadRefusalReason,
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
 * A version that never enters the queue: its text would carry a credential,
 * a secret-shaped value, or an absolute path out of this host, or it is past
 * the bundle size bound.
 */
export const ReplicaArtifactPublishRefused = Schema.Struct({
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  kind: ReplicaArtifactKind,
  reason: Schema.Literal("unsafe-content", "too-large"),
}).annotations(strict);

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
    .register(names.slotErased, 1, ReplicaArtifactSlotErased);
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
