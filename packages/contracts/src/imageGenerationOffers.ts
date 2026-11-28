import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const ImageOfferReference = Schema.Struct({
  kind: Schema.Literals(["attachment", "browser-capture", "file", "generated-image"]),
  label: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_IMAGE_REFERENCE_LABEL_LENGTH),
  ),
  signedIn: Schema.optional(Schema.Literal(true)),
});
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
  threadKind: Schema.Literals(["chat-thread", "work-thread", "code-thread"]),
  scopeId: ImageGenerationScopeId,
  prompt: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_IMAGE_PROMPT_CHARACTERS),
  ),
  variantCount: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_IMAGE_VARIANTS)),
  /** The agent asked to revise an image this thread already generated. */
  revision: Schema.Boolean,
  references: Schema.optional(
    Schema.Array(ImageOfferReference).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_IMAGE_REFERENCES),
    ),
  ),
  suggested: Schema.Struct({
    profileInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  }),
  requestedAt: UtcTimestamp,
});
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
  threadKind: Schema.Literals(["work-thread", "code-thread"]),
  scopeId: ImageGenerationScopeId,
  jobId: ImageJobId,
  attachmentId: ImageArtifactId,
  relativePath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  /**
   * Set when the agent saves an icon set: `relativePath` is then the directory
   * and this many new files go into it.
   */
  fileCount: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ICON_SET_FILES))),
  requestedAt: UtcTimestamp,
});
export type ImageGenerationSaveOffer = typeof ImageGenerationSaveOffer.Type;

export const ImageGenerationOffer = Schema.Union([
  ImageGenerationGenerateOffer,
  ImageGenerationSaveOffer,
]).annotate(personDecides);
export type ImageGenerationOffer = typeof ImageGenerationOffer.Type;

export const ImageGenerationOffersResponse = Schema.Struct({
  offers: Schema.Array(ImageGenerationOffer).check(
    Schema.isMaxLength(MAX_PENDING_IMAGE_GENERATION_OFFERS),
  ),
});
export type ImageGenerationOffersResponse = typeof ImageGenerationOffersResponse.Type;

export const decodeImageGenerationOffer = Schema.decodeUnknownSync(
  ImageGenerationOffer,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationGenerateOffer = Schema.decodeUnknownSync(
  ImageGenerationGenerateOffer,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationSaveOffer = Schema.decodeUnknownSync(
  ImageGenerationSaveOffer,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationOffersResponse = Schema.decodeUnknownSync(
  ImageGenerationOffersResponse,
  STRICT_DECODE_OPTIONS,
);
