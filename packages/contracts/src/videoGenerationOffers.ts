import { Schema } from "effect";
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

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** One image a video offer names: where it comes from, as the person will recognize it. */
export const VideoOfferImage = Schema.Struct({
  role: Schema.Literal("first-frame", "last-frame", "reference"),
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200)),
  /** The image came from a page the person is signed in to; the card says so. */
  signedIn: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
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
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_VIDEO_PROMPT_CHARACTERS)),
  images: Schema.Array(VideoOfferImage).pipe(Schema.maxItems(8)),
  profileInstanceId: ProviderInstanceId,
  profileName: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(MAX_VIDEO_OFFER_PROFILE_NAME_LENGTH),
  ),
  /** The provider that bills the clip and receives the prompt, by name. */
  providerName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120)),
  model: VideoModelCapabilities,
  options: VideoClipOptions,
  /** Whether "Don't ask again" may be offered; never with images, as for image generation. */
  canRemember: Schema.Boolean,
  requestedAt: UtcTimestamp,
}).annotations(strict);
export type VideoGenerateOffer = typeof VideoGenerateOffer.Type;

/** An agent asking, at a level that asks before edits, to save a clip as a new file. */
export const VideoSaveOffer = Schema.Struct({
  offerId: ImageGenerationOfferId,
  kind: Schema.Literal("video-save"),
  threadKind: Schema.Literal("work-thread", "code-thread"),
  scopeId: ImageGenerationScopeId,
  jobId: VideoJobId,
  clipId: VideoClipId,
  relativePath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  sizeBytes: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(MAX_VIDEO_CLIP_BYTES)),
  requestedAt: UtcTimestamp,
}).annotations(strict);
export type VideoSaveOffer = typeof VideoSaveOffer.Type;

export const decodeVideoGenerateOffer = Schema.decodeUnknownSync(VideoGenerateOffer);
export const decodeVideoSaveOffer = Schema.decodeUnknownSync(VideoSaveOffer);
