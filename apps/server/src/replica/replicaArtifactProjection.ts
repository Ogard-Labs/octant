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

import { decodeReplicaArtifactEntry, decodeReplicaEntryText } from "@octant/contracts";
import type { ArtifactBundle } from "@octant/contracts/artifact-bundle";
import type { CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import type {
  ReplicaArtifactEntry,
  ReplicaDisplayName,
  ReplicaInstanceId,
  ReplicaReadRefusalReason,
} from "@octant/contracts/replica-entry";
import type { EventEnvelope } from "@octant/contracts";
import type {
  ReplicaAppliedEntry,
  ReplicaArtifactRecord,
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
  type ReplicaArtifactPublishFailure,
  type ReplicaArtifactQueued,
} from "./replicaArtifactEvents";
import { REPLICA_MEMBERSHIP_AGGREGATE_TYPE } from "./replicaMembershipProjection";

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
  /** Why the last publish attempt did not land, if one did not. */
  readonly lastFailure: ReplicaArtifactPublishFailure | undefined;
}

export interface ReplicaArtifactState {
  /** Entries waiting to publish, oldest first. */
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

export class ReplicaArtifactProjection implements Projection {
  readonly name = "replica-artifacts";
  readonly dependencies: ReadonlyArray<string> = [];
  readonly holdsStateInMemory = true as const;
  readonly #queued = new Map<string, ReplicaQueuedArtifact>();
  readonly #artifacts = new Map<string, MutableArtifact>();
  readonly #applied = new Map<string, ReplicaAppliedEntry>();
  readonly #refusals = new Set<string>();
  #state: ReplicaArtifactState | undefined;

  reset(_connection: SqliteConnection): void {
    this.#queued.clear();
    this.#artifacts.clear();
    this.#applied.clear();
    this.#refusals.clear();
    this.#state = undefined;
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.aggregateType !== REPLICA_MEMBERSHIP_AGGREGATE_TYPE || event.eventVersion !== 1) {
      return;
    }
    const names = REPLICA_ARTIFACT_EVENT_NAMES;
    switch (event.eventName) {
      case names.queued: {
        const queued = decodeReplicaArtifactQueued(event.payload);
        if (!this.#queued.has(queued.queueId)) {
          this.#queued.set(queued.queueId, { ...queued, lastFailure: undefined });
        }
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
    for (const id of evicted) this.#artifacts.delete(id);
    for (const [queueId, queued] of this.#queued) {
      if (evicted.has(String(queued.artifact.canvasId))) this.#queued.delete(queueId);
    }
    this.#state = undefined;
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
    return {
      outbox: [...this.#queued.values()],
      artifacts,
      artifact: (canvasId) => byId.get(String(canvasId)),
      applied: [...this.#applied.values()],
      refusalRecorded: (instanceId, sequence, reason) =>
        refusals.has(`${slotKey(instanceId, sequence)}#${reason}`),
    };
  }
}
