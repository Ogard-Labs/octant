import { Schema } from "effect";
import { CanvasId, CanvasVersionId } from "./canvas";
import { isCanvasShareSafeText } from "./canvasShare";
import { UtcTimestamp } from "./events";

// A destination plugin receives a rendered Canvas and returns a receipt or a
// typed refusal. The server renders, shows the payload and destination on an
// approval card, and calls the plugin only after approval. PDF and PNG are
// named so a later target can declare them; this host does not render them.
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedText = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));
const boundedToken = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(96),
    Schema.pattern(/^[a-z][a-z0-9-]*$/),
    Schema.brand(brand),
  );

export const CANVAS_EXPORT_SCHEMA_VERSION = 1 as const;
export const CanvasExportSchemaVersion = Schema.Literal(CANVAS_EXPORT_SCHEMA_VERSION);
export type CanvasExportSchemaVersion = typeof CanvasExportSchemaVersion.Type;

export const CANVAS_EXPORT_BODY_MAX_BYTES = 262_144;
export const CANVAS_EXPORT_LABEL_MAX_CHARS = 128;
export const CANVAS_EXPORT_MESSAGE_MAX_CHARS = 1_024;

/** A held approval is answered or forgotten. This is how long it waits. */
export const CANVAS_EXPORT_APPROVAL_TTL_MS = 10 * 60_000;

/**
 * Per-canvas bound on held approvals. The oldest is evicted as expired when a
 * prepare would exceed it, so a closed dialog cannot pin a payload forever.
 */
export const CANVAS_EXPORT_MAX_PENDING_PER_CANVAS = 8;

const bodyEncoder = new TextEncoder();

/** UTF-8 byte length of a rendered body; the budget is bytes, not code units. */
export function canvasExportBodyByteLength(body: string): number {
  return bodyEncoder.encode(body).length;
}

const exportBody = Schema.String.pipe(
  Schema.minLength(1),
  Schema.filter((value) => canvasExportBodyByteLength(value) <= CANVAS_EXPORT_BODY_MAX_BYTES, {
    message: () => "A Canvas export body must fit the UTF-8 byte budget.",
  }),
);

/** Formats a destination may declare. Only markdown and html are rendered. */
export const CanvasExportFormat = Schema.Literal("markdown", "html", "pdf", "png");
export type CanvasExportFormat = typeof CanvasExportFormat.Type;

export const CanvasExportImplementedFormat = Schema.Literal("markdown", "html");
export type CanvasExportImplementedFormat = typeof CanvasExportImplementedFormat.Type;

export const CANVAS_EXPORT_IMPLEMENTED_FORMATS = ["markdown", "html"] as const;

export function isCanvasExportImplementedFormat(
  format: string,
): format is CanvasExportImplementedFormat {
  return (CANVAS_EXPORT_IMPLEMENTED_FORMATS as ReadonlyArray<string>).includes(format);
}

export const CanvasExportTargetId = boundedToken("CanvasExportTargetId");
export type CanvasExportTargetId = typeof CanvasExportTargetId.Type;

export const CanvasExportRecordId = brandedUuid("CanvasExportRecordId");
export type CanvasExportRecordId = typeof CanvasExportRecordId.Type;

export const CanvasExportApprovalId = brandedUuid("CanvasExportApprovalId");
export type CanvasExportApprovalId = typeof CanvasExportApprovalId.Type;

export const CanvasExportPayloadDigest = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/),
  Schema.brand("CanvasExportPayloadDigest"),
);
export type CanvasExportPayloadDigest = typeof CanvasExportPayloadDigest.Type;

const safeBounded = (maximum: number) =>
  boundedText(maximum).pipe(
    Schema.filter((value) => isCanvasShareSafeText(value), {
      message: () => "Canvas export text must not contain a secret or a file path.",
    }),
  );

/** Text a destination or the host shows the person about one export. */
const CanvasExportMessage = safeBounded(CANVAS_EXPORT_MESSAGE_MAX_CHARS);

/** Whether `value` would decode as an export message: bounded and free of paths and secrets. */
export const isCanvasExportMessage = Schema.is(CanvasExportMessage);

const uniqueFormats = <T extends string>(formats: ReadonlyArray<T>): boolean =>
  new Set(formats).size === formats.length;

export const CanvasExportContribution = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export-contribution"),
  targetId: CanvasExportTargetId,
  label: safeBounded(CANVAS_EXPORT_LABEL_MAX_CHARS),
  formats: Schema.NonEmptyArray(CanvasExportFormat).pipe(
    Schema.maxItems(4),
    Schema.filter(uniqueFormats, {
      message: () => "Canvas export formats must be unique.",
    }),
  ),
}).annotations(strict);
export type CanvasExportContribution = typeof CanvasExportContribution.Type;

/** Honest status of a destination that passed activation. Disabled and uninstalled targets are omitted, not listed. */
export const CanvasExportTargetStatus = Schema.Literal("not-connected", "ready", "refused");
export type CanvasExportTargetStatus = typeof CanvasExportTargetStatus.Type;

export const CanvasExportTargetOffer = Schema.Struct({
  targetId: CanvasExportTargetId,
  label: safeBounded(CANVAS_EXPORT_LABEL_MAX_CHARS),
  formats: Schema.Array(CanvasExportImplementedFormat).pipe(
    Schema.maxItems(2),
    Schema.filter(uniqueFormats, {
      message: () => "Canvas export formats must be unique.",
    }),
  ),
  status: CanvasExportTargetStatus,
  message: Schema.optional(CanvasExportMessage),
})
  .annotations(strict)
  .pipe(
    Schema.filter((offer) => offer.status !== "ready" || offer.formats.length > 0, {
      message: () => "A ready export destination must accept a format this host can render.",
    }),
  );
export type CanvasExportTargetOffer = typeof CanvasExportTargetOffer.Type;

export const CanvasExportOfferList = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export-offers"),
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  targets: Schema.Array(CanvasExportTargetOffer).pipe(Schema.maxItems(32)),
}).annotations(strict);
export type CanvasExportOfferList = typeof CanvasExportOfferList.Type;

export const CanvasExportMetadata = Schema.Struct({
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  byteLength: Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(CANVAS_EXPORT_BODY_MAX_BYTES),
  ),
  contentDigest: CanvasExportPayloadDigest,
}).annotations(strict);
export type CanvasExportMetadata = typeof CanvasExportMetadata.Type;

export const CanvasExportRenderedOutput = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export-output"),
  format: CanvasExportImplementedFormat,
  title: safeBounded(256),
  body: exportBody,
  metadata: CanvasExportMetadata,
}).annotations(strict);
export type CanvasExportRenderedOutput = typeof CanvasExportRenderedOutput.Type;

const exportUrl = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.username === "" &&
          parsed.password === "" &&
          isCanvasShareSafeText(value)
        );
      } catch {
        return false;
      }
    },
    { message: () => "An export link must be a credential-free http(s) URL." },
  ),
);

export const CanvasExportReceipt = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("link"), href: exportUrl }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("path"),
    path: safeBounded(1_024),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remote-id"),
    remoteId: boundedText(128).pipe(
      Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
      Schema.filter((value) => isCanvasShareSafeText(value), {
        message: () => "An export remote id must not contain a secret.",
      }),
    ),
  }).annotations(strict),
);
export type CanvasExportReceipt = typeof CanvasExportReceipt.Type;

export const CanvasExportRefusalCode = Schema.Literal(
  "approval-required",
  "not-offered",
  "not-connected",
  "refused",
  "unsupported-format",
  "malformed",
  "too-large",
  "unauthorized",
  "unavailable",
  "expired",
);
export type CanvasExportRefusalCode = typeof CanvasExportRefusalCode.Type;

export const CanvasExportRefusal = Schema.Struct({
  kind: Schema.Literal("refused"),
  code: CanvasExportRefusalCode,
  message: CanvasExportMessage,
}).annotations(strict);
export type CanvasExportRefusal = typeof CanvasExportRefusal.Type;

export const CanvasExportDelivery = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("receipt"),
    receipt: CanvasExportReceipt,
  }).annotations(strict),
  CanvasExportRefusal,
);
export type CanvasExportDelivery = typeof CanvasExportDelivery.Type;

export const CanvasExportApprovalCard = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export-approval"),
  approvalId: CanvasExportApprovalId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  targetId: CanvasExportTargetId,
  destinationLabel: safeBounded(CANVAS_EXPORT_LABEL_MAX_CHARS),
  format: CanvasExportImplementedFormat,
  title: safeBounded(256),
  /** The rendered document the person is approving. Not a summary of it. */
  payload: exportBody,
  payloadDigest: CanvasExportPayloadDigest,
  byteLength: Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(CANVAS_EXPORT_BODY_MAX_BYTES),
  ),
  /** Past this instant the host drops the held approval; answering it expires. */
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type CanvasExportApprovalCard = typeof CanvasExportApprovalCard.Type;

export const CanvasExportPrepareRequest = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export-prepare"),
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  expectedSequence: Schema.Int.pipe(Schema.positive()),
  targetId: CanvasExportTargetId,
  format: CanvasExportFormat,
}).annotations(strict);
export type CanvasExportPrepareRequest = typeof CanvasExportPrepareRequest.Type;

export const CanvasExportPrepareResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("approval"),
    card: CanvasExportApprovalCard,
  }).annotations(strict),
  CanvasExportRefusal,
);
export type CanvasExportPrepareResult = typeof CanvasExportPrepareResult.Type;

export const CanvasExportDecision = Schema.Literal("approved", "denied");
export type CanvasExportDecision = typeof CanvasExportDecision.Type;

export const CanvasExportDecideRequest = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export-decision"),
  canvasId: CanvasId,
  approvalId: CanvasExportApprovalId,
  decision: CanvasExportDecision,
}).annotations(strict);
export type CanvasExportDecideRequest = typeof CanvasExportDecideRequest.Type;

/** The person declined. This is not a destination refusal and is not journaled. */
export const CanvasExportDenied = Schema.Struct({
  kind: Schema.Literal("denied"),
  message: CanvasExportMessage,
}).annotations(strict);
export type CanvasExportDenied = typeof CanvasExportDenied.Type;

export const CanvasExportRecorded = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export"),
  exportId: CanvasExportRecordId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  targetId: CanvasExportTargetId,
  destinationLabel: safeBounded(CANVAS_EXPORT_LABEL_MAX_CHARS),
  format: CanvasExportImplementedFormat,
  payloadDigest: CanvasExportPayloadDigest,
  approvalId: CanvasExportApprovalId,
  outcome: CanvasExportDelivery,
}).annotations(strict);
export type CanvasExportRecorded = typeof CanvasExportRecorded.Type;

/**
 * The destination was called but the journal could not take the record, so a
 * restart would not replay this export. The outcome is returned so the person
 * still sees what the destination did.
 */
export const CanvasExportUnrecorded = Schema.Struct({
  kind: Schema.Literal("unrecorded"),
  outcome: CanvasExportDelivery,
  message: CanvasExportMessage,
}).annotations(strict);
export type CanvasExportUnrecorded = typeof CanvasExportUnrecorded.Type;

export const CanvasExportDecideResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("exported"),
    record: CanvasExportRecorded,
  }).annotations(strict),
  CanvasExportUnrecorded,
  CanvasExportDenied,
  CanvasExportRefusal,
);
export type CanvasExportDecideResult = typeof CanvasExportDecideResult.Type;

export const decodeCanvasExportContribution = Schema.decodeUnknownSync(CanvasExportContribution);
export const decodeCanvasExportTargetOffer = Schema.decodeUnknownSync(CanvasExportTargetOffer);
export const decodeCanvasExportOfferList = Schema.decodeUnknownSync(CanvasExportOfferList);
export const decodeCanvasExportRenderedOutput = Schema.decodeUnknownSync(
  CanvasExportRenderedOutput,
);
export const decodeCanvasExportReceipt = Schema.decodeUnknownSync(CanvasExportReceipt);
export const decodeCanvasExportDelivery = Schema.decodeUnknownSync(CanvasExportDelivery);
export const decodeCanvasExportApprovalCard = Schema.decodeUnknownSync(CanvasExportApprovalCard);
export const decodeCanvasExportPrepareRequest = Schema.decodeUnknownSync(
  CanvasExportPrepareRequest,
);
export const decodeCanvasExportPrepareResult = Schema.decodeUnknownSync(CanvasExportPrepareResult);
export const decodeCanvasExportDecideRequest = Schema.decodeUnknownSync(CanvasExportDecideRequest);
export const decodeCanvasExportDecideResult = Schema.decodeUnknownSync(CanvasExportDecideResult);
export const decodeCanvasExportRecorded = Schema.decodeUnknownSync(CanvasExportRecorded);
export const decodeCanvasExportPayloadDigest = Schema.decodeUnknownSync(CanvasExportPayloadDigest);
