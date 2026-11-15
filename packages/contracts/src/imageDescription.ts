/**
 * An image described in words for a model that cannot read images.
 *
 * The Sees images role (`vision` slot, `image-understanding` job) describes a
 * person's image for a thread whose model takes no image input. The host
 * decides which model describes it, never the renderer or the model, and the
 * record names that model so the transcript can say who described it.
 */

import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** A description is cut here, so one image never fills a turn. */
export const MAX_IMAGE_DESCRIPTION_CHARACTERS = 4_000;
/** The question `look` may ask about an image. */
export const MAX_LOOK_QUESTION_CHARACTERS = 500;

const Label = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256));

/** Which model described an image: its name and its provider's, as the person sees them. */
export const ImageDescribedBy = Schema.Struct({
  model: Label,
  provider: Label,
}).annotations(strict);
export type ImageDescribedBy = typeof ImageDescribedBy.Type;

/** The attached image's name, as its attachment record keeps it. */
export const DescribedImageName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255));

/** One attachment of a turn the host described, by the attachment's id. */
export const DescribedTurnImage = Schema.Struct({
  attachmentId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  name: DescribedImageName,
  describedBy: ImageDescribedBy,
  /**
   * The words themselves, where the mode keeps a turn's text in its own
   * record (Work, Chat), so a later turn rebuilt from the transcript, or a
   * compaction, still reads them. Code keeps them in its content store.
   */
  description: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_IMAGE_DESCRIPTION_CHARACTERS)),
  ),
}).annotations(strict);
export type DescribedTurnImage = typeof DescribedTurnImage.Type;

/** A turn sends at most eight images, so at most eight are described. */
export const DescribedTurnImages = Schema.Array(DescribedTurnImage).pipe(
  Schema.minItems(1),
  Schema.maxItems(8),
);
export type DescribedTurnImages = typeof DescribedTurnImages.Type;

/**
 * Whether Sees images could describe an image for a thread now, read by a
 * composer before it accepts an image its thread's model cannot read. It
 * sends nothing; the turn decides again when it starts.
 */
export const SeesImagesAvailability = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("available"),
    describedBy: ImageDescribedBy,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_000)),
  }).annotations(strict),
);
export type SeesImagesAvailability = typeof SeesImagesAvailability.Type;
