/**
 * Artifact sync through the replica store: publish and pull.
 *
 * Publish. Every committed artifact version, and every deletion, reaches this
 * service through the same hook the 0029 mirror listens on, whichever surface
 * made it. It is queued in the journal first and published after, oldest
 * first, so a host that is offline or stops publishes it later in the order
 * it was made. A failed upload is a journaled receipt; the local version is
 * never unwound. Plan mode and sync off queue nothing and call nothing.
 *
 * Pull. On start, on a bounded interval, and on demand, the membership pull
 * reads the store, holds membership records, and hands every valid artifact
 * entry to {@link ReplicaArtifactImport}, which runs each one through the
 * reconcile policy and journals what it did. Imported versions keep the name
 * of the computer that wrote them and the Project they were filed under; an
 * imported artifact is not bound to a thread here until a person opens or
 * revises it here.
 */

import { createHash } from "node:crypto";
import {
  ARTIFACT_BUNDLE_FORMAT,
  decodeArtifactBundle,
  encodeArtifactBundle,
  type ArtifactBundle,
} from "@octant/contracts/artifact-bundle";
import { MAX_ARTIFACT_BUNDLE_BYTES } from "@octant/contracts/artifact-mirror";
import type {
  CanvasDefinition,
  CanvasId,
  CanvasVersion,
  CanvasVersionId,
} from "@octant/contracts/canvas";
import { isCanvasShareSafeText } from "@octant/contracts/canvas-share";
import type { HostId } from "@octant/contracts/host";
import {
  REPLICA_ENTRY_FORMAT,
  decodeReplicaArtifactEntry,
  replicaEntryContentPreimage,
  type ReplicaArtifactEntry,
  type ReplicaArtifactKeptOutcome,
  type ReplicaArtifactReconciled,
  type ReplicaContentHash,
  type ReplicaDisplayName,
  type ReplicaInstanceId,
  type ReplicaReadRefusal,
} from "@octant/contracts/replica-entry";
import {
  reconcileReplicaEntry,
  replicaArtifactHeads,
  replicaArtifactStanding,
  type ReplicaArtifactRecord,
  type ReplicaInstanceMembership,
  type ReplicaLocalState,
  type ReplicaReconcileOutcome,
} from "@octant/domain/replica-entry-policy";
import { replicaInGoodStanding } from "@octant/domain/replica-membership-policy";
import { artifactKindForBlocks } from "@octant/domain";
import type { ArtifactLibrarySyncedEntry } from "@octant/contracts/artifact-library";
import { REPLICA_ARTIFACT_EVENT_NAMES, type ReplicaArtifactQueued } from "./replicaArtifactEvents";
import type {
  ReplicaArtifactState,
  ReplicaSyncedArtifact,
  ReplicaSyncedTombstone,
  ReplicaSyncedVersion,
} from "./replicaArtifactProjection";
import { renderArtifactThumbnail } from "../canvas/artifactRender";
import type {
  ReplicaMembershipJournal,
  ReplicaMembershipState,
} from "./replicaMembershipProjection";
import type {
  ReplicaArtifactRead,
  ReplicaArtifactReconciler,
  ReplicaMembershipOutcome,
  ReplicaMembershipService,
  ReplicaStoreSelection,
  Slot,
} from "./replicaMembershipService";

/** How often a host with sync on pulls and retries its queue on its own. */
export const REPLICA_SYNC_INTERVAL_MS = 5 * 60_000;

/**
 * Whether an artifact's text may leave this host: the share filter every
 * exported document passes, over the title, every string a block carries,
 * and each source's display name. No credential, secret-shaped value, or
 * absolute path leaves, and none is accepted from another computer.
 */
export function replicaArtifactTextLeavesSafely(definition: CanvasDefinition): boolean {
  const texts: string[] = [definition.title];
  const collect = (value: unknown): void => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item);
    else if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) collect(item);
    }
  };
  collect(definition.blocks);
  for (const source of definition.sourceManifest) texts.push(source.displayName);
  return texts.every((text) => isCanvasShareSafeText(text));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function same(left: unknown, right: unknown): boolean {
  return String(left) === String(right);
}

export interface ReplicaArtifactImportPorts {
  readonly membership: () => ReplicaMembershipState;
  readonly artifacts: () => ReplicaArtifactState;
  /** Canvases this host holds in its own journal. */
  readonly localCanvasIds: () => ReadonlyArray<CanvasId>;
  readonly journal: ReplicaMembershipJournal;
}

const KEPT: Record<
  Exclude<ReplicaReconcileOutcome["outcome"], "refused">,
  ReplicaArtifactKeptOutcome
> = {
  "append-version": "imported",
  "already-present": "already-present",
  "concurrent-head": "concurrent-head",
  tombstone: "tombstone",
};

/**
 * Decide and journal what each pulled artifact entry does here.
 *
 * Entries come in instance and sequence order, and each decision reads the
 * state the previous one journaled, so one writer's entries apply in the
 * order it wrote them and a restart part-way resumes from what was
 * journaled. A kept entry is journaled with its exact text; a refusal is
 * journaled once per slot and reason, so a pull on an interval does not
 * repeat what it already said.
 */
export class ReplicaArtifactImport implements ReplicaArtifactReconciler {
  readonly #ports: ReplicaArtifactImportPorts;

  constructor(ports: ReplicaArtifactImportPorts) {
    this.#ports = ports;
  }

  reconcile(input: {
    readonly reads: ReadonlyArray<ReplicaArtifactRead>;
    readonly listed: ReadonlyArray<Slot>;
  }): {
    readonly kept: ReadonlyArray<ReplicaArtifactReconciled>;
    readonly refused: ReadonlyArray<ReplicaReadRefusal>;
  } {
    const kept: ReplicaArtifactReconciled[] = [];
    const refused: ReplicaReadRefusal[] = [];
    for (const read of input.reads) {
      const outcome = this.#decide(read, input.listed);
      if (outcome === undefined) continue;
      if (outcome.outcome === "refused") {
        refused.push({
          instanceId: read.instanceId,
          sequence: read.sequence,
          reason: outcome.reason,
        });
        if (
          !this.#ports.artifacts().refusalRecorded(read.instanceId, read.sequence, outcome.reason)
        ) {
          this.#ports.journal.append({
            eventName: REPLICA_ARTIFACT_EVENT_NAMES.reconciled,
            payload: {
              instanceId: read.instanceId,
              sequence: read.sequence,
              outcome: "refused",
              reason: outcome.reason,
            },
          });
        }
        continue;
      }
      const result = KEPT[outcome.outcome];
      this.#ports.journal.append({
        eventName: REPLICA_ARTIFACT_EVENT_NAMES.reconciled,
        payload: {
          instanceId: read.instanceId,
          sequence: read.sequence,
          outcome: result,
          text: read.text,
        },
      });
      kept.push({ instanceId: read.instanceId, sequence: read.sequence, outcome: result });
    }
    return { kept, refused };
  }

  #decide(
    read: ReplicaArtifactRead,
    listed: ReadonlyArray<Slot>,
  ):
    | ReplicaReconcileOutcome
    | { readonly outcome: "refused"; readonly reason: "unsafe-content" }
    | undefined {
    const membership = this.#ports.membership();
    const local = membership.local;
    if (local === undefined) return undefined;
    if (!replicaArtifactTextLeavesSafely(read.entry.bundle.definition)) {
      return { outcome: "refused", reason: "unsafe-content" };
    }
    return reconcileReplicaEntry(
      this.#localState(membership, local.instanceId, listed, read.entry),
      read.entry,
    );
  }

  #localState(
    membership: ReplicaMembershipState,
    localInstanceId: ReplicaLocalState["localInstanceId"],
    listed: ReadonlyArray<Slot>,
    entry: ReplicaArtifactEntry,
  ): ReplicaLocalState {
    const artifacts = this.#ports.artifacts();
    // Every host calls itself `local`, so an artifact's origin is the replica
    // instance that first published it, and a Canvas this host holds that no
    // entry names yet is this instance's own.
    const localHostId = String(localInstanceId) as HostId;
    const records: ReplicaArtifactRecord[] = [...artifacts.artifacts];
    for (const canvasId of this.#ports.localCanvasIds()) {
      if (artifacts.artifact(canvasId) !== undefined) continue;
      records.push({ canvasId, originHostId: localHostId, versions: [], tombstones: [] });
    }
    const instances: ReplicaInstanceMembership[] = [];
    for (const node of membership.members) {
      if (!node.admitted) continue;
      instances.push(
        node.cut === undefined
          ? { instanceId: node.instanceId, status: "member" }
          : { instanceId: node.instanceId, status: "revoked", lastAcceptedSequence: node.cut },
      );
    }
    return {
      localHostId,
      localInstanceId,
      instances,
      applied: artifacts.applied,
      listedSlots: listed,
      settledSlots: membership.settledSlots,
      artifacts: records,
      measuredContentHash: sha256Hex(replicaEntryContentPreimage(entry)),
      // The pull verified the detached signature under the key the entry
      // names before handing it here; an entry that failed never arrives.
      signature: "verified",
    };
  }
}

export interface ReplicaArtifactSyncPorts {
  readonly membership: Pick<ReplicaMembershipService, "execute" | "publishArtifact">;
  /** The store sync uses; `not-configured` while sync is off or none is chosen. */
  readonly store: () => ReplicaStoreSelection;
  readonly membershipState: () => ReplicaMembershipState;
  readonly artifactState: () => ReplicaArtifactState;
  readonly journal: ReplicaMembershipJournal;
  readonly uuid: () => string;
  /** The local Canvas, with every version this host holds. */
  readonly canvas: (
    canvasId: CanvasId,
  ) =>
    | { readonly currentVersion: CanvasVersion; readonly versions: ReadonlyArray<CanvasVersion> }
    | undefined;
  /** The name of a Project this host holds. */
  readonly projectName: (projectId: string) => string | undefined;
  /** Whether the thread that owns this version is read-only. */
  readonly planMode: (version: CanvasVersion) => boolean;
  /**
   * Told after every pull this service makes, so an artifact open in a
   * thread here takes a later version another computer wrote on top of it.
   */
  readonly afterPull?: () => void;
}

export class ReplicaArtifactSyncService {
  readonly #ports: ReplicaArtifactSyncPorts;
  #drain: Promise<void> = Promise.resolve();
  /**
   * Parents the next commit of a Canvas resolves, by Canvas. Keep, Merge,
   * and Restore name every version they resolve just before the commit
   * announces itself, which happens synchronously inside the commit.
   */
  readonly #resolving = new Map<string, ReadonlyArray<string>>();

  constructor(ports: ReplicaArtifactSyncPorts) {
    this.#ports = ports;
  }

  /**
   * Queue a committed version and publish it. Never throws: the version
   * already happened, and nothing here can unwind it.
   */
  async versionCommitted(version: CanvasVersion): Promise<void> {
    const resolving = this.#resolving.get(String(version.canvasId));
    this.#resolving.delete(String(version.canvasId));
    try {
      if (!this.#queues() || this.#ports.planMode(version)) return;
      // A version another computer wrote, now open in a thread here, is
      // already in the store under its writer's slot; it is not published
      // again under this computer's.
      const synced = this.#ports.artifactState().artifact(version.canvasId);
      if (synced?.versions.some((held) => same(held.versionId, version.versionId)) === true) {
        return;
      }
      const versions = this.#ports.canvas(version.canvasId)?.versions ?? [];
      const parent = versions
        .filter((candidate) => candidate.sequence < version.sequence)
        .sort((left, right) => right.sequence - left.sequence)[0];
      this.#queue({
        kind: "artifact-version",
        canvasId: version.canvasId,
        version,
        parents: resolving ?? (parent === undefined ? [] : [String(parent.versionId)]),
      });
      await this.drain();
    } catch {
      // A publish that could not be queued leaves the version as it is.
    }
  }

  /**
   * Name the versions the next commit of this Canvas resolves. Keep, Merge,
   * and Restore on an artifact open here commit through the Canvas service,
   * whose hook only knows the previous local version; this tells it the
   * rest. Call it just before the commit, and call what it returns just
   * after, so a commit that was refused leaves nothing behind for the next.
   */
  resolveNext(canvasId: CanvasId, parents: ReadonlyArray<string>): () => void {
    const key = String(canvasId);
    const sorted = [...new Set(parents.map(String))].sort();
    this.#resolving.set(key, sorted);
    return () => {
      if (this.#resolving.get(key) === sorted) this.#resolving.delete(key);
    };
  }

  /**
   * Publish a version of an artifact that is not open in a thread here: Keep
   * or Restore from the library. It is queued and drained like any other
   * version; `published` is false while the store cannot be reached.
   */
  async publishVersion(input: {
    readonly canvasId: CanvasId;
    readonly bundle: ArtifactBundle;
    readonly parents: ReadonlyArray<string>;
  }): Promise<
    | { readonly status: "queued"; readonly published: boolean }
    | { readonly status: "refused"; readonly reason: "sync-off" | "unsafe-content" | "too-large" }
  > {
    if (!this.#queues()) return { status: "refused", reason: "sync-off" };
    const queued = this.#queue({
      kind: "artifact-version",
      canvasId: input.canvasId,
      version: input.bundle,
      parents: [...new Set(input.parents.map(String))].sort(),
    });
    if (queued.status === "refused") return queued;
    await this.drain().catch(() => undefined);
    const waiting = this.#ports
      .artifactState()
      .outbox.some((entry) => entry.queueId === queued.queueId);
    return { status: "queued", published: !waiting };
  }

  /** Whether this computer can publish at all: sync on and an identity that can still write. */
  publishes(): boolean {
    return this.#queues();
  }

  /**
   * Queue a tombstone for an artifact a person deleted on this host, taken
   * from every head this host knows, and publish it. Never throws.
   */
  async artifactDeleted(canvasId: CanvasId): Promise<void> {
    try {
      if (!this.#queues()) return;
      const local = this.#ports.canvas(canvasId)?.currentVersion;
      if (local !== undefined && this.#ports.planMode(local)) return;
      const synced = this.#ports.artifactState().artifact(canvasId);
      const heads =
        synced === undefined
          ? []
          : replicaArtifactHeads(synced).flatMap((head) =>
              head.kind === "version" ? [String(head.versionId)] : [],
            );
      const parents =
        heads.length > 0 ? heads : local === undefined ? [] : [String(local.versionId)];
      const bundleOf =
        local ?? synced?.versions.find((version) => same(version.versionId, parents[0]))?.bundle;
      if (bundleOf === undefined) return;
      this.#queue({ kind: "artifact-tombstone", canvasId, version: bundleOf, parents });
      await this.drain();
    } catch {
      // As for a version: the deletion stands locally whatever the store does.
    }
  }

  /**
   * Publish queued entries oldest first until one does not land. The one that
   * did not land is retried on the next drain, ahead of anything newer.
   */
  drain(): Promise<void> {
    const run = this.#drain.then(() => this.#drainOnce());
    this.#drain = run.catch(() => undefined);
    return run;
  }

  /** Read the store, when there is one and this computer has an identity in it. */
  async pull(): Promise<ReplicaMembershipOutcome | undefined> {
    if (this.#ports.store().status !== "selected") return undefined;
    if (this.#ports.membershipState().local === undefined) return undefined;
    const pulled = await this.#ports.membership.execute({ kind: "pull" });
    try {
      this.#ports.afterPull?.();
    } catch {
      // A version that could not be taken in here stays in the library.
    }
    return pulled;
  }

  /** Pull, then publish what is queued. */
  async sync(): Promise<void> {
    await this.pull();
    await this.drain();
  }

  /**
   * Sync now and then on an interval. The timer does not keep the process
   * alive, and with sync off each tick returns before any store call.
   */
  start(
    intervalMs: number = REPLICA_SYNC_INTERVAL_MS,
    timers: {
      readonly setInterval: (callback: () => void, ms: number) => unknown;
      readonly clearInterval: (handle: unknown) => void;
    } = {
      setInterval: (callback, ms) => {
        const handle = setInterval(callback, ms);
        handle.unref?.();
        return handle;
      },
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    },
  ): () => void {
    const tick = () => {
      void this.sync().catch(() => undefined);
    };
    tick();
    const handle = timers.setInterval(tick, intervalMs);
    return () => timers.clearInterval(handle);
  }

  async #drainOnce(): Promise<void> {
    const pending = this.#ports.artifactState().outbox.length;
    for (let index = 0; index < pending; index += 1) {
      const next = this.#ports.artifactState().outbox[0];
      if (next === undefined) return;
      if (!this.#publishes()) return;
      const outcome = await this.#ports.membership.publishArtifact({
        queueId: next.queueId,
        build: (origin) => replicaArtifactEntryFor(next, origin),
      });
      if (outcome.status === "published") continue;
      if (outcome.status === "not-configured") return;
      // One receipt per reason: a retry on the interval that fails the same
      // way says nothing new.
      if (next.lastFailure !== outcome.reason) {
        this.#ports.journal.append({
          eventName: REPLICA_ARTIFACT_EVENT_NAMES.publishFailed,
          payload: { queueId: next.queueId, reason: outcome.reason },
        });
      }
      return;
    }
  }

  /** Sync is on, and this computer has an identity that can still write. */
  #queues(): boolean {
    if (this.#ports.store().status !== "selected") return false;
    const state = this.#ports.membershipState();
    return state.local !== undefined && !state.localFinished;
  }

  /** Only a member in good standing publishes; anything else stays queued. */
  #publishes(): boolean {
    if (this.#ports.store().status !== "selected") return false;
    const state = this.#ports.membershipState();
    return (
      state.local !== undefined && replicaInGoodStanding(state.membership, state.local.instanceId)
    );
  }

  #queue(input: {
    readonly kind: ReplicaArtifactQueued["kind"];
    readonly canvasId: CanvasId;
    readonly version: CanvasVersion | ArtifactBundle;
    readonly parents: ReadonlyArray<string>;
  }):
    | { readonly status: "queued"; readonly queueId: string }
    | { readonly status: "refused"; readonly reason: "sync-off" | "unsafe-content" | "too-large" } {
    const local = this.#ports.membershipState().local;
    if (local === undefined) return { status: "refused", reason: "sync-off" };
    const synced = this.#ports.artifactState().artifact(input.canvasId);
    // A revision of an artifact another computer made keeps that origin.
    const originHostId = synced?.originHostId ?? (String(local.instanceId) as HostId);
    const bundle =
      "octant" in input.version ? input.version : bundleFor(input.version, originHostId);
    const versionId = bundle.octant.versionId;
    const projectName =
      this.#ports.projectName(String(bundle.octant.projectId)) ?? synced?.projectName ?? "Project";
    if (!replicaArtifactTextLeavesSafely(bundle.definition)) {
      this.#refuse(input.canvasId, versionId, input.kind, "unsafe-content");
      return { status: "refused", reason: "unsafe-content" };
    }
    if (Buffer.byteLength(encodeArtifactBundle(bundle), "utf8") > MAX_ARTIFACT_BUNDLE_BYTES) {
      this.#refuse(input.canvasId, versionId, input.kind, "too-large");
      return { status: "refused", reason: "too-large" };
    }
    const queueId = this.#ports.uuid();
    this.#ports.journal.append({
      eventName: REPLICA_ARTIFACT_EVENT_NAMES.queued,
      payload: {
        queueId,
        kind: input.kind,
        artifact: {
          canvasId: input.canvasId,
          hostId: originHostId,
          projectName,
        },
        parents: input.parents.map((versionId) => ({ versionId })),
        bundle: { ...bundle, octant: { ...bundle.octant, hostId: originHostId } },
      },
    });
    return { status: "queued", queueId };
  }

  #refuse(
    canvasId: CanvasId,
    versionId: string,
    kind: ReplicaArtifactQueued["kind"],
    reason: "unsafe-content" | "too-large",
  ): void {
    this.#ports.journal.append({
      eventName: REPLICA_ARTIFACT_EVENT_NAMES.publishRefused,
      payload: { canvasId, versionId, kind, reason },
    });
  }
}

/**
 * The bundle a version becomes in the store: the 0029 document, with the
 * header naming the artifact's replica origin rather than `local`.
 */
function bundleFor(version: CanvasVersion, originHostId: HostId): ArtifactBundle {
  const provenance = version.definition.provenance;
  return decodeArtifactBundle({
    octant: {
      format: ARTIFACT_BUNDLE_FORMAT,
      canvasId: version.canvasId,
      versionId: version.versionId,
      sequence: version.sequence,
      title: version.definition.title,
      mode: provenance.mode,
      projectId: provenance.projectId,
      hostId: originHostId,
      createdAt: version.createdAt,
    },
    definition: version.definition,
  });
}

/** The entry a queued artifact becomes at one slot. Rebuilt at the same slot it is the same bytes. */
export function replicaArtifactEntryFor(
  queued: ReplicaArtifactQueued,
  origin: ReplicaArtifactEntry["origin"],
): ReplicaArtifactEntry {
  const bundle = decodeArtifactBundle(JSON.parse(encodeArtifactBundle(queued.bundle)));
  return decodeReplicaArtifactEntry({
    format: REPLICA_ENTRY_FORMAT,
    kind: queued.kind,
    origin,
    artifact: queued.artifact,
    parents: queued.parents,
    contentHash: sha256Hex(encodeArtifactBundle(bundle)),
    bundle,
  });
}

/**
 * Every synced artifact, with this computer's queued versions counted as
 * versions it wrote. A version kept or restored here waits in the queue
 * until the store takes it; counting it keeps the library from offering the
 * same choice again while it waits.
 */
export function replicaArtifactsWithQueued(
  state: ReplicaArtifactState,
  local: { readonly instanceId: ReplicaInstanceId; readonly displayName: string } | undefined,
): ReadonlyArray<ReplicaSyncedArtifact> {
  const artifacts = new Map(
    state.artifacts.map((artifact) => [String(artifact.canvasId), artifact]),
  );
  if (local === undefined) return [...artifacts.values()];
  for (const queued of state.outbox) {
    if (queued.kind !== "artifact-version") continue;
    const key = String(queued.artifact.canvasId);
    const known = artifacts.get(key);
    const versionId = String(queued.bundle.octant.versionId);
    if (known?.versions.some((version) => same(version.versionId, versionId)) === true) continue;
    const version: ReplicaSyncedVersion = {
      versionId: queued.bundle.octant.versionId as CanvasVersionId,
      contentHash: sha256Hex(encodeArtifactBundle(queued.bundle)) as ReplicaContentHash,
      parentVersionIds: queued.parents.map((parent) => String(parent.versionId)),
      bundle: queued.bundle,
      writtenBy: {
        instanceId: local.instanceId,
        displayName: local.displayName as ReplicaDisplayName,
        sequence: 0,
      },
      local: true,
    };
    artifacts.set(key, {
      canvasId: queued.artifact.canvasId,
      originHostId: known?.originHostId ?? queued.artifact.hostId,
      projectName: queued.artifact.projectName,
      versions: [...(known?.versions ?? []), version],
      tombstones: known?.tombstones ?? [],
    });
  }
  return [...artifacts.values()];
}

/** The version a tombstone deleted, newest deletion first, with who deleted it. */
export function replicaDeletionShown(
  artifact: ReplicaSyncedArtifact,
  deletions: ReadonlyArray<{
    readonly originInstanceId: ReplicaInstanceId;
    readonly originSequence: number;
  }>,
): ReplicaSyncedTombstone | undefined {
  return artifact.tombstones
    .filter((tombstone) =>
      deletions.some(
        (deletion) =>
          same(deletion.originInstanceId, tombstone.originInstanceId) &&
          deletion.originSequence === tombstone.originSequence,
      ),
    )
    .sort((left, right) =>
      String(right.bundle.octant.createdAt).localeCompare(String(left.bundle.octant.createdAt)),
    )[0];
}

/**
 * What the library lists for artifacts other computers made and that are not
 * open in a thread here. Each card shows the newest version standing, named
 * by the computer that wrote it, under the Project name it was filed under
 * there. Two versions standing is `two-versions`; a deletion that is all that
 * is left is `deleted`, shown as the version it deleted and the computer
 * that deleted it, so the person can restore it.
 */
export function replicaSyncedLibraryEntries(
  state: ReplicaArtifactState,
  local?: { readonly instanceId: ReplicaInstanceId; readonly displayName: string },
): ReadonlyArray<ArtifactLibrarySyncedEntry> {
  const entries: ArtifactLibrarySyncedEntry[] = [];
  for (const artifact of replicaArtifactsWithQueued(state, local)) {
    const standing = replicaArtifactStanding(artifact);
    const heads = replicaArtifactHeads(artifact);
    const deletion =
      standing.status === "deleted"
        ? replicaDeletionShown(artifact, standing.deletions)
        : undefined;
    const newest = artifact.versions
      .filter((version) => standing.candidates.includes(String(version.versionId)))
      .sort((left, right) =>
        String(right.bundle.octant.createdAt).localeCompare(String(left.bundle.octant.createdAt)),
      )[0];
    const shown =
      deletion === undefined ? newest : { bundle: deletion.bundle, writtenBy: deletion.writtenBy };
    if (shown === undefined) continue;
    const markup = renderArtifactThumbnail(shown.bundle.definition);
    entries.push({
      canvasId: artifact.canvasId,
      projectName: artifact.projectName,
      computerName: shown.writtenBy.displayName,
      mode: shown.bundle.octant.mode,
      kind: artifactKindForBlocks(shown.bundle.definition.blocks),
      title: shown.bundle.definition.title,
      versionCount: Math.max(1, artifact.versions.length),
      headCount: heads.length,
      status: standing.status,
      ...(deletion === undefined ? {} : { deletedOn: deletion.writtenBy.displayName }),
      updatedAt: shown.bundle.octant.createdAt,
      ...(markup === "" ? {} : { preview: { format: "svg" as const, markup } }),
    });
  }
  return entries.sort((left, right) =>
    String(right.updatedAt).localeCompare(String(left.updatedAt)),
  );
}
