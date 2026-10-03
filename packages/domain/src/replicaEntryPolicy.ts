/**
 * Whether one replica entry may join the local library.
 *
 * The host has already read the file and reached a signature verdict. This
 * function decides what that entry means. It does not write, and it does not
 * verify a signature.
 *
 * There is no overwrite. A function that cannot return that outcome cannot be
 * talked into it. A sequence gap is refused so a later entry is never applied
 * while an earlier one is missing. A tombstone stays in the history the caller
 * already holds; a later version from another computer appends beside it.
 */

import {
  replicaEntryBundleAgrees,
  type ReplicaContentHash,
  type ReplicaEntry,
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

export interface ReplicaInstanceMembership {
  readonly instanceId: ReplicaInstanceId;
  readonly status: "member" | "revoked";
}

export interface ReplicaAppliedEntry {
  readonly instanceId: ReplicaInstanceId;
  readonly sequence: number;
  readonly kind: ReplicaEntry["kind"];
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
  readonly instances: ReadonlyArray<ReplicaInstanceMembership>;
  readonly applied: ReadonlyArray<ReplicaAppliedEntry>;
  readonly artifacts: ReadonlyArray<ReplicaArtifactRecord>;
  /** SHA-256 of the canonical bundle, measured by the host before this call. */
  readonly measuredContentHash: string;
  readonly signature: ReplicaSignatureVerdict;
}

function refuse(reason: ReplicaRefusalReason): ReplicaReconcileOutcome {
  return { outcome: "refused", reason };
}

function membership(
  state: ReplicaLocalState,
  instanceId: ReplicaInstanceId,
): "unknown" | "member" | "revoked" {
  const records = state.instances.filter(
    (instance) => String(instance.instanceId) === String(instanceId),
  );
  if (records.length === 0) return "unknown";
  if (records.some((instance) => instance.status === "revoked")) return "revoked";
  return "member";
}

function highestApplied(state: ReplicaLocalState, instanceId: ReplicaInstanceId): number {
  let highest = 0;
  for (const applied of state.applied) {
    if (String(applied.instanceId) !== String(instanceId)) continue;
    if (applied.sequence > highest) highest = applied.sequence;
  }
  return highest;
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

/**
 * A local artifact named as if it had been created somewhere else, or a bundle
 * that names a different artifact than the entry claims.
 */
function namesLocalArtifactAsForeign(state: ReplicaLocalState, entry: ReplicaEntry): boolean {
  if (!replicaEntryBundleAgrees(entry)) return true;
  const known = artifactRecord(state, entry.artifact.canvasId);
  if (known === undefined) return false;
  return (
    String(known.originHostId) === String(state.localHostId) &&
    String(entry.artifact.hostId) !== String(state.localHostId)
  );
}

function concurrentWithExisting(state: ReplicaLocalState, entry: ReplicaEntry): boolean {
  const known = artifactRecord(state, entry.artifact.canvasId);
  if (known === undefined) return false;
  const key = parentKey(entry.parents.map((parent) => String(parent.versionId)));
  return known.versions.some(
    (version) =>
      parentKey(version.parentVersionIds) === key && version.contentHash !== entry.contentHash,
  );
}

/**
 * Decide what one pulled entry does to the local library.
 *
 * Signature and hash are checked before membership, so a bad copy is refused
 * even when the instance would otherwise be welcome. An already-applied entry
 * is idempotent: pulling it again changes nothing. Anything else from a
 * revoked or unknown instance is refused. A sequence other than the next one
 * is a gap and is not applied.
 */
export function reconcileReplicaEntry(
  localState: ReplicaLocalState,
  entry: ReplicaEntry,
): ReplicaReconcileOutcome {
  switch (localState.signature) {
    case "verified":
      break;
    case "bad-signature":
    case "missing":
      return refuse("bad-signature");
    default: {
      const unexpected: never = localState.signature;
      throw new Error(`Unexpected signature verdict: ${String(unexpected)}`);
    }
  }

  if (localState.measuredContentHash !== entry.contentHash) return refuse("hash-mismatch");

  const recorded = localState.applied.find(
    (applied) =>
      String(applied.instanceId) === String(entry.origin.instanceId) &&
      applied.sequence === entry.origin.sequence,
  );
  if (recorded !== undefined) {
    if (recorded.kind === entry.kind && recorded.contentHash === entry.contentHash) {
      return { outcome: "already-present" };
    }
    // The sequence was written once. A different body cannot take its place.
    return refuse("hash-mismatch");
  }

  const standing = membership(localState, entry.origin.instanceId);
  if (standing === "unknown") return refuse("unknown-instance");
  if (standing === "revoked") return refuse("revoked-instance");

  // Sequence 3 is refused while 2 is missing. Applying it would invent the
  // gap and make the missing entry impossible to insert later.
  if (entry.origin.sequence !== highestApplied(localState, entry.origin.instanceId) + 1) {
    return refuse("sequence-gap");
  }
  if (namesLocalArtifactAsForeign(localState, entry)) {
    return refuse("names-local-artifact-as-foreign");
  }

  if (entry.kind === "artifact-version") {
    const known = artifactRecord(localState, entry.artifact.canvasId);
    const clash = known?.versions.find(
      (version) => String(version.versionId) === String(entry.bundle.octant.versionId),
    );
    if (clash !== undefined && clash.contentHash !== entry.contentHash) {
      // A version id already names one body. A different body cannot replace it.
      return refuse("hash-mismatch");
    }
  }

  if (entry.kind === "artifact-tombstone") return { outcome: "tombstone" };
  if (concurrentWithExisting(localState, entry)) return { outcome: "concurrent-head" };
  return { outcome: "append-version" };
}
