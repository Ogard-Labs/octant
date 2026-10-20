import { Schema } from "effect";
import { CanvasId, CanvasVersionId } from "./canvas";
import {
  CANVAS_EXPORT_BODY_MAX_BYTES,
  CanvasExportLinkExpiry,
  CanvasExportLinkPassword,
} from "./canvasExport";
import {
  CANVAS_SHARE_SCHEMA_VERSION,
  CanvasStaticExportBlock,
  isCanvasShareSafeText,
} from "./canvasShare";
import { AggregateVersion, UtcTimestamp } from "./events";

// A public link is a Canvas published to the public Canvas share service. The
// host sends the share filter's blocks with no host, Project, thread, or source
// identity; the service stores them, can read them, and draws them for anyone
// holding the link. These are the wire shapes between the host and the
// service, and the host's own record of each link. Rules live in
// docs/design/canvas-public-links.md.

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** Version of the host-to-service wire. The service refuses any other. */
export const CANVAS_PUBLIC_SHARE_WIRE_VERSION = 1 as const;
export const CanvasPublicShareWireVersion = Schema.Literal(CANVAS_PUBLIC_SHARE_WIRE_VERSION);

/** The payload budget: the export body budget, measured over the JSON the host sends. */
export const CANVAS_PUBLIC_SHARE_MAX_DOCUMENT_BYTES = CANVAS_EXPORT_BODY_MAX_BYTES;
export const CANVAS_PUBLIC_SHARE_SUMMARY_MAX_CHARS = 200;
export const CANVAS_PUBLIC_SHARE_REPORT_DETAIL_MAX_CHARS = 1_000;
/** Default service a person can replace with their own in Settings. */
export const CANVAS_PUBLIC_SHARE_DEFAULT_SERVICE_URL = "https://canvas.octant.sh";
/** Revoked and expired links answer 410 for this long, then 404. */
export const CANVAS_PUBLIC_SHARE_TOMBSTONE_DAYS = 90;

/** 16 random bytes as URL-safe base64: 128 bits, 22 characters. */
export const CanvasPublicShareId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{22}$/),
  Schema.brand("CanvasPublicShareId"),
);
export type CanvasPublicShareId = typeof CanvasPublicShareId.Type;

/** 32 random bytes as URL-safe base64, held by the host and hashed by the service. */
export const CanvasPublicShareOwnerSecret = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{43}$/),
  Schema.brand("CanvasPublicShareOwnerSecret"),
);
export type CanvasPublicShareOwnerSecret = typeof CanvasPublicShareOwnerSecret.Type;

const safeText = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(maximum),
    Schema.filter((value) => isCanvasShareSafeText(value), {
      message: () => "Public share text must not contain a secret or a file path.",
    }),
  );

/**
 * A service or link address: https, or http only on a loopback host so a
 * self-hosted service can be tried on one computer. No credentials, no
 * fragment.
 */
export const CanvasPublicShareServiceUrl = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter(
    (value) => {
      try {
        const parsed = new URL(value);
        if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return false;
        if (parsed.protocol === "https:") return true;
        return (
          parsed.protocol === "http:" &&
          (parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "localhost" ||
            parsed.hostname === "[::1]")
        );
      } catch {
        return false;
      }
    },
    {
      message: () =>
        "A public share service address is https, or http on this computer's loopback address.",
    },
  ),
);
export type CanvasPublicShareServiceUrl = typeof CanvasPublicShareServiceUrl.Type;

/**
 * What leaves the host: the shared blocks and what a page and a link preview
 * need, and nothing that names the host, its Project, the thread, the Canvas,
 * or a source. The blocks are the share filter's union, so an action block or
 * a future kind fails here as it does in a snapshot.
 */
export const CanvasPublicShareDocument = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-document"),
  /** The share schema the blocks are written in. */
  shareSchemaVersion: Schema.Literal(CANVAS_SHARE_SCHEMA_VERSION),
  title: safeText(256),
  /** The first reading text, shortened, for link previews. */
  summary: Schema.optional(safeText(CANVAS_PUBLIC_SHARE_SUMMARY_MAX_CHARS)),
  publishedAt: UtcTimestamp,
  blocks: Schema.Array(CanvasStaticExportBlock).pipe(Schema.maxItems(128)),
}).annotations(strict);
export type CanvasPublicShareDocument = typeof CanvasPublicShareDocument.Type;

/** `POST /api/v1/shares` */
export const CanvasPublicShareCreateRequest = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-create"),
  document: CanvasPublicShareDocument,
  expiry: CanvasExportLinkExpiry,
  password: Schema.optional(CanvasExportLinkPassword),
}).annotations(strict);
export type CanvasPublicShareCreateRequest = typeof CanvasPublicShareCreateRequest.Type;

const expiresAt = Schema.NullOr(UtcTimestamp);

export const CanvasPublicShareCreated = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-created"),
  shareId: CanvasPublicShareId,
  url: CanvasPublicShareServiceUrl,
  ownerSecret: CanvasPublicShareOwnerSecret,
  expiresAt,
}).annotations(strict);
export type CanvasPublicShareCreated = typeof CanvasPublicShareCreated.Type;

/**
 * `PUT /api/v1/shares/<id>` with the owner secret. An absent password keeps
 * the link's existing one; an update never removes a password.
 */
export const CanvasPublicShareUpdateRequest = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-update"),
  document: CanvasPublicShareDocument,
  expiry: CanvasExportLinkExpiry,
  password: Schema.optional(CanvasExportLinkPassword),
}).annotations(strict);
export type CanvasPublicShareUpdateRequest = typeof CanvasPublicShareUpdateRequest.Type;

export const CanvasPublicShareUpdated = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-updated"),
  shareId: CanvasPublicShareId,
  url: CanvasPublicShareServiceUrl,
  expiresAt,
  updatedAt: UtcTimestamp,
  passwordProtected: Schema.Boolean,
}).annotations(strict);
export type CanvasPublicShareUpdated = typeof CanvasPublicShareUpdated.Type;

/** `DELETE /api/v1/shares/<id>` with the owner secret. */
export const CanvasPublicShareRevoked = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-revoked"),
  shareId: CanvasPublicShareId,
}).annotations(strict);
export type CanvasPublicShareRevoked = typeof CanvasPublicShareRevoked.Type;

/** `GET /api/v1/shares/<id>` with the owner secret. */
export const CanvasPublicShareStatus = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-status"),
  shareId: CanvasPublicShareId,
  url: CanvasPublicShareServiceUrl,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  expiresAt,
  passwordProtected: Schema.Boolean,
  byteLength: Schema.Int.pipe(Schema.nonNegative()),
  /** An aggregate count; the service keeps nothing about who viewed. */
  viewCount: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type CanvasPublicShareStatus = typeof CanvasPublicShareStatus.Type;

export const CanvasPublicShareReportReason = Schema.Literal(
  "spam",
  "phishing",
  "malware",
  "illegal",
  "harassment",
  "privacy",
  "other",
);
export type CanvasPublicShareReportReason = typeof CanvasPublicShareReportReason.Type;

/** `POST /api/v1/shares/<id>/reports`. Stored without the reporter's address. */
export const CanvasPublicShareReport = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-report"),
  reason: CanvasPublicShareReportReason,
  detail: Schema.optional(
    Schema.String.pipe(Schema.maxLength(CANVAS_PUBLIC_SHARE_REPORT_DETAIL_MAX_CHARS)),
  ),
}).annotations(strict);
export type CanvasPublicShareReport = typeof CanvasPublicShareReport.Type;

export const CanvasPublicShareRefusalCode = Schema.Literal(
  "malformed",
  "too-large",
  "unauthorized",
  "not-found",
  "gone",
  "rate-limited",
  "unavailable",
);
export type CanvasPublicShareRefusalCode = typeof CanvasPublicShareRefusalCode.Type;

export const CanvasPublicShareRefusal = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-refused"),
  code: CanvasPublicShareRefusalCode,
  message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
}).annotations(strict);
export type CanvasPublicShareRefusal = typeof CanvasPublicShareRefusal.Type;

// ---------------------------------------------------------------------------
// The host's side: Settings, the record of each link, and its routes.
// ---------------------------------------------------------------------------

/** Settings › Data & privacy › Public links. Off until the person turns it on. */
export const CanvasPublicLinkSettings = Schema.Struct({
  kind: Schema.Literal("canvas-public-link-settings"),
  enabled: Schema.Boolean,
  serviceUrl: CanvasPublicShareServiceUrl,
  version: AggregateVersion,
  updatedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type CanvasPublicLinkSettings = typeof CanvasPublicLinkSettings.Type;

/** A person changed the switch or the service address, from the version they read. */
export const CanvasPublicLinkSettingsCommand = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("set-canvas-public-link-settings"),
  enabled: Schema.Boolean,
  serviceUrl: CanvasPublicShareServiceUrl,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type CanvasPublicLinkSettingsCommand = typeof CanvasPublicLinkSettingsCommand.Type;

export const CanvasPublicLinkSettingsResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("canvas-public-link-settings"),
    settings: CanvasPublicLinkSettings,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("canvas-public-link-settings-refused"),
    reason: Schema.Literal("malformed", "stale-version", "unauthorized", "unavailable"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type CanvasPublicLinkSettingsResult = typeof CanvasPublicLinkSettingsResult.Type;

export const CanvasPublicShareRecordStatus = Schema.Literal(
  "active",
  "expired",
  "revoking",
  "revoked",
);
export type CanvasPublicShareRecordStatus = typeof CanvasPublicShareRecordStatus.Type;

/**
 * The host's record of one link. The owner secret is not here: it lives in
 * the credential broker under `credentialRef` and never reaches a window.
 */
export const CanvasPublicShareRecord = Schema.Struct({
  publicShareId: CanvasPublicShareId,
  canvasId: CanvasId,
  url: CanvasPublicShareServiceUrl,
  serviceUrl: CanvasPublicShareServiceUrl,
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  publishedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  expiresAt,
  passwordProtected: Schema.Boolean,
  status: CanvasPublicShareRecordStatus,
  revokedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type CanvasPublicShareRecord = typeof CanvasPublicShareRecord.Type;

/** What a window is shown for one Canvas. */
export const CanvasPublicShareList = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-list"),
  canvasId: CanvasId,
  enabled: Schema.Boolean,
  serviceUrl: CanvasPublicShareServiceUrl,
  shares: Schema.Array(CanvasPublicShareRecord).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type CanvasPublicShareList = typeof CanvasPublicShareList.Type;

export const CanvasPublicShareRevokeRequest = Schema.Struct({
  schemaVersion: CanvasPublicShareWireVersion,
  kind: Schema.Literal("canvas-public-share-revoke"),
  canvasId: CanvasId,
  publicShareId: CanvasPublicShareId,
}).annotations(strict);
export type CanvasPublicShareRevokeRequest = typeof CanvasPublicShareRevokeRequest.Type;

export const CanvasPublicShareRevokeResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("revoked"),
    share: CanvasPublicShareRecord,
  }).annotations(strict),
  /** The service could not be reached; the host keeps trying. */
  Schema.Struct({
    kind: Schema.Literal("revoking"),
    share: CanvasPublicShareRecord,
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    code: Schema.Literal("unauthorized", "not-found", "malformed"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
);
export type CanvasPublicShareRevokeResult = typeof CanvasPublicShareRevokeResult.Type;

// Journal payloads. A record event names its Canvas, so purging the Canvas
// erases it; a pending revocation names only the link, so it outlives the
// Canvas until the service confirms the link is gone.

export const CANVAS_PUBLIC_SHARE_AGGREGATE_TYPE = "canvas-public-share";
export const CANVAS_PUBLIC_SHARE_PUBLISHED = "canvas.public-share-published@1";
export const CANVAS_PUBLIC_SHARE_UPDATED = "canvas.public-share-updated@1";
export const CANVAS_PUBLIC_SHARE_REVOKED = "canvas.public-share-revoked@1";
export const CANVAS_PUBLIC_SHARE_REVOCATION_AGGREGATE_TYPE = "canvas-public-share-revocation";
export const CANVAS_PUBLIC_SHARE_REVOCATION_PENDING = "canvas.public-share-revocation-pending@1";
export const CANVAS_PUBLIC_SHARE_REVOCATION_SETTLED = "canvas.public-share-revocation-settled@1";
export const CANVAS_PUBLIC_LINK_SETTINGS_AGGREGATE_TYPE = "canvas-public-link-settings";
export const CANVAS_PUBLIC_LINK_SETTINGS_CHANGED = "canvas.public-link-settings-changed@1";

/** A lowercase UUID naming the owner secret in the credential broker. */
export const CanvasPublicShareCredentialRef = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);

export const CanvasPublicSharePublished = Schema.Struct({
  record: CanvasPublicShareRecord,
  credentialRef: CanvasPublicShareCredentialRef,
}).annotations(strict);
export type CanvasPublicSharePublished = typeof CanvasPublicSharePublished.Type;

export const CanvasPublicShareRecordUpdated = Schema.Struct({
  record: CanvasPublicShareRecord,
}).annotations(strict);
export type CanvasPublicShareRecordUpdated = typeof CanvasPublicShareRecordUpdated.Type;

export const CanvasPublicShareRecordRevoked = Schema.Struct({
  publicShareId: CanvasPublicShareId,
  canvasId: CanvasId,
  revokedAt: UtcTimestamp,
}).annotations(strict);
export type CanvasPublicShareRecordRevoked = typeof CanvasPublicShareRecordRevoked.Type;

export const CanvasPublicShareRevocationPending = Schema.Struct({
  publicShareId: CanvasPublicShareId,
  serviceUrl: CanvasPublicShareServiceUrl,
  credentialRef: CanvasPublicShareCredentialRef,
}).annotations(strict);
export type CanvasPublicShareRevocationPending = typeof CanvasPublicShareRevocationPending.Type;

export const CanvasPublicShareRevocationSettled = Schema.Struct({
  publicShareId: CanvasPublicShareId,
}).annotations(strict);
export type CanvasPublicShareRevocationSettled = typeof CanvasPublicShareRevocationSettled.Type;

export const CanvasPublicLinkSettingsChanged = Schema.Struct({
  enabled: Schema.Boolean,
  serviceUrl: CanvasPublicShareServiceUrl,
}).annotations(strict);
export type CanvasPublicLinkSettingsChanged = typeof CanvasPublicLinkSettingsChanged.Type;

export const decodeCanvasPublicShareDocument = Schema.decodeUnknownSync(CanvasPublicShareDocument);
export const decodeCanvasPublicShareCreateRequest = Schema.decodeUnknownSync(
  CanvasPublicShareCreateRequest,
);
export const decodeCanvasPublicShareCreated = Schema.decodeUnknownSync(CanvasPublicShareCreated);
export const decodeCanvasPublicShareUpdateRequest = Schema.decodeUnknownSync(
  CanvasPublicShareUpdateRequest,
);
export const decodeCanvasPublicShareUpdated = Schema.decodeUnknownSync(CanvasPublicShareUpdated);
export const decodeCanvasPublicShareRevoked = Schema.decodeUnknownSync(CanvasPublicShareRevoked);
export const decodeCanvasPublicShareStatus = Schema.decodeUnknownSync(CanvasPublicShareStatus);
export const decodeCanvasPublicShareReport = Schema.decodeUnknownSync(CanvasPublicShareReport);
export const decodeCanvasPublicShareRefusal = Schema.decodeUnknownSync(CanvasPublicShareRefusal);
export const decodeCanvasPublicShareId = Schema.decodeUnknownSync(CanvasPublicShareId);
export const decodeCanvasPublicShareOwnerSecret = Schema.decodeUnknownSync(
  CanvasPublicShareOwnerSecret,
);
export const decodeCanvasPublicShareServiceUrl = Schema.decodeUnknownSync(
  CanvasPublicShareServiceUrl,
);
export const decodeCanvasPublicLinkSettings = Schema.decodeUnknownSync(CanvasPublicLinkSettings);
export const decodeCanvasPublicLinkSettingsCommand = Schema.decodeUnknownSync(
  CanvasPublicLinkSettingsCommand,
);
export const decodeCanvasPublicLinkSettingsResult = Schema.decodeUnknownSync(
  CanvasPublicLinkSettingsResult,
);
export const decodeCanvasPublicShareRecord = Schema.decodeUnknownSync(CanvasPublicShareRecord);
export const decodeCanvasPublicShareList = Schema.decodeUnknownSync(CanvasPublicShareList);
export const decodeCanvasPublicShareRevokeRequest = Schema.decodeUnknownSync(
  CanvasPublicShareRevokeRequest,
);
export const decodeCanvasPublicShareRevokeResult = Schema.decodeUnknownSync(
  CanvasPublicShareRevokeResult,
);
