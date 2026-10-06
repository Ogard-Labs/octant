/**
 * Whether one replica entry may join the local library, or change who shares
 * the store it came from.
 *
 * The host has already read the file and reached a signature verdict. This
 * function decides what that entry means. It does not write, and it does not
 * verify a signature.
 *
 * There is no overwrite. A function that cannot return that outcome cannot be
 * talked into it. A sequence gap is refused so a later entry is never applied
 * while an earlier one is missing. A tombstone stays in the history the caller
 * already holds; a later version from another computer appends beside it.
 * A join request from a computer that is not yet a member is not a refusal:
 * it returns the one outcome that can make it one, and the approval that
 * follows is the caller's to journal.
 */

import {
  replicaEntryBundleAgrees,
  type ReplicaArtifactEntry,
  type ReplicaContentHash,
  type ReplicaEntry,
  type ReplicaInstanceId,
  type ReplicaMembershipEntry,
  type ReplicaSignatureVerdict,
} from "@octant/contracts/replica-entry";
import type { CanvasId, CanvasVersionId } from "@octant/contracts/canvas";
import type { HostId } from "@octant/contracts/host";

export const REPLICA_RECONCILE_OUTCOMES = [
  "append-version",
  "already-present",
  "concurrent-head",
  "tombstone",
  "request-approval",
  "member-added",
  "member-revoked",
  "refused",
] as const;

export const REPLICA_REFUSAL_REASONS = [
  "unknown-instance",
  "revoked-instance",
  "sequence-gap",
  "names-local-artifact-as-foreign",
  "hash-mismatch",
  "membership-conflict",
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
  /** Artifact entries record the hash they were applied with. */
  readonly contentHash?: ReplicaContentHash;
  /** Membership entries record the instance they are about. */
  readonly subject?: ReplicaInstanceId;
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
  /** This host's own instance in the store. Membership includes it. */
  readonly localInstanceId: ReplicaInstanceId;
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

function atSequence(state: ReplicaLocalState, entry: ReplicaEntry) {
  return state.applied.find(
    (applied) =>
      String(applied.instanceId) === String(entry.origin.instanceId) &&
      applied.sequence === entry.origin.sequence,
  );
}

// Sequence 3 is refused while 2 is missing. Applying it would invent the gap
// and make the missing entry impossible to insert later.
function behindSequence(state: ReplicaLocalState, entry: ReplicaEntry): boolean {
  return entry.origin.sequence !== highestApplied(state, entry.origin.instanceId) + 1;
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
 * Decide what one pulled entry does to the local library.
 *
 * Signature is checked first, so a bad copy is refused even when the instance
 * would otherwise be welcome. An already-applied entry is idempotent: pulling
 * it again changes nothing, whichever kind it was. A sequence other than the
 * next one for its own origin is a gap and is not applied.
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
      throw new Error("Unexpected signature verdict: " + String(unexpected));
    }
  }
  return entry.kind === "artifact-version" || entry.kind === "artifact-tombstone"
    ? artifactOutcome(localState, entry)
    : membershipOutcome(localState, entry);
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
  const standing = membership(state, entry.origin.instanceId);
  if (standing === "unknown") return refuse("unknown-instance");
  if (standing === "revoked") return refuse("revoked-instance");
  if (behindSequence(state, entry)) return refuse("sequence-gap");
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

/**
 * What one membership record does to the local membership list.
 *
 * A join request is the one record a computer that is not yet a member may
 * write, so its origin is not checked against membership: only a revoked
 * identity is refused, because re-joining is a new identity rather than the
 * old one back. An approval and a revocation are written by a member, so
 * their origin must be one. An approval naming a revoked instance is refused:
 * that instance rejoins with a new identity, not with this one.
 */
function membershipOutcome(
  state: ReplicaLocalState,
  entry: ReplicaMembershipEntry,
): ReplicaReconcileOutcome {
  const recorded = atSequence(state, entry);
  if (recorded !== undefined) {
    if (
      recorded.kind === entry.kind &&
      recorded.contentHash === undefined &&
      recorded.subject !== undefined &&
      String(recorded.subject) === String(entry.subject)
    ) {
      return { outcome: "already-present" };
    }
    // The sequence was written once. A different record cannot take its place.
    return refuse("membership-conflict");
  }
  const wrote = membership(state, entry.origin.instanceId);
  if (entry.kind !== "join-request") {
    // A sequence-1 self-approval proves only that its writer holds the key the
    // record names, and any computer that can write to the store can mint
    // one, so it cannot bootstrap trust by what it is. A computer holds the
    // store creator as a member because it journaled that record itself -
    // its own create, or an approval the person confirmed - and that journal
    // is the anchor an approval's writer is checked against.
    if (wrote === "unknown") return refuse("unknown-instance");
    if (wrote === "revoked") return refuse("revoked-instance");
  } else if (wrote === "revoked") {
    return refuse("revoked-instance");
  }
  if (behindSequence(state, entry)) return refuse("sequence-gap");
  const subject = membership(state, entry.subject);
  if (entry.kind === "join-request") {
    return subject === "unknown" ? { outcome: "request-approval" } : { outcome: "already-present" };
  }
  if (entry.kind === "join-approved") {
    if (subject === "revoked") return refuse("revoked-instance");
    return subject === "member" ? { outcome: "already-present" } : { outcome: "member-added" };
  }
  if (subject === "unknown") return refuse("unknown-instance");
  return subject === "revoked" ? { outcome: "already-present" } : { outcome: "member-revoked" };
}
