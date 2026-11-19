/**
 * Artifact sync, rebuilt from the journal: what is still queued to publish,
 * and every artifact version and tombstone this host published or imported.
 *
 * The journal holds the queued entries, the slots they landed in, and the
 * exact text of every entry a pull kept, so a restart - even one in the middle
 * of a pull - rebuilds the same library from the journal alone. Heads and
 * what is hidden are derived on read. Every apply is idempotent: a version id
 * already held, or a slot already applied, changes nothing.
 *
 * Imported versions live here, not in the Canvas projection: an imported
 * artifact is not bound to a thread on this host until a person opens or
 * revises it here, so it has no Canvas aggregate yet.
 */

import {
  decodeReplicaArtifactEntry,
  decodeReplicaEntryText,
  replicaChoiceAnswerContentPreimage,
} from "@octant/contracts";
import type { ArtifactBundle } from "@octant/contracts/artifact-bundle";
import type { CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import type {
  ReplicaArtifactEntry,
  ReplicaChoiceAnswerChange,
  ReplicaDisplayName,
  ReplicaInstanceId,
  ReplicaReadRefusalReason,
  ReplicaRestoreProgress,
  ReplicaSlotRef,
} from "@octant/contracts/replica-entry";
import type { EventEnvelope } from "@octant/contracts";
import type {
  ReplicaAppliedEntry,
  ReplicaArtifactRecord,
  ReplicaChoiceAnswerRecord,
  ReplicaKnownTombstone,
  ReplicaKnownVersion,
} from "@octant/domain/replica-entry-policy";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  REPLICA_ARTIFACT_EVENT_NAMES,
  decodeReplicaArtifactPublished,
  decodeReplicaArtifactPublishFailed,
  decodeReplicaArtifactQueued,
  decodeReplicaArtifactReconciled,
  decodeReplicaBackfillStarted,
  decodeReplicaBackfillRestoring,
  type ReplicaBackfillRestoring,
  decodeReplicaBackfillMarked,
  decodeReplicaBackfillQueued,
  decodeReplicaChoiceAnswerQueued,
  decodeReplicaCommentQueued,
  decodeReplicaRestoreMarked,
  decodeReplicaRestoreProgressed,
  decodeReplicaRestoreStarted,
  type ReplicaArtifactPublishFailure,
  type ReplicaArtifactQueued,
  type ReplicaBackfillStarted,
  type ReplicaChoiceAnswerQueued,
  type ReplicaCommentQueued,
} from "./replicaArtifactEvents";
import {
  REPLICA_MEMBERSHIP_AGGREGATE_TYPE,
  REPLICA_MEMBERSHIP_EVENT_NAMES,
  ReplicaIdentityCreated,
} from "./replicaMembershipProjection";
import { Schema } from "effect";

const decodeIdentityCreated = Schema.decodeUnknownSync(ReplicaIdentityCreated);

/** The computer that wrote an entry, as the entry names it. */
export interface ReplicaEntryProvenance {
  readonly instanceId: ReplicaInstanceId;
  readonly displayName: ReplicaDisplayName;
  readonly sequence: number;
}

export interface ReplicaSyncedVersion extends ReplicaKnownVersion {
  readonly bundle: ArtifactBundle;
  readonly writtenBy: ReplicaEntryProvenance;
  /** Whether this host published it, rather than importing it. */
  readonly local: boolean;
}

export interface ReplicaSyncedTombstone extends ReplicaKnownTombstone {
  readonly bundle: ArtifactBundle;
  readonly writtenBy: ReplicaEntryProvenance;
}

export interface ReplicaSyncedArtifact extends ReplicaArtifactRecord {
  /** The Project name the latest entry was filed under. */
  readonly projectName: string;
  readonly versions: ReadonlyArray<ReplicaSyncedVersion>;
  readonly tombstones: ReadonlyArray<ReplicaSyncedTombstone>;
}

export interface ReplicaQueuedArtifact extends ReplicaArtifactQueued {
  readonly backfillId?: string;
  /** Why the last publish attempt did not land, if one did not. */
  readonly lastFailure: ReplicaArtifactPublishFailure | undefined;
}

export interface ReplicaQueuedComment extends ReplicaCommentQueued {
  /** Why the last publish attempt did not land, if one did not. */
  readonly lastFailure: ReplicaArtifactPublishFailure | undefined;
}

export interface ReplicaQueuedChoiceAnswer extends ReplicaChoiceAnswerQueued {
  /** Why the last publish attempt did not land, if one did not. */
  readonly lastFailure: ReplicaArtifactPublishFailure | undefined;
}

export type ReplicaQueuedEntry =
  | ReplicaQueuedArtifact
  | ReplicaQueuedComment
  | ReplicaQueuedChoiceAnswer;

/** A restore of one identity's library, with the id its events share. */
export interface ReplicaRestoreState extends ReplicaRestoreProgress {
  readonly restoreId: string;
}

export interface ReplicaArtifactState {
  readonly backfills: ReadonlyArray<
    ReplicaBackfillStarted & {
      readonly state: "running" | "stopped";
      readonly restoring?: ReplicaBackfillRestoring;
    }
  >;
  /** Every entry waiting to publish, versions and comment changes, oldest first. */
  readonly queue: ReadonlyArray<ReplicaQueuedEntry>;
  /** Artifact versions and tombstones waiting to publish, oldest first. */
  readonly outbox: ReadonlyArray<ReplicaQueuedArtifact>;
  readonly artifacts: ReadonlyArray<ReplicaSyncedArtifact>;
  readonly artifact: (canvasId: CanvasId) => ReplicaSyncedArtifact | undefined;
  /** Every entry this host published or kept from a pull, by slot. */
  readonly applied: ReadonlyArray<ReplicaAppliedEntry>;
  /** Whether this refusal of this slot was already journaled. */
  readonly refusalRecorded: (
    instanceId: ReplicaInstanceId,
    sequence: number,
    reason: ReplicaReadRefusalReason,
  ) => boolean;
  /**
   * For each computer, the newest comment entry on this Canvas held here,
   * published or pulled: what a comment written now has seen.
   */
  readonly commentsSeen: (canvasId: CanvasId) => ReadonlyArray<ReplicaSlotRef>;
  /**
   * For each computer, the newest choice-answer entry on this Canvas held
   * here, published or pulled: what an answer written now has seen.
   */
  readonly choiceAnswersSeen: (canvasId: CanvasId) => ReadonlyArray<ReplicaSlotRef>;
  /**
   * Every choice-answer change held for one question `(canvasId, blockId, questionId)`,
   * published, pulled, and — when `localInstanceId` is given — still waiting in
   * this computer's local queue.
   */
  readonly choiceAnswerRecords: (
    canvasId: CanvasId,
    blockId: string,
    questionId: string,
    localInstanceId?: ReplicaInstanceId,
  ) => ReadonlyArray<ReplicaChoiceAnswerRecord>;
  /** The restore of this identity, once one started. */
  readonly restore: (instanceId: ReplicaInstanceId) => ReplicaRestoreState | undefined;
}

interface MutableArtifact {
  canvasId: CanvasId;
  originHostId: ReplicaArtifactRecord["originHostId"];
  projectName: string;
  readonly versions: Map<string, ReplicaSyncedVersion>;
  readonly tombstones: Map<string, ReplicaSyncedTombstone>;
}

function slotKey(instanceId: ReplicaInstanceId, sequence: number): string {
  return `${String(instanceId)}/${String(sequence)}`;
}

function choiceAnswerTarget(change: ReplicaChoiceAnswerChange): {
  readonly blockId: string;
  readonly questionId: string;
} {
  return change.kind === "set"
    ? { blockId: String(change.answer.blockId), questionId: change.answer.questionId }
    : { blockId: String(change.blockId), questionId: change.questionId };
}

function choiceAnswerKey(canvasId: CanvasId, blockId: string, questionId: string): string {
  return `${String(canvasId)}\0${blockId}\0${questionId}`;
}

function sameSlotList(
  left: ReadonlyArray<ReplicaSlotRef>,
  right: ReadonlyArray<ReplicaSlotRef>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (slot, index) =>
        String(slot.instanceId) === String(right[index]?.instanceId) &&
        slot.sequence === right[index]?.sequence,
    )
  );
}

export class ReplicaArtifactProjection implements Projection {
  readonly name = "replica-artifacts";
  readonly dependencies: ReadonlyArray<string> = [];
  readonly holdsStateInMemory = true as const;
  readonly aggregateTypes: ReadonlyArray<string> = [REPLICA_MEMBERSHIP_AGGREGATE_TYPE];
  readonly #queued = new Map<string, ReplicaQueuedEntry>();
  readonly #artifacts = new Map<string, MutableArtifact>();
  readonly #applied = new Map<string, ReplicaAppliedEntry>();
  readonly #refusals = new Set<string>();
  /** By Canvas, then by writer: the newest comment entry held here. */
  readonly #comments = new Map<string, Map<string, ReplicaSlotRef>>();
  /** By Canvas, then by writer: the newest choice-answer entry held here. */
  readonly #choiceAnswers = new Map<string, Map<string, ReplicaSlotRef>>();
  /** By `(canvasId, blockId, questionId)`: every published or pulled choice-answer change. */
  readonly #choiceAnswerHistory = new Map<string, ReplicaChoiceAnswerRecord[]>();
  /** This host's current replica identity, used to retire a recovered upload from `#queued`. */
  #localInstanceId: ReplicaInstanceId | undefined;
  /** By identity; a restore id names which one a later event continues. */
  readonly #restores = new Map<string, ReplicaRestoreState & { readonly instanceId: string }>();
  readonly #backfills = new Map<
    string,
    ReplicaBackfillStarted & {
      readonly state: "running" | "stopped";
      readonly restoring?: ReplicaBackfillRestoring;
    }
  >();
  #state: ReplicaArtifactState | undefined;

  reset(_connection: SqliteConnection): void {
    this.#queued.clear();
    this.#artifacts.clear();
    this.#applied.clear();
    this.#refusals.clear();
    this.#comments.clear();
    this.#choiceAnswers.clear();
    this.#choiceAnswerHistory.clear();
    this.#localInstanceId = undefined;
    this.#restores.clear();
    this.#backfills.clear();
    this.#state = undefined;
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.aggregateType !== REPLICA_MEMBERSHIP_AGGREGATE_TYPE || event.eventVersion !== 1) {
      return;
    }
    const names = REPLICA_ARTIFACT_EVENT_NAMES;
    switch (event.eventName) {
      case REPLICA_MEMBERSHIP_EVENT_NAMES.identityCreated: {
        this.#localInstanceId = decodeIdentityCreated(event.payload).instanceId;
        break;
      }
      case REPLICA_MEMBERSHIP_EVENT_NAMES.left:
        // What was queued would publish under the identity that left, or
        // under the next one into another store. The versions stay here.
        this.#localInstanceId = undefined;
        this.#queued.clear();
        this.#backfills.clear();
        break;
      case names.backfillStarted: {
        const started = decodeReplicaBackfillStarted(event.payload);
        if (!this.#backfills.has(started.backfillId))
          this.#backfills.set(started.backfillId, { ...started, state: "running" });
        break;
      }
      case names.backfillRestoring: {
        const restoring = decodeReplicaBackfillRestoring(event.payload);
        const batch = this.#backfills.get(restoring.backfillId);
        if (batch !== undefined) this.#backfills.set(restoring.backfillId, { ...batch, restoring });
        break;
      }
      case names.backfillStopped:
      case names.backfillResumed: {
        const { backfillId } = decodeReplicaBackfillMarked(event.payload);
        const held = this.#backfills.get(backfillId);
        if (held !== undefined)
          this.#backfills.set(backfillId, {
            ...held,
            state: event.eventName === names.backfillStopped ? "stopped" : "running",
          });
        break;
      }
      case names.queued:
      case names.backfillQueued: {
        const queued =
          event.eventName === names.queued
            ? decodeReplicaArtifactQueued(event.payload)
            : decodeReplicaBackfillQueued(event.payload);
        if (!this.#queued.has(queued.queueId)) {
          this.#queued.set(queued.queueId, { ...queued, lastFailure: undefined });
        }
        break;
      }
      case names.commentQueued: {
        const queued = decodeReplicaCommentQueued(event.payload);
        if (!this.#queued.has(queued.queueId)) {
          this.#queued.set(queued.queueId, { ...queued, lastFailure: undefined });
        }
        break;
      }
      case names.choiceAnswerQueued: {
        const queued = decodeReplicaChoiceAnswerQueued(event.payload);
        if (!this.#queued.has(queued.queueId)) {
          this.#queued.set(queued.queueId, { ...queued, lastFailure: undefined });
        }
        break;
      }
      case names.restoreStarted: {
        const started = decodeReplicaRestoreStarted(event.payload);
        this.#restores.set(String(started.instanceId), {
          restoreId: started.restoreId,
          instanceId: String(started.instanceId),
          state: "running",
          done: 0,
          total: started.total,
        });
        break;
      }
      case names.restoreProgress: {
        const progress = decodeReplicaRestoreProgressed(event.payload);
        this.#updateRestore(progress.restoreId, (restore) => ({
          ...restore,
          done: Math.max(restore.done, Math.min(progress.done, progress.total)),
          total: Math.max(progress.total, restore.done),
        }));
        break;
      }
      case names.restoreStopped:
      case names.restoreResumed:
      case names.restoreFinished: {
        const marked = decodeReplicaRestoreMarked(event.payload);
        const next =
          event.eventName === names.restoreStopped
            ? "stopped"
            : event.eventName === names.restoreResumed
              ? "running"
              : "finished";
        this.#updateRestore(marked.restoreId, (restore) =>
          // A finished restore stays finished; stopping or resuming it is a no-op.
          restore.state === "finished"
            ? restore
            : next === "finished"
              ? { ...restore, state: next, done: restore.total }
              : { ...restore, state: next },
        );
        break;
      }
      case names.publishFailed: {
        const failed = decodeReplicaArtifactPublishFailed(event.payload);
        const queued = this.#queued.get(failed.queueId);
        if (queued === undefined) return;
        this.#queued.set(failed.queueId, { ...queued, lastFailure: failed.reason });
        break;
      }
      case names.published: {
        const published = decodeReplicaArtifactPublished(event.payload);
        const queued = this.#queued.get(published.queueId);
        if (queued === undefined) return;
        this.#queued.delete(published.queueId);
        if (queued.kind === "canvas-comment") {
          this.#keepComment(
            queued.artifact.canvasId,
            published.instanceId,
            published.sequence,
            published.contentHash,
          );
          break;
        }
        if (queued.kind === "canvas-choice-answer") {
          this.#keepChoiceAnswer(
            queued.artifact.canvasId,
            published.instanceId,
            published.sequence,
            published.contentHash,
            queued.after,
            queued.change,
          );
          break;
        }
        this.#keep(
          {
            kind: queued.kind,
            artifact: queued.artifact,
            parents: queued.parents,
            contentHash: published.contentHash,
            bundle: queued.bundle,
          },
          {
            instanceId: published.instanceId,
            displayName: published.displayName,
            sequence: published.sequence,
          },
          true,
        );
        break;
      }
      case names.reconciled: {
        const reconciled = decodeReplicaArtifactReconciled(event.payload);
        if (reconciled.outcome === "refused") {
          this.#refusals.add(
            `${slotKey(reconciled.instanceId, reconciled.sequence)}#${reconciled.reason}`,
          );
          break;
        }
        const entry = decodeReplicaEntryText(reconciled.text);
        if (entry.kind === "canvas-comment") {
          this.#keepComment(
            entry.artifact.canvasId,
            entry.origin.instanceId,
            entry.origin.sequence,
            entry.contentHash,
          );
          break;
        }
        if (entry.kind === "canvas-choice-answer") {
          if (
            this.#localInstanceId !== undefined &&
            String(entry.origin.instanceId) === String(this.#localInstanceId)
          ) {
            this.#retireRecoveredChoiceAnswer(entry.artifact.canvasId, entry.after, entry.change);
          }
          this.#keepChoiceAnswer(
            entry.artifact.canvasId,
            entry.origin.instanceId,
            entry.origin.sequence,
            entry.contentHash,
            entry.after,
            entry.change,
          );
          break;
        }
        if (entry.kind !== "artifact-version" && entry.kind !== "artifact-tombstone") return;
        const artifactEntry = decodeReplicaArtifactEntry(entry);
        this.#keep(artifactEntry, artifactEntry.origin, false);
        break;
      }
      default:
        return;
    }
    this.#state = undefined;
  }

  state(): ReplicaArtifactState {
    this.#state ??= this.#derive();
    return this.#state;
  }

  /**
   * Drop erased Canvases. A purge rewrites their replica events, but this
   * projection lives in memory and would keep serving them until a restart.
   */
  evict(canvasIds: ReadonlyArray<string>): void {
    const evicted = new Set(canvasIds);
    for (const id of evicted) {
      this.#artifacts.delete(id);
      this.#comments.delete(id);
      this.#choiceAnswers.delete(id);
    }
    for (const key of this.#choiceAnswerHistory.keys()) {
      const canvasId = key.slice(0, key.indexOf("\0"));
      if (evicted.has(canvasId)) this.#choiceAnswerHistory.delete(key);
    }
    for (const [queueId, queued] of this.#queued) {
      if (evicted.has(String(queued.artifact.canvasId))) this.#queued.delete(queueId);
    }
    for (const [id, batch] of this.#backfills) {
      if (evicted.has(String(batch.canvasId))) this.#backfills.delete(id);
    }
    this.#state = undefined;
  }

  #updateRestore(
    restoreId: string,
    update: (restore: ReplicaRestoreState & { readonly instanceId: string }) => ReplicaRestoreState,
  ): void {
    for (const [instanceId, restore] of this.#restores) {
      if (restore.restoreId !== restoreId) continue;
      this.#restores.set(instanceId, { ...update(restore), instanceId: restore.instanceId });
    }
  }

  #keepComment(
    canvasId: CanvasId,
    instanceId: ReplicaInstanceId,
    sequence: number,
    contentHash: ReplicaAppliedEntry["contentHash"],
  ): void {
    const key = slotKey(instanceId, sequence);
    if (this.#applied.has(key)) return;
    this.#applied.set(key, { instanceId, sequence, kind: "canvas-comment", contentHash });
    const byWriter = this.#comments.get(String(canvasId)) ?? new Map<string, ReplicaSlotRef>();
    const newest = byWriter.get(String(instanceId));
    if (newest === undefined || newest.sequence < sequence) {
      byWriter.set(String(instanceId), { instanceId, sequence });
    }
    this.#comments.set(String(canvasId), byWriter);
  }

  /**
   * When an upload of this host's own choice-answer entry landed in the store
   * before the host stopped (so no `published` receipt was journaled), pulling
   * that slot back retires its pending duplicate from `#queued`. Leaving the
   * unsequenced duplicate queued would let it outrank a causal reply with an
   * earlier clock and cause the next drain to republish it at a new sequence.
   */
  #retireRecoveredChoiceAnswer(
    canvasId: CanvasId,
    after: ReadonlyArray<ReplicaSlotRef>,
    change: ReplicaChoiceAnswerChange,
  ): void {
    const preimage = replicaChoiceAnswerContentPreimage(change);
    for (const [queueId, queued] of this.#queued) {
      if (queued.kind !== "canvas-choice-answer") continue;
      if (String(queued.artifact.canvasId) !== String(canvasId)) continue;
      if (!sameSlotList(queued.after, after)) continue;
      if (replicaChoiceAnswerContentPreimage(queued.change) !== preimage) continue;
      this.#queued.delete(queueId);
      return;
    }
  }

  #keepChoiceAnswer(
    canvasId: CanvasId,
    instanceId: ReplicaInstanceId,
    sequence: number,
    contentHash: ReplicaAppliedEntry["contentHash"],
    after: ReadonlyArray<ReplicaSlotRef>,
    change: ReplicaChoiceAnswerChange,
  ): void {
    const key = slotKey(instanceId, sequence);
    if (this.#applied.has(key)) return;
    this.#applied.set(key, { instanceId, sequence, kind: "canvas-choice-answer", contentHash });
    const byWriter = this.#choiceAnswers.get(String(canvasId)) ?? new Map<string, ReplicaSlotRef>();
    const newest = byWriter.get(String(instanceId));
    if (newest === undefined || newest.sequence < sequence) {
      byWriter.set(String(instanceId), { instanceId, sequence });
    }
    this.#choiceAnswers.set(String(canvasId), byWriter);
    const target = choiceAnswerTarget(change);
    const historyKey = choiceAnswerKey(canvasId, target.blockId, target.questionId);
    const list = this.#choiceAnswerHistory.get(historyKey) ?? [];
    list.push({ instanceId, sequence, after, change });
    this.#choiceAnswerHistory.set(historyKey, list);
  }

  #keep(
    entry: Pick<ReplicaArtifactEntry, "kind" | "artifact" | "parents" | "contentHash" | "bundle">,
    writtenBy: ReplicaEntryProvenance,
    local: boolean,
  ): void {
    const key = slotKey(writtenBy.instanceId, writtenBy.sequence);
    if (this.#applied.has(key)) return;
    this.#applied.set(key, {
      instanceId: writtenBy.instanceId,
      sequence: writtenBy.sequence,
      kind: entry.kind,
      contentHash: entry.contentHash,
    });
    const canvasKey = String(entry.artifact.canvasId);
    const artifact: MutableArtifact = this.#artifacts.get(canvasKey) ?? {
      canvasId: entry.artifact.canvasId,
      // The first entry seen names the origin; a later revision from another
      // computer carries the same one, so the record never changes owner.
      originHostId: entry.artifact.hostId,
      projectName: entry.artifact.projectName,
      versions: new Map(),
      tombstones: new Map(),
    };
    artifact.projectName = entry.artifact.projectName;
    const parentVersionIds = entry.parents.map((parent) => String(parent.versionId));
    const provenance = {
      instanceId: writtenBy.instanceId,
      displayName: writtenBy.displayName,
      sequence: writtenBy.sequence,
    };
    if (entry.kind === "artifact-tombstone") {
      artifact.tombstones.set(key, {
        contentHash: entry.contentHash,
        originInstanceId: writtenBy.instanceId,
        originSequence: writtenBy.sequence,
        parentVersionIds,
        bundle: entry.bundle,
        writtenBy: provenance,
      });
    } else {
      const versionId = String(entry.bundle.octant.versionId);
      // A version id names one body; the first one held stays.
      if (!artifact.versions.has(versionId)) {
        artifact.versions.set(versionId, {
          versionId: entry.bundle.octant.versionId as CanvasVersionId,
          contentHash: entry.contentHash,
          parentVersionIds,
          bundle: entry.bundle,
          writtenBy: provenance,
          local,
        });
      }
    }
    this.#artifacts.set(canvasKey, artifact);
  }

  #derive(): ReplicaArtifactState {
    const artifacts: ReplicaSyncedArtifact[] = [...this.#artifacts.values()].map((artifact) => ({
      canvasId: artifact.canvasId,
      originHostId: artifact.originHostId,
      projectName: artifact.projectName,
      versions: [...artifact.versions.values()],
      tombstones: [...artifact.tombstones.values()],
    }));
    const byId = new Map(artifacts.map((artifact) => [String(artifact.canvasId), artifact]));
    const refusals = new Set(this.#refusals);
    const queue = [...this.#queued.values()];
    const comments = new Map(
      [...this.#comments].map(([canvasId, byWriter]) => [
        canvasId,
        [...byWriter.values()].sort((left, right) =>
          String(left.instanceId).localeCompare(String(right.instanceId)),
        ),
      ]),
    );
    const choiceAnswers = new Map(
      [...this.#choiceAnswers].map(([canvasId, byWriter]) => [
        canvasId,
        [...byWriter.values()].sort((left, right) =>
          String(left.instanceId).localeCompare(String(right.instanceId)),
        ),
      ]),
    );
    const choiceAnswerHistory = new Map(
      [...this.#choiceAnswerHistory].map(([key, records]) => [key, [...records]]),
    );
    const restores = new Map(
      [...this.#restores].map(([instanceId, { instanceId: _instance, ...restore }]) => [
        instanceId,
        restore,
      ]),
    );
    return {
      backfills: [...this.#backfills.values()],
      queue,
      outbox: queue.filter(
        (entry): entry is ReplicaQueuedArtifact =>
          entry.kind === "artifact-version" || entry.kind === "artifact-tombstone",
      ),
      commentsSeen: (canvasId) => comments.get(String(canvasId)) ?? [],
      choiceAnswersSeen: (canvasId) => choiceAnswers.get(String(canvasId)) ?? [],
      choiceAnswerRecords: (canvasId, blockId, questionId, localInstanceId) => {
        const held = choiceAnswerHistory.get(choiceAnswerKey(canvasId, blockId, questionId)) ?? [];
        if (localInstanceId === undefined) return held;
        const queued: ReplicaChoiceAnswerRecord[] = [];
        let localOrder = 0;
        for (const entry of queue) {
          if (entry.kind !== "canvas-choice-answer") continue;
          if (String(entry.artifact.canvasId) !== String(canvasId)) continue;
          const target = choiceAnswerTarget(entry.change);
          if (target.blockId !== blockId || target.questionId !== questionId) continue;
          queued.push({
            instanceId: localInstanceId,
            localOrder,
            after: entry.after,
            change: entry.change,
          });
          localOrder += 1;
        }
        return queued.length === 0 ? held : [...held, ...queued];
      },
      restore: (instanceId) => restores.get(String(instanceId)),
      artifacts,
      artifact: (canvasId) => byId.get(String(canvasId)),
      applied: [...this.#applied.values()],
      refusalRecorded: (instanceId, sequence, reason) =>
        refusals.has(`${slotKey(instanceId, sequence)}#${reason}`),
    };
  }
}
