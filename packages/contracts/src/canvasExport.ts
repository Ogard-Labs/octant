import { personDecides } from "./hostAnswer";
import { Schema } from "effect";
import { CanvasId, CanvasVersionId } from "./canvas";
import { isCanvasShareSafeText, isExportCredentialFreeText } from "./canvasShare";
import { UtcTimestamp } from "./events";

// A destination plugin receives a rendered Canvas and returns a receipt or a
// typed refusal. The server renders, shows the payload and destination on an
// approval card, and calls the plugin only after approval. Markdown and HTML
// are text; PNG and PDF are pictures the host draws in its own browser, and a
// destination that declares them receives files rather than a body.
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

/** Formats a destination may declare. Every one is rendered by this host. */
export const CanvasExportFormat = Schema.Literal("markdown", "html", "pdf", "png");
export type CanvasExportFormat = typeof CanvasExportFormat.Type;

/** The forms rendered as one text body. */
export const CanvasExportTextFormat = Schema.Literal("markdown", "html");
export type CanvasExportTextFormat = typeof CanvasExportTextFormat.Type;

/**
 * The forms drawn as pictures: a PNG per design frame (or one of the whole
 * document), or one PDF of a page per frame (or the document paginated).
 */
export const CanvasExportPictureFormat = Schema.Literal("png", "pdf");
export type CanvasExportPictureFormat = typeof CanvasExportPictureFormat.Type;

export const CanvasExportImplementedFormat = Schema.Literal("markdown", "html", "png", "pdf");
export type CanvasExportImplementedFormat = typeof CanvasExportImplementedFormat.Type;

export const CANVAS_EXPORT_IMPLEMENTED_FORMATS = ["markdown", "html", "png", "pdf"] as const;

export function isCanvasExportImplementedFormat(
  format: string,
): format is CanvasExportImplementedFormat {
  return (CANVAS_EXPORT_IMPLEMENTED_FORMATS as ReadonlyArray<string>).includes(format);
}

export function isCanvasExportPictureFormat(format: string): format is CanvasExportPictureFormat {
  return format === "png" || format === "pdf";
}

/**
 * How much a picture export may weigh in all, and how many files it may be.
 * A pending approval holds the bytes until it is answered or expires, so the
 * bound is what a handful of held decks may pin in memory, not disk.
 */
export const CANVAS_EXPORT_PICTURES_MAX_BYTES = 32 * 1024 * 1024;
export const CANVAS_EXPORT_PICTURE_FILES_MAX = 96;

/**
 * The name of one file a picture export writes: a bare name with no separator
 * and no leading dot, scanned for credential-shaped text like every other
 * exported string, because it is shown on the card and written to disk.
 */
export const CanvasExportFileName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(160),
  Schema.pattern(/^[^./\\\0][^/\\\0]*$/),
  Schema.filter((value) => isExportCredentialFreeText(value), {
    message: () => "An export file name must not contain a secret.",
  }),
);
export type CanvasExportFileName = typeof CanvasExportFileName.Type;

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

/**
 * Who can see a remote export, when the destination keeps one.
 *
 * `secret` keeps the result unlisted — it appears on no profile or search, but
 * anyone holding its link can open it; `public` is listed and visible to
 * anyone, which is a thing to say plainly before it happens. A destination with
 * no audience — a file on this Mac — declares neither.
 */
export const CanvasExportVisibility = Schema.Literal("secret", "public");
export type CanvasExportVisibility = typeof CanvasExportVisibility.Type;

export const CanvasExportTargetOffer = Schema.Struct({
  targetId: CanvasExportTargetId,
  label: safeBounded(CANVAS_EXPORT_LABEL_MAX_CHARS),
  formats: Schema.Array(CanvasExportImplementedFormat).pipe(
    Schema.maxItems(4),
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

export const CanvasExportRenderedText = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export-output"),
  format: CanvasExportTextFormat,
  title: safeBounded(256),
  body: exportBody,
  metadata: CanvasExportMetadata,
}).annotations(strict);
export type CanvasExportRenderedText = typeof CanvasExportRenderedText.Type;

/** One file of a picture export, with the bytes the destination writes. */
export const CanvasExportRenderedFile = Schema.Struct({
  name: CanvasExportFileName,
  bytes: Schema.Uint8ArrayFromSelf.pipe(
    Schema.filter((bytes) => bytes.length > 0, {
      message: () => "An export file must hold at least one byte.",
    }),
  ),
}).annotations(strict);
export type CanvasExportRenderedFile = typeof CanvasExportRenderedFile.Type;

export const CanvasExportPictureMetadata = Schema.Struct({
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  byteLength: Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(CANVAS_EXPORT_PICTURES_MAX_BYTES),
  ),
  contentDigest: CanvasExportPayloadDigest,
}).annotations(strict);
export type CanvasExportPictureMetadata = typeof CanvasExportPictureMetadata.Type;

/**
 * A picture export: the files the host drew, in the order they are written.
 * It never crosses the wire — the card carries names and sizes — so the bytes
 * travel as they are, from the host's browser to the destination.
 */
export const CanvasExportRenderedPictures = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export-output"),
  format: CanvasExportPictureFormat,
  title: safeBounded(256),
  files: Schema.NonEmptyArray(CanvasExportRenderedFile).pipe(
    Schema.maxItems(CANVAS_EXPORT_PICTURE_FILES_MAX),
    Schema.filter((files) => new Set(files.map((file) => file.name)).size === files.length, {
      message: () => "Export file names must be unique.",
    }),
  ),
  metadata: CanvasExportPictureMetadata,
}).annotations(strict);
export type CanvasExportRenderedPictures = typeof CanvasExportRenderedPictures.Type;

/**
 * What a destination receives. A target only ever sees a format it declared,
 * so one that declared text alone never has to handle files; it still narrows
 * on `format` to read the body, which is what keeps that true in the types.
 */
export const CanvasExportRenderedOutput = Schema.Union(
  CanvasExportRenderedText,
  CanvasExportRenderedPictures,
);
export type CanvasExportRenderedOutput = typeof CanvasExportRenderedOutput.Type;

/** One file as the approval card names it: its name and weight, never its bytes. */
export const CanvasExportApprovalFile = Schema.Struct({
  name: CanvasExportFileName,
  byteLength: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type CanvasExportApprovalFile = typeof CanvasExportApprovalFile.Type;

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

/**
 * A file on this machine, named the way the person will open it.
 *
 * This is the one exported string allowed to be an absolute path. A local
 * destination exists to write a readable file and report where it put it, and
 * the approval card names that file before it is written, so the path is the
 * payload the person is approving. It is still bounded, free of NUL, and
 * scanned for credential-shaped text like every other exported string — the
 * share filter's path rule protects a snapshot leaving the host, and none of
 * this leaves the host.
 */
export const CanvasExportFilePath = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(4_096),
  Schema.filter((value) => value.startsWith("/") && !value.includes("\0"), {
    message: () => "An export file path must be an absolute path with no NUL.",
  }),
  Schema.filter((value) => isExportCredentialFreeText(value), {
    message: () => "An export file path must not contain a secret.",
  }),
);
export type CanvasExportFilePath = typeof CanvasExportFilePath.Type;

/**
 * A stable id a remote destination assigned to what it created. Bounded and
 * scanned like every exported string, because it is echoed back to the person.
 */
const exportRemoteId = boundedText(128).pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  Schema.filter((value) => isCanvasShareSafeText(value), {
    message: () => "An export remote id must not contain a secret.",
  }),
);

export const CanvasExportReceipt = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("link"),
    href: exportUrl,
    /**
     * The remote id of what the link points at, when the destination reports
     * one. A gist's URL and id are one receipt, not two.
     */
    remoteId: Schema.optional(exportRemoteId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("path"),
    /** The file a local destination wrote, named the way the person will open it. */
    path: CanvasExportFilePath,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remote-id"),
    remoteId: exportRemoteId,
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
  /**
   * The exact file this export will write, when the destination can name one.
   *
   * Naming the file is what makes approving this card the confirmation that an
   * existing file at that path may be replaced; a destination that cannot name
   * one never replaces anything (see the seam's `describeDestination`).
   */
  destinationPath: Schema.optional(CanvasExportFilePath),
  /** Whether a file is already at `destinationPath` and will be replaced. */
  replacesExisting: Schema.optional(Schema.Boolean),
  /**
   * The other files of a picture set that are already there and will be
   * replaced. Approving the card confirms exactly these and `destinationPath`;
   * a file that exists and is not named here is never overwritten.
   */
  alsoReplaces: Schema.optional(
    Schema.Array(CanvasExportFilePath).pipe(Schema.maxItems(CANVAS_EXPORT_PICTURE_FILES_MAX)),
  ),
  /**
   * The account this export will act as, when the destination acts as one.
   * Shown verbatim so the person knows whose name it goes out under.
   */
  destinationAccount: Schema.optional(safeBounded(128)),
  /**
   * The audience the destination offered for this export. `secret` is visible
   * only to the account; `public` is visible to anyone, which
   * `destinationNote` is expected to say plainly. Absent for a destination
   * with no audience.
   */
  destinationVisibility: Schema.optional(CanvasExportVisibility),
  /**
   * The destination's own note about this export, shown verbatim — for example
   * that a public result is visible to anyone. Bounded and free of paths and
   * secrets like every other exported string.
   */
  destinationNote: Schema.optional(CanvasExportMessage),
  /**
   * Present when the document writes a design's frames: the author's markup,
   * exactly as written. The share filter reads values, not markup, so naming
   * this is what makes approving the card the person's acknowledgement that
   * markup leaves unchecked.
   */
  writesDesignMarkup: Schema.optional(Schema.Literal(true)),
  /**
   * Present when the pictures are of a design's frames. Pixels of markup are
   * as unreadable to the share filter as the markup, so naming this is what
   * makes approving the card the person's acknowledgement.
   */
  drawsDesignFrames: Schema.optional(Schema.Literal(true)),
  /**
   * The rendered document the person is approving, for a text form. Not a
   * summary of it. A picture form has no text to show and names its files.
   */
  payload: Schema.optional(exportBody),
  /** The files a picture form writes, named and weighed, in writing order. */
  files: Schema.optional(
    Schema.NonEmptyArray(CanvasExportApprovalFile).pipe(
      Schema.maxItems(CANVAS_EXPORT_PICTURE_FILES_MAX),
    ),
  ),
  /** How many pages a PDF holds. */
  pages: Schema.optional(Schema.Int.pipe(Schema.positive())),
  payloadDigest: CanvasExportPayloadDigest,
  byteLength: Schema.Int.pipe(
    Schema.nonNegative(),
    Schema.lessThanOrEqualTo(CANVAS_EXPORT_PICTURES_MAX_BYTES),
  ),
  /** Past this instant the host drops the held approval; answering it expires. */
  expiresAt: UtcTimestamp,
})
  .annotations(strict)
  // Only a card that names the file can say what it will do to one. A card
  // claiming a replacement without naming the file would be asking for a
  // confirmation nobody can give.
  .pipe(
    Schema.filter(
      (card) =>
        (card.replacesExisting === undefined && card.alsoReplaces === undefined) ||
        card.destinationPath !== undefined,
      {
        message: () => "Only a card that names a destination path can say it replaces one.",
      },
    ),
  )
  // A text form shows its payload and a picture form names its files, never
  // neither and never both: a card with nothing to approve, or with a body no
  // file will hold, would not be the export it describes.
  .pipe(
    Schema.filter(
      (card) =>
        isCanvasExportPictureFormat(card.format)
          ? card.payload === undefined && card.files !== undefined
          : card.payload !== undefined &&
            card.files === undefined &&
            card.pages === undefined &&
            card.byteLength <= CANVAS_EXPORT_BODY_MAX_BYTES,
      {
        message: () =>
          "A text export card shows its payload; a picture export card names its files.",
      },
    ),
  )
  .annotations(personDecides);
export type CanvasExportApprovalCard = typeof CanvasExportApprovalCard.Type;

/**
 * The theme a design drawn in the workspace theme is exported in: the scheme
 * and the token values the person's own window draws it with. An exported
 * file has no Octant page to read them from, so the window hands them over.
 * They are values to bound, not markup: a name is a frame token's name and a
 * value cannot end its declaration. The host writes only the tokens a frame
 * receives and checks each value again.
 */
export const CanvasExportFrameTheme = Schema.Struct({
  scheme: Schema.Literal("light", "dark"),
  tokens: Schema.Array(
    Schema.Tuple(
      Schema.String.pipe(Schema.pattern(/^--oct-[a-z0-9-]{1,40}$/)),
      Schema.String.pipe(
        Schema.minLength(1),
        Schema.maxLength(512),
        Schema.pattern(/^[^<>{};\\]*$/),
      ),
    ),
  ).pipe(Schema.maxItems(96)),
}).annotations(strict);
export type CanvasExportFrameTheme = typeof CanvasExportFrameTheme.Type;

export const CanvasExportPrepareRequest = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export-prepare"),
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  expectedSequence: Schema.Int.pipe(Schema.positive()),
  targetId: CanvasExportTargetId,
  format: CanvasExportFormat,
  frameTheme: Schema.optional(CanvasExportFrameTheme),
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
  /**
   * The audience the person chose when the approval card offered one. Absent
   * means the destination's own default, which the card showed and the person
   * approved.
   */
  visibility: Schema.optional(CanvasExportVisibility),
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
