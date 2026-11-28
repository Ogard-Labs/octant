import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import {
  CANVAS_SHARE_MAX_IMAGES,
  CanvasShareImage,
  CanvasShareLocalUserActor,
  CanvasShareSchemaVersion,
  CanvasStaticExportDocument,
  isCanvasShareSafeText,
} from "./canvasShare";
import {
  CanvasShareDenialCode,
  CanvasShareSnapshotId,
  CanvasShareSnapshotSummary,
} from "./canvasShareSnapshot";
import { CanvasBlockId, CanvasDesignFrameId, CanvasId } from "./canvas";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { ProjectId } from "./projects";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedNonEmptyText = (maximum: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));

export const CanvasShareAccessEventId = brandedUuid("CanvasShareAccessEventId");
export type CanvasShareAccessEventId = typeof CanvasShareAccessEventId.Type;

/**
 * Most recent access events one owner-visible overview publishes for a Canvas.
 * A host journals an event for every evaluated read, so this is the only window
 * an overview ever carries and the window a rebuilt share projection retains.
 */
export const CANVAS_SHARE_MAX_ACCESS_LOG_EVENTS = 256;

/**
 * Share rows one owner-visible overview publishes for a Canvas. An owner keeps
 * every snapshot they ever minted, so a long-lived Canvas can hold more rows
 * than an overview may carry, and the server bounds them to this window rather
 * than failing to decode the overview at all.
 */
export const CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS = 256;

/**
 * Why one evaluated read ended the way it did. `denied-scope-mismatch` is its
 * own reason because the request named a Canvas, host, or Project the snapshot
 * was never shared from: the read never reached audience, expiry, or
 * revocation, and recording it as any of those would misstate the denial.
 * `denied-sharing-disabled` is its own reason for the same kind of truth: the
 * host itself refuses to share, so the read never reached the snapshot's scope
 * or lifecycle at all.
 */
export const CanvasShareAccessOutcome = Schema.Literals([
  "allowed",
  "denied-expired",
  "denied-revoked",
  "denied-audience",
  "denied-deleted-source",
  "denied-scope-mismatch",
  "denied-sharing-disabled",
]);
export type CanvasShareAccessOutcome = typeof CanvasShareAccessOutcome.Type;

/**
 * Access logs are privacy-preserving: no request bodies, credentials, raw UA
 * strings, or absolute paths. Browser compatibility is reduced to a coarse
 * family token.
 */
export const CanvasShareAccessLogEvent = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-share-access-log"),
  eventId: CanvasShareAccessEventId,
  snapshotId: CanvasShareSnapshotId,
  canvasId: CanvasId,
  hostId: HostId,
  projectId: ProjectId,
  occurredAt: UtcTimestamp,
  outcome: CanvasShareAccessOutcome,
  /** Coarse browser family only: chrome | safari | firefox | edge | other */
  browserFamily: Schema.Literals(["chrome", "safari", "firefox", "edge", "other"]),
  /** Optional redacted principal label already owner-visible on the snapshot. */
  audienceLabel: Schema.optional(
    boundedNonEmptyText(128).check(
      Schema.makeFilter((value) => isCanvasShareSafeText(value), {
        message: "Canvas share access-log audience labels must not contain secrets or host paths.",
      }),
    ),
  ),
  /**
   * Optional authenticated principal identity used for lifecycle validation when
   * privacy-preserving producers omit audienceLabel.
   */
  principalId: Schema.optional(GuidString),
});
export type CanvasShareAccessLogEvent = typeof CanvasShareAccessLogEvent.Type;

/**
 * Request to read a shared snapshot. The caller names the snapshot only: the
 * accessing principal is the host-authenticated identity, never a client claim,
 * so a request can never widen the audience it is evaluated against.
 */
export const CanvasShareAccessRequest = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-share-access"),
  snapshotId: CanvasShareSnapshotId,
  canvasId: CanvasId,
  hostId: HostId,
  projectId: ProjectId,
  /**
   * Asks for a page to run one of the snapshot's prototypes from. It is the
   * same read as opening the snapshot, decided and journaled the same way,
   * and names only a design the snapshot already holds.
   */
  runDesign: Schema.optional(
    Schema.Struct({
      blockId: CanvasBlockId,
      frameId: Schema.optional(CanvasDesignFrameId),
    }),
  ),
});
export type CanvasShareAccessRequest = typeof CanvasShareAccessRequest.Type;

/**
 * The result of an access attempt. Allowed and denied attempts both carry the
 * journaled access-log event, so the outcome the reader is shown is the same
 * outcome the owner later audits. `unavailable` is the only shape without an
 * event: there was no snapshot record to evaluate or log against.
 */
export const CanvasShareAccessResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("allowed"),
    document: CanvasStaticExportDocument,
    event: CanvasShareAccessLogEvent,
    /**
     * Present when the request asked to run a prototype and the host could
     * offer it: a path on the host holding a single-use ticket, loaded in a
     * frame sandboxed to scripts alone, as for a live Canvas.
     */
    designPage: Schema.optional(
      Schema.String.check(
        Schema.isPattern(/^\/api\/canvas\/design-page\?ticket=[A-Za-z0-9_-]{43}$/),
      ),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    outcome: CanvasShareAccessOutcome,
    event: CanvasShareAccessLogEvent,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    denialCode: CanvasShareDenialCode,
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
]);
export type CanvasShareAccessResult = typeof CanvasShareAccessResult.Type;

/**
 * Owner-visible view of everything shared from one Canvas: whether this host
 * shares at all, the local-user owner whose consent a share must carry, and the
 * current share rows with their honest access log. The renderer echoes `owner`,
 * `hostId`, and `projectId` back on a create; the server re-checks all three
 * against the Canvas's own provenance before any share exists.
 */
export const CanvasShareOverview = Schema.Struct({
  schemaVersion: CanvasShareSchemaVersion,
  kind: Schema.Literal("canvas-share-overview"),
  canvasId: CanvasId,
  hostId: HostId,
  projectId: ProjectId,
  /** False fails every share closed while local Canvas use stays available. */
  sharingEnabled: Schema.Boolean,
  owner: CanvasShareLocalUserActor,
  snapshots: Schema.Array(CanvasShareSnapshotSummary).check(
    Schema.isMaxLength(CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS),
  ),
  accessLog: Schema.Array(CanvasShareAccessLogEvent).check(
    Schema.isMaxLength(CANVAS_SHARE_MAX_ACCESS_LOG_EVENTS),
  ),
  /**
   * The images a snapshot of the current version would copy, each exactly as
   * it would leave, so the share panel shows the person what is shared
   * before they agree (maintainer decision, 2026-11-22).
   */
  images: Schema.optional(
    Schema.Array(CanvasShareImage).check(Schema.isMaxLength(CANVAS_SHARE_MAX_IMAGES)),
  ),
});
export type CanvasShareOverview = typeof CanvasShareOverview.Type;

/** Journal frame for one evaluated access attempt. */
export const CanvasShareAccessLogged = Schema.Struct({
  event: CanvasShareAccessLogEvent,
});
export type CanvasShareAccessLogged = typeof CanvasShareAccessLogged.Type;

export const decodeCanvasShareAccessLogEvent = Schema.decodeUnknownSync(
  CanvasShareAccessLogEvent,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareAccessRequest = Schema.decodeUnknownSync(
  CanvasShareAccessRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareAccessResult = Schema.decodeUnknownSync(
  CanvasShareAccessResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareOverview = Schema.decodeUnknownSync(
  CanvasShareOverview,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasShareAccessLogged = Schema.decodeUnknownSync(
  CanvasShareAccessLogged,
  STRICT_DECODE_OPTIONS,
);
