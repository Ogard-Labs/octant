import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { personDecides } from "./hostAnswer";
import {
  ImageArtifactId,
  ImageGenerationOfferId,
  ImageGenerationScopeId,
  ImageJobId,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_REFERENCE_LABEL_LENGTH,
  MAX_IMAGE_REFERENCES,
  MAX_IMAGE_VARIANTS,
  MAX_PENDING_IMAGE_GENERATION_OFFERS,
} from "./imageGeneration";
import { ProviderInstanceId, ProviderModelId } from "./providers";

// Apart from the ids and jobs a window reads at launch, so an offer's payload
// loads with the card that shows it.

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const ImageOfferReference = Schema.Struct({
  kind: Schema.Literal("attachment", "browser-capture", "file", "generated-image"),
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_IMAGE_REFERENCE_LABEL_LENGTH)),
  signedIn: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
export type ImageOfferReference = typeof ImageOfferReference.Type;

/**
 * An agent asking, in its thread, to generate an image with a configured
 * image model instead of drawing it itself. Nothing is spent until the person
 * answers: they pick the profile and model, may let the agent draw it after
 * all, or may say not to ask again (for the Project, or the thread outside one). `suggested` is what the
 * card preselects; the person's choice is what runs.
 */
export const ImageGenerationGenerateOffer = Schema.Struct({
  offerId: ImageGenerationOfferId,
  kind: Schema.Literal("generate"),
  threadKind: Schema.Literal("chat-thread", "work-thread", "code-thread"),
  scopeId: ImageGenerationScopeId,
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_IMAGE_PROMPT_CHARACTERS)),
  variantCount: PositiveInt.pipe(Schema.lessThanOrEqualTo(MAX_IMAGE_VARIANTS)),
  /** The agent asked to revise an image this thread already generated. */
  revision: Schema.Boolean,
  references: Schema.optional(
    Schema.Array(ImageOfferReference).pipe(
      Schema.minItems(1),
      Schema.maxItems(MAX_IMAGE_REFERENCES),
    ),
  ),
  suggested: Schema.Struct({
    profileInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  }).annotations(strict),
  requestedAt: UtcTimestamp,
}).annotations(strict);
export type ImageGenerationGenerateOffer = typeof ImageGenerationGenerateOffer.Type;

/**
 * An agent asking, in a Work or Code thread whose level asks before edits, to
 * save an image this thread generated as a new file under the folder its turn
 * works in. The path is relative to that folder; the host confines it there
 * and never overwrites a file.
 */
/** The largest icon set an agent can save: the macOS app icon's ten sizes and its Contents.json. */
export const MAX_ICON_SET_FILES = 11;

export const ImageGenerationSaveOffer = Schema.Struct({
  offerId: ImageGenerationOfferId,
  kind: Schema.Literal("save"),
  threadKind: Schema.Literal("work-thread", "code-thread"),
  scopeId: ImageGenerationScopeId,
  jobId: ImageJobId,
  attachmentId: ImageArtifactId,
  relativePath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  /**
   * Set when the agent saves an icon set: `relativePath` is then the directory
   * and this many new files go into it.
   */
  fileCount: Schema.optional(PositiveInt.pipe(Schema.lessThanOrEqualTo(MAX_ICON_SET_FILES))),
  requestedAt: UtcTimestamp,
}).annotations(strict);
export type ImageGenerationSaveOffer = typeof ImageGenerationSaveOffer.Type;

export const ImageGenerationOffer = Schema.Union(
  ImageGenerationGenerateOffer,
  ImageGenerationSaveOffer,
).annotations(personDecides);
export type ImageGenerationOffer = typeof ImageGenerationOffer.Type;

export const ImageGenerationOffersResponse = Schema.Struct({
  offers: Schema.Array(ImageGenerationOffer).pipe(
    Schema.maxItems(MAX_PENDING_IMAGE_GENERATION_OFFERS),
  ),
}).annotations(strict);
export type ImageGenerationOffersResponse = typeof ImageGenerationOffersResponse.Type;

export const decodeImageGenerationOffer = Schema.decodeUnknownSync(ImageGenerationOffer);
export const decodeImageGenerationGenerateOffer = Schema.decodeUnknownSync(
  ImageGenerationGenerateOffer,
);
export const decodeImageGenerationSaveOffer = Schema.decodeUnknownSync(ImageGenerationSaveOffer);
export const decodeImageGenerationOffersResponse = Schema.decodeUnknownSync(
  ImageGenerationOffersResponse,
);
