/**
 * One write-once record in a store a person set aside for artifact sync.
 *
 * The file is `<instanceId>/<sequence>.json`. A detached signature sits beside
 * it at `<instanceId>/<sequence>.sig`. Both are write-once. This module names
 * those paths and decodes the JSON; it does not write either file and it does
 * not verify a signature. An artifact entry's payload is the bundle the
 * mirror writes, not a second document. A membership entry is a record about
 * who shares the store and carries no artifact at all. The detached
 * signature covers an entry's encoded bytes whole - origin, kind, parents,
 * the claimed content hash, and the bundle - so a rewrite of any of them is
 * a different signature.
 *
 * An unknown format fails closed. A decoder that guessed would apply a record
 * this host does not know how to read.
 */

import { Schema } from "effect";
import { ArtifactBundle, decodeArtifactBundle, encodeArtifactBundle } from "./artifactBundle";
import { CanvasId, CanvasVersionId } from "./canvas";
import { HostId } from "./host";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const REPLICA_ENTRY_FORMAT = "octant.replica-entry/1" as const;

const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

export const ReplicaInstanceId = brandedUuid("ReplicaInstanceId");
export type ReplicaInstanceId = typeof ReplicaInstanceId.Type;

function isReplicaDisplayName(value: string): boolean {
  if (value !== value.normalize("NFC") || value === "." || value === "..") return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 0x20 || character === "\\" || character === "/") return false;
  }
  return true;
}

/**
 * The name of the computer that wrote the entry, as that computer names
 * itself. It is not a path and it is not an instance id.
 */
export const ReplicaDisplayName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.filter(isReplicaDisplayName),
);
export type ReplicaDisplayName = typeof ReplicaDisplayName.Type;

export const ReplicaOrigin = Schema.Struct({
  instanceId: ReplicaInstanceId,
  displayName: ReplicaDisplayName,
  sequence: PositiveInt,
}).annotations(strict);
export type ReplicaOrigin = typeof ReplicaOrigin.Type;

/**
 * Where the artifact was created. A later revision from another computer
 * still carries this identity; it does not become that computer's artifact.
 */
export const ReplicaArtifactOrigin = Schema.Struct({
  canvasId: CanvasId,
  hostId: HostId,
}).annotations(strict);
export type ReplicaArtifactOrigin = typeof ReplicaArtifactOrigin.Type;

export const ReplicaParentVersion = Schema.Struct({
  versionId: CanvasVersionId,
}).annotations(strict);
export type ReplicaParentVersion = typeof ReplicaParentVersion.Type;

export const ReplicaParents = Schema.Array(ReplicaParentVersion).pipe(
  Schema.maxItems(16),
  Schema.filter(
    (parents) => new Set(parents.map((parent) => String(parent.versionId))).size === parents.length,
  ),
);
export type ReplicaParents = typeof ReplicaParents.Type;

/** Lowercase hex SHA-256 of {@link replicaEntryContentPreimage}. */
export const ReplicaContentHash = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
export type ReplicaContentHash = typeof ReplicaContentHash.Type;

/**
 * A verdict the host already reached. `verified` means the detached signature
 * over `encodeReplicaEntry(entry)` matched, so every field the record
 * carries was covered. Missing is not verified: an entry whose signature was
 * not checked is not an entry that passed.
 */
export const ReplicaSignatureVerdict = Schema.Literal("verified", "bad-signature", "missing");
export type ReplicaSignatureVerdict = typeof ReplicaSignatureVerdict.Type;

const ReplicaEntryFields = {
  format: Schema.Literal(REPLICA_ENTRY_FORMAT),
  origin: ReplicaOrigin,
  artifact: ReplicaArtifactOrigin,
  parents: ReplicaParents,
  contentHash: ReplicaContentHash,
  bundle: ArtifactBundle,
} as const;

export const ReplicaVersionEntry = Schema.Struct({
  kind: Schema.Literal("artifact-version"),
  ...ReplicaEntryFields,
}).annotations(strict);
export type ReplicaVersionEntry = typeof ReplicaVersionEntry.Type;

export const ReplicaTombstoneEntry = Schema.Struct({
  kind: Schema.Literal("artifact-tombstone"),
  ...ReplicaEntryFields,
}).annotations(strict);
export type ReplicaTombstoneEntry = typeof ReplicaTombstoneEntry.Type;

export const ReplicaArtifactEntry = Schema.Union(ReplicaVersionEntry, ReplicaTombstoneEntry);
export type ReplicaArtifactEntry = typeof ReplicaArtifactEntry.Type;

/**
 * Membership lifecycle, carried in the same log so a computer that is not yet
 * a member can be discovered and approved by name instead of being invisible.
 *
 * `join-request` is written by the joining computer as its own next sequence
 * and names itself, and it says when it was written so an approver can hold
 * it to a freshness window. `join-approved` and `revocation` are written by a
 * member as that member's next sequence and name the instance they act on.
 * None of the three carries an artifact, a parent chain, or a content hash:
 * their body is the record, and the signature covers it whole.
 */
export const ReplicaMembershipEntryKind = Schema.Literal(
  "join-request",
  "join-approved",
  "revocation",
);
export type ReplicaMembershipEntryKind = typeof ReplicaMembershipEntryKind.Type;

/**
 * Base64 SPKI bytes of the Ed25519 device key an instance signs entries with.
 * Ed25519 SPKI is 44 DER bytes, which base64 encodes to 60 characters with
 * one padding character; a different-length string is not an Ed25519 SPKI.
 */
export const ReplicaDevicePublicKey = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9+/]{59}=$/));
export type ReplicaDevicePublicKey = typeof ReplicaDevicePublicKey.Type;

const ReplicaMembershipEntryFields = {
  format: Schema.Literal(REPLICA_ENTRY_FORMAT),
  kind: ReplicaMembershipEntryKind,
  origin: ReplicaOrigin,
  /** The instance this record is about. A join request names itself. */
  subject: ReplicaInstanceId,
  subjectDisplayName: ReplicaDisplayName,
  /** The device key that instance signs entries with. A revocation has none. */
  subjectDeviceKey: Schema.optional(ReplicaDevicePublicKey),
  /**
   * When the joining computer wrote its request, in epoch milliseconds. The
   * signature covers it like every other field, so the approver can hold the
   * request to a freshness window measured against its own clock. Only a
   * join request carries it.
   */
  requestedAt: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
} as const;

export const ReplicaMembershipEntry = Schema.Struct(ReplicaMembershipEntryFields)
  .annotations(strict)
  .pipe(
    Schema.filter(
      (entry) => {
        if (entry.kind === "join-request") {
          return (
            String(entry.subject) === String(entry.origin.instanceId) &&
            entry.subjectDeviceKey !== undefined &&
            entry.requestedAt !== undefined
          );
        }
        if (entry.kind === "join-approved") {
          return entry.subjectDeviceKey !== undefined && entry.requestedAt === undefined;
        }
        return entry.subjectDeviceKey === undefined && entry.requestedAt === undefined;
      },
      {
        message: () =>
          "A join request names the instance that wrote it, carries its device key, and says when it was written; an approval carries the approved device key; a revocation carries neither key nor time.",
      },
    ),
  );
export type ReplicaMembershipEntry = typeof ReplicaMembershipEntry.Type;

export const ReplicaEntry = Schema.Union(ReplicaArtifactEntry, ReplicaMembershipEntry);
export type ReplicaEntry = typeof ReplicaEntry.Type;

export const decodeReplicaEntry = Schema.decodeUnknownSync(ReplicaEntry);
export const decodeReplicaArtifactEntry = Schema.decodeUnknownSync(ReplicaArtifactEntry);
export const decodeReplicaMembershipEntry = Schema.decodeUnknownSync(ReplicaMembershipEntry);
export const decodeReplicaSignatureVerdict = Schema.decodeUnknownSync(ReplicaSignatureVerdict);

/**
 * Read one entry from the JSON text a store would hold.
 *
 * Invalid JSON, an unknown format, and a field this format does not define
 * all fail closed. There is no fallback document.
 */
export function decodeReplicaEntryText(text: string): ReplicaEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Replica entry is not readable JSON.");
  }
  return decodeReplicaEntry(parsed);
}

/**
 * The bytes a content hash covers: the canonical artifact bundle, including
 * its trailing newline, in the same shape the mirror writes.
 */
export function replicaEntryContentPreimage(entry: ReplicaArtifactEntry): string {
  return encodeArtifactBundle(entry.bundle);
}

/**
 * Whether the bundle names the artifact the entry claims.
 *
 * A bundle that names another artifact is not this entry's payload, however
 * it got there. Applying it would graft one document onto another's history.
 */
export function replicaEntryBundleAgrees(entry: ReplicaArtifactEntry): boolean {
  return (
    String(entry.bundle.octant.canvasId) === String(entry.artifact.canvasId) &&
    String(entry.bundle.octant.hostId) === String(entry.artifact.hostId)
  );
}

/**
 * Relative paths under the store root.
 *
 * `<instanceId>/<sequence>.json` beside `<instanceId>/<sequence>.sig`. Both
 * are write-once. This names them; it does not create them.
 */
export function replicaEntryRelativePaths(
  instanceId: ReplicaInstanceId,
  sequence: number,
): { readonly entry: string; readonly signature: string } {
  const id = String(instanceId);
  if (
    !Number.isInteger(sequence) ||
    sequence < 1 ||
    id.length === 0 ||
    /[\\/]/.test(id) ||
    id.includes("..")
  ) {
    throw new Error("Replica entry path is not a write-once instance sequence.");
  }
  return {
    entry: `${id}/${String(sequence)}.json`,
    signature: `${id}/${String(sequence)}.sig`,
  };
}

/**
 * Plain readable JSON. Keys go out in a fixed order, indentation is two
 * spaces, and the text ends with a newline, so a revision that changed one
 * sentence shows one changed line.
 */
export function encodeReplicaEntry(entry: ReplicaEntry): string {
  const body = isMembershipEntry(entry)
    ? {
        format: entry.format,
        kind: entry.kind,
        origin: {
          instanceId: entry.origin.instanceId,
          displayName: entry.origin.displayName,
          sequence: entry.origin.sequence,
        },
        subject: entry.subject,
        subjectDisplayName: entry.subjectDisplayName,
        ...(entry.subjectDeviceKey === undefined
          ? {}
          : { subjectDeviceKey: entry.subjectDeviceKey }),
        ...(entry.requestedAt === undefined ? {} : { requestedAt: entry.requestedAt }),
      }
    : {
        format: entry.format,
        kind: entry.kind,
        origin: {
          instanceId: entry.origin.instanceId,
          displayName: entry.origin.displayName,
          sequence: entry.origin.sequence,
        },
        artifact: {
          canvasId: entry.artifact.canvasId,
          hostId: entry.artifact.hostId,
        },
        parents: entry.parents.map((parent) => ({ versionId: parent.versionId })),
        contentHash: entry.contentHash,
        bundle: decodeArtifactBundle(JSON.parse(encodeArtifactBundle(entry.bundle))),
      };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Host commands for managing who may write to a replica store. These travel
 * only over the loopback host route; a paired phone is refused there.
 */
export const ReplicaMembershipCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("create-replica"),
    displayName: ReplicaDisplayName,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("write-join-request"),
    displayName: ReplicaDisplayName,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("approve-join"),
    joinRequest: ReplicaMembershipEntry,
    confirmationCode: Schema.String.pipe(Schema.pattern(/^\d{6}$/)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("confirm-join"),
    /** The member whose approval of this computer's request the person confirmed. */
    approver: ReplicaInstanceId,
    confirmationCode: Schema.String.pipe(Schema.pattern(/^\d{6}$/)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("revoke"),
    subject: ReplicaInstanceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pull"),
  }).annotations(strict),
);
export type ReplicaMembershipCommand = typeof ReplicaMembershipCommand.Type;

/**
 * Why an entry read from the store was not applied. The first seven are the
 * reconcile policy's reasons; `path-mismatch` is a body whose origin is not
 * the instance and sequence its path names, and `unreadable` is a file that
 * does not decode as an entry this format defines.
 */
export const ReplicaReadRefusalReason = Schema.Literal(
  "unknown-instance",
  "revoked-instance",
  "sequence-gap",
  "names-local-artifact-as-foreign",
  "hash-mismatch",
  "membership-conflict",
  "bad-signature",
  "path-mismatch",
  "unreadable",
);
export type ReplicaReadRefusalReason = typeof ReplicaReadRefusalReason.Type;

export const ReplicaReadRefusal = Schema.Struct({
  instanceId: ReplicaInstanceId,
  sequence: PositiveInt,
  reason: ReplicaReadRefusalReason,
}).annotations(strict);
export type ReplicaReadRefusal = typeof ReplicaReadRefusal.Type;

export const ReplicaMembershipResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("replica-created"),
    instanceId: ReplicaInstanceId,
    entry: ReplicaMembershipEntry,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("join-requested"),
    instanceId: ReplicaInstanceId,
    entry: ReplicaMembershipEntry,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("join-approved"),
    subject: ReplicaInstanceId,
    entry: ReplicaMembershipEntry,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("revoked"),
    subject: ReplicaInstanceId,
    entry: ReplicaMembershipEntry,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("join-confirmed"),
    approver: ReplicaInstanceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pulled"),
    /** Entries verified and applied by this pull. */
    applied: Schema.Int.pipe(Schema.nonNegative()),
    /** Entries refused by this pull, each journaled. */
    refused: Schema.Array(ReplicaReadRefusal),
    /**
     * Artifact entries that verified but were not applied: importing an
     * artifact version is not built yet, so the walk for that instance stops
     * there and the entry is read again by a later pull.
     */
    held: Schema.Array(
      Schema.Struct({ instanceId: ReplicaInstanceId, sequence: PositiveInt }).annotations(strict),
    ),
    /** Fresh join requests from computers that are not members yet. */
    joinRequests: Schema.Array(ReplicaMembershipEntry),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literal(
      "not-configured",
      "already-member",
      "revoked-instance",
      "code-mismatch",
      "expired-join-request",
      "unknown-instance",
      "not-a-member",
      "store-unavailable",
      "key-unavailable",
    ),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("store-failed"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type ReplicaMembershipResult = typeof ReplicaMembershipResult.Type;

export const decodeReplicaMembershipCommand = Schema.decodeUnknownSync(ReplicaMembershipCommand);
export const decodeReplicaMembershipResult = Schema.decodeUnknownSync(ReplicaMembershipResult);

function isMembershipEntry(entry: ReplicaEntry): entry is ReplicaMembershipEntry {
  return (
    entry.kind === "join-request" || entry.kind === "join-approved" || entry.kind === "revocation"
  );
}
