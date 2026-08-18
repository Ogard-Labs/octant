import { Schema } from "effect";
import { ContentProvenance } from "./contentProvenance";
import { AggregateVersion, UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const ProductFeedbackNoteId = Schema.UUID.pipe(Schema.brand("ProductFeedbackNoteId"));
export type ProductFeedbackNoteId = typeof ProductFeedbackNoteId.Type;

/**
 * A note is a sentence about what the user is looking at, not a document. The
 * bound keeps a pointed-at note from becoming a second composer, and keeps the
 * journal free of pasted prose.
 */
export const MAX_PRODUCT_FEEDBACK_COMMENT_LENGTH = 2_000;

/** Room for a legible crop of one element, not a page. */
export const MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS = 256 * 1024;

const boundedLabel = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));

/**
 * Where in the picture the element sits, normalized to the capture, so a client
 * can draw the same box the host cropped without knowing its viewport.
 */
export const ProductFeedbackBounds = Schema.Struct({
  x: Schema.Number.pipe(Schema.between(0, 1)),
  y: Schema.Number.pipe(Schema.between(0, 1)),
  width: Schema.Number.pipe(Schema.between(0, 1)),
  height: Schema.Number.pipe(Schema.between(0, 1)),
}).annotations(strict);
export type ProductFeedbackBounds = typeof ProductFeedbackBounds.Type;

/**
 * What the user pointed at, as the host resolved it.
 *
 * Two identities are modelled from the start because the same gesture is coming
 * to the simulator: a web element is named by its selector and accessible
 * identity, and a native element by its accessibility identifier. Nothing here
 * is supplied by the client — the host reads the running product itself, so a
 * caller can neither invent an element nor point at one it cannot see.
 */
export const ProductFeedbackElement = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("browser-element"),
    selector: boundedLabel(1_024),
    role: Schema.optional(boundedLabel(64)),
    accessibleName: Schema.optional(boundedLabel(512)),
    /** The element's own text, bounded. Page content, and treated as such. */
    text: Schema.optional(Schema.String.pipe(Schema.maxLength(2_048))),
    url: Schema.optional(boundedLabel(4_096)),
    title: Schema.optional(boundedLabel(1_024)),
    bounds: ProductFeedbackBounds,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("accessibility-element"),
    identifier: boundedLabel(512),
    role: Schema.optional(boundedLabel(64)),
    label: Schema.optional(boundedLabel(512)),
    bounds: ProductFeedbackBounds,
  }).annotations(strict),
);
export type ProductFeedbackElement = typeof ProductFeedbackElement.Type;

/**
 * The crop the host cut from its own capture, referenced rather than carried:
 * the journal keeps the reference and the picture lives in the purgeable
 * evidence store beside it.
 */
export const ProductFeedbackCrop = Schema.Struct({
  contentId: Schema.UUID,
  digest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  byteLength: Schema.Int.pipe(Schema.between(0, MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS)),
}).annotations(strict);
export type ProductFeedbackCrop = typeof ProductFeedbackCrop.Type;

/**
 * Where each half of a note came from.
 *
 * A note is two things at once and they are never conflated: the comment is the
 * user's own words, and everything about the element — its identity, its text,
 * its picture — came off a page the host does not control. Recording that split
 * is what lets the untrusted-content rules treat the second half as external
 * content while still crediting the first half to the person.
 */
export const ProductFeedbackProvenance = Schema.Struct({
  comment: ContentProvenance,
  element: ContentProvenance,
}).annotations(strict);
export type ProductFeedbackProvenance = typeof ProductFeedbackProvenance.Type;

export const ProductFeedbackNote = Schema.Struct({
  id: ProductFeedbackNoteId,
  threadId: Schema.UUID,
  mode: Schema.Literal("chat", "work", "code"),
  comment: boundedLabel(MAX_PRODUCT_FEEDBACK_COMMENT_LENGTH),
  element: ProductFeedbackElement,
  /** Absent when the host could not cut a picture of the element. */
  crop: Schema.optional(ProductFeedbackCrop),
  provenance: ProductFeedbackProvenance,
  /**
   * `pending` until a turn carries it, then `delivered`. A note is never
   * carried twice: the turn that takes it says so in the journal.
   */
  lifecycle: Schema.Literal("pending", "delivered", "discarded"),
  capturedAt: UtcTimestamp,
  deliveredAt: Schema.optional(UtcTimestamp),
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter((note) => (note.lifecycle === "delivered") === (note.deliveredAt !== undefined)),
  );
export type ProductFeedbackNote = typeof ProductFeedbackNote.Type;

/**
 * Point at something in the running product and say what is wrong with it.
 *
 * The caller sends where it tapped and what it wants to say. The host resolves
 * the element and cuts the crop itself, after checking that this caller may
 * look at this thread's browser at all — so a note can never name an element
 * from a page its author was not entitled to see.
 */
export const CaptureProductFeedbackCommand = Schema.Struct({
  kind: Schema.Literal("capture-product-feedback"),
  noteId: Schema.optional(ProductFeedbackNoteId),
  threadId: Schema.UUID,
  mode: Schema.Literal("chat", "work", "code"),
  contextId: Schema.UUID,
  point: Schema.Struct({
    x: Schema.Number.pipe(Schema.between(0, 1)),
    y: Schema.Number.pipe(Schema.between(0, 1)),
  }).annotations(strict),
  comment: boundedLabel(MAX_PRODUCT_FEEDBACK_COMMENT_LENGTH),
}).annotations(strict);
export type CaptureProductFeedbackCommand = typeof CaptureProductFeedbackCommand.Type;

export const DiscardProductFeedbackCommand = Schema.Struct({
  kind: Schema.Literal("discard-product-feedback"),
  noteId: ProductFeedbackNoteId,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type DiscardProductFeedbackCommand = typeof DiscardProductFeedbackCommand.Type;

export const ProductFeedbackCommand = Schema.Union(
  CaptureProductFeedbackCommand,
  DiscardProductFeedbackCommand,
);
export type ProductFeedbackCommand = typeof ProductFeedbackCommand.Type;

export const ProductFeedbackRefusalReason = Schema.Literal(
  "thread-unavailable",
  "surface-unavailable",
  "element-unavailable",
  "capture-unavailable",
  "note-limit-reached",
);
export type ProductFeedbackRefusalReason = typeof ProductFeedbackRefusalReason.Type;

/** A thread keeps a short queue of notes; past it, the user sends what they have. */
export const MAX_PENDING_PRODUCT_FEEDBACK_NOTES = 8;

export const ProductFeedbackCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("feedback-captured"),
    note: ProductFeedbackNote,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("feedback-discarded"),
    note: ProductFeedbackNote,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("feedback-refused"),
    reason: ProductFeedbackRefusalReason,
  }).annotations(strict),
);
export type ProductFeedbackCommandResult = typeof ProductFeedbackCommandResult.Type;

export const ProductFeedbackList = Schema.Struct({
  notes: Schema.Array(ProductFeedbackNote),
}).annotations(strict);
export type ProductFeedbackList = typeof ProductFeedbackList.Type;

export const ProductFeedbackCaptured = Schema.Struct({
  kind: Schema.Literal("feedback-captured"),
  note: ProductFeedbackNote,
}).annotations(strict);
export type ProductFeedbackCaptured = typeof ProductFeedbackCaptured.Type;

export const ProductFeedbackDiscarded = Schema.Struct({
  kind: Schema.Literal("feedback-discarded"),
  note: ProductFeedbackNote,
}).annotations(strict);
export type ProductFeedbackDiscarded = typeof ProductFeedbackDiscarded.Type;

export const ProductFeedbackDelivered = Schema.Struct({
  kind: Schema.Literal("feedback-delivered"),
  note: ProductFeedbackNote,
  /** The turn that carried it, so the journal says where a note went. */
  operationId: Schema.UUID,
}).annotations(strict);
export type ProductFeedbackDelivered = typeof ProductFeedbackDelivered.Type;

export const PRODUCT_FEEDBACK_EVENT_SCHEMAS = {
  "feedback.note-captured@1": ProductFeedbackCaptured,
  "feedback.note-discarded@1": ProductFeedbackDiscarded,
  "feedback.note-delivered@1": ProductFeedbackDelivered,
} as const;

export const PRODUCT_FEEDBACK_EVENT_NAMES = Object.freeze(
  Object.keys(PRODUCT_FEEDBACK_EVENT_SCHEMAS),
) as ReadonlyArray<keyof typeof PRODUCT_FEEDBACK_EVENT_SCHEMAS>;

export const PRODUCT_FEEDBACK_AGGREGATE_TYPE = "product-feedback-note";

export const decodeProductFeedbackNoteId = Schema.decodeUnknownSync(ProductFeedbackNoteId);
export const decodeProductFeedbackElement = Schema.decodeUnknownSync(ProductFeedbackElement);
export const decodeProductFeedbackNote = Schema.decodeUnknownSync(ProductFeedbackNote);
export const decodeProductFeedbackCommand = Schema.decodeUnknownSync(ProductFeedbackCommand);
export const decodeProductFeedbackCommandResult = Schema.decodeUnknownSync(
  ProductFeedbackCommandResult,
);
export const decodeProductFeedbackList = Schema.decodeUnknownSync(ProductFeedbackList);
