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
import {
  CANVAS_MAX_BLOCKS,
  type CanvasBlock,
  type CanvasDefinition,
  type CanvasId,
  type CanvasVersionId,
} from "@octant/contracts/canvas";
import { sourceIdsForBlock } from "./canvasPolicy";
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

/**
 * Where an artifact stands across this person's computers, and what the
 * person chooses between.
 *
 * `candidates` are the versions that stand: one when it is current, two or
 * more when the person must keep one or merge them. When the artifact is
 * open in a thread here, the version standing here is a candidate unless a
 * version from another computer revises it. A head this computer already
 * holds in its own history is not one: a version committed here while sync
 * was off, or one still queued, descends from it. `ahead` is the one version
 * from another computer that revises the version standing here, when nothing
 * else stands beside it: it is appended here (0040: a later import of the
 * same origin appends a version), not chosen between. `deletions` are the
 * tombstones that are all that is left.
 */
export interface ReplicaArtifactStanding {
  readonly status: "current" | "two-versions" | "deleted";
  readonly candidates: ReadonlyArray<string>;
  readonly ahead: string | undefined;
  readonly deletions: ReadonlyArray<ReplicaKnownTombstone>;
}

/** Whether `versionId` is `ancestorId` or revises it, through any chain of parents. */
function revisesVersion(
  versions: ReadonlyArray<ReplicaKnownVersion>,
  versionId: string,
  ancestorId: string,
): boolean {
  const parents = new Map(versions.map((version) => [String(version.versionId), version]));
  const pending = [versionId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || seen.has(next)) continue;
    if (next === ancestorId) return true;
    seen.add(next);
    pending.push(...(parents.get(next)?.parentVersionIds.map(String) ?? []));
  }
  return false;
}

export function replicaArtifactStanding(
  record: Pick<ReplicaArtifactRecord, "versions" | "tombstones">,
  local?: {
    readonly currentVersionId: string;
    readonly versionIds: ReadonlyArray<string>;
  },
): ReplicaArtifactStanding {
  const heads = replicaArtifactHeads(record);
  const versionHeads = heads.flatMap((head) =>
    head.kind === "version" ? [String(head.versionId)] : [],
  );
  const tombstoneHeads = record.tombstones.filter((tombstone) =>
    heads.some(
      (head) =>
        head.kind === "tombstone" &&
        String(head.originInstanceId) === String(tombstone.originInstanceId) &&
        head.originSequence === tombstone.originSequence,
    ),
  );
  if (local === undefined) {
    if (versionHeads.length === 0 && tombstoneHeads.length > 0) {
      return { status: "deleted", candidates: [], ahead: undefined, deletions: tombstoneHeads };
    }
    return {
      status: versionHeads.length > 1 ? "two-versions" : "current",
      candidates: versionHeads,
      ahead: undefined,
      deletions: [],
    };
  }
  const current = String(local.currentVersionId);
  // Deleted here only when the deletion was taken from the version standing
  // here; a version written here since then is not covered by it.
  if (
    versionHeads.length === 0 &&
    tombstoneHeads.some((tombstone) => tombstone.parentVersionIds.map(String).includes(current))
  ) {
    return { status: "deleted", candidates: [], ahead: undefined, deletions: tombstoneHeads };
  }
  const held = new Set(local.versionIds.map(String));
  const elsewhere = versionHeads.filter((versionId) => !held.has(versionId));
  const superseded = elsewhere.some((versionId) =>
    revisesVersion(record.versions, versionId, current),
  );
  const candidates = superseded ? elsewhere : [current, ...elsewhere];
  return {
    status: candidates.length > 1 ? "two-versions" : "current",
    candidates,
    ahead: superseded && elsewhere.length === 1 ? elsewhere[0] : undefined,
    deletions: [],
  };
}

/** What a thread here is, as far as taking a synced artifact goes. */
export interface ReplicaBindingThread {
  readonly mode: "chat" | "work" | "code";
  /** The thread is active, not archived or closed. */
  readonly active: boolean;
  /** Its Project exists here, is active, and is of the thread's mode. */
  readonly projectActive: boolean;
  /** Plan mode: nothing it holds may change. */
  readonly readOnly: boolean;
  /** The host resolves the thread's workspace now, from durable state. */
  readonly workspaceResolved: boolean;
}

export type ReplicaBindingRefusal =
  | "mode-mismatch"
  | "thread-inactive"
  | "project-unavailable"
  | "read-only"
  | "workspace-unavailable";

export type ReplicaBindingDecision =
  | { readonly kind: "compatible" }
  | { readonly kind: "incompatible"; readonly reason: ReplicaBindingRefusal };

/**
 * Whether a synced artifact may be bound to this thread (0040: bind to a
 * compatible thread, not merely a Project). The thread's own mode, Project,
 * and authority decide; the artifact brings none of its origin's. A Chat
 * artifact goes to a Chat thread, a Work artifact to a Work thread, and a
 * Code artifact to a Code thread whose checkout is available and that is
 * not in Plan mode, so binding never widens what a thread may do.
 */
export function decideReplicaArtifactBinding(
  artifactMode: ReplicaBindingThread["mode"],
  thread: ReplicaBindingThread,
): ReplicaBindingDecision {
  if (thread.mode !== artifactMode) return { kind: "incompatible", reason: "mode-mismatch" };
  if (!thread.active) return { kind: "incompatible", reason: "thread-inactive" };
  if (!thread.projectActive) return { kind: "incompatible", reason: "project-unavailable" };
  if (thread.readOnly) return { kind: "incompatible", reason: "read-only" };
  if (!thread.workspaceResolved) {
    return { kind: "incompatible", reason: "workspace-unavailable" };
  }
  return { kind: "compatible" };
}

/**
 * The blocks of a version made from two: every block of `base`, then each
 * block of `other` that `base` does not already carry. Where both carry a
 * block under one id with different content, both stay - `other`'s under a
 * fresh id beside it - so the person sees each side and nothing is silently
 * chosen. A block of `other` that names a source `base` does not list cannot
 * stand in `base`'s manifest and is left out, as is anything past the block
 * ceiling; `omitted` counts both, so the caller can say so.
 */
export function mergeReplicaArtifactBlocks(
  base: Pick<CanvasDefinition, "blocks" | "sourceManifest">,
  other: Pick<CanvasDefinition, "blocks">,
): { readonly blocks: ReadonlyArray<CanvasBlock>; readonly omitted: number } {
  const sources = new Set(base.sourceManifest.map((source) => String(source.sourceId)));
  const byId = new Map(base.blocks.map((block) => [String(block.blockId), block]));
  const used = new Set(byId.keys());
  const blocks: CanvasBlock[] = [...base.blocks];
  let omitted = 0;
  for (const block of other.blocks) {
    const id = String(block.blockId);
    const existing = byId.get(id);
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(block)) continue;
    if (
      blocks.length >= CANVAS_MAX_BLOCKS ||
      !sourceIdsForBlock(block).every((sourceId) => sources.has(String(sourceId)))
    ) {
      omitted += 1;
      continue;
    }
    let fresh = id;
    for (let suffix = 2; used.has(fresh); suffix += 1) {
      fresh = `${id.slice(0, 120)}-${String(suffix)}`;
    }
    used.add(fresh);
    blocks.push(fresh === id ? block : { ...block, blockId: fresh as CanvasBlock["blockId"] });
  }
  return { blocks, omitted };
}
