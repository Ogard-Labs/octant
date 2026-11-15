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
}).annotations(strict);
export type DescribedTurnImage = typeof DescribedTurnImage.Type;

/** A turn sends at most eight images, so at most eight are described. */
export const DescribedTurnImages = Schema.Array(DescribedTurnImage).pipe(
  Schema.minItems(1),
  Schema.maxItems(8),
);
export type DescribedTurnImages = typeof DescribedTurnImages.Type;
