/**
 * Whether one artifact entry from a replica store may join the local library.
 *
 * The host has already read the file and reached a signature verdict. This
 * function decides what that entry means. It does not write, and it does not
 * verify a signature.
 *
 * There is no overwrite. A function that cannot return that outcome cannot be
 * talked into it. An entry waits while an earlier slot of its writer that the
 * store lists has no lasting verdict here yet, so one writer's entries apply
 * in the order it wrote them. A tombstone stays in the history the caller
 * already holds; a later version from another computer appends beside it.
 *
 * Membership records are not reconciled here: who counts is derived from the
 * whole set of membership records a host holds, by the membership policy, and
 * this function takes that standing as an input.
 */

import {
  replicaEntryBundleAgrees,
  type ReplicaArtifactEntry,
  type ReplicaContentHash,
  type ReplicaInstanceId,
  type ReplicaSignatureVerdict,
} from "@octant/contracts/replica-entry";
import type { CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import type { HostId } from "@octant/contracts/host";

export const REPLICA_RECONCILE_OUTCOMES = [
  "append-version",
  "already-present",
  "concurrent-head",
  "tombstone",
  "refused",
] as const;

export const REPLICA_REFUSAL_REASONS = [
  "unknown-instance",
  "revoked-instance",
  "sequence-gap",
  "names-local-artifact-as-foreign",
  "hash-mismatch",
  "bad-signature",
] as const;

export type ReplicaRefusalReason = (typeof REPLICA_REFUSAL_REASONS)[number];

type KeepingOutcome = Exclude<(typeof REPLICA_RECONCILE_OUTCOMES)[number], "refused">;

export type ReplicaReconcileOutcome =
  | { readonly outcome: KeepingOutcome }
  | { readonly outcome: "refused"; readonly reason: ReplicaRefusalReason };

type OverwriteName = Extract<(typeof REPLICA_RECONCILE_OUTCOMES)[number], "replace" | "overwrite">;
export const replicaReconcileCannotOverwrite: [OverwriteName] extends [never] ? true : never = true;

/**
 * A revoked instance carries the cut its revocation named: entries it signed
 * at or before that sequence keep counting, and later ones are refused.
 */
export type ReplicaInstanceMembership =
  | { readonly instanceId: ReplicaInstanceId; readonly status: "member" }
  | {
      readonly instanceId: ReplicaInstanceId;
      readonly status: "revoked";
      readonly lastAcceptedSequence: number;
    };

/** One write-once slot of one instance in the store. */
export interface ReplicaSlot {
  readonly instanceId: ReplicaInstanceId;
  readonly sequence: number;
}

export interface ReplicaAppliedEntry {
  readonly instanceId: ReplicaInstanceId;
  readonly sequence: number;
  readonly kind: ReplicaArtifactEntry["kind"];
  /** The hash the entry was applied with. */
  readonly contentHash: ReplicaContentHash;
}

export interface ReplicaKnownVersion {
  readonly versionId: CanvasVersionId;
  readonly contentHash: ReplicaContentHash;
  readonly parentVersionIds: ReadonlyArray<string>;
}

export interface ReplicaKnownTombstone {
  readonly contentHash: ReplicaContentHash;
  readonly originInstanceId: ReplicaInstanceId;
  readonly originSequence: number;
  /** The versions the deletion was taken from. */
  readonly parentVersionIds: ReadonlyArray<string>;
}

export interface ReplicaArtifactRecord {
  readonly canvasId: CanvasId;
  /** The host that created the artifact. A foreign claim against a local one is refused. */
  readonly originHostId: HostId;
  readonly versions: ReadonlyArray<ReplicaKnownVersion>;
  readonly tombstones: ReadonlyArray<ReplicaKnownTombstone>;
}

/**
 * What the host already knows, plus the verdict and hash it measured for this
 * entry. The signature is an input, not a check this function performs.
 */
export interface ReplicaLocalState {
  readonly localHostId: HostId;
  /** This host's own instance in the store. Membership includes it. */
  readonly localInstanceId: ReplicaInstanceId;
  readonly instances: ReadonlyArray<ReplicaInstanceMembership>;
  readonly applied: ReadonlyArray<ReplicaAppliedEntry>;
  /**
   * Slots the store listed in the read this entry came from. Artifact entries
   * share each instance's sequence with its membership records, and a writer
   * skips a slot someone else's file took, so a writer's sequence has gaps
   * that are not missing entries.
   */
  readonly listedSlots: ReadonlyArray<ReplicaSlot>;
  /**
   * Slots this host reached a lasting verdict on besides `applied`: the
   * membership records it holds, artifact entries refused for their own
   * content, and files that are not valid records.
   */
  readonly settledSlots: ReadonlyArray<ReplicaSlot>;
  readonly artifacts: ReadonlyArray<ReplicaArtifactRecord>;
  /** SHA-256 of the canonical bundle, measured by the host before this call. */
  readonly measuredContentHash: string;
  readonly signature: ReplicaSignatureVerdict;
}

function refuse(reason: ReplicaRefusalReason): ReplicaReconcileOutcome {
  return { outcome: "refused", reason };
}

/**
 * Standing of an instance. With `sequence`, it is the standing of the entry
 * that instance signed at that sequence: at or before every cut that names it,
 * a revoked instance's entry still counts as a member's.
 */
function membership(
  state: ReplicaLocalState,
  instanceId: ReplicaInstanceId,
  sequence?: number,
): "unknown" | "member" | "revoked" {
  const records = state.instances.filter(
    (instance) => String(instance.instanceId) === String(instanceId),
  );
  if (records.length === 0) return "unknown";
  const cuts = records.flatMap((instance) =>
    instance.status === "revoked" ? [instance.lastAcceptedSequence] : [],
  );
  if (cuts.length === 0) return "member";
  if (sequence !== undefined && sequence <= Math.min(...cuts)) {
    return records.some((instance) => instance.status === "member") ? "member" : "revoked";
  }
  return "revoked";
}

function parentKey(versionIds: ReadonlyArray<string>): string {
  return [...versionIds].map(String).sort().join("\0");
}

function artifactRecord(
  state: ReplicaLocalState,
  canvasId: CanvasId,
): ReplicaArtifactRecord | undefined {
  return state.artifacts.find((artifact) => String(artifact.canvasId) === String(canvasId));
}

function atSequence(state: ReplicaLocalState, entry: ReplicaArtifactEntry) {
  return state.applied.find(
    (applied) =>
      String(applied.instanceId) === String(entry.origin.instanceId) &&
      applied.sequence === entry.origin.sequence,
  );
}

// An entry waits while an earlier slot of its writer that the store lists is
// unsettled here: applying it would let a reader skip an entry it can still
// read. A slot the store does not list - a squatted slot whose file was
// removed, or one a sync client has not delivered yet - does not hold it back,
// because a writer's sequence has gaps by design.
function waitsOnEarlierSlot(state: ReplicaLocalState, entry: ReplicaArtifactEntry): boolean {
  const writer = String(entry.origin.instanceId);
  const settled = new Set<number>();
  for (const slot of [...state.applied, ...state.settledSlots]) {
    if (String(slot.instanceId) === writer) settled.add(slot.sequence);
  }
  return state.listedSlots.some(
    (slot) =>
      String(slot.instanceId) === writer &&
      slot.sequence < entry.origin.sequence &&
      !settled.has(slot.sequence),
  );
}

/**
 * A local artifact named as if it had been created somewhere else, or a bundle
 * that names a different artifact than the entry claims.
 */
function namesLocalArtifactAsForeign(
  state: ReplicaLocalState,
  entry: ReplicaArtifactEntry,
): boolean {
  if (!replicaEntryBundleAgrees(entry)) return true;
  const known = artifactRecord(state, entry.artifact.canvasId);
  if (known === undefined) return false;
  return (
    String(known.originHostId) === String(state.localHostId) &&
    String(entry.artifact.hostId) !== String(state.localHostId)
  );
}

function concurrentWithExisting(state: ReplicaLocalState, entry: ReplicaArtifactEntry): boolean {
  const known = artifactRecord(state, entry.artifact.canvasId);
  if (known === undefined) return false;
  const key = parentKey(entry.parents.map((parent) => String(parent.versionId)));
  return known.versions.some(
    (version) =>
      parentKey(version.parentVersionIds) === key && version.contentHash !== entry.contentHash,
  );
}

/**
 * Decide what one pulled artifact entry does to the local library.
 *
 * Signature is checked first, so a bad copy is refused even when the instance
 * would otherwise be welcome. An already-applied entry is idempotent: pulling
 * it again changes nothing. An entry whose writer has an earlier listed slot
 * still unsettled here waits as a gap and is not applied.
 */
export function reconcileReplicaEntry(
  localState: ReplicaLocalState,
  entry: ReplicaArtifactEntry,
): ReplicaReconcileOutcome {
  switch (localState.signature) {
    case "verified":
      break;
    case "bad-signature":
    case "missing":
      return refuse("bad-signature");
    default: {
      const unexpected: never = localState.signature;
      throw new Error("Unexpected signature verdict: " + String(unexpected));
    }
  }
  return artifactOutcome(localState, entry);
}
function artifactOutcome(
  state: ReplicaLocalState,
  entry: ReplicaArtifactEntry,
): ReplicaReconcileOutcome {
  if (state.measuredContentHash !== entry.contentHash) return refuse("hash-mismatch");
  const recorded = atSequence(state, entry);
  if (recorded !== undefined) {
    // The sequence was written once. A different body cannot take its place.
    if (recorded.kind === entry.kind && recorded.contentHash === entry.contentHash) {
      return { outcome: "already-present" };
    }
    return refuse("hash-mismatch");
  }
  const standing = membership(state, entry.origin.instanceId, entry.origin.sequence);
  if (standing === "unknown") return refuse("unknown-instance");
  if (standing === "revoked") return refuse("revoked-instance");
  if (waitsOnEarlierSlot(state, entry)) return refuse("sequence-gap");
  if (namesLocalArtifactAsForeign(state, entry)) {
    return refuse("names-local-artifact-as-foreign");
  }
  if (entry.kind === "artifact-version") {
    const known = artifactRecord(state, entry.artifact.canvasId);
    const clash = known?.versions.find(
      (version) => String(version.versionId) === String(entry.bundle.octant.versionId),
    );
    if (clash !== undefined && clash.contentHash !== entry.contentHash) {
      // A version id already names one body. A different body cannot replace it.
      return refuse("hash-mismatch");
    }
  }
  if (entry.kind === "artifact-tombstone") return { outcome: "tombstone" };
  if (concurrentWithExisting(state, entry)) return { outcome: "concurrent-head" };
  return { outcome: "append-version" };
}

/** One head of an artifact's history: a version nothing revises, or a tombstone. */
export type ReplicaArtifactHead =
  | { readonly kind: "version"; readonly versionId: CanvasVersionId }
  | {
      readonly kind: "tombstone";
      readonly originInstanceId: ReplicaInstanceId;
      readonly originSequence: number;
    };

/**
 * The heads of an artifact's history, in a stable order.
 *
 * A version is a head while no version or tombstone names it as a parent. A
 * tombstone is always a head: nothing revises a deletion, and a later version
 * from the same parent stands beside it rather than replacing it. Nothing here
 * picks a winner; two heads stay two heads until a person merges them.
 */
export function replicaArtifactHeads(
  record: Pick<ReplicaArtifactRecord, "versions" | "tombstones">,
): ReadonlyArray<ReplicaArtifactHead> {
  const named = new Set<string>();
  for (const version of record.versions) {
    for (const parent of version.parentVersionIds) named.add(String(parent));
  }
  for (const tombstone of record.tombstones) {
    for (const parent of tombstone.parentVersionIds) named.add(String(parent));
  }
  const versions: ReplicaArtifactHead[] = record.versions
    .filter((version) => !named.has(String(version.versionId)))
    .map((version) => ({ kind: "version", versionId: version.versionId }));
  versions.sort((left, right) =>
    left.kind === "version" && right.kind === "version"
      ? String(left.versionId).localeCompare(String(right.versionId))
      : 0,
  );
  const tombstones: ReplicaArtifactHead[] = [...record.tombstones]
    .sort(
      (left, right) =>
        String(left.originInstanceId).localeCompare(String(right.originInstanceId)) ||
        left.originSequence - right.originSequence,
    )
    .map((tombstone) => ({
      kind: "tombstone",
      originInstanceId: tombstone.originInstanceId,
      originSequence: tombstone.originSequence,
    }));
  return [...versions, ...tombstones];
}

/**
 * Whether another computer hides the artifact: only when every head is a
 * tombstone. A revision beside a deletion keeps it visible.
 */
export function replicaArtifactHidden(
  record: Pick<ReplicaArtifactRecord, "versions" | "tombstones">,
): boolean {
  const heads = replicaArtifactHeads(record);
  return heads.length > 0 && heads.every((head) => head.kind === "tombstone");
}
