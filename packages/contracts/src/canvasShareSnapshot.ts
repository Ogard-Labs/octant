import { Schema } from "effect";
import { GuidString, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CanvasId, CanvasVersionId } from "./canvas";
import {
  CanvasExportId,
  CanvasRedactedProvenance,
  CanvasShareLocalUserActor,
  CanvasShareSchemaVersion,
  CanvasStaticExportDocument,
  CanvasStaticExportSourceEntry,
  isCanvasShareSafeText,
  CANVAS_SHARE_MAX_IMAGES,
} from "./canvasShare";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { ProjectId } from "./projects";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedNonEmptyText = (maximum: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));

export const CanvasShareSnapshotId = brandedUuid("CanvasShareSnapshotId");
export type CanvasShareSnapshotId = typeof CanvasShareSnapshotId.Type;

export const CanvasShareAudiencePrincipal = Schema.Struct({
  /** Owner-visible audience label only; never a credential or host path. */
  label: boundedNonEmptyText(128).check(
    Schema.makeFilter((value) => isCanvasShareSafeText(value), {
      message: "Canvas share audience labels must not contain secrets or host paths.",
    }),
  ),
  principalKind: Schema.Literals(["local-user", "paired-device"]),
  principalId: GuidString,
});
export type CanvasShareAudiencePrincipal = typeof CanvasShareAudiencePrincipal.Type;

export const CanvasShareAudience = Schema.Struct({
  ownerActorId: GuidString,
  principals: Schema.Array(CanvasShareAudiencePrincipal).check(Schema.isMaxLength(32)),
});
export type CanvasShareAudience = typeof CanvasShareAudience.Type;

export const CanvasShareRefreshPolicy = Schema.Literals(["manual-only", "owner-reissue"]);
export type CanvasShareRefreshPolicy = typeof CanvasShareRefreshPolicy.Type;

export const CanvasShareSnapshotRequest = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-share-snapshot"),
  snapshotId: CanvasShareSnapshotId,
  exportId: CanvasExportId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  expectedSequence: PositiveInt,
  hostId: HostId,
  projectId: ProjectId,
  audience: CanvasShareAudience,
  expiresAt: UtcTimestamp,
  refreshPolicy: CanvasShareRefreshPolicy,
  consent: Schema.Struct({
    acknowledgedAuthenticatedSnapshot: Schema.Literal(true),
    acknowledgedOwnerVisibleAudience: Schema.Literal(true),
    acknowledgedMarkupSharedAsWritten: Schema.optional(Schema.Literal(true)),
    /**
     * The SHA-256 of each image the person saw in the share panel and agreed
     * to copy (maintainer decision, 2026-11-22). A snapshot that would copy
     * any other image, or any image without it, is refused.
     */
    acknowledgedImages: Schema.optional(
      Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
        Schema.isMaxLength(CANVAS_SHARE_MAX_IMAGES),
      ),
    ),
    acknowledgedAt: UtcTimestamp,
    acknowledgedBy: CanvasShareLocalUserActor,
  }),
});
export type CanvasShareSnapshotRequest = typeof CanvasShareSnapshotRequest.Type;

export const CanvasShareSnapshotStatus = Schema.Literals(["active", "expired", "revoked"]);
export type CanvasShareSnapshotStatus = typeof CanvasShareSnapshotStatus.Type;

const CanvasShareSnapshotRecordFields = {
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-share-snapshot-record"),
  snapshotId: CanvasShareSnapshotId,
  exportId: CanvasExportId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: PositiveInt,
  hostId: HostId,
  projectId: ProjectId,
  audience: CanvasShareAudience,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  refreshPolicy: CanvasShareRefreshPolicy,
  document: CanvasStaticExportDocument,
  provenance: CanvasRedactedProvenance,
  sourceManifest: Schema.Array(CanvasStaticExportSourceEntry).check(Schema.isMaxLength(128)),
} as const;

function canvasShareSnapshotRecordIdentitiesMatch(record: {
  readonly exportId: string;
  readonly canvasId: string;
  readonly versionId: string;
  readonly sequence: number;
  readonly hostId: string;
  readonly projectId: string;
  readonly audience: {
    readonly ownerActorId: string;
  };
  readonly consent: {
    readonly acknowledgedBy: {
      readonly actorId: string;
    };
  };
  readonly document: {
    readonly exportId: string;
    readonly canvasId: string;
    readonly versionId: string;
    readonly sequence: number;
    readonly channel: string;
    readonly threatModelId: string;
    readonly provenance: {
      readonly hostId: string;
      readonly projectId: string;
    };
    readonly sourceManifest: ReadonlyArray<unknown>;
  };
  readonly provenance: {
    readonly hostId: string;
    readonly projectId: string;
  };
  readonly sourceManifest: ReadonlyArray<unknown>;
}): boolean {
  if (String(record.exportId) !== String(record.document.exportId)) return false;
  if (String(record.canvasId) !== String(record.document.canvasId)) return false;
  if (String(record.versionId) !== String(record.document.versionId)) return false;
  if (record.sequence !== record.document.sequence) return false;
  if (record.hostId !== record.document.provenance.hostId) return false;
  if (String(record.projectId) !== String(record.document.provenance.projectId)) return false;
  if (record.hostId !== record.provenance.hostId) return false;
  if (String(record.projectId) !== String(record.provenance.projectId)) return false;
  if (record.document.provenance.hostId !== record.provenance.hostId) return false;
  if (String(record.document.provenance.projectId) !== String(record.provenance.projectId)) {
    return false;
  }
  // Provenance and source manifest must be the authoritative document copies.
  if (JSON.stringify(record.provenance) !== JSON.stringify(record.document.provenance)) {
    return false;
  }
  if (JSON.stringify(record.sourceManifest) !== JSON.stringify(record.document.sourceManifest)) {
    return false;
  }
  if (String(record.consent.acknowledgedBy.actorId) !== String(record.audience.ownerActorId)) {
    return false;
  }
  // Authenticated snapshot documents must not claim the static-export channel/threat model.
  if (
    record.document.channel !== "authenticated-snapshot" ||
    record.document.threatModelId !== "canvas-share-authenticated-snapshot-v1"
  ) {
    return false;
  }
  return true;
}

const CanvasShareSnapshotRecordBase = Schema.Union([
  Schema.Struct({
    ...CanvasShareSnapshotRecordFields,
    status: Schema.Literals(["active", "expired"]),
    /** Validated dual-consent evidence retained with the authenticated snapshot. */
    consent: Schema.Struct({
      acknowledgedAuthenticatedSnapshot: Schema.Literal(true),
      acknowledgedOwnerVisibleAudience: Schema.Literal(true),
      acknowledgedMarkupSharedAsWritten: Schema.optional(Schema.Literal(true)),
      /**
       * The SHA-256 of each image the person saw in the share panel and agreed
       * to copy (maintainer decision, 2026-11-22). A snapshot that would copy
       * any other image, or any image without it, is refused.
       */
      acknowledgedImages: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
          Schema.isMaxLength(CANVAS_SHARE_MAX_IMAGES),
        ),
      ),
      acknowledgedAt: UtcTimestamp,
      acknowledgedBy: CanvasShareLocalUserActor,
    }),
  }),
  Schema.Struct({
    ...CanvasShareSnapshotRecordFields,
    status: Schema.Literal("revoked"),
    revokedAt: UtcTimestamp,
    /** Validated dual-consent evidence retained with the authenticated snapshot. */
    consent: Schema.Struct({
      acknowledgedAuthenticatedSnapshot: Schema.Literal(true),
      acknowledgedOwnerVisibleAudience: Schema.Literal(true),
      acknowledgedMarkupSharedAsWritten: Schema.optional(Schema.Literal(true)),
      /**
       * The SHA-256 of each image the person saw in the share panel and agreed
       * to copy (maintainer decision, 2026-11-22). A snapshot that would copy
       * any other image, or any image without it, is refused.
       */
      acknowledgedImages: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
          Schema.isMaxLength(CANVAS_SHARE_MAX_IMAGES),
        ),
      ),
      acknowledgedAt: UtcTimestamp,
      acknowledgedBy: CanvasShareLocalUserActor,
    }),
  }),
]);

export const CanvasShareSnapshotRecord = CanvasShareSnapshotRecordBase.check(
  Schema.makeFilter((record) => canvasShareSnapshotRecordIdentitiesMatch(record), {
    message:
      "Canvas share snapshot record document, provenance, and source manifest must match the authoritative outer identity.",
  }),
  Schema.makeFilter(
    (record) => {
      if (record.status !== "revoked") return true;
      const revokedAt = Date.parse(String(record.revokedAt));
      const createdAt = Date.parse(String(record.createdAt));
      return Number.isFinite(revokedAt) && Number.isFinite(createdAt) && revokedAt >= createdAt;
    },
    { message: "Canvas share snapshot revokedAt cannot predate createdAt." },
  ),
);
export type CanvasShareSnapshotRecord = typeof CanvasShareSnapshotRecord.Type;

export const CanvasShareSnapshotRevokeRequest = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-share-snapshot-revoke"),
  snapshotId: CanvasShareSnapshotId,
  canvasId: CanvasId,
  hostId: HostId,
  projectId: ProjectId,
  actor: CanvasShareLocalUserActor,
  revokedAt: UtcTimestamp,
});
export type CanvasShareSnapshotRevokeRequest = typeof CanvasShareSnapshotRevokeRequest.Type;

/**
 * Every denial a share surface may report. The union is the policy denial codes
 * for the static-export sanitizer and the authenticated snapshot lifecycle, plus
 * `unavailable` for a Canvas or snapshot the host cannot resolve at all.
 */
export const CanvasShareDenialCode = Schema.Literals([
  "malformed-request",
  "sharing-disabled",
  "consent-required",
  "scope-mismatch",
  "stale-version",
  "unsafe-payload",
  "unsupported-channel",
  "expired",
  "revoked",
  "audience-required",
  "unauthorized",
  "public-audience-forbidden",
  "unavailable",
]);
export type CanvasShareDenialCode = typeof CanvasShareDenialCode.Type;

/**
 * Owner-visible share row: identity, audience, and lifecycle only. The snapshot
 * document itself is never listed, so seeing what is shared never re-serves the
 * shared payload. `status` is the effective lifecycle at read time, so a share
 * past `expiresAt` reads as `expired` before any record is rewritten.
 */
export const CanvasShareSnapshotSummary = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-share-snapshot-summary"),
  snapshotId: CanvasShareSnapshotId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: PositiveInt,
  hostId: HostId,
  projectId: ProjectId,
  audience: CanvasShareAudience,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  refreshPolicy: CanvasShareRefreshPolicy,
  status: CanvasShareSnapshotStatus,
  revokedAt: Schema.optional(UtcTimestamp),
}).check(
  Schema.makeFilter((summary) => summary.status === "revoked" || summary.revokedAt === undefined, {
    message: "Canvas share summaries may only carry revokedAt when they are revoked.",
  }),
);
export type CanvasShareSnapshotSummary = typeof CanvasShareSnapshotSummary.Type;

/** Result of an owner-authenticated share create or revoke. */
export const CanvasShareResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    snapshot: CanvasShareSnapshotSummary,
  }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasShareDenialCode,
    message: boundedNonEmptyText(512),
  }),
]);
export type CanvasShareResult = typeof CanvasShareResult.Type;

/** Journal frame for an admitted authenticated snapshot. */
export const CanvasShareSnapshotCreated = Schema.Struct({
  record: CanvasShareSnapshotRecord,
});
export type CanvasShareSnapshotCreated = typeof CanvasShareSnapshotCreated.Type;

/**
 * Journal frame for an owner revocation. The revoked frame carries lifecycle
 * identity only; replay applies it to the created record, so the shared document
 * is never journaled twice.
 */
export const CanvasShareSnapshotRevoked = Schema.Struct({
  snapshotId: CanvasShareSnapshotId,
  canvasId: CanvasId,
  hostId: HostId,
  projectId: ProjectId,
  revokedAt: UtcTimestamp,
  actor: CanvasShareLocalUserActor,
});
export type CanvasShareSnapshotRevoked = typeof CanvasShareSnapshotRevoked.Type;

export const decodeCanvasShareSnapshotRequest = Schema.decodeUnknownSync(
  CanvasShareSnapshotRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareSnapshotRecord = Schema.decodeUnknownSync(
  CanvasShareSnapshotRecord,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareSnapshotRevokeRequest = Schema.decodeUnknownSync(
  CanvasShareSnapshotRevokeRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareSnapshotSummary = Schema.decodeUnknownSync(
  CanvasShareSnapshotSummary,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareResult = Schema.decodeUnknownSync(
  CanvasShareResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareSnapshotCreated = Schema.decodeUnknownSync(
  CanvasShareSnapshotCreated,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareSnapshotRevoked = Schema.decodeUnknownSync(
  CanvasShareSnapshotRevoked,
  STRICT_DECODE_OPTIONS,
);
