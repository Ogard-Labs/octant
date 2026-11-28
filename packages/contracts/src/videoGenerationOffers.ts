import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { ImageGenerationOfferId, ImageGenerationScopeId } from "./imageGeneration";
import { ProviderInstanceId } from "./providers";
import {
  MAX_VIDEO_CLIP_BYTES,
  MAX_VIDEO_PROMPT_CHARACTERS,
  VideoClipId,
  VideoClipOptions,
  VideoJobId,
  VideoJobThreadKind,
  VideoModelCapabilities,
} from "./videoGeneration";

// Apart from the jobs and models a window reads at launch, so an offer's
// payload loads with the card that shows it.

/** One image a video offer names: where it comes from, as the person will recognize it. */
export const VideoOfferImage = Schema.Struct({
  role: Schema.Literals(["first-frame", "last-frame", "reference"]),
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  /** The image came from a page the person is signed in to; the card says so. */
  signedIn: Schema.optional(Schema.Literal(true)),
});
export type VideoOfferImage = typeof VideoOfferImage.Type;

export const MAX_VIDEO_OFFER_PROFILE_NAME_LENGTH = 120;

/**
 * An agent asking to make a clip. The card shows the prompt, the named
 * images, the profile and model with what the model declares, the chosen
 * options (which the person may change within the declaration), the price for
 * them, who receives the prompt and images and how long they keep them, and
 * what Stop does when the model cannot cancel.
 */
export const VideoGenerateOffer = Schema.Struct({
  offerId: ImageGenerationOfferId,
  kind: Schema.Literal("video-generate"),
  threadKind: VideoJobThreadKind,
  scopeId: ImageGenerationScopeId,
  prompt: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_VIDEO_PROMPT_CHARACTERS),
  ),
  images: Schema.Array(VideoOfferImage).check(Schema.isMaxLength(8)),
  profileInstanceId: ProviderInstanceId,
  profileName: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_VIDEO_OFFER_PROFILE_NAME_LENGTH),
  ),
  /** The provider that bills the clip and receives the prompt, by name. */
  providerName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
  model: VideoModelCapabilities,
  options: VideoClipOptions,
  /** Whether "Don't ask again" may be offered; never with images, as for image generation. */
  canRemember: Schema.Boolean,
  requestedAt: UtcTimestamp,
});
export type VideoGenerateOffer = typeof VideoGenerateOffer.Type;

/** An agent asking, at a level that asks before edits, to save a clip as a new file. */
export const VideoSaveOffer = Schema.Struct({
  offerId: ImageGenerationOfferId,
  kind: Schema.Literal("video-save"),
  threadKind: Schema.Literals(["work-thread", "code-thread"]),
  scopeId: ImageGenerationScopeId,
  jobId: VideoJobId,
  clipId: VideoClipId,
  relativePath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  sizeBytes: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(MAX_VIDEO_CLIP_BYTES),
  ),
  requestedAt: UtcTimestamp,
});
export type VideoSaveOffer = typeof VideoSaveOffer.Type;

export const decodeVideoGenerateOffer = Schema.decodeUnknownSync(
  VideoGenerateOffer,
  STRICT_DECODE_OPTIONS,
);
export const decodeVideoSaveOffer = Schema.decodeUnknownSync(VideoSaveOffer, STRICT_DECODE_OPTIONS);
