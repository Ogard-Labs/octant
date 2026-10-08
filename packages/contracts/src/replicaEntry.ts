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

export const REPLICA_ENTRY_FORMAT = "octant.replica-entry/2" as const;

const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

/**
 * An instance id is derived from the device key it signs with: the first 16
 * bytes of SHA-256 over the key's SPKI bytes, written as a UUIDv8. A record
 * whose id is not its key's is not valid, so no approval can name another key
 * for an id and no rewrite can change a member's key. The host checks that
 * binding; this schema only reads the shape.
 */
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

/**
 * Base64 SPKI bytes of the Ed25519 device key an instance signs entries with.
 * Ed25519 SPKI is 44 DER bytes, which base64 encodes to 60 characters with
 * one padding character; a different-length string is not an Ed25519 SPKI.
 */
export const ReplicaDevicePublicKey = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9+/]{59}=$/));
export type ReplicaDevicePublicKey = typeof ReplicaDevicePublicKey.Type;

/**
 * Who wrote an entry. Every entry carries its writer's public key, so whether
 * a record is valid depends on that one file alone: its signature checks
 * against this key, and its instance id is this key's id.
 */
export const ReplicaOrigin = Schema.Struct({
  instanceId: ReplicaInstanceId,
  displayName: ReplicaDisplayName,
  sequence: PositiveInt,
  publicKey: ReplicaDevicePublicKey,
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
 * None of these carries an artifact, a parent chain, or a content hash: the
 * body is the record, and the signature covers it whole.
 *
 * - `replica-founded` is the founder's own record at its sequence 1. It means
 *   something only to a computer that pinned this founder.
 * - `join-request` is a joining computer's sequence 1. It says when it was
 *   written, so an approver can hold it to a freshness window.
 * - `join-approved` names the approved computer and its key; it is valid only
 *   when that id is the key's id.
 * - `join-accepted` is signed by the joiner after the person compared codes.
 *   It names the one approval it accepted, by its writer, sequence, and the
 *   SHA-256 of the approval file's bytes, so each computer has one parent.
 * - `revocation` names a computer and the last of its sequences that still
 *   counts; 0 means none.
 */
export const ReplicaMembershipEntryKind = Schema.Literal(
  "replica-founded",
  "join-request",
  "join-approved",
  "join-accepted",
  "revocation",
);
export type ReplicaMembershipEntryKind = typeof ReplicaMembershipEntryKind.Type;

const membershipFormat = Schema.Literal(REPLICA_ENTRY_FORMAT);

/** Lowercase hex SHA-256 of the exact bytes of an approval file. */
export const ReplicaRecordHash = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
export type ReplicaRecordHash = typeof ReplicaRecordHash.Type;

export const ReplicaFoundedEntry = Schema.Struct({
  format: membershipFormat,
  kind: Schema.Literal("replica-founded"),
  origin: ReplicaOrigin,
})
  .annotations(strict)
  .pipe(
    Schema.filter((entry) => entry.origin.sequence === 1, {
      message: () => "A founding record is its writer's sequence 1.",
    }),
  );
export type ReplicaFoundedEntry = typeof ReplicaFoundedEntry.Type;

export const ReplicaJoinRequestEntry = Schema.Struct({
  format: membershipFormat,
  kind: Schema.Literal("join-request"),
  origin: ReplicaOrigin,
  /**
   * When the joining computer wrote its request, in epoch milliseconds. The
   * signature covers it, so the approver can hold the request to a freshness
   * window measured against its own clock.
   */
  requestedAt: Schema.Int.pipe(Schema.nonNegative()),
})
  .annotations(strict)
  .pipe(
    Schema.filter((entry) => entry.origin.sequence === 1, {
      message: () => "A join request is its writer's sequence 1.",
    }),
  );
export type ReplicaJoinRequestEntry = typeof ReplicaJoinRequestEntry.Type;

export const ReplicaJoinApprovedEntry = Schema.Struct({
  format: membershipFormat,
  kind: Schema.Literal("join-approved"),
  origin: ReplicaOrigin,
  subject: ReplicaInstanceId,
  /** The approved computer's device key; the record is valid only when `subject` is its id. */
  subjectKey: ReplicaDevicePublicKey,
  subjectName: ReplicaDisplayName,
}).annotations(strict);
export type ReplicaJoinApprovedEntry = typeof ReplicaJoinApprovedEntry.Type;

export const ReplicaJoinAcceptedEntry = Schema.Struct({
  format: membershipFormat,
  kind: Schema.Literal("join-accepted"),
  origin: ReplicaOrigin,
  approver: ReplicaInstanceId,
  approvalSequence: PositiveInt,
  approvalHash: ReplicaRecordHash,
  /** The founder the joiner pinned when it confirmed. */
  founder: ReplicaInstanceId,
})
  .annotations(strict)
  .pipe(
    Schema.filter((entry) => entry.origin.sequence >= 2, {
      message: () => "A join acceptance follows its writer's join request.",
    }),
  );
export type ReplicaJoinAcceptedEntry = typeof ReplicaJoinAcceptedEntry.Type;

export const ReplicaRevocationEntry = Schema.Struct({
  format: membershipFormat,
  kind: Schema.Literal("revocation"),
  origin: ReplicaOrigin,
  subject: ReplicaInstanceId,
  /**
   * The last sequence of the revoked instance that still counts; 0 when none
   * does. Every entry it signed after this stops counting on every computer.
   */
  cut: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type ReplicaRevocationEntry = typeof ReplicaRevocationEntry.Type;

export const ReplicaMembershipEntry = Schema.Union(
  ReplicaFoundedEntry,
  ReplicaJoinRequestEntry,
  ReplicaJoinApprovedEntry,
  ReplicaJoinAcceptedEntry,
  ReplicaRevocationEntry,
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
  const origin = {
    instanceId: entry.origin.instanceId,
    displayName: entry.origin.displayName,
    sequence: entry.origin.sequence,
    publicKey: entry.origin.publicKey,
  };
  const head = { format: entry.format, kind: entry.kind, origin };
  let body: object;
  switch (entry.kind) {
    case "replica-founded":
      body = head;
      break;
    case "join-request":
      body = { ...head, requestedAt: entry.requestedAt };
      break;
    case "join-approved":
      body = {
        ...head,
        subject: entry.subject,
        subjectKey: entry.subjectKey,
        subjectName: entry.subjectName,
      };
      break;
    case "join-accepted":
      body = {
        ...head,
        approver: entry.approver,
        approvalSequence: entry.approvalSequence,
        approvalHash: entry.approvalHash,
        founder: entry.founder,
      };
      break;
    case "revocation":
      body = { ...head, subject: entry.subject, cut: entry.cut };
      break;
    case "artifact-version":
    case "artifact-tombstone":
      body = {
        ...head,
        artifact: {
          canvasId: entry.artifact.canvasId,
          hostId: entry.artifact.hostId,
        },
        parents: entry.parents.map((parent) => ({ versionId: parent.versionId })),
        contentHash: entry.contentHash,
        bundle: decodeArtifactBundle(JSON.parse(encodeArtifactBundle(entry.bundle))),
      };
      break;
  }
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
    joinRequest: ReplicaJoinRequestEntry,
    confirmationCode: Schema.String.pipe(Schema.pattern(/^\d{6}$/)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("confirm-join"),
    /** The member whose approval of this computer's request the person confirmed. */
    approver: ReplicaInstanceId,
    confirmationCode: Schema.String.pipe(Schema.pattern(/^\d{6}$/)),
  }).annotations(strict),
  /**
   * What revoking a computer would keep: the cut the host would take after
   * reading the store, and the computers the revoked one brought in, so the
   * person can revoke them in the same step or move the cut earlier.
   */
  Schema.Struct({
    kind: Schema.Literal("revoke-preview"),
    subject: ReplicaInstanceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("revoke"),
    subject: ReplicaInstanceId,
    /**
     * The last of the subject's sequences that still counts. Without it the
     * host cuts at the highest sequence of the subject it holds after reading
     * the store; a value may only move the cut earlier than that.
     */
    cut: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
    /** Computers the subject brought in, revoked in the same step. */
    alsoRevoke: Schema.optional(Schema.Array(ReplicaInstanceId).pipe(Schema.maxItems(64))),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pull"),
  }).annotations(strict),
);
export type ReplicaMembershipCommand = typeof ReplicaMembershipCommand.Type;

/**
 * Why an entry read from the store does not count. `bad-signature`,
 * `path-mismatch`, and `unreadable` describe the file alone: a signature that
 * does not verify under the key the entry names, an id that is not that key's
 * id, a body whose origin is not the instance and sequence its path names, or
 * a file that does not decode as an entry this format defines. The rest are
 * the artifact reconcile policy's reasons.
 */
export const ReplicaReadRefusalReason = Schema.Literal(
  "unknown-instance",
  "revoked-instance",
  "sequence-gap",
  "names-local-artifact-as-foreign",
  "hash-mismatch",
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

/** A computer the revoked one brought in, directly or through others. */
export const ReplicaBroughtIn = Schema.Struct({
  instanceId: ReplicaInstanceId,
  displayName: ReplicaDisplayName,
  /** The computer that approved it. */
  parent: ReplicaInstanceId,
  /** The parent's sequence that approval sits at: a cut below it removes this computer. */
  approvalSequence: PositiveInt,
}).annotations(strict);
export type ReplicaBroughtIn = typeof ReplicaBroughtIn.Type;

export const ReplicaMembershipResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("replica-created"),
    instanceId: ReplicaInstanceId,
    entry: ReplicaFoundedEntry,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("join-requested"),
    instanceId: ReplicaInstanceId,
    entry: ReplicaJoinRequestEntry,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("join-approved"),
    subject: ReplicaInstanceId,
    entry: ReplicaJoinApprovedEntry,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("revoke-preview"),
    subject: ReplicaInstanceId,
    /** The cut a revoke without one would take now. */
    cut: Schema.Int.pipe(Schema.nonNegative()),
    broughtIn: Schema.Array(ReplicaBroughtIn),
    /** False when the store could not be read first, so the cut is what this computer already holds. */
    readStore: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("revoked"),
    subject: ReplicaInstanceId,
    entry: ReplicaRevocationEntry,
    alsoRevoked: Schema.Array(ReplicaRevocationEntry),
    /** False when the store could not be read first, so the cut is what this computer already holds. */
    readStore: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("join-confirmed"),
    approver: ReplicaInstanceId,
    founder: ReplicaInstanceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pulled"),
    /** Membership records this pull read and now holds. */
    applied: Schema.Int.pipe(Schema.nonNegative()),
    /** Files this pull read that are not valid records, and artifact entries that do not count. */
    refused: Schema.Array(ReplicaReadRefusal),
    /**
     * Artifact entries that are valid and count but were not imported:
     * importing an artifact version is not built yet, so a later pull reads
     * them again.
     */
    held: Schema.Array(
      Schema.Struct({ instanceId: ReplicaInstanceId, sequence: PositiveInt }).annotations(strict),
    ),
    /** Fresh join requests from computers that are not members yet. */
    joinRequests: Schema.Array(ReplicaJoinRequestEntry),
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
      "not-a-descendant",
      "invalid-cut",
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
