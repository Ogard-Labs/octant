import { Schema } from "effect";
import { GuidString, NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ContentProvenance } from "./contentProvenance";
import { AggregateVersion, UtcTimestamp } from "./events";

export const ProductFeedbackNoteId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("ProductFeedbackNoteId"),
);
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
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));

/** Fixed context about the selected element; never a page HTML export. */
export const ProductFeedbackBrowserContext = Schema.Struct({
  captureId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  viewport: Schema.Struct({
    width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16_384 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16_384 })),
  }),
  tag: boundedLabel(64),
  ancestors: Schema.Array(boundedLabel(64)).check(Schema.isMaxLength(4)),
  children: Schema.Array(boundedLabel(128)).check(Schema.isMaxLength(8)),
  styles: Schema.Array(
    Schema.Struct({
      property: Schema.Literals([
        "display",
        "position",
        "box-sizing",
        "gap",
        "padding",
        "margin",
        "width",
        "height",
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
        "text-align",
        "color",
        "background-color",
        "border-color",
        "border-width",
        "border-radius",
      ]),
      value: Schema.String.check(Schema.isMaxLength(128)),
    }),
  ).check(Schema.isMaxLength(18)),
  omissions: Schema.Array(
    Schema.Literals([
      "bounded-neighborhood",
      "form-values-excluded",
      "shadow-content-excluded",
      "crop-unavailable",
      "crop-withheld-for-editable-content",
      "crop-withheld-for-uninspected-region",
    ]),
  ).check(Schema.isMaxLength(6)),
}).check(
  Schema.makeFilter(
    (context) => new TextEncoder().encode(JSON.stringify(context)).byteLength <= 8 * 1_024,
  ),
);
export type ProductFeedbackBrowserContext = typeof ProductFeedbackBrowserContext.Type;

/**
 * Where in the picture the element sits, normalized to the capture, so a client
 * can draw the same box the host cropped without knowing its viewport.
 */
export const ProductFeedbackBounds = Schema.Struct({
  x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  width: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  height: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type ProductFeedbackBounds = typeof ProductFeedbackBounds.Type;

export const ProductFeedbackBrowserDescription = Schema.Struct({
  selector: boundedLabel(1_024),
  role: Schema.optional(boundedLabel(64)),
  accessibleName: Schema.optional(boundedLabel(512)),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
  bounds: ProductFeedbackBounds,
  /** Legacy captures did not record a reviewable context. */
  context: Schema.optional(ProductFeedbackBrowserContext),
});

/**
 * The element's own markup, as the fixed reader serialized it for the Browser
 * element picker: form values, editable text and script or style bodies are
 * left out, and a cut is marked so a reader never takes a fragment for the
 * whole element.
 */
export const MAX_BROWSER_ELEMENT_MARKUP_CHARACTERS = 4_096;

export const BrowserElementMarkup = Schema.Struct({
  html: Schema.String.check(Schema.isMaxLength(MAX_BROWSER_ELEMENT_MARKUP_CHARACTERS)),
  truncated: Schema.Boolean,
});
export type BrowserElementMarkup = typeof BrowserElementMarkup.Type;

export const ProductFeedbackPointObservation = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("described"),
    element: ProductFeedbackBrowserDescription,
    /** Read for the picker only; a note never keeps it. */
    markup: Schema.optional(BrowserElementMarkup),
    cropDataUrl: Schema.optional(
      Schema.String.check(
        Schema.isMaxLength(MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS),
        Schema.isPattern(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/),
      ),
    ),
    url: Schema.optional(boundedLabel(4_096)),
    title: Schema.optional(boundedLabel(1_024)),
  }),
  Schema.Struct({ status: Schema.Literal("no-element") }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.optional(
      Schema.Literals([
        "page-changed",
        "observation-paused",
        "frame-unavailable",
        "capture-unavailable",
      ]),
    ),
  }),
]);
export type ProductFeedbackPointObservation = typeof ProductFeedbackPointObservation.Type;

/**
 * What the user pointed at, as the host resolved it.
 *
 * Two identities are modelled from the start because the same gesture is coming
 * to the simulator: a web element is named by its selector and accessible
 * identity, and a native element by its accessibility identifier. Nothing here
 * is supplied by the client — the host reads the running product itself, so a
 * caller can neither invent an element nor point at one it cannot see.
 */
export const ProductFeedbackElement = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("browser-element"),
    ...ProductFeedbackBrowserDescription.fields,
    url: Schema.optional(boundedLabel(4_096)),
    title: Schema.optional(boundedLabel(1_024)),
  }),
  Schema.Struct({
    kind: Schema.Literal("accessibility-element"),
    identifier: boundedLabel(512),
    role: Schema.optional(boundedLabel(64)),
    label: Schema.optional(boundedLabel(512)),
    bounds: ProductFeedbackBounds,
  }),
]);
export type ProductFeedbackElement = typeof ProductFeedbackElement.Type;

/**
 * The crop the host cut from its own capture, referenced rather than carried:
 * the journal keeps the reference and the picture lives in the purgeable
 * evidence store beside it.
 */
export const ProductFeedbackCrop = Schema.Struct({
  contentId: GuidString,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  byteLength: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS }),
  ),
});
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
});
export type ProductFeedbackProvenance = typeof ProductFeedbackProvenance.Type;

export const ProductFeedbackNote = Schema.Struct({
  id: ProductFeedbackNoteId,
  threadId: GuidString,
  mode: Schema.Literals(["chat", "work", "code"]),
  comment: boundedLabel(MAX_PRODUCT_FEEDBACK_COMMENT_LENGTH),
  element: ProductFeedbackElement,
  /** Absent when the host could not cut a picture of the element. */
  crop: Schema.optional(ProductFeedbackCrop),
  provenance: ProductFeedbackProvenance,
  /**
   * `pending` until a turn carries it, then `delivered`. A note is never
   * carried twice: the turn that takes it says so in the journal.
   */
  lifecycle: Schema.Literals(["pending", "delivered", "discarded"]),
  /** Legacy pending notes were included with the next message. */
  included: Schema.optional(Schema.Boolean),
  capturedAt: UtcTimestamp,
  deliveredAt: Schema.optional(UtcTimestamp),
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).check(
  Schema.makeFilter(
    (note) => (note.lifecycle === "delivered") === (note.deliveredAt !== undefined),
  ),
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
  threadId: GuidString,
  mode: Schema.Literals(["chat", "work", "code"]),
  contextId: GuidString,
  point: Schema.Struct({
    x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
  comment: boundedLabel(MAX_PRODUCT_FEEDBACK_COMMENT_LENGTH),
});
export type CaptureProductFeedbackCommand = typeof CaptureProductFeedbackCommand.Type;

export const DiscardProductFeedbackCommand = Schema.Struct({
  kind: Schema.Literal("discard-product-feedback"),
  noteId: ProductFeedbackNoteId,
  expectedVersion: AggregateVersion,
});
export type DiscardProductFeedbackCommand = typeof DiscardProductFeedbackCommand.Type;

export const ProductFeedbackPreview = Schema.Struct({
  id: GuidString,
  threadId: GuidString,
  mode: Schema.Literals(["work", "code"]),
  element: ProductFeedbackElement,
  cropDataUrl: Schema.optional(
    Schema.String.check(
      Schema.isMaxLength(MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS),
      Schema.isPattern(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/),
    ),
  ),
  provenance: ProductFeedbackProvenance,
  capturedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});
export type ProductFeedbackPreview = typeof ProductFeedbackPreview.Type;

export const ProductFeedbackCropAnswer = Schema.Struct({
  dataUrl: Schema.optional(
    Schema.String.check(
      Schema.isMaxLength(MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS),
      Schema.isPattern(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/),
    ),
  ),
});

export const PrepareProductFeedbackCommand = Schema.Struct({
  kind: Schema.Literal("prepare-product-feedback"),
  threadId: GuidString,
  contextId: GuidString,
  selectionId: Schema.optional(GuidString),
  expectedObservationRevision: Schema.optional(NonNegativeInt),
  point: CaptureProductFeedbackCommand.fields.point,
}).check(
  Schema.makeFilter(
    (command) =>
      command.selectionId !== undefined || command.expectedObservationRevision !== undefined,
  ),
);

export const CommitProductFeedbackCommand = Schema.Struct({
  kind: Schema.Literal("commit-product-feedback"),
  previewId: GuidString,
  threadId: GuidString,
  noteId: Schema.optional(ProductFeedbackNoteId),
  comment: boundedLabel(MAX_PRODUCT_FEEDBACK_COMMENT_LENGTH),
});

export const CancelProductFeedbackPreviewCommand = Schema.Struct({
  kind: Schema.Literal("cancel-product-feedback-preview"),
  previewId: GuidString,
  threadId: GuidString,
});

export const UpdateProductFeedbackCommand = Schema.Struct({
  kind: Schema.Literal("update-product-feedback"),
  noteId: ProductFeedbackNoteId,
  expectedVersion: AggregateVersion,
  comment: Schema.optional(boundedLabel(MAX_PRODUCT_FEEDBACK_COMMENT_LENGTH)),
  included: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((command) => command.comment !== undefined || command.included !== undefined),
);

/**
 * Pick one element of a Work or Code thread's Browser for the composer. The
 * host resolves it exactly as it resolves a pointed-at note, marks the thread
 * as holding outside content, and answers with a snapshot; nothing is kept.
 */
export const PickBrowserElementCommand = Schema.Struct({
  kind: Schema.Literal("pick-browser-element"),
  threadId: GuidString,
  contextId: GuidString,
  selectionId: Schema.optional(GuidString),
  expectedObservationRevision: Schema.optional(NonNegativeInt),
  point: CaptureProductFeedbackCommand.fields.point,
}).check(
  Schema.makeFilter(
    (command) =>
      command.selectionId !== undefined || command.expectedObservationRevision !== undefined,
  ),
);

/** The computed styles a picked element reports: box size, colours, font, display and position. */
export const BROWSER_ELEMENT_SNAPSHOT_STYLES = [
  "display",
  "position",
  "width",
  "height",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
] as const;

export const BrowserElementSnapshot = Schema.Struct({
  threadId: GuidString,
  selector: boundedLabel(1_024),
  tag: boundedLabel(64),
  url: Schema.optional(boundedLabel(4_096)),
  title: Schema.optional(boundedLabel(1_024)),
  /** Absent when the reader returned no markup for the element. */
  markup: Schema.optional(BrowserElementMarkup),
  styles: Schema.Array(
    Schema.Struct({
      property: Schema.Literals(BROWSER_ELEMENT_SNAPSHOT_STYLES),
      value: Schema.String.check(Schema.isMaxLength(128)),
    }),
  ).check(Schema.isMaxLength(BROWSER_ELEMENT_SNAPSHOT_STYLES.length)),
  /** Always outside content: everything here came off the page. */
  provenance: ContentProvenance,
  capturedAt: UtcTimestamp,
});
export type BrowserElementSnapshot = typeof BrowserElementSnapshot.Type;

export const ProductFeedbackCommand = Schema.Union([
  PickBrowserElementCommand,
  CaptureProductFeedbackCommand,
  DiscardProductFeedbackCommand,
  PrepareProductFeedbackCommand,
  CommitProductFeedbackCommand,
  CancelProductFeedbackPreviewCommand,
  UpdateProductFeedbackCommand,
]);
export type ProductFeedbackCommand = typeof ProductFeedbackCommand.Type;

export const ProductFeedbackRefusalReason = Schema.Literals([
  "thread-unavailable",
  "surface-unavailable",
  "element-unavailable",
  "capture-unavailable",
  "note-limit-reached",
  "preview-limit-reached",
  "preview-expired",
]);
export type ProductFeedbackRefusalReason = typeof ProductFeedbackRefusalReason.Type;

/** A thread keeps a short queue of notes; past it, the user sends what they have. */
export const MAX_PENDING_PRODUCT_FEEDBACK_NOTES = 8;

export const ProductFeedbackCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("feedback-prepared"),
    preview: ProductFeedbackPreview,
  }),
  Schema.Struct({
    kind: Schema.Literal("feedback-preview-cancelled"),
    previewId: GuidString,
  }),
  Schema.Struct({
    kind: Schema.Literal("feedback-updated"),
    note: ProductFeedbackNote,
  }),
  Schema.Struct({
    kind: Schema.Literal("feedback-captured"),
    note: ProductFeedbackNote,
  }),
  Schema.Struct({
    kind: Schema.Literal("feedback-discarded"),
    note: ProductFeedbackNote,
  }),
  Schema.Struct({
    kind: Schema.Literal("feedback-refused"),
    reason: ProductFeedbackRefusalReason,
  }),
  Schema.Struct({
    kind: Schema.Literal("browser-element-picked"),
    snapshot: BrowserElementSnapshot,
  }),
]);
export type ProductFeedbackCommandResult = typeof ProductFeedbackCommandResult.Type;

export const ProductFeedbackList = Schema.Struct({
  notes: Schema.Array(ProductFeedbackNote),
});
export type ProductFeedbackList = typeof ProductFeedbackList.Type;

export const ProductFeedbackCaptured = Schema.Struct({
  kind: Schema.Literal("feedback-captured"),
  note: ProductFeedbackNote,
});
export type ProductFeedbackCaptured = typeof ProductFeedbackCaptured.Type;

export const ProductFeedbackDiscarded = Schema.Struct({
  kind: Schema.Literal("feedback-discarded"),
  note: ProductFeedbackNote,
});
export type ProductFeedbackDiscarded = typeof ProductFeedbackDiscarded.Type;

export const ProductFeedbackUpdated = Schema.Struct({
  kind: Schema.Literal("feedback-updated"),
  note: ProductFeedbackNote,
});

export const ProductFeedbackDelivered = Schema.Struct({
  kind: Schema.Literal("feedback-delivered"),
  note: ProductFeedbackNote,
  /** The turn that carried it, so the journal says where a note went. */
  operationId: GuidString,
});
export type ProductFeedbackDelivered = typeof ProductFeedbackDelivered.Type;

export const PRODUCT_FEEDBACK_EVENT_SCHEMAS = {
  "feedback.note-captured@1": ProductFeedbackCaptured,
  "feedback.note-discarded@1": ProductFeedbackDiscarded,
  "feedback.note-delivered@1": ProductFeedbackDelivered,
  "feedback.note-updated@1": ProductFeedbackUpdated,
} as const;

export const decodeProductFeedbackNoteId = Schema.decodeUnknownSync(
  ProductFeedbackNoteId,
  STRICT_DECODE_OPTIONS,
);
export const decodeProductFeedbackElement = Schema.decodeUnknownSync(
  ProductFeedbackElement,
  STRICT_DECODE_OPTIONS,
);
export const decodeProductFeedbackPointObservation = Schema.decodeUnknownSync(
  ProductFeedbackPointObservation,
  STRICT_DECODE_OPTIONS,
);
export const decodeProductFeedbackBrowserContext = Schema.decodeUnknownSync(
  ProductFeedbackBrowserContext,
  STRICT_DECODE_OPTIONS,
);
export const decodeProductFeedbackNote = Schema.decodeUnknownSync(
  ProductFeedbackNote,
  STRICT_DECODE_OPTIONS,
);
export const decodeProductFeedbackPreview = Schema.decodeUnknownSync(
  ProductFeedbackPreview,
  STRICT_DECODE_OPTIONS,
);
export const decodeProductFeedbackCropAnswer = Schema.decodeUnknownSync(
  ProductFeedbackCropAnswer,
  STRICT_DECODE_OPTIONS,
);
export const decodeProductFeedbackCommand = Schema.decodeUnknownSync(
  ProductFeedbackCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeBrowserElementSnapshot = Schema.decodeUnknownSync(
  BrowserElementSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeProductFeedbackCommandResult = Schema.decodeUnknownSync(
  ProductFeedbackCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeProductFeedbackList = Schema.decodeUnknownSync(
  ProductFeedbackList,
  STRICT_DECODE_OPTIONS,
);
